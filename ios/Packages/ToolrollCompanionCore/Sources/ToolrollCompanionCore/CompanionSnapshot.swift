import CryptoKit
import Foundation

/// What the phone last saw, kept on disk so a cold launch away from the Mac still shows it under "Last updated" (U11).
/// Keyed by the pairing (machineId + deviceId): a snapshot from another pairing is never shown.
public struct CompanionSnapshot: Codable, Equatable, Sendable {
    public static let version = 1
    /// At most this many opened tasks are kept (the newest).
    public static let maxTasks = 8

    public struct TaskEntry: Codable, Equatable, Sendable {
        public var row: WorkRow?
        public var steps: StepCards?
        public var diff: ResultDiff?
        public var openedAt: Date

        public init(row: WorkRow?, steps: StepCards?, diff: ResultDiff?, openedAt: Date) {
            self.row = row
            self.steps = steps
            self.diff = diff
            self.openedAt = openedAt
        }
    }

    public var v: Int
    public var machineId: String
    public var deviceId: String
    public var savedAt: Date
    public var workspaceLabel: String
    public var consoleUrl: String?
    public var needsCount: Int?
    /// Work views by their server name (`needs-you`, `all`, …), page 1 and anything loaded after it.
    public var inbox: [String: InboxPage]
    public var tasks: [String: TaskEntry]

    public init(
        machineId: String, deviceId: String, savedAt: Date, workspaceLabel: String, consoleUrl: String? = nil,
        needsCount: Int? = nil, inbox: [String: InboxPage] = [:], tasks: [String: TaskEntry] = [:]
    ) {
        self.v = Self.version
        self.machineId = machineId
        self.deviceId = deviceId
        self.savedAt = savedAt
        self.workspaceLabel = workspaceLabel
        self.consoleUrl = consoleUrl
        self.needsCount = needsCount
        self.inbox = inbox
        self.tasks = tasks
    }

    /// Keeps the newest `maxTasks` opened tasks.
    public mutating func trimTasks() {
        guard tasks.count > Self.maxTasks else { return }
        let keep = tasks.sorted { $0.value.openedAt > $1.value.openedAt }.prefix(Self.maxTasks).map(\.key)
        tasks = tasks.filter { keep.contains($0.key) }
    }
}

/// One snapshot file per pairing in Application Support, written atomically with complete file protection (unreadable
/// while the iPhone is locked), excluded from backups. `deleteAll()` runs on remove, refused, damaged and pair again.
public struct CompanionSnapshotStore: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// `<Application Support>/CompanionSnapshot`.
    public static func standard() -> CompanionSnapshotStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return CompanionSnapshotStore(directory: base.appendingPathComponent("CompanionSnapshot", isDirectory: true))
    }

    static func fileName(machineId: String, deviceId: String) -> String {
        let digest = SHA256.hash(data: Data("\(machineId)\u{0}\(deviceId)".utf8))
        return "snapshot-" + digest.prefix(12).map { String(format: "%02x", $0) }.joined() + ".json"
    }

    private func url(machineId: String, deviceId: String) -> URL {
        directory.appendingPathComponent(Self.fileName(machineId: machineId, deviceId: deviceId))
    }

    public func save(_ snapshot: CompanionSnapshot) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let data = try encoder.encode(snapshot)
        var target = url(machineId: snapshot.machineId, deviceId: snapshot.deviceId)
        #if os(iOS)
        try data.write(to: target, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: target, options: [.atomic])
        #endif
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }

    /// The pairing's snapshot, or nil (none, unreadable, another pairing's, another version).
    public func load(machineId: String, deviceId: String) -> CompanionSnapshot? {
        guard let data = try? Data(contentsOf: url(machineId: machineId, deviceId: deviceId)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        guard let snapshot = try? decoder.decode(CompanionSnapshot.self, from: data),
              snapshot.v == CompanionSnapshot.version,
              snapshot.machineId == machineId, snapshot.deviceId == deviceId
        else { return nil }
        return snapshot
    }

    /// Removes every snapshot (any pairing).
    public func deleteAll() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where name.hasPrefix("snapshot-") {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}

// MARK: - Handoff

public enum CompanionHandoff {
    /// `consoleUrl` + `/t/<taskId>` for Handoff (U12), only for a plain http(s) origin with no path, credentials, query
    /// or fragment, and a task id of safe characters.
    public static func taskURL(consoleUrl: String?, taskId: String) -> URL? {
        guard let consoleUrl, consoleUrl.utf8.count <= 200,
              let base = URLComponents(string: consoleUrl),
              let scheme = base.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = base.host, !host.isEmpty,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              base.path.isEmpty || base.path == "/",
              taskId.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil
        else { return nil }
        var c = URLComponents()
        c.scheme = scheme
        c.host = host
        c.port = base.port
        c.path = "/t/\(taskId)"
        return c.url
    }
}
