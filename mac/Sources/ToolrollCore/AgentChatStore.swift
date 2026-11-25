import Foundation

public enum AgentChatProvider: String, Codable, CaseIterable, Identifiable, Sendable {
    case claude
    case codex
    case gemini

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .gemini: return "Gemini"
        }
    }

    public var shortBadge: String {
        switch self {
        case .claude: return "CL"
        case .codex: return "CX"
        case .gemini: return "GM"
        }
    }

    public var defaultModelId: String {
        switch self {
        case .claude: return "opus"
        case .codex: return "gpt-6-astra"
        case .gemini: return "gemini-4-neon-high"
        }
    }

    public var presets: [(id: String, label: String)] {
        switch self {
        case .claude:
            return [
                ("opus", "Claude Opus 5.5"),
                ("sonnet", "Claude Sonnet 5.5"),
                ("haiku", "Claude Haiku"),
            ]
        case .codex:
            return [
                ("gpt-6-astra", "GPT-6 Astra"),
                ("gpt-6-sol", "GPT-6 Sol"),
                ("gpt-6-luna", "GPT-6 Luna"),
            ]
        case .gemini:
            return [
                ("gemini-4-neon-high", "Gemini 4 Neon"),
                ("gemini-4-carbon-high", "Gemini 4 Carbon"),
                ("gemini-3.8-flash-high", "Gemini 3.8 Flash"),
            ]
        }
    }

    public func label(for modelId: String) -> String {
        if let found = presets.first(where: { $0.id == modelId }) {
            return found.label
        }
        if let found = Self.fallbackCatalogModels.first(where: { $0.provider == self && $0.id == modelId }) {
            return found.label
        }
        return modelId
    }

    public static var fallbackCatalogModels: [DirectChatModelOption] {
        [
            DirectChatModelOption(provider: .claude, id: "opus", label: "Claude Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindow: 1_000_000),
            DirectChatModelOption(provider: .claude, id: "sonnet", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindow: 1_000_000),
            DirectChatModelOption(provider: .claude, id: "haiku", label: "Claude Haiku 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200_000),
            DirectChatModelOption(provider: .claude, id: "fable", label: "Claude Fable", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindow: 1_000_000),
            DirectChatModelOption(provider: .codex, id: "gpt-6.2-sol", label: "GPT-6.2 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "high", contextWindow: 500_000),
            DirectChatModelOption(provider: .codex, id: "gpt-6.2-astra", label: "GPT-6.2 Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "high", contextWindow: 272_000),
            DirectChatModelOption(provider: .codex, id: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "high", contextWindow: 272_000),
            DirectChatModelOption(provider: .codex, id: "gpt-6-sol", label: "GPT-6 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "high", contextWindow: 272_000),
            DirectChatModelOption(provider: .codex, id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindow: 272_000),
            DirectChatModelOption(provider: .gemini, id: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high", contextWindow: 1_000_000),
            DirectChatModelOption(provider: .gemini, id: "gemini-4-carbon", label: "Gemini 4 Carbon", efforts: ["low", "medium", "high"], defaultEffort: "high", contextWindow: 1_000_000),
            DirectChatModelOption(provider: .gemini, id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"], defaultEffort: "high", contextWindow: 1_000_000),
            DirectChatModelOption(provider: .gemini, id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high", contextWindow: 1_000_000),
            DirectChatModelOption(provider: .gemini, id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "high", contextWindow: 1_000_000),
        ]
    }
}

public enum DirectChatEffortDisplay {
    public static func label(for effort: String) -> String {
        switch effort.lowercased() {
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "XHigh"
        case "max": return "Max"
        case "ultra": return "Ultra"
        default: return effort.capitalized
        }
    }

    public static func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            let val = Double(count) / 1_000_000.0
            return val.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0fM", val)
                : String(format: "%.1fM", val)
        }
        if count >= 1_000 {
            let val = Double(count) / 1_000.0
            return val >= 100
                ? String(format: "%.0fk", val)
                : String(format: "%.1fk", val)
        }
        return "\(count)"
    }
}

public struct DirectChatUsage: Codable, Equatable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheCreationTokens: Int
    public let thinkingTokens: Int
    public let contextTokens: Int
    public let contextWindow: Int?
    public let costUsd: Double?

    public init(
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheCreationTokens: Int = 0,
        thinkingTokens: Int = 0,
        contextTokens: Int = 0,
        contextWindow: Int? = nil,
        costUsd: Double? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.thinkingTokens = thinkingTokens
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.costUsd = costUsd
    }

    public var contextFraction: Double? {
        guard let window = contextWindow, window > 0, contextTokens > 0 else { return nil }
        return min(1.0, Double(contextTokens) / Double(window))
    }

    public var totalTokens: Int {
        inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
    }

    public var compactContextLabel: String {
        let used = contextTokens > 0 ? contextTokens : totalTokens
        if let window = contextWindow, window > 0 {
            let pct = Int((Double(used) / Double(window) * 100.0).rounded())
            return "\(DirectChatEffortDisplay.formatTokens(used)) / \(DirectChatEffortDisplay.formatTokens(window)) (\(pct)%)"
        }
        return "\(DirectChatEffortDisplay.formatTokens(used)) tok"
    }
}

public struct DirectChatModelOption: Codable, Equatable, Identifiable, Sendable {
    public var id: String { "\(provider.rawValue):\(modelId)" }
    public let provider: AgentChatProvider
    public let modelId: String
    public let label: String
    public let efforts: [String]
    public let defaultEffort: String?
    public let contextWindow: Int?

    enum CodingKeys: String, CodingKey {
        case provider
        case modelId = "id"
        case label
        case efforts
        case defaultEffort
        case contextWindow
    }

    public init(
        provider: AgentChatProvider,
        id: String,
        label: String,
        efforts: [String] = [],
        defaultEffort: String? = nil,
        contextWindow: Int? = nil
    ) {
        self.provider = provider
        self.modelId = id
        self.label = label
        self.efforts = efforts
        self.defaultEffort = defaultEffort
        self.contextWindow = contextWindow
    }

    public var menuTitle: String {
        guard let ctx = contextWindow, ctx > 0 else { return label }
        return "\(label)  ·  \(DirectChatEffortDisplay.formatTokens(ctx))"
    }
}

public struct DirectChatPosture: Codable, Equatable, Sendable {
    public let summary: String
    public let detail: String
    public let sandboxed: Bool

    public init(summary: String, detail: String, sandboxed: Bool) {
        self.summary = summary
        self.detail = detail
        self.sandboxed = sandboxed
    }

    public static func defaultFor(_ provider: AgentChatProvider) -> DirectChatPosture {
        switch provider {
        case .claude:
            return DirectChatPosture(
                summary: "Runs commands without asking",
                detail: "Uses Claude auto mode inside this chat's isolated clone (no OS sandbox).",
                sandboxed: false
            )
        case .codex:
            return DirectChatPosture(
                summary: "Runs commands without asking",
                detail: "Uses Codex workspace-write sandbox inside this chat's isolated clone.",
                sandboxed: true
            )
        case .gemini:
            return DirectChatPosture(
                summary: "Runs commands without asking",
                detail: "Uses Antigravity auto mode with sandbox inside this chat's isolated clone.",
                sandboxed: true
            )
        }
    }
}

public struct AgentChatToolEvent: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let ordinal: Int?
    public let name: String
    public let detail: String
    public var status: String
    public let updatedAt: String?

    public init(
        id: String = UUID().uuidString,
        ordinal: Int? = nil,
        name: String,
        detail: String,
        status: String = "done",
        updatedAt: String? = nil
    ) {
        self.id = id
        self.ordinal = ordinal
        self.name = name
        self.detail = detail
        self.status = status
        self.updatedAt = updatedAt
    }
}

public struct DirectChatArtifact: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let filename: String
    public let mimeType: String
    public let byteSize: Int
    public let url: String
    public let sourcePath: String?
    public let createdAt: String

    public init(
        id: String,
        kind: String,
        filename: String,
        mimeType: String,
        byteSize: Int,
        url: String,
        sourcePath: String? = nil,
        createdAt: String
    ) {
        self.id = id
        self.kind = kind
        self.filename = filename
        self.mimeType = mimeType
        self.byteSize = byteSize
        self.url = url
        self.sourcePath = sourcePath
        self.createdAt = createdAt
    }

    public var isImage: Bool {
        mimeType.lowercased().hasPrefix("image/")
    }
}

public struct DirectChatShipSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let seq: Int
    public let mode: String
    public let branch: String
    public let candidateSha: String
    public let state: String
    public let taskId: String?
    public let prUrl: String?
    public let detail: String?
    public let createdAt: String
    public let stateAt: String

    public init(
        id: String,
        seq: Int,
        mode: String,
        branch: String,
        candidateSha: String,
        state: String,
        taskId: String? = nil,
        prUrl: String? = nil,
        detail: String? = nil,
        createdAt: String,
        stateAt: String
    ) {
        self.id = id
        self.seq = seq
        self.mode = mode
        self.branch = branch
        self.candidateSha = candidateSha
        self.state = state
        self.taskId = taskId
        self.prUrl = prUrl
        self.detail = detail
        self.createdAt = createdAt
        self.stateAt = stateAt
    }

    public var canCancel: Bool {
        state == "armed" || state == "completed"
    }

    public var shortSha: String {
        String(candidateSha.prefix(8))
    }

    public var statusLabel: String {
        switch state {
        case "kept": return "Saved branch"
        case "imported": return "Imported"
        case "armed": return "Verifying checks"
        case "completed": return "Checks passed — opening PR"
        case "merging": return "Merging PR"
        case "merged": return "Merged"
        case "cancelled": return "Cancelled"
        case "failed": return "Failed"
        default: return state.capitalized
        }
    }
}

public struct DirectChatTurnDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let seq: Int
    public let userPrompt: String
    public let switchedFromProvider: AgentChatProvider?
    public let status: String
    public let assistantText: String
    public let errorText: String?
    public let createdAt: String
    public let finishedAt: String?
    public let usage: DirectChatUsage?
    public let tools: [AgentChatToolEvent]
    public let artifacts: [DirectChatArtifact]

    public init(
        id: String,
        seq: Int,
        userPrompt: String,
        switchedFromProvider: AgentChatProvider? = nil,
        status: String,
        assistantText: String,
        errorText: String? = nil,
        createdAt: String,
        finishedAt: String? = nil,
        usage: DirectChatUsage? = nil,
        tools: [AgentChatToolEvent] = [],
        artifacts: [DirectChatArtifact] = []
    ) {
        self.id = id
        self.seq = seq
        self.userPrompt = userPrompt
        self.switchedFromProvider = switchedFromProvider
        self.status = status
        self.assistantText = assistantText
        self.errorText = errorText
        self.createdAt = createdAt
        self.finishedAt = finishedAt
        self.usage = usage
        self.tools = tools
        self.artifacts = artifacts
    }
}

