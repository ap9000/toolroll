import Foundation

public enum AgentRequestKind: String, Codable, Sendable {
    case network
    case worktreeSetup = "worktree-setup"
    case liveView = "live-view"
}

public enum AgentRequestStatus: String, Codable, Sendable {
    case pending
    case approved
    case declined
}

public struct AgentRequestParams: Codable, Equatable, Sendable {
    public var local: String?
    public var mode: String?
    public var hosts: [String]?
    public var command: String?
    public var timeoutSeconds: Int?
    public var showCommands: Bool?

    public init(
        local: String? = nil,
        mode: String? = nil,
        hosts: [String]? = nil,
        command: String? = nil,
        timeoutSeconds: Int? = nil,
        showCommands: Bool? = nil
    ) {
        self.local = local
        self.mode = mode
        self.hosts = hosts
        self.command = command
        self.timeoutSeconds = timeoutSeconds
        self.showCommands = showCommands
    }
}

public struct AgentRequest: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: AgentRequestKind
    public let repo: String
    public let projectName: String
    public let requester: String
    public let summary: String
    public let why: String
    public let params: AgentRequestParams
    public var status: AgentRequestStatus
    public let createdAt: String
    public var resolvedAt: String?
    public var resolutionNote: String?

    public init(
        id: String,
        kind: AgentRequestKind,
        repo: String,
        projectName: String,
        requester: String,
        summary: String,
        why: String,
        params: AgentRequestParams,
        status: AgentRequestStatus = .pending,
        createdAt: String = ISO8601DateFormatter().string(from: Date()),
        resolvedAt: String? = nil,
        resolutionNote: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.repo = repo
        self.projectName = projectName
        self.requester = requester
        self.summary = summary
        self.why = why
        self.params = params
        self.status = status
        self.createdAt = createdAt
        self.resolvedAt = resolvedAt
        self.resolutionNote = resolutionNote
    }
}

/// Reads and resolves pending agent requests stored in `<stateDir>/.toolroll-run/agent-requests.json`
/// (the exact folder already fenced from sandboxed builds in `src/agent-fence.ts`).
public enum AgentRequestStore {
    private struct FileEnvelope: Codable {
        var version: Int = 1
        var requests: [AgentRequest] = []
    }

    public static func requestsFilePath(databasePath: String) -> String {
        let dir = (databasePath as NSString).deletingLastPathComponent
        let runDir = (dir as NSString).appendingPathComponent(".toolroll-run")
        return (runDir as NSString).appendingPathComponent("agent-requests.json")
    }

    public static func load(databasePath: String) -> [AgentRequest] {
        let path = requestsFilePath(databasePath: databasePath)
        guard FileManager.default.fileExists(atPath: path),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode(FileEnvelope.self, from: data)
        else {
            return []
        }
        return decoded.requests
    }

    public static func loadPending(databasePath: String) -> [AgentRequest] {
        load(databasePath: databasePath).filter { $0.status == .pending }
    }

    @discardableResult
    public static func resolve(
        databasePath: String,
        id: String,
        status: AgentRequestStatus,
        note: String? = nil,
        now: Date = Date()
    ) -> AgentRequest? {
        let path = requestsFilePath(databasePath: databasePath)
        var envelope = FileEnvelope(version: 1, requests: load(databasePath: databasePath))
        guard let index = envelope.requests.firstIndex(where: { $0.id == id }) else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        envelope.requests[index].status = status
        envelope.requests[index].resolvedAt = formatter.string(from: now)
        if let note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            envelope.requests[index].resolutionNote = String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400))
        }
        let updated = envelope.requests[index]
        save(envelope: envelope, to: path)
        return updated
    }

    public static func appendForTesting(databasePath: String, request: AgentRequest) {
        let path = requestsFilePath(databasePath: databasePath)
        var envelope = FileEnvelope(version: 1, requests: load(databasePath: databasePath))
        envelope.requests.append(request)
        save(envelope: envelope, to: path)
    }

    private static func save(envelope: FileEnvelope, to path: String) {
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard var data = try? encoder.encode(envelope) else { return }
        data.append(0x0A)
        let tmp = "\(path).\(ProcessInfo.processInfo.processIdentifier).\(UUID().uuidString.prefix(8)).tmp"
        FileManager.default.createFile(atPath: tmp, contents: data, attributes: [.posixPermissions: 0o600])
        _ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))
    }
}
