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

/// Everything fetched in one mode. Demo and live each have their own; both are cleared on unpair / exit demo.
struct CompanionCache {
    var inbox: [WorkView: Loadable<InboxPage>] = [:]
    var needsCount: Int?
    var rows: [String: WorkRow] = [:]
    var steps: [String: Loadable<StepCards>] = [:]
    var diffs: [String: Loadable<ResultDiff>] = [:]
    var diffFiles: [String: Loadable<ResultDiffFile>] = [:]
    /// When each task was last opened (what the offline snapshot keeps).
    var opened: [String: Date] = [:]
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

/// Lets the relay client's callbacks reach the app state without keeping it alive.
private final class WeakOwner: @unchecked Sendable {
    weak var value: CompanionAppState?
    init(_ value: CompanionAppState) { self.value = value }
}

/// Whether the current network can reach a local Mac (Wi-Fi or Ethernet), read by the Bonjour discovery closure.
private final class LocalNetworkFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true
    var isLocal: Bool { lock.withLock { value } }
    func set(_ local: Bool) { lock.withLock { value = local } }
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
    /// The last time live data was fetched successfully (or when the offline snapshot was saved).
    private(set) var lastUpdated: Date?
    /// Bumped after a quiet reconnect so visible screens reload.
    private(set) var refreshTick = 0
    var pairingError: String?
    /// The title over `pairingError`: each way a pairing can end reads differently.
    private(set) var pairingErrorTitle = "Pairing didn't finish"
    /// The path the current session runs over (direct or hosted), for Settings.
    private(set) var connectedPath: CompanionPath?
    /// iOS blocks this app from the local network, so direct connections to the Mac can't work.
    private(set) var localNetworkDenied = false
    /// Automatic reconnects running now (after a drop, a failed attempt's backoff, or a network change).
    private var reconnecting = 0
    var isReconnecting: Bool { reconnecting > 0 }
    /// Bumped when a pairing completes (drives the success haptic).
    private(set) var pairedCount = 0
    /// One-off message for the Welcome screen (for example, how unpairing went).
    var notice: String?
    /// The Mac's console origin from the last hello (Handoff to the task page), or nil.
    private(set) var consoleUrl: String?
    /// "Name this iPhone": sent in `pair.ready`. Defaults to the marketing model name.
    var deviceName: String {
        didSet { UserDefaults.standard.set(deviceName, forKey: Self.deviceNameKey) }
    }
    /// A sheet or system prompt is up (the scanner, the camera or Local Network prompt): the privacy cover stays off
    /// while inactive, so it doesn't hide them.
    var presentingSystemUI = false

    /// The privacy cover stays off while inactive during a pairing or while a sheet/prompt is up.
    var suppressesPrivacyCover: Bool { presentingSystemUI || pairing != .idle }

    private var demoCache = CompanionCache()
    private var liveCache = CompanionCache()

    @ObservationIgnored private let client: CompanionRelayClient
    @ObservationIgnored private let demoSource = DemoCompanionSource()
    @ObservationIgnored private let liveSource: LiveCompanionSource
    @ObservationIgnored private let snapshots = CompanionSnapshotStore.standard()
    @ObservationIgnored private var snapshotTask: Task<Void, Never>?
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
    @ObservationIgnored private let localNetwork = LocalNetworkFlag()

    #if DEBUG
    /// DEBUG-only launch route for screenshots: `--screen task:<id>|diff:<task>:<file>|live:<task>|settings|scan|paste`.
    @ObservationIgnored var debugScreen: String?
    /// DEBUG-only: a `--debug-state` is on screen; nothing dials, reads come from the demo fixtures, nothing is saved.
    @ObservationIgnored private var debugFrozen = false
    #endif

    private var isDebugFrozen: Bool {
        #if DEBUG
        return debugFrozen
        #else
        return false
        #endif
    }

    private static let recordStorageKey = "paired.workspace.record.v1"
    private static let labelStorageKey = "paired.workspace.label.v1"
    private static let deviceNameKey = "device.name.v1"
    private static let keyAccounts = ["device.psk", "phone.noise.priv", "device.relay.priv"]

