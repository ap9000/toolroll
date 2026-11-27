import Foundation
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
    private(set) var pairing: CompanionPairingPhase = .idle
    private(set) var pairedRecord: PairedWorkspaceRecord?
    private(set) var workspaceLabel: String = "Your Mac"
    /// The last time live data was fetched successfully.
    private(set) var lastUpdated: Date?
    /// Bumped after a quiet reconnect so visible screens reload.
    private(set) var refreshTick = 0
    var pairingError: String?
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
    @ObservationIgnored private var isActive = true

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
    }

    #if DEBUG
    /// DEBUG only: a pairing whose relay is a closed localhost port, to exercise the offline path.
    private static func installUnreachablePairingForDebug() {
        func random(_ n: Int) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }
        let record = PairedWorkspaceRecord(
            workspaceId: "ws-debug", workspaceLabel: "Studio Mac", machineId: "m-debug",
            relayUrl: "ws://127.0.0.1:9/v1/connect",
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

    /// Cached rows are shown dimmed while the Mac can't be reached.
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
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let qr = try? JSONDecoder().decode(PairingQRPayload.self, from: Data(trimmed.utf8)), qr.v == 1 else {
            pairingError = "That isn't a Toolroll pairing code. On your Mac, open Settings → Phone → Pair an iPhone for a new one."
            return
        }
        pairingTask?.cancel()
        pairing = .contacting
        let deviceName = UIDevice.current.name
        pairingTask = Task { await runPairing(qr: qr, deviceName: deviceName) }
    }

    private func runPairing(qr: PairingQRPayload, deviceName: String) async {
        do {
            let result = try await client.beginPairing(qr: qr, deviceName: deviceName) { code in
                await MainActor.run { [weak self] in
                    guard let self, self.pairing != .idle else { return }
                    self.pairing = .awaitingMacConfirm(code: code)
                }
            }
            guard pairing != .idle, !Task.isCancelled else { return }
            try saveKeys([result.devicePsk, result.phoneNoisePriv, result.deviceRelayPriv])
            UserDefaults.standard.set(try JSONEncoder().encode(result.record), forKey: Self.recordStorageKey)
            UserDefaults.standard.removeObject(forKey: Self.labelStorageKey)

            epoch += 1
            await client.disconnect()
            pairedRecord = result.record
            workspaceLabel = result.record.workspaceLabel
            liveCache = CompanionCache()
            demoCache = CompanionCache()
            lastUpdated = nil
            pairing = .idle
            pairingTask = nil
            connection = .connecting
            if await reconnect(quiet: false) { refreshTick += 1 }
        } catch {
            guard pairing != .idle else { return } // cancelled by the person
            pairing = .idle
            pairingTask = nil
            pairingError = "Pairing didn't finish. On your Mac, start pairing again for a new code."
        }
    }

    func cancelPairing() {
        guard pairing != .idle || pairingTask != nil else { return }
        pairing = .idle
        pairingTask?.cancel()
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
            connection = .notRecognized
            return false
        }
        if !quiet, !isConnectedState {
            connection = .connecting
        }
        do {
            let hello = try await client.connect(
                record: record, devicePsk: keys.psk, phoneNoisePriv: keys.noise, deviceRelayPriv: keys.relay
            )
            guard started == epoch, startedConnect == connectEpoch, pairedRecord == record, !isDemoMode else {
                await client.disconnect()
                return false
            }
            if let label = hello.workspaceLabel, !label.isEmpty {
                workspaceLabel = label
                UserDefaults.standard.set(label, forKey: Self.labelStorageKey)
            }
            connection = .connected(workspaceLabel: workspaceLabel, since: Date())
            return true
        } catch {
            guard started == epoch, startedConnect == connectEpoch, !isDemoMode, pairedRecord != nil else { return false }
            if case CompanionConnectionError.handshakeFailed = error {
                connection = .notRecognized
            } else {
                connection = .unreachable(lastUpdated: lastUpdated)
            }
            return false
        }
    }

    private var isConnectedState: Bool {
        if case .connected = connection { return true }
        return false
    }

    /// Retry from the status line: reconnect, then reload what's on screen.
    func retry() async {
        if await reconnect(quiet: false) { refreshTick += 1 }
    }

    private func connectionDropped() async {
        guard isActive, !isDemoMode, pairedRecord != nil else { return }
        if await reconnect(quiet: true) { refreshTick += 1 }
    }

    func handleForeground() async {
        let wasActive = isActive
        isActive = true
        guard !wasActive, !isDemoMode, pairedRecord != nil, pairing == .idle else { return }
        if await reconnect(quiet: true) { refreshTick += 1 }
    }

    /// Keep everything on screen; just close the socket. The next foreground reconnects quietly.
    func handleBackground() async {
        isActive = false
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

    func loadInbox(_ view: WorkView) async {
        let started = epoch, demo = isDemoMode
        cache.inbox[view, default: Loadable()].phase = .loading
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
            guard started == epoch, demo == isDemoMode else { return }
            let existing = cache.inbox[view] ?? Loadable()
            cache.inbox[view]?.phase = failurePhase(error, keeping: existing)
        }
    }

    func loadMore(_ view: WorkView) async {
        guard let current = cache.inbox[view], current.phase == .loaded,
              let page = current.value, let cursor = page.next
        else { return }
        let started = epoch, demo = isDemoMode
        cache.inbox[view]?.phase = .loading
        do {
            let next = try await fetch { try await $0.workRows(view: view, cursor: cursor) }
            guard started == epoch, demo == isDemoMode else { return }
            var c = cache
            var merged = page
            let seen = Set(merged.rows.map(\.id))
            merged.rows += next.rows.filter { !seen.contains($0.id) }
            merged.next = next.next
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
            cache.inbox[view]?.phase = failurePhase(error, keeping: current)
        }
    }

    func loadTask(_ task: String) async {
        async let steps: Void = loadSteps(task)
        async let diff: Void = loadDiff(task)
        _ = await (steps, diff)
    }

    func loadSteps(_ task: String) async {
        let started = epoch, demo = isDemoMode
        cache.steps[task, default: Loadable()].phase = .loading
        do {
            let steps = try await fetch { try await $0.taskSteps(task: task) }
            guard started == epoch, demo == isDemoMode else { return }
            cache.steps[task] = Loadable(value: steps, phase: .loaded)
            noteSuccess()
        } catch {
            guard started == epoch, demo == isDemoMode else { return }
            let existing = cache.steps[task] ?? Loadable()
            cache.steps[task]?.phase = failurePhase(error, keeping: existing)
        }
    }

    func loadDiff(_ task: String) async {
        let started = epoch, demo = isDemoMode
        cache.diffs[task, default: Loadable()].phase = .loading
        do {
            let diff = try await fetch { try await $0.taskDiff(task: task, run: nil) }
            guard started == epoch, demo == isDemoMode else { return }
            cache.diffs[task] = Loadable(value: diff, phase: .loaded)
            noteSuccess()
        } catch {
            guard started == epoch, demo == isDemoMode else { return }
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

    /// The run's recent records and a live stream after them. Ending the stream stops watching only.
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

    /// Removes this iPhone. Says "and your Mac" only if the Mac confirmed the revoke.
    func unpairThisPhone() async {
        var revokedOnMac = false
        if !isDemoMode, pairedRecord != nil, await reconnect(quiet: true) {
            if let result = try? await client.call("device.self.revoke", params: EmptyParams(), as: RevokeResult.self) {
                revokedOnMac = result.revoked == true
            }
        }
        epoch += 1
        cancelPairing()
        await client.disconnect()
        Self.keyAccounts.forEach { CompanionKeychain.delete(account: $0) }
        CompanionKeychain.delete(account: "push.p256.priv", sharedAppGroup: true)
        CompanionKeychain.delete(account: "push.auth.secret", sharedAppGroup: true)
        UserDefaults.standard.removeObject(forKey: Self.recordStorageKey)
        UserDefaults.standard.removeObject(forKey: Self.labelStorageKey)
        pairedRecord = nil
        liveCache = CompanionCache()
        demoCache = CompanionCache()
        lastUpdated = nil
        workspaceLabel = "Your Mac"
        connection = .unpaired
        notice = revokedOnMac
            ? "Removed from this iPhone and your Mac."
            : "Removed from this iPhone. Remove it on your Mac too: Settings → Phone."
    }
}