public struct DirectChatSummaryDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let project: String
    public let branch: String
    public let provider: AgentChatProvider
    public let modelId: String
    public let effort: String?
    public let posture: DirectChatPosture
    public let running: Bool
    public let lastStatus: String?
    public let changedFilesCount: Int
    public let mainDirtyFiles: [String]
    public let usage: DirectChatUsage?
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String,
        title: String,
        project: String,
        branch: String,
        provider: AgentChatProvider,
        modelId: String,
        effort: String? = nil,
        posture: DirectChatPosture,
        running: Bool,
        lastStatus: String? = nil,
        changedFilesCount: Int = 0,
        mainDirtyFiles: [String] = [],
        usage: DirectChatUsage? = nil,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.title = title
        self.project = project
        self.branch = branch
        self.provider = provider
        self.modelId = modelId
        self.effort = effort
        self.posture = posture
        self.running = running
        self.lastStatus = lastStatus
        self.changedFilesCount = changedFilesCount
        self.mainDirtyFiles = mainDirtyFiles
        self.usage = usage
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct DirectChatDiffDTO: Codable, Equatable, Sendable {
    public let changedFiles: [String]
    public let diffText: String
    public let dirty: Bool

    public init(changedFiles: [String] = [], diffText: String = "", dirty: Bool = false) {
        self.changedFiles = changedFiles
        self.diffText = diffText
        self.dirty = dirty
    }
}