    init() {
        let flag = localNetwork
        client = CompanionRelayClient(discover: { machineId in
            // Browse only where a local Mac could be (Wi-Fi or Ethernet); on cellular go straight to the relay.
            guard flag.isLocal else { return [] }
            return await CompanionBonjour.discover(machineId: machineId)
        })
        liveSource = LiveCompanionSource(client: client)
        deviceName = UserDefaults.standard.string(forKey: Self.deviceNameKey)
            ?? CompanionDeviceName.defaultName(identifier: CompanionDeviceName.currentIdentifier(), fallback: UIDevice.current.model)
        let args = ProcessInfo.processInfo.arguments
        #if DEBUG
        if let i = args.firstIndex(of: "--screen"), i + 1 < args.count {
            debugScreen = args[i + 1]
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
        if let i = args.firstIndex(of: "--debug-state"), i + 1 < args.count {
            applyDebugState(args[i + 1])
        }
        #endif
        let client = self.client
        let owner = WeakOwner(self)
        Task {
            await client.setSessionEndHandler { end in
                Task { @MainActor in await owner.value?.sessionEnded(end) }
            }
        }
        pathMonitor.pathUpdateHandler = { path in
            let satisfied = path.status == .satisfied
            let local = path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
            flag.set(local)
            Task { @MainActor in owner.value?.networkChanged(satisfied: satisfied) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "dev.toolroll.companion.network-path"))
    }

    var isDemoMode: Bool { connection == .demo }
    var isPaired: Bool { pairedRecord != nil }

    /// Cached data is shown under a "Last updated" banner while the Mac can't be reached.
    var isOffline: Bool {
        switch connection {
        case .unreachable: return true
        default: return false
        }
    }

    /// Refused or damaged: the pairing can't be used; only Pair again / Remove from this iPhone.
    var isTerminal: Bool {
        switch connection {
        case .refused, .damaged: return true
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

    /// The Handoff URL for a task, when the Mac gave its console origin (never in the demo).
    func handoffURL(task: String) -> URL? {
        guard !isDemoMode else { return nil }
        return CompanionHandoff.taskURL(consoleUrl: consoleUrl, taskId: task)
    }

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
        if let record = pairedRecord {
            restoreSnapshot(for: record)
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
        restoreSnapshot(for: record)
    }

    // MARK: Offline snapshot (U11)

    /// What this pairing showed last time, under its "Last updated" time.
    private func restoreSnapshot(for record: PairedWorkspaceRecord) {
        guard let snapshot = snapshots.load(machineId: record.machineId, deviceId: record.deviceId) else { return }
        var c = CompanionCache()
        for (raw, page) in snapshot.inbox {
            guard let view = WorkView(rawValue: raw) else { continue }
            c.inbox[view] = Loadable(value: page, phase: .loaded)
            for row in page.rows { c.rows[row.id] = row }
        }
        c.needsCount = snapshot.needsCount
        for (task, entry) in snapshot.tasks {
            if let row = entry.row { c.rows[task] = row }
            if let steps = entry.steps { c.steps[task] = Loadable(value: steps, phase: .loaded) }
            if let diff = entry.diff { c.diffs[task] = Loadable(value: diff, phase: .loaded) }
            c.opened[task] = entry.openedAt
        }
        liveCache = c
        lastUpdated = snapshot.savedAt
        consoleUrl = snapshot.consoleUrl
        if UserDefaults.standard.string(forKey: Self.labelStorageKey) == nil { workspaceLabel = snapshot.workspaceLabel }
    }

    /// Saves the live cache a moment after the last successful read (coalesced).
    private func scheduleSnapshot() {
        guard !isDemoMode, !isDebugFrozen, let record = pairedRecord else { return }
        snapshotTask?.cancel()
        let started = epoch
        snapshotTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self, self.epoch == started, self.pairedRecord == record, !self.isDemoMode,
                  !self.isTerminal
            else { return }
            self.writeSnapshot(record: record)
        }
    }

    private func writeSnapshot(record: PairedWorkspaceRecord) {
        let c = liveCache
        var snapshot = CompanionSnapshot(
            machineId: record.machineId, deviceId: record.deviceId, savedAt: lastUpdated ?? Date(),
            workspaceLabel: workspaceLabel, consoleUrl: consoleUrl, needsCount: c.needsCount
        )
        for (view, loadable) in c.inbox {
            if let page = loadable.value { snapshot.inbox[view.rawValue] = page }
        }
        for (task, opened) in c.opened {
            snapshot.tasks[task] = .init(row: c.rows[task], steps: c.steps[task]?.value, diff: c.diffs[task]?.value, openedAt: opened)
        }
        snapshot.trimTasks()
        let store = snapshots
        Task.detached(priority: .utility) { try? store.save(snapshot) }
    }

    private func dropSnapshot() {
        guard !isDebugFrozen else { return }
        snapshotTask?.cancel()
        snapshotTask = nil
        snapshots.deleteAll()
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
        let name = CompanionDeviceName.sanitized(deviceName) ?? "iPhone"
        pairingTask = Task { await runPairing(qr: qr, deviceName: name, attempt: attempt) }
    }

    /// One scan's pairing. Every callback (code ready, keys stored, result, failure) checks that `attempt` still owns
    /// the pairing UI before publishing anything, so a late answer from an older scan can't overwrite a newer one.
    private func runPairing(qr: PairingQRPayload, deviceName: String, attempt: UInt64) async {
        let owner = WeakOwner(self)
        do {
            let completion = try await client.pair(
                qr: qr,
                deviceName: deviceName,
                onCodeReady: { code in
                    await MainActor.run { _ = owner.value?.pairingGate.codeReady(code, attempt: attempt) }
                },
                persist: { keys in
                    guard let state = owner.value else { throw CancellationError() }
                    try await state.storePairing(keys, attempt: attempt)
                }
            )
            guard pairingGate.mayComplete(attempt) else { return }
            pairingTask = nil
            let ok = await reconnect(quiet: false)
            // The final screen (the success haptic and Work) only once the Mac confirmed: `pair.done` answered, or the
            // first hello passed.
            if completion == .activated || ok { pairedCount += 1 }
            if ok { refreshTick += 1 }
            pairingGate.end(attempt)
        } catch {
            // Cancelled by the person, or replaced by a newer scan: that one owns the UI now.
            guard pairingGate.end(attempt) else { return }
            pairingTask = nil
            await showPairingFailure(error, paths: qr.paths)
        }
    }

    /// Stores a finished pairing's keys and record before `pair.done` goes out. Throws (so nothing is stored and the
    /// Mac's pending row expires) when a newer scan took over.
    private func storePairing(_ keys: CompanionPairingKeys, attempt: UInt64) throws {
        guard pairingGate.mayComplete(attempt) else { throw CancellationError() }
        try saveKeys([keys.devicePsk, keys.phoneNoisePriv, keys.deviceRelayPriv])
        UserDefaults.standard.set(try JSONEncoder().encode(keys.record), forKey: Self.recordStorageKey)
        UserDefaults.standard.removeObject(forKey: Self.labelStorageKey)
        dropSnapshot()
        pairingGate.finishing(attempt: attempt)
        epoch += 1
        cancelRetry()
        connectTask = nil
        let client = self.client
        Task { await client.disconnect() }
        pairedRecord = keys.record
        connectedPath = nil
        consoleUrl = nil
        workspaceLabel = keys.record.workspaceLabel
        liveCache = CompanionCache()
        demoCache = CompanionCache()
        lastUpdated = nil
        connection = .connecting
    }

    private func showPairingFailure(_ error: Error, paths: [CompanionPath]) async {
        switch error {
        case let pairing as CompanionPairingError:
            pairingErrorTitle = pairing.title
            pairingError = pairing.userMessage
        case CompanionConnectionError.unreachable(let hint):
            pairingErrorTitle = "Couldn't reach your Mac"
            if await Self.localNetworkBlocked(paths) {
                localNetworkDenied = true
                pairingError = Self.localNetworkMessage
            } else if hint == .generic {
                // Nothing reached the Mac (offline, DNS, the relay timed out): the code is still good.
                pairingError = "Can't reach your Mac or the relay. Check this iPhone's connection, then scan again."
            } else {
                pairingError = CompanionConnectionPolicy.hintMessage(hint)
            }
        case is CompanionNoiseError, is PairingPayloadError:
            pairingErrorTitle = "That code didn't work"
            pairingError = PairingPayloadError.invalid("").userMessage
        default:
            pairingErrorTitle = "Pairing didn't finish"
            pairingError = "This iPhone couldn't save the pairing keys. Start again on your Mac."
        }
    }

    static let localNetworkMessage =
        "Allow Local Network for Toolroll so this iPhone can reach your Mac on your Wi-Fi: Settings → Toolroll → Local Network."

    /// True when one of `paths`' direct addresses is on this network and iOS blocks the app from it. The probes run in
    /// parallel, and only for addresses Local Network covers.
    private static func localNetworkBlocked(_ paths: [CompanionPath]) async -> Bool {
        let targets: [(String, UInt16)] = paths.compactMap { path in
            guard path.kind == .direct, let url = URL(string: path.url), let host = url.host, let port = url.port,
                  LocalNetworkAccess.isLocal(host) else { return nil }
            return (host, UInt16(clamping: port))
        }
        guard !targets.isEmpty else { return false }
        return await withTaskGroup(of: Bool.self) { group in
            for (host, port) in targets {
                group.addTask { await LocalNetworkAccess.isDenied(host: host, port: port) }
            }
            for await denied in group where denied {
                group.cancelAll()
                return true
            }
            return false
        }
    }

    /// Stops the pairing UI and closes the pairing socket. The task itself isn't cancelled: if the Mac's answer to
    /// `pair.ready` already arrived, the pairing still finishes (`CompanionPairingGate.mayComplete`).
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

    // MARK: Connection

    /// Makes sure a live session exists. Quiet: the status line doesn't change unless the attempt fails.
    @discardableResult
    func reconnect(quiet: Bool) async -> Bool {
        if isDebugFrozen { return connection == .connected }
        guard !isDemoMode, pairedRecord != nil, !isTerminal else { return false }
        // A connect in flight is joined first: `isConnected` turns true only once its hello passed.
        if let running = connectTask { return await running.value }
        if await client.isConnected { return true }
        let task = Task { await performConnect(quiet: quiet) }
        connectTask = task
        let ok = await task.value
        if connectTask == task { connectTask = nil }
        return ok
    }

    private func performConnect(quiet: Bool) async -> Bool {
        guard let record = pairedRecord else { return false }
        let started = epoch, startedConnect = connectEpoch
        // Keys are readable only after the first unlock: until then, wait (never treat it as missing).
        guard UIApplication.shared.isProtectedDataAvailable else {
            connection = .unreachable(hint: .keychainUnavailable)
            scheduleRetry()
            return false
        }
        let keys: [Data]
        switch CompanionKeychain.load(accounts: Self.keyAccounts) {
        case .present(let values):
            keys = values
        case .missing:
            // A restored backup (keys never leave this iPhone) or a wiped keychain: nothing to connect with.
            forgetPairing(notice: "This iPhone's pairing keys are missing — pair again.")
            return false
        case .partial:
            becomeTerminal(.damaged)
            return false
        case .unavailable:
            connection = .unreachable(hint: .keychainUnavailable)
            scheduleRetry()
            return false
        }
        if !quiet, !isConnectedState {
            connection = .connecting
        }
        do {
            let result = try await client.connect(record: record, devicePsk: keys[0], phoneNoisePriv: keys[1], deviceRelayPriv: keys[2])
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
            if result.path.kind == .direct { localNetworkDenied = false }
            cancelRetry()
            if let label = hello.workspaceLabel, !label.isEmpty {
                workspaceLabel = label
                UserDefaults.standard.set(label, forKey: Self.labelStorageKey)
            }
            consoleUrl = hello.consoleUrl
            connection = .connected
            return true
        } catch {
            guard started == epoch, startedConnect == connectEpoch, !isDemoMode, pairedRecord == record else { return false }
            connectedPath = nil
            switch CompanionConnectionPolicy.verdict(for: error) {
            case .superseded:
                return false
            case .refused(let reason):
                becomeTerminal(.refused(reason: reason))
            case .damaged:
                becomeTerminal(.damaged)
            case .unreachable(let hint):
                connection = .unreachable(hint: hint)
                if hint == .generic || hint == .noPath {
                    let denied = await Self.localNetworkBlocked(record.paths)
                    guard started == epoch, pairedRecord == record else { return false }
                    localNetworkDenied = denied
                }
                scheduleRetry()
            }
            return false
        }
    }

    /// Refused or damaged: no retries, nothing of this pairing's data stays on screen or on disk.
    private func becomeTerminal(_ state: CompanionConnectionState) {
        cancelRetry()
        connectTask = nil
        connectedPath = nil
        dropSnapshot()
        liveCache = CompanionCache()
        lastUpdated = nil
        connection = state
        let client = self.client
        Task { await client.disconnect() }
    }

    // MARK: Automatic reconnect

    /// After a failed attempt while the app is in front: try again in 2, 5, 15, then every 30 seconds.
    private func scheduleRetry() {
        retryTask?.cancel()
        guard isActive, !isDemoMode, pairedRecord != nil, connection.isUnreachable else { return }
        let delay = CompanionConnectionPolicy.retryDelay(attempt: retryAttempt)
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

    /// One automatic attempt; a failure schedules the next (performConnect). While a pairing runs, try again later
    /// instead of letting the chain die (C5).
    private func autoReconnect() async {
        guard isActive, !isDemoMode, pairedRecord != nil, !isTerminal else { return }
        guard pairing == .idle else {
            scheduleRetry()
            return
        }
        reconnecting += 1
        let ok = await reconnect(quiet: true)
        reconnecting -= 1
        if ok { refreshTick += 1 }
    }

    /// The network changed: a live session is checked at once (A6); a Mac that couldn't be reached is tried now.
    private func networkChanged(satisfied: Bool) {
        guard satisfied, isActive, !isDemoMode, pairedRecord != nil else { return }
        if isConnectedState {
            let client = self.client
            Task { await client.checkAlive() }
        } else if connection.isUnreachable {
            cancelRetry()
            Task { await autoReconnect() }
        }
    }

    /// Fresh data while a screen is up: only when connected and in front (never dials on its own).
    var canAutoRefresh: Bool { isActive && isConnectedState && pairing == .idle }

    private var isConnectedState: Bool { connection == .connected }

    /// Retry from the status line: reconnect, then reload what's on screen.
    func retry() async {
        cancelRetry()
        if await reconnect(quiet: false) { refreshTick += 1 }
    }

    private func sessionEnded(_ end: CompanionSessionEnd) async {
        guard !isDemoMode, pairedRecord != nil else { return }
        switch end {
        case .refused(let reason):
            becomeTerminal(.refused(reason: reason))
        case .rekey:
            // The Mac's session limit: reconnect straight away, with no "Reconnecting…".
            guard isActive else { return }
            if await reconnect(quiet: true) { refreshTick += 1 }
        case .lost:
            guard isActive else { return }
            reconnecting += 1
            let ok = await reconnect(quiet: true)
            reconnecting -= 1
            if ok { refreshTick += 1 }
        }
    }

    func handleForeground() async {
        let wasActive = isActive
        isActive = true
        guard !wasActive, !isDemoMode, pairedRecord != nil, pairing == .idle, !isTerminal else { return }
        cancelRetry()
        if await client.isConnected {
            await client.checkAlive()
            return
        }
        if await reconnect(quiet: true) { refreshTick += 1 }
    }

    /// Keep everything on screen; just close the socket. The next foreground reconnects quietly.
    func handleBackground() async {
        isActive = false
        cancelRetry()
        if let record = pairedRecord, !isDemoMode, !isTerminal, !isDebugFrozen { writeSnapshot(record: record) }
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
        if isDemoMode || isDebugFrozen { return try await read(demoSource) }
        guard await reconnect(quiet: true) else { throw OfflineError() }
        do {
            return try await read(liveSource)
        } catch CompanionConnectionError.closed {
            guard isActive, await reconnect(quiet: true) else { throw OfflineError() }
            return try await read(liveSource)
        }
    }

    private func noteSuccess() {
        guard !isDemoMode, !isDebugFrozen else { return }
        lastUpdated = Date()
        scheduleSnapshot()
    }

    /// A failure seen while backgrounded is the socket closing on purpose: keep the last good state.
    private func failurePhase<V>(_ error: Error, keeping existing: Loadable<V>) -> LoadPhase {
        if !isActive || error is CancellationError {
            return existing.value == nil ? .idle : .loaded
        }
        return .failed(loadFailureMessage(error))
    }

    /// `quiet`: a background refresh. The phase doesn't go to loading, and a failure keeps what's shown. A refresh
    /// with more than page 1 loaded keeps the loaded tail (C2).
    func loadInbox(_ view: WorkView, quiet: Bool = false) async {
        let started = epoch, demo = isDemoMode
        if !quiet { cache.inbox[view, default: Loadable()].phase = .loading }
        do {
            let page = try await fetch { try await $0.workRows(view: view, cursor: nil) }
            guard started == epoch, demo == isDemoMode else { return }
            var c = cache
            c.inbox[view] = Loadable(value: InboxMerge.refreshed(current: c.inbox[view]?.value, firstPage: page), phase: .loaded)
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

    /// The next page. Allowed after a failure too (the button stays live); its error shows next to the button. The
    /// page joins what's on screen after the await; a refresh that landed meanwhile wins (C2).
    func loadMore(_ view: WorkView) async {
        guard let current = cache.inbox[view], current.phase != .loading,
              let cursor = current.value?.next
        else { return }
        let started = epoch, demo = isDemoMode
        cache.inbox[view]?.phase = .loading
        cache.inbox[view]?.value?.moreFailure = nil
        do {
            let next = try await fetch { try await $0.workRows(view: view, cursor: cursor) }
            guard started == epoch, demo == isDemoMode else { return }
            var c = cache
            guard let merged = InboxMerge.appended(current: c.inbox[view]?.value, cursor: cursor, page: next) else {
                c.inbox[view]?.phase = .loaded
                cache = c
                return
            }
            c.inbox[view] = Loadable(value: merged, phase: .loaded)
            c.needsCount = next.needsCount
            for row in next.rows { c.rows[row.id] = row }
            cache = c
            noteSuccess()
        } catch let error as CompanionRPCError where error.code == CompanionRPCError.invalidCursor {
            // The cursor expired: start over from page 1.
            guard started == epoch, demo == isDemoMode else { return }
            cache.inbox[view] = Loadable(value: nil, phase: .loading)
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
        if !isDemoMode { cache.opened[task] = Date() }
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
        return ((window.window.records ?? []).filter { $0.kind != .other }, stream)
    }

    // MARK: Unpair

    private struct EmptyParams: Encodable, Sendable {}
    private struct RevokeResult: Decodable, Sendable {
        let ok: Bool?
        let revoked: Bool?
    }

    /// Removes this iPhone. Says "and your Mac" only if the Mac confirmed the revoke. The Mac gets about five seconds
    /// (connecting included); after that the iPhone forgets the pairing anyway and says to remove it on the Mac too. A
    /// pairing the Mac already removed (or that is damaged) is only removed here (U10).
    func unpairThisPhone() async {
        if isTerminal {
            forgetPairing(notice: "Removed from this iPhone.")
            return
        }
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

    /// Drops the pairing from this iPhone (keys, record, snapshot, caches) and returns to Welcome with `notice`.
    private func forgetPairing(notice message: String) {
        epoch += 1
        cancelPairing()
        cancelRetry()
        connectTask = nil
        let client = self.client
        Task { await client.disconnect() }
        Self.keyAccounts.forEach { CompanionKeychain.delete(account: $0) }
        UserDefaults.standard.removeObject(forKey: Self.recordStorageKey)
        UserDefaults.standard.removeObject(forKey: Self.labelStorageKey)
        dropSnapshot()
        pairedRecord = nil
        connectedPath = nil
        consoleUrl = nil
        localNetworkDenied = false
        liveCache = CompanionCache()
        demoCache = CompanionCache()
        lastUpdated = nil
        workspaceLabel = "Your Mac"
        connection = .unpaired
        notice = message
    }

    // MARK: DEBUG screenshot states

    #if DEBUG
    /// DEBUG only: `--debug-state refused|refused-account|damaged|unreachable:<hint>|pairing-code|pairing-finishing|
    /// pairing-error:<cancelled|expired|contested|failed|interrupted>`. Fills the live cache from the demo fixtures so
    /// each state renders as it would with real data. Never in release builds.
    private func applyDebugState(_ state: String) {
        let record = PairedWorkspaceRecord(
            workspaceId: "ws-debug", workspaceLabel: "Studio Mac", machineId: "m-debug",
            paths: [CompanionPath(kind: .direct, url: "ws://192.168.1.20:4199/v1/direct")],
            macStaticPubBase64Url: CompanionRelayAuth.base64UrlEncode(Data(repeating: 9, count: 32)),
            deviceId: "dev-debug", recoveryGeneration: String(repeating: "0", count: 32), pairedAt: Date()
        )
        let parts = state.split(separator: ":").map(String.init)
        func useRecord() {
            epoch += 1
            pairedRecord = record
            workspaceLabel = "Studio Mac"
            consoleUrl = "http://127.0.0.1:4180"
            if let rows = try? CompanionDemoFixtures.workRows() {
                let needs = rows.rows.filter { $0.rank == 0 }
                liveCache.inbox[.needsYou] = Loadable(value: InboxPage(rows: needs, otherNeeds: rows.needs.flatMap(\.rows), next: nil), phase: .loaded)
                liveCache.inbox[.all] = Loadable(value: InboxPage(rows: rows.rows, otherNeeds: [], next: nil), phase: .loaded)
                liveCache.needsCount = rows.needsCount
                for row in rows.rows { liveCache.rows[row.id] = row }
                for row in rows.rows {
                    if let steps = try? CompanionDemoFixtures.steps(task: row.id) { liveCache.steps[row.id] = Loadable(value: steps, phase: .loaded) }
                    if let diff = try? CompanionDemoFixtures.diff(task: row.id) { liveCache.diffs[row.id] = Loadable(value: diff, phase: .loaded) }
                }
            }
            lastUpdated = Date().addingTimeInterval(-3600)
        }
        switch parts.first {
        case "refused":
            useRecord()
            connection = .refused(reason: "device_revoked")
        case "refused-account":
            useRecord()
            connection = .refused(reason: "account_revoked")
        case "damaged":
            useRecord()
            connection = .damaged
        case "unreachable":
            useRecord()
            let hints: [String: CompanionUnreachableHint] = [
                "generic": .generic, "different": .differentMachine, "offline": .macOffline, "clock": .clockSkew,
                "nopath": .noPath, "keychain": .keychainUnavailable,
            ]
            connection = .unreachable(hint: hints[parts.count > 1 ? parts[1] : "generic"] ?? .generic)
        case "connected":
            useRecord()
            lastUpdated = Date()
            connection = .connected
        case "pairing-code":
            _ = pairingGate.begin()
            _ = pairingGate.codeReady("HFX-2B0", attempt: pairingGate.current)
        case "pairing-contacting":
            _ = pairingGate.begin()
        case "pairing-finishing":
            let attempt = pairingGate.begin()
            _ = pairingGate.finishing(attempt: attempt)
        case "pairing-error":
            let kinds: [String: CompanionPairingError] = [
                "cancelled": .cancelled, "expired": .expired, "contested": .contested, "failed": .failed, "interrupted": .interrupted,
            ]
            let error = kinds[parts.count > 1 ? parts[1] : "failed"] ?? .failed
            pairingErrorTitle = error.title
            pairingError = error.userMessage
        default:
            break
        }
        // Keep the debug state: no live dialing, no keychain reads, no snapshot writes behind it.
        debugFrozen = true
    }
    #endif
}

// MARK: - Local Network access

/// iOS asks once before an app may reach devices on the local network. Asking from Welcome (before the camera
/// opens) keeps the prompt out of the pairing itself; a denied permission is detected and named instead of showing as
/// "Can't reach your Mac".
enum LocalNetworkAccess {
    nonisolated(unsafe) private static var promptBrowser: NWBrowser?
    private static let queue = DispatchQueue(label: "dev.toolroll.companion.local-network")

    /// A brief Bonjour browse for Toolroll (declared in NSBonjourServices): it sends nothing, but it makes iOS show the
    /// Local Network prompt now. Once per launch.
    @MainActor
    static func requestPrompt() {
        guard promptBrowser == nil else { return }
        let browser = NWBrowser(for: .bonjour(type: CompanionWire.bonjourService, domain: nil), using: .tcp)
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
