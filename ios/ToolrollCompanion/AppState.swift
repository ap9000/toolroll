import Foundation
import Network
import Observation
import ToolrollCompanionCore
import UIKit

/// Where one screen's data stands. `value` survives a failed refresh, so cached data stays visible (dimmed).
enum LoadPhase: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

struct Loadable<Value: Equatable>: Equatable {
    var value: Value?
    var phase: LoadPhase = .idle

    var isLoading: Bool { phase == .loading }
    var failure: String? {
        if case .failed(let message) = phase { return message }
        return nil
    }
}

/// One Work view as loaded so far (page 1 plus any "load more" pages).
struct InboxPage: Equatable {
    var rows: [WorkRow]
    /// Waiting asks that are no task row (a held release, a flow card, a setup step).
    var otherNeeds: [NeedRow]
    var next: String?
    /// Why the last "Load more" failed, shown next to the button (which stays usable).
    var moreFailure: String?
}

/// Everything fetched in one mode. Demo and live each have their own; both are cleared on unpair / exit demo.
struct CompanionCache {
    var inbox: [WorkView: Loadable<InboxPage>] = [:]
    var needsCount: Int?
    var rows: [String: WorkRow] = [:]
    var steps: [String: Loadable<StepCards>] = [:]
    var diffs: [String: Loadable<ResultDiff>] = [:]
    var diffFiles: [String: Loadable<ResultDiffFile>] = [:]
}

enum Route: Hashable {
    case task(String)
    case diff(DiffRoute)
}

struct DiffRoute: Hashable {
    let task: String
    let run: Int
    let file: Int
    let path: String
    let additions: Int
    let deletions: Int
}

/// Lets the relay client's loss callback reach the app state without keeping it alive.
private final class WeakOwner: @unchecked Sendable {
    weak var value: CompanionAppState?
    init(_ value: CompanionAppState) { self.value = value }
}

@MainActor
@Observable
final class CompanionAppState {
    private(set) var connection: CompanionConnectionState = .unpaired
    /// Which scan owns the pairing UI (a late callback from an older scan never overwrites a newer one).
    private var pairingGate = CompanionPairingGate()
    var pairing: CompanionPairingPhase { pairingGate.phase }
    private(set) var pairedRecord: PairedWorkspaceRecord?
    private(set) var workspaceLabel: String = "Your Mac"
    /// The last time live data was fetched successfully.
    private(set) var lastUpdated: Date?
    /// Bumped after a quiet reconnect so visible screens reload.
    private(set) var refreshTick = 0
    var pairingError: String?
    /// The path the current session runs over (direct or hosted), for Settings.
    private(set) var connectedPath: CompanionPath?
    /// Why the Mac can't be reached, when there's something the person can do about it.
    private(set) var connectionProblem: String?
    /// iOS blocks this app from the local network, so direct connections to the Mac can't work.
    private(set) var localNetworkDenied = false
    /// An automatic reconnect is running (after a drop, a failed attempt's backoff, or a network change).
    private(set) var isReconnecting = false
    /// The title over `pairingError`: a code that isn't Toolroll's reads differently from a pairing that broke off.
    private(set) var pairingErrorTitle = "Pairing didn't finish"
    /// Bumped when a pairing completes (drives the success haptic).
    private(set) var pairedCount = 0
    /// One-off message for the Welcome screen (for example, how unpairing went).
    var notice: String?

    private var demoCache = CompanionCache()
    private var liveCache = CompanionCache()