public struct DirectChatsListResponse: Codable, Equatable, Sendable {
    public let version: Int
    public let available: Bool
    public let problem: String?
    public let backgroundOn: Bool
    public let models: [DirectChatModelOption]
    public let threads: [DirectChatSummaryDTO]

    public init(
        version: Int = 1,
        available: Bool = true,
        problem: String? = nil,
        backgroundOn: Bool = false,
        models: [DirectChatModelOption] = [],
        threads: [DirectChatSummaryDTO] = []
    ) {
        self.version = version
        self.available = available
        self.problem = problem
        self.backgroundOn = backgroundOn
        self.models = models
        self.threads = threads
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? true
        problem = try c.decodeIfPresent(String.self, forKey: .problem)
        backgroundOn = try c.decodeIfPresent(Bool.self, forKey: .backgroundOn) ?? false
        models = try c.decodeIfPresent([DirectChatModelOption].self, forKey: .models) ?? []
        threads = try c.decodeIfPresent([DirectChatSummaryDTO].self, forKey: .threads) ?? []
    }
}

public struct DirectChatDetailResponse: Codable, Equatable, Sendable {
    public let version: Int
    public let room: String
    public let thread: DirectChatSummaryDTO
    public let turns: [DirectChatTurnDTO]
    public let attachments: [DirectChatArtifact]
    public let ships: [DirectChatShipSummary]
    public let diff: DirectChatDiffDTO

    public init(
        version: Int = 1,
        room: String,
        thread: DirectChatSummaryDTO,
        turns: [DirectChatTurnDTO] = [],
        attachments: [DirectChatArtifact] = [],
        ships: [DirectChatShipSummary] = [],
        diff: DirectChatDiffDTO = DirectChatDiffDTO()
    ) {
        self.version = version
        self.room = room
        self.thread = thread
        self.turns = turns
        self.attachments = attachments
        self.ships = ships
        self.diff = diff
    }
}

public struct DirectChatStartedResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let threadId: String?
    public let turnId: String?
    public let room: String?
    public let error: String?
    public let code: String?
}

public struct DirectChatMutatedResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let said: String?
    public let error: String?
    public let code: String?

    public init(ok: Bool, said: String? = nil, error: String? = nil, code: String? = nil) {
        self.ok = ok
        self.said = said
        self.error = error
        self.code = code
    }
}

public struct DirectChatShipPreview: Codable, Equatable, Sendable {
    public let version: Int
    public let threadId: String
    public let mode: String
    public let canAutoMerge: Bool
    public let autoMergeReason: String?
    public let termsDigest: String
    public let title: String
    public let goal: String
    public let baseSha: String
    public let branch: String
    public let changedFiles: [String]
    public let checkCommand: String?
    public let githubRepo: String?
    public let githubBase: String?
    public let mergeSummary: String

    public init(
        version: Int = 1,
        threadId: String,
        mode: String,
        canAutoMerge: Bool,
        autoMergeReason: String? = nil,
        termsDigest: String,
        title: String,
        goal: String,
        baseSha: String,
        branch: String,
        changedFiles: [String],
        checkCommand: String? = nil,
        githubRepo: String? = nil,
        githubBase: String? = nil,
        mergeSummary: String
    ) {
        self.version = version
        self.threadId = threadId
        self.mode = mode
        self.canAutoMerge = canAutoMerge
        self.autoMergeReason = autoMergeReason
        self.termsDigest = termsDigest
        self.title = title
        self.goal = goal
        self.baseSha = baseSha
        self.branch = branch
        self.changedFiles = changedFiles
        self.checkCommand = checkCommand
        self.githubRepo = githubRepo
        self.githubBase = githubBase
        self.mergeSummary = mergeSummary
    }
}