    @ObservationIgnored private let client = CompanionRelayClient()
    @ObservationIgnored private let demoSource = DemoCompanionSource()
    @ObservationIgnored private let liveSource: LiveCompanionSource
    @ObservationIgnored private var connectTask: Task<Bool, Never>?
    /// Bumped whenever a mode or pairing changes: work started under an older one never publishes.
    @ObservationIgnored private var epoch = 0
    /// Bumped on background: a connect that finishes after the app left the foreground is dropped.
    @ObservationIgnored private var connectEpoch = 0
    @ObservationIgnored private var pairingTask: Task<Void, Never>?
    @ObservationIgnored private(set) var isActive = true
    /// The next automatic reconnect while the Mac can't be reached (2, 5, 15, then every 30 seconds).
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var retryAttempt = 0
    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    private static let retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15), .seconds(30)]

    #if DEBUG
    /// DEBUG-only launch route for screenshots: `--screen task:<id>|diff:<task>:<file>|live:<task>|settings|scan`.
    @ObservationIgnored var debugScreen: String?
    #endif

    private static let recordStorageKey = "paired.workspace.record.v1"
    private static let labelStorageKey = "paired.workspace.label.v1"
    private static let keyAccounts = ["device.psk", "phone.noise.priv", "device.relay.priv"]

    init() {
        liveSource = LiveCompanionSource(client: client)
        let args = ProcessInfo.processInfo.arguments
        #if DEBUG
        if let i = args.firstIndex(of: "--screen"), i + 1 < args.count {
            debugScreen = args[i + 1]
        }
        #endif
        #if DEBUG
        if args.contains("--debug-unreachable") {
            Self.installUnreachablePairingForDebug()
        }
        #endif
        if args.contains("--demo") {
            enterDemoMode()
        } else {
            restoreSavedWorkspace()
        }
        #if DEBUG
        // DEBUG only (the Simulator has no camera): `--pair-payload <base64url of the pairing code>` pairs on launch,
        // exactly as pasting the code into "Can't scan?" does.
        if let i = args.firstIndex(of: "--pair-payload"), i + 1 < args.count,
           let data = CompanionRelayAuth.base64UrlDecode(args[i + 1]), let text = String(data: data, encoding: .utf8) {
            let payload = text
            Task { @MainActor [weak self] in self?.startPairing(payload: payload) }
        }
        #endif
        let client = self.client
        let owner = WeakOwner(self)
        Task {
            await client.setConnectionLostHandler { _ in
                Task { @MainActor in await owner.value?.connectionDropped() }
            }
        }
        // A network that comes back (Wi-Fi joined, cellular regained) is the best time to try again.
        pathMonitor.pathUpdateHandler = { path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in owner.value?.networkChanged(satisfied: satisfied) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "dev.toolroll.companion.network-path"))
    }

    #if DEBUG
    /// DEBUG only: a pairing whose only path is a closed localhost port, to exercise the offline path.
    private static func installUnreachablePairingForDebug() {
        func random(_ n: Int) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }
        let record = PairedWorkspaceRecord(
            workspaceId: "ws-debug", workspaceLabel: "Studio Mac", machineId: "m-debug",
            paths: [CompanionPath(kind: .hosted, url: "ws://127.0.0.1:9/v1/connect")],
            macStaticPubBase64Url: CompanionRelayAuth.base64UrlEncode(X25519KeyPair.generate().publicKey),
            deviceId: "dev-debug", recoveryGeneration: String(repeating: "0", count: 32), pairedAt: Date()
        )
        try? CompanionKeychain.save(random(32), account: "device.psk")
        try? CompanionKeychain.save(X25519KeyPair.generate().privateKey, account: "phone.noise.priv")
        try? CompanionKeychain.save(random(32), account: "device.relay.priv")
        UserDefaults.standard.set(try? JSONEncoder().encode(record), forKey: recordStorageKey)
        UserDefaults.standard.set("Studio Mac", forKey: labelStorageKey)
    }
    #endif

    var isDemoMode: Bool { connection == .demo }
    var isPaired: Bool { pairedRecord != nil }

    /// Cached data is shown under a "Last updated" banner while the Mac can't be reached.
    var isOffline: Bool {
        switch connection {
        case .unreachable, .notRecognized: return true
        default: return false
        }
    }

    private var cache: CompanionCache {
        get { isDemoMode ? demoCache : liveCache }
        set { if isDemoMode { demoCache = newValue } else { liveCache = newValue } }
    }

    // MARK: Reads for views

    func inbox(_ view: WorkView) -> Loadable<InboxPage> { cache.inbox[view] ?? Loadable() }
    var needsCount: Int? { cache.needsCount }
    func row(_ task: String) -> WorkRow? { cache.rows[task] }
    func steps(_ task: String) -> Loadable<StepCards> { cache.steps[task] ?? Loadable() }
    func diff(_ task: String) -> Loadable<ResultDiff> { cache.diffs[task] ?? Loadable() }
    func diffFile(_ route: DiffRoute) -> Loadable<ResultDiffFile> { cache.diffFiles[Self.fileKey(route)] ?? Loadable() }

    private static func fileKey(_ route: DiffRoute) -> String { "\(route.task):\(route.run):\(route.file)" }

    // MARK: Modes

    func enterDemoMode() {
        cancelPairing()
        cancelRetry()
        epoch += 1
        let client = self.client
        Task { await client.disconnect() }
        pairingError = nil
        notice = nil
        demoCache = CompanionCache()
        connection = .demo
    }

    func exitDemoMode() {
        epoch += 1
        demoCache = CompanionCache()
        liveCache = CompanionCache()
        connection = pairedRecord == nil ? .unpaired : .connecting
        if pairedRecord != nil {
            Task { await reconnect(quiet: false) }
        }
    }

    private func restoreSavedWorkspace() {
        guard let data = UserDefaults.standard.data(forKey: Self.recordStorageKey),
              let record = try? JSONDecoder().decode(PairedWorkspaceRecord.self, from: data)
        else {
            connection = .unpaired
            return
        }
        pairedRecord = record
        workspaceLabel = UserDefaults.standard.string(forKey: Self.labelStorageKey) ?? record.workspaceLabel
        connection = .connecting
    }

    // MARK: Pairing

    func startPairing(payload: String) {
        pairingError = nil
        notice = nil
        let qr: PairingQRPayload
        do {
            qr = try PairingQRPayload.parse(payload)
        } catch {
            pairingErrorTitle = "That code didn't work"
            pairingError = (error as? PairingPayloadError ?? .invalid("")).userMessage
            return
        }
        pairingTask?.cancel()
        let attempt = pairingGate.begin()
        let deviceName = UIDevice.current.name
        pairingTask = Task { await runPairing(qr: qr, deviceName: deviceName, attempt: attempt) }
    }

    /// One scan's pairing. Every callback (code ready, result, failure) checks that `attempt` still owns the pairing
    /// UI before publishing anything, so a late answer from an older scan can't overwrite a newer one.
    private func runPairing(qr: PairingQRPayload, deviceName: String, attempt: UInt64) async {
        do {
            let result = try await client.beginPairing(qr: qr, deviceName: deviceName) { code in
                await MainActor.run { [weak self] in
                    _ = self?.pairingGate.codeReady(code, attempt: attempt)
                }
            }
            // The Mac confirmed and now keeps this device: finish even if Cancel came in meanwhile (only a newer scan
            // takes over).
            guard pairingGate.mayComplete(attempt) else { return }
            try saveKeys([result.devicePsk, result.phoneNoisePriv, result.deviceRelayPriv])
            UserDefaults.standard.set(try JSONEncoder().encode(result.record), forKey: Self.recordStorageKey)
            UserDefaults.standard.removeObject(forKey: Self.labelStorageKey)

            // Release the pairing UI before the first suspension: a scan started during the awaits below owns it.
            pairingGate.end(attempt)
            pairingTask = nil
            epoch += 1
            pairedCount += 1
            cancelRetry()
            await client.disconnect()
            pairedRecord = result.record
            connectedPath = nil
            connectionProblem = nil
            workspaceLabel = result.record.workspaceLabel
            liveCache = CompanionCache()
            demoCache = CompanionCache()
            lastUpdated = nil
            connection = .connecting
            if await reconnect(quiet: false) { refreshTick += 1 }
        } catch {
            // Cancelled by the person, or replaced by a newer scan: that one owns the UI now.
            guard pairingGate.end(attempt) else { return }
            pairingTask = nil
            pairingErrorTitle = "Pairing didn't finish"
            if case CompanionConnectionError.unreachable(let message) = error {
                if await Self.localNetworkBlocked(qr.paths) {
                    localNetworkDenied = true
                    pairingError = Self.localNetworkMessage
                } else if message == CompanionRelayClient.noReachablePathMessage {
                    pairingError = message
                } else {
                    // Nothing reached the Mac (offline, DNS, the relay timed out): the code is still good.
                    pairingError = "Can't reach your Mac or the relay. Check this iPhone's connection."
                }
            } else {
                pairingError = CompanionPairingError.interrupted.userMessage
            }
        }
    }

    static let localNetworkMessage =
        "Allow Local Network for Toolroll so this iPhone can reach your Mac on your Wi-Fi: Settings → Toolroll → Local Network."

    /// True when one of `paths`' direct addresses is on this network and iOS blocks the app from it.
    private static func localNetworkBlocked(_ paths: [CompanionPath]) async -> Bool {
        for path in paths where path.kind == .direct {
            guard let url = URL(string: path.url), let host = url.host, let port = url.port,
                  LocalNetworkAccess.isLocal(host) else { continue }
            if await LocalNetworkAccess.isDenied(host: host, port: UInt16(clamping: port)) { return true }
        }
        return false
    }

    /// Stops the pairing UI and closes the pairing socket. The task itself isn't cancelled: if the Mac's
    /// `pair.confirmed` already arrived, the pairing still finishes (`CompanionPairingGate.mayComplete`).
    func cancelPairing() {
        guard pairing != .idle || pairingTask != nil else { return }
        pairingGate.cancel()
        pairingTask = nil
        let client = self.client
        Task { await client.cancelPairing() }
    }

    /// Writes all three transport secrets or none of them.
    private func saveKeys(_ values: [Data]) throws {
        do {
            for (account, value) in zip(Self.keyAccounts, values) {
                try CompanionKeychain.save(value, account: account)
            }
        } catch {
            Self.keyAccounts.forEach { CompanionKeychain.delete(account: $0) }
            throw error
        }
    }

    private func loadKeys() -> (psk: Data, noise: Data, relay: Data)? {
        let values = Self.keyAccounts.compactMap { CompanionKeychain.load(account: $0) }
        guard values.count == 3 else { return nil }
        return (values[0], values[1], values[2])
    }

    // MARK: Connection

    /// Makes sure a live session exists. Quiet: the status line doesn't change unless the attempt fails.
    @discardableResult
    func reconnect(quiet: Bool) async -> Bool {
        guard !isDemoMode, pairedRecord != nil else { return false }
        if await client.isConnected { return true }
        if let running = connectTask { return await running.value }
        let task = Task { await performConnect(quiet: quiet) }
        connectTask = task
        let ok = await task.value
        if connectTask == task { connectTask = nil }
        return ok
    }

    private func performConnect(quiet: Bool) async -> Bool {
        guard let record = pairedRecord else { return false }
        let started = epoch, startedConnect = connectEpoch
        guard let keys = loadKeys() else {
            // A restored backup (keys never leave this iPhone) or a wiped keychain: nothing to connect with.
            forgetPairing(notice: "This iPhone's pairing keys are missing — pair again.")
            return false
        }
        if !quiet, !isConnectedState {
            connection = .connecting
        }
        do {
            let result = try await client.connect(
                record: record, devicePsk: keys.psk, phoneNoisePriv: keys.noise, deviceRelayPriv: keys.relay
            )
            guard started == epoch, startedConnect == connectEpoch, pairedRecord == record, !isDemoMode else {
                await client.disconnect()
                return false
            }
            let hello = result.hello
            // The Mac's current addresses (from a hello that passed the identity checks) are where we dial next time.
            if result.record != record, let data = try? JSONEncoder().encode(result.record) {
                UserDefaults.standard.set(data, forKey: Self.recordStorageKey)
                pairedRecord = result.record
            }
            connectedPath = result.path
            connectionProblem = nil
            if result.path.kind == .direct { localNetworkDenied = false }
            cancelRetry()
            if let label = hello.workspaceLabel, !label.isEmpty {
                workspaceLabel = label
                UserDefaults.standard.set(label, forKey: Self.labelStorageKey)
            }
            connection = .connected(workspaceLabel: workspaceLabel, since: Date())
            return true
        } catch {
            guard started == epoch, startedConnect == connectEpoch, !isDemoMode, pairedRecord != nil else { return false }
            connectedPath = nil
            connectionProblem = nil
            if case CompanionConnectionError.unreachable(let message) = error,
               message == CompanionRelayClient.noReachablePathMessage {
                connectionProblem = message
            }
            if case CompanionConnectionError.handshakeFailed = error {
                connection = .notRecognized
                cancelRetry()
            } else {
                connection = .unreachable(lastUpdated: lastUpdated)
                let denied = await Self.localNetworkBlocked(record.paths)
                guard started == epoch, pairedRecord == record else { return false }
                localNetworkDenied = denied
                scheduleRetry()
            }
            return false
        }
    }

    // MARK: Automatic reconnect

    /// After a failed attempt while the app is in front: try again in 2, 5, 15, then every 30 seconds.
    private func scheduleRetry() {
        retryTask?.cancel()
        guard isActive, !isDemoMode, pairedRecord != nil, connection.isUnreachable else { return }
        let delay = Self.retryDelays[min(retryAttempt, Self.retryDelays.count - 1)]
        retryAttempt += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.autoReconnect()
        }
    }

    private func cancelRetry() {
        retryTask?.cancel()
        retryTask = nil
        retryAttempt = 0
    }

    /// One automatic attempt; a failure schedules the next (performConnect).
    private func autoReconnect() async {
        guard isActive, !isDemoMode, pairedRecord != nil, pairing == .idle else { return }
        isReconnecting = true
        let ok = await reconnect(quiet: true)
        isReconnecting = false
        if ok { refreshTick += 1 }
    }

    /// The network came back: if the Mac couldn't be reached, try now and restart the backoff.
    private func networkChanged(satisfied: Bool) {
        guard satisfied, isActive, connection.isUnreachable else { return }
        cancelRetry()
        Task { await autoReconnect() }
    }

    /// Fresh data while a screen is up: only when connected and in front (never dials on its own).
    var canAutoRefresh: Bool { isActive && isConnectedState && pairing == .idle }

    private var isConnectedState: Bool {
        if case .connected = connection { return true }
        return false
    }

    /// Retry from the status line: reconnect, then reload what's on screen.
    func retry() async {
        cancelRetry()
        if await reconnect(quiet: false) { refreshTick += 1 }
    }

    private func connectionDropped() async {
        guard isActive, !isDemoMode, pairedRecord != nil else { return }
        isReconnecting = true
        let ok = await reconnect(quiet: true)
        isReconnecting = false
        if ok { refreshTick += 1 }
    }

    func handleForeground() async {
        let wasActive = isActive
        isActive = true
        guard !wasActive, !isDemoMode, pairedRecord != nil, pairing == .idle else { return }
        cancelRetry()
        if await reconnect(quiet: true) { refreshTick += 1 }
    }

    /// Keep everything on screen; just close the socket. The next foreground reconnects quietly.
    func handleBackground() async {
        isActive = false
        cancelRetry()
        guard !isDemoMode, pairing == .idle else { return }
        // Reads in flight fail with `closed` and keep their last good state (see failurePhase). A connect still in
        // flight belongs to the old epoch: retire it, so foreground starts a fresh one instead of joining it.
        connectEpoch += 1
        connectTask = nil
        await client.disconnect()
    }

    // MARK: Fetching

    /// Runs one read against the current mode's source. A live read connects first and retries once if the
    /// session dropped mid-call.
    private func fetch<T: Sendable>(_ read: @escaping @Sendable (any CompanionDataSource) async throws -> T) async throws -> T {
        if isDemoMode { return try await read(demoSource) }
        guard await reconnect(quiet: true) else { throw OfflineError() }
        do {
            return try await read(liveSource)
        } catch CompanionConnectionError.closed {
            guard isActive, await reconnect(quiet: true) else { throw OfflineError() }
            return try await read(liveSource)
        }
    }

    private func noteSuccess() {
        guard !isDemoMode else { return }
        lastUpdated = Date()
        if !isConnectedState {
            connection = .connected(workspaceLabel: workspaceLabel, since: Date())
        }
    }

    /// A failure seen while backgrounded is the socket closing on purpose: keep the last good state.
    private func failurePhase<V>(_ error: Error, keeping existing: Loadable<V>) -> LoadPhase {
        if !isActive || error is CancellationError {
            return existing.value == nil ? .idle : .loaded
        }
        return .failed(loadFailureMessage(error))
    }

    /// `quiet`: a background refresh. The phase doesn't go to loading, and a failure keeps what's shown.
    func loadInbox(_ view: WorkView, quiet: Bool = false) async {
        let started = epoch, demo = isDemoMode
        if !quiet { cache.inbox[view, default: Loadable()].phase = .loading }
        do {
            let page = try await fetch { try await $0.workRows(view: view, cursor: nil) }
            guard started == epoch, demo == isDemoMode else { return }
            var c = cache
            c.inbox[view] = Loadable(
                value: InboxPage(rows: page.rows, otherNeeds: page.needs.flatMap(\.rows), next: page.next),
                phase: .loaded
            )
            c.needsCount = page.needsCount
            for row in page.rows { c.rows[row.id] = row }
            cache = c
            noteSuccess()
        } catch {
            guard started == epoch, demo == isDemoMode, !quiet else { return }
            let existing = cache.inbox[view] ?? Loadable()
            cache.inbox[view]?.phase = failurePhase(error, keeping: existing)
        }
    }

    /// The next page. Allowed after a failure too (the button stays live); its error shows next to the button.
    func loadMore(_ view: WorkView) async {
        guard let current = cache.inbox[view], current.phase != .loading,
              let page = current.value, let cursor = page.next
        else { return }
        let started = epoch, demo = isDemoMode
        cache.inbox[view]?.phase = .loading
        cache.inbox[view]?.value?.moreFailure = nil
        do {
            let next = try await fetch { try await $0.workRows(view: view, cursor: cursor) }
            guard started == epoch, demo == isDemoMode else { return }
            var c = cache
            var merged = page
            let seen = Set(merged.rows.map(\.id))
            merged.rows += next.rows.filter { !seen.contains($0.id) }
            merged.next = next.next
            merged.moreFailure = nil
            c.inbox[view] = Loadable(value: merged, phase: .loaded)
            c.needsCount = next.needsCount
            for row in next.rows { c.rows[row.id] = row }
            cache = c
            noteSuccess()
        } catch let error as CompanionRPCError where error.code == CompanionRPCError.invalidCursor {
            // The cursor expired: start over from page 1.
            guard started == epoch, demo == isDemoMode else { return }
            await loadInbox(view)
        } catch {
            guard started == epoch, demo == isDemoMode else { return }
            // The page stays as it was; the error belongs to the button.
            cache.inbox[view]?.phase = .loaded
            if isActive, !(error is CancellationError) {
                cache.inbox[view]?.value?.moreFailure = loadFailureMessage(error)
            }
        }
    }

    func loadTask(_ task: String, quiet: Bool = false) async {
        async let steps: Void = loadSteps(task, quiet: quiet)
        async let diff: Void = loadDiff(task, quiet: quiet)
        _ = await (steps, diff)
    }

    func loadSteps(_ task: String, quiet: Bool = false) async {
        let started = epoch, demo = isDemoMode
        if !quiet { cache.steps[task, default: Loadable()].phase = .loading }
        do {
            let steps = try await fetch { try await $0.taskSteps(task: task) }
            guard started == epoch, demo == isDemoMode else { return }
            cache.steps[task] = Loadable(value: steps, phase: .loaded)
            noteSuccess()
        } catch {
            guard started == epoch, demo == isDemoMode, !quiet else { return }
            let existing = cache.steps[task] ?? Loadable()
            cache.steps[task]?.phase = failurePhase(error, keeping: existing)
        }
    }

    func loadDiff(_ task: String, quiet: Bool = false) async {
        let started = epoch, demo = isDemoMode
        if !quiet { cache.diffs[task, default: Loadable()].phase = .loading }
        do {
            let diff = try await fetch { try await $0.taskDiff(task: task, run: nil) }
            guard started == epoch, demo == isDemoMode else { return }
            cache.diffs[task] = Loadable(value: diff, phase: .loaded)
            noteSuccess()
        } catch {
            guard started == epoch, demo == isDemoMode, !quiet else { return }
            let existing = cache.diffs[task] ?? Loadable()
            cache.diffs[task]?.phase = failurePhase(error, keeping: existing)
        }
    }

    func loadDiffFile(_ route: DiffRoute) async {
        let key = Self.fileKey(route)
        let started = epoch, demo = isDemoMode
        cache.diffFiles[key, default: Loadable()].phase = .loading
        do {
            let file = try await fetch { try await $0.taskDiffFile(task: route.task, run: route.run, file: route.file) }
            guard started == epoch, demo == isDemoMode else { return }
            cache.diffFiles[key] = Loadable(value: file, phase: .loaded)
            noteSuccess()
        } catch {
            guard started == epoch, demo == isDemoMode else { return }
            let existing = cache.diffFiles[key] ?? Loadable()
            cache.diffFiles[key]?.phase = failurePhase(error, keeping: existing)
        }
    }

    /// The run's recent records and a live stream after them. Ending the stream stops watching only. Opening it again
    /// (after the app comes back) starts from the run's latest window, so nothing is shown twice.
    func openWatch(run: Int) async throws -> (records: [LiveRecord], stream: AsyncThrowingStream<LiveRecord, Error>) {
        let window = try await fetch { try await $0.runWindow(run: run, cursor: nil) }
        let cursor = window.window.cursor
        let stream = try await fetch { try await $0.watchRun(run: run, cursor: cursor) }
        return (window.window.records ?? [], stream)
    }

    // MARK: Unpair

    private struct EmptyParams: Encodable, Sendable {}
    private struct RevokeResult: Decodable, Sendable {
        let ok: Bool?
        let revoked: Bool?
    }

    /// Removes this iPhone. Says "and your Mac" only if the Mac confirmed the revoke. The Mac gets about five seconds
    /// (connecting included); after that the iPhone forgets the pairing anyway and says to remove it on the Mac too.
    func unpairThisPhone() async {
        var revokedOnMac = false
        if !isDemoMode, pairedRecord != nil {
            let answer = FirstAnswer<Bool>()
            revokedOnMac = await withCheckedContinuation { continuation in
                answer.set(continuation)
                Task { @MainActor [weak self] in
                    guard let self, await self.reconnect(quiet: true) else { return answer.give(false) }
                    let result = try? await self.client.call(
                        "device.self.revoke", params: EmptyParams(), as: RevokeResult.self, timeout: .seconds(5)
                    )
                    answer.give(result?.revoked == true)
                }
                Task {
                    try? await Task.sleep(for: .seconds(5))
                    answer.give(false)
                }
            }
        }
        forgetPairing(notice: revokedOnMac
            ? "Removed from this iPhone and your Mac."
            : "Removed from this iPhone. Remove it on your Mac too: Settings → Phone.")
    }

    /// Drops the pairing from this iPhone (keys, record, caches) and returns to Welcome with `notice`.
    private func forgetPairing(notice message: String) {
        epoch += 1
        cancelPairing()
        cancelRetry()
        connectTask = nil
        let client = self.client
        Task { await client.disconnect() }
        Self.keyAccounts.forEach { CompanionKeychain.delete(account: $0) }
        CompanionKeychain.delete(account: "push.p256.priv", sharedAppGroup: true)
        CompanionKeychain.delete(account: "push.auth.secret", sharedAppGroup: true)
        UserDefaults.standard.removeObject(forKey: Self.recordStorageKey)
        UserDefaults.standard.removeObject(forKey: Self.labelStorageKey)
        pairedRecord = nil
        connectedPath = nil
        connectionProblem = nil
        localNetworkDenied = false
        liveCache = CompanionCache()
        demoCache = CompanionCache()
        lastUpdated = nil
        workspaceLabel = "Your Mac"
        connection = .unpaired
        notice = message
    }
}