public struct DirectChatShippedResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let ship: DirectChatShipSummary?
    public let said: String?
    public let error: String?
    public let code: String?
}

public struct DirectChatAttachedResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let artifact: DirectChatArtifact?
    public let cloneRelativePath: String?
    public let error: String?
}

public enum AgentChatRole: String, Codable, Sendable {
    case user
    case assistant
}

public struct AgentChatMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let role: AgentChatRole
    public var text: String
    public var tools: [AgentChatToolEvent]
    public var artifacts: [DirectChatArtifact]
    public var switchedFromProvider: AgentChatProvider?
    public let timestamp: Date
    public var isStreaming: Bool
    public var isError: Bool
    public var status: String
    public var usage: DirectChatUsage?

    public init(
        id: String = UUID().uuidString,
        role: AgentChatRole,
        text: String,
        tools: [AgentChatToolEvent] = [],
        artifacts: [DirectChatArtifact] = [],
        switchedFromProvider: AgentChatProvider? = nil,
        timestamp: Date = Date(),
        isStreaming: Bool = false,
        isError: Bool = false,
        status: String = "completed",
        usage: DirectChatUsage? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.tools = tools
        self.artifacts = artifacts
        self.switchedFromProvider = switchedFromProvider
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.isError = isError
        self.status = status
        self.usage = usage
    }
}

public struct AgentChatGitDiff: Equatable, Sendable {
    public let changedFiles: [String]
    public let diffText: String
    public let dirty: Bool

    public init(changedFiles: [String] = [], diffText: String = "", dirty: Bool = false) {
        self.changedFiles = changedFiles
        self.diffText = diffText
        self.dirty = dirty
    }

    public init(dto: DirectChatDiffDTO) {
        self.changedFiles = dto.changedFiles
        self.diffText = dto.diffText
        self.dirty = dto.dirty
    }

    public var isEmpty: Bool { changedFiles.isEmpty && diffText.isEmpty && !dirty }
}

public struct AgentChatThread: Equatable, Identifiable, Sendable {
    public let id: String
    public var title: String
    public let projectName: String
    public let branch: String
    public var provider: AgentChatProvider
    public var modelId: String
    public var effort: String?
    public var posture: DirectChatPosture
    public var running: Bool
    public var lastStatus: String?
    public var changedFilesCount: Int
    public var mainDirtyFiles: [String]
    public var usage: DirectChatUsage?
    public var messages: [AgentChatMessage]
    public var attachments: [DirectChatArtifact]
    public var ships: [DirectChatShipSummary]
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        title: String,
        projectName: String,
        branch: String = "",
        provider: AgentChatProvider,
        modelId: String? = nil,
        effort: String? = nil,
        posture: DirectChatPosture? = nil,
        running: Bool = false,
        lastStatus: String? = nil,
        changedFilesCount: Int = 0,
        mainDirtyFiles: [String] = [],
        usage: DirectChatUsage? = nil,
        messages: [AgentChatMessage] = [],
        attachments: [DirectChatArtifact] = [],
        ships: [DirectChatShipSummary] = [],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.projectName = projectName
        self.branch = branch
        self.provider = provider
        self.modelId = modelId ?? provider.defaultModelId
        self.effort = effort
        self.posture = posture ?? DirectChatPosture.defaultFor(provider)
        self.running = running
        self.lastStatus = lastStatus
        self.changedFilesCount = changedFilesCount
        self.mainDirtyFiles = mainDirtyFiles
        self.usage = usage
        self.messages = messages
        self.attachments = attachments
        self.ships = ships
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public init(summary: DirectChatSummaryDTO, preserving existing: AgentChatThread? = nil) {
        self.id = summary.id
        self.title = summary.title
        self.projectName = summary.project
        self.branch = summary.branch
        self.provider = summary.provider
        self.modelId = summary.modelId
        self.effort = summary.effort
        self.posture = summary.posture
        self.running = summary.running
        self.lastStatus = summary.lastStatus
        self.changedFilesCount = summary.changedFilesCount
        self.mainDirtyFiles = summary.mainDirtyFiles
        self.usage = summary.usage ?? existing?.usage
        self.messages = existing?.messages ?? []
        self.attachments = existing?.attachments ?? []
        self.ships = existing?.ships ?? []
        self.createdAt = DirectChatDateParser.parse(summary.createdAt) ?? existing?.createdAt ?? Date()
        self.updatedAt = DirectChatDateParser.parse(summary.updatedAt) ?? existing?.updatedAt ?? Date()
    }

    public init(detail: DirectChatDetailResponse) {
        self.id = detail.thread.id
        self.title = detail.thread.title
        self.projectName = detail.thread.project
        self.branch = detail.thread.branch
        self.provider = detail.thread.provider
        self.modelId = detail.thread.modelId
        self.effort = detail.thread.effort
        self.posture = detail.thread.posture
        self.running = detail.thread.running
        self.lastStatus = detail.thread.lastStatus
        self.changedFilesCount = max(detail.thread.changedFilesCount, detail.diff.changedFiles.count)
        self.mainDirtyFiles = detail.thread.mainDirtyFiles
        self.usage = detail.thread.usage
        self.messages = Self.messagesFromTurns(detail.turns)
        self.attachments = detail.attachments
        self.ships = detail.ships
        self.createdAt = DirectChatDateParser.parse(detail.thread.createdAt) ?? Date()
        self.updatedAt = DirectChatDateParser.parse(detail.thread.updatedAt) ?? Date()
    }

    public var room: String { "direct-chat:\(id)" }

    public var relativeAge: String {
        let secs = max(0, Int(Date().timeIntervalSince(updatedAt)))
        if secs < 60 { return "now" }
        if secs < 3600 { return "\(secs / 60)m" }
        if secs < 86_400 { return "\(secs / 3600)h" }
        return "\(secs / 86_400)d"
    }

    public static func messagesFromTurns(_ turns: [DirectChatTurnDTO]) -> [AgentChatMessage] {
        var out: [AgentChatMessage] = []
        out.reserveCapacity(turns.count * 2)
        for turn in turns {
            let created = DirectChatDateParser.parse(turn.createdAt) ?? Date()
            let finished = turn.finishedAt.flatMap(DirectChatDateParser.parse) ?? created
            out.append(AgentChatMessage(
                id: "\(turn.id)-user",
                role: .user,
                text: turn.userPrompt,
                switchedFromProvider: turn.switchedFromProvider,
                timestamp: created,
                isStreaming: false,
                isError: false,
                status: turn.status
            ))
            let isRunning = turn.status == "running"
            let isError = turn.status == "failed" || (turn.status == "interrupted" && turn.assistantText.isEmpty && (turn.errorText?.isEmpty == false))
            let displayText: String
            if !turn.assistantText.isEmpty {
                if let err = turn.errorText, !err.isEmpty, turn.status == "failed" {
                    displayText = "\(turn.assistantText)\n\n\(err)"
                } else {
                    displayText = turn.assistantText
                }
            } else if let err = turn.errorText, !err.isEmpty {
                displayText = err
            } else {
                displayText = ""
            }
            out.append(AgentChatMessage(
                id: "\(turn.id)-assistant",
                role: .assistant,
                text: displayText,
                tools: turn.tools,
                artifacts: turn.artifacts,
                switchedFromProvider: turn.switchedFromProvider,
                timestamp: finished,
                isStreaming: isRunning,
                isError: isError,
                status: turn.status,
                usage: turn.usage
            ))
        }
        return out
    }
}

public enum DirectChatDateParser {
    public static func parse(_ iso: String) -> Date? {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }

    public static func makeHex32RequestId() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}