// MARK: - Local Network access

/// iOS asks once before an app may reach devices on the local network. Asking from Welcome (before the camera
/// opens) keeps the prompt out of the pairing itself; a denied permission is detected and named instead of showing as
/// "Can't reach your Mac".
enum LocalNetworkAccess {
    nonisolated(unsafe) private static var promptBrowser: NWBrowser?
    private static let queue = DispatchQueue(label: "dev.toolroll.companion.local-network")

    /// A brief Bonjour browse for Toolroll (declared in NSBonjourServices): it finds nothing on its own and sends
    /// nothing, but it makes iOS show the Local Network prompt now. Once per launch.
    @MainActor
    static func requestPrompt() {
        guard promptBrowser == nil else { return }
        let browser = NWBrowser(for: .bonjour(type: "_toolroll._tcp", domain: nil), using: .tcp)
        promptBrowser = browser
        browser.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 30) { browser.cancel() }
    }

    /// A private (RFC 1918) address: the ones Local Network covers. Tailscale's 100.64/10 goes over its VPN instead.
    static func isLocal(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { UInt8($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168)
    }

    /// True when iOS refuses this app the local network on the way to `host` (the person turned it off).
    static func isDenied(host: String, port: UInt16) async -> Bool {
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else { return false }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: .tcp)
        let answer = FirstAnswer<Bool>()
        return await withCheckedContinuation { continuation in
            answer.set(continuation)
            connection.stateUpdateHandler = { state in
                switch state {
                case .waiting, .failed, .ready:
                    answer.give(connection.currentPath?.unsatisfiedReason == .localNetworkDenied)
                    connection.cancel()
                default:
                    break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 1.5) {
                answer.give(false)
                connection.cancel()
            }
        }
    }
}

/// Resumes a continuation once, with whichever answer comes first (a result or a deadline).
private final class FirstAnswer<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?

    func set(_ continuation: CheckedContinuation<Value, Never>) { lock.withLock { self.continuation = continuation } }

    func give(_ value: Value) {
        let pending: CheckedContinuation<Value, Never>? = lock.withLock {
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(returning: value)
    }
}
