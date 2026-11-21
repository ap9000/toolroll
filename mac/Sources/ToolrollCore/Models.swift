import Foundation

// MARK: - Connection Profiles (~/.config/toolroll/remote/profiles.json)

public struct ConnectionProfile: Codable, Sendable, Equatable, Identifiable {
    public var id: String { name }
    public var name: String
    public var origin: String
    public var account: String
    public var token: String
    public var workspaceId: String?
    public var recoveryGeneration: String?
    public var label: String?
    public var isDemo: Bool

    public init(
        name: String,
        origin: String,
        account: String,
        token: String,
        workspaceId: String? = nil,
        recoveryGeneration: String? = nil,
        label: String? = nil,
        isDemo: Bool = false
    ) {
        self.name = name
        self.origin = origin
        self.account = account
        self.token = token
        self.workspaceId = workspaceId
        self.recoveryGeneration = recoveryGeneration
        self.label = label
        self.isDemo = isDemo
    }

    public var displayTitle: String {
        if let label, !label.isEmpty { return label }
        return name
    }
}

// MARK: - Work Rows (GET /work/rows)

public enum TaskStatusTone: String, Codable, Sendable, Equatable {
    case needs
    case running
    case queued
    case finished
    case failed
    case unknown

    public init(fromWire raw: String) {
        switch raw.lowercased() {
        case "needs", "need", "decide", "decision", "approval", "waiting-you", "needs_you", "needs-you", "ink":
            self = .needs
        case "running", "live", "active", "working", "blue":
            self = .running
        case "queued", "waiting", "pending", "muted":
            self = .queued
        case "finished", "done", "good", "ok", "accepted", "merged", "green":
            self = .finished
        case "failed", "bad", "error", "danger", "stopped", "red":
            self = .failed
        default:
            self = TaskStatusTone(rawValue: raw.lowercased()) ?? .unknown
        }
    }

    public init(from decoder: Decoder) throws {
        if let raw = try? decoder.singleValueContainer().decode(String.self) {
            self = TaskStatusTone(fromWire: raw)
            return
        }
        if let obj = try? decoder.container(keyedBy: ObjKeys.self) {
            let token = (try? obj.decodeIfPresent(String.self, forKey: .token)) ?? ""
            let tone = (try? obj.decodeIfPresent(String.self, forKey: .tone)) ?? ""
            let label = (try? obj.decodeIfPresent(String.self, forKey: .label)) ?? ""
            let first = !tone.isEmpty ? tone : (!token.isEmpty ? token : label)
            self = TaskStatusTone(fromWire: first)
            return
        }
        self = .unknown
    }

    private enum ObjKeys: String, CodingKey {
        case label, tone, token
    }
}

public struct WorkRow: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let href: String
    public let project: String?
    public let age: String
    public let status: TaskStatusTone
    public let word: String
    public let ask: String?
    public let chip: String?
    public let group: String
    public let rank: Int
    public let detail: String?
    public let problem: String?

    public init(
        id: String,
        title: String,
        href: String = "",
        project: String? = nil,
        age: String = "",
        status: TaskStatusTone,
        word: String,
        ask: String? = nil,
        chip: String? = nil,
        group: String = "",
        rank: Int = 0,
        detail: String? = nil,
        problem: String? = nil
    ) {
        self.id = id
        self.title = title
        self.href = href
        self.project = project
        self.age = age
        self.status = status
        self.word = word
        self.ask = ask
        self.chip = chip
        self.group = group
        self.rank = rank
        self.detail = detail
        self.problem = problem
    }

    private struct WireWord: Decodable {
        let word: String
        let tone: String?
    }

    private struct WireStatus: Decodable {
        let label: String
        let tone: String
        let token: String?
    }

    enum CodingKeys: String, CodingKey {
        case id, title, href, project, age, status, word, ask, chip, group, rank, detail, problem
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        href = try c.decodeIfPresent(String.self, forKey: .href) ?? "/t/\(id)"
        project = try c.decodeIfPresent(String.self, forKey: .project)
        age = try c.decodeIfPresent(String.self, forKey: .age) ?? ""
        group = try c.decodeIfPresent(String.self, forKey: .group) ?? ""
        rank = try c.decodeIfPresent(Int.self, forKey: .rank) ?? 0
        ask = try c.decodeIfPresent(String.self, forKey: .ask)
        chip = try c.decodeIfPresent(String.self, forKey: .chip)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        problem = try c.decodeIfPresent(String.self, forKey: .problem)

        if let sObj = try? c.decode(WireStatus.self, forKey: .status) {
            let derived = TaskStatusTone(fromWire: sObj.tone)
            if derived != .unknown {
                status = derived
            } else {
                status = TaskStatusTone(fromWire: sObj.token ?? group)
            }
        } else if let sStr = try? c.decode(String.self, forKey: .status) {
            status = TaskStatusTone(fromWire: sStr)
        } else {
            status = TaskStatusTone(fromWire: group)
        }

        if let wObj = try? c.decode(WireWord.self, forKey: .word) {
            word = wObj.word
        } else if let wStr = try? c.decode(String.self, forKey: .word) {
            word = wStr
        } else {
            word = ""
        }
    }
}

public struct SpendSummary: Codable, Sendable, Equatable {
    public let todayUsd: Double
    public let planPercent: Int?

    public init(todayUsd: Double, planPercent: Int? = nil) {
        self.todayUsd = todayUsd
        self.planPercent = planPercent
    }
}

public struct WorkRowsResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let project: String?
    public let projectName: String
    public let needsCount: Int
    public let rows: [WorkRow]
    public let room: String
    public let spend: SpendSummary?

    enum CodingKeys: String, CodingKey {
        case version
        case project
        case projectName = "project_name"
        case needsCount = "needs_count"
        case rows
        case room
        case spend
    }

    public init(
        version: Int = 1,
        project: String? = nil,
        projectName: String = "All projects",
        needsCount: Int = 0,
        rows: [WorkRow] = [],
        room: String = "home",
        spend: SpendSummary? = nil
    ) {
        self.version = version
        self.project = project
        self.projectName = projectName
        self.needsCount = needsCount
        self.rows = rows
        self.room = room
        self.spend = spend
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let alt = try decoder.container(keyedBy: CamelKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        project = try c.decodeIfPresent(String.self, forKey: .project)
        projectName = (try? c.decodeIfPresent(String.self, forKey: .projectName))
            ?? (try? alt.decodeIfPresent(String.self, forKey: .projectName))
            ?? "All projects"
        needsCount = (try? c.decodeIfPresent(Int.self, forKey: .needsCount))
            ?? (try? alt.decodeIfPresent(Int.self, forKey: .needsCount))
            ?? 0
        rows = try c.decodeIfPresent([WorkRow].self, forKey: .rows) ?? []
        room = try c.decodeIfPresent(String.self, forKey: .room) ?? "home"
        spend = try c.decodeIfPresent(SpendSummary.self, forKey: .spend)
    }

    private enum CamelKeys: String, CodingKey {
        case projectName
        case needsCount
    }
}

// MARK: - Step Cards (GET /t/<task>/steps)

public struct StepAgent: Codable, Sendable, Equatable {
    public let provider: String
    public let model: String?
}

public struct StepTermsRow: Codable, Sendable, Equatable {
    public let label: String
    public let words: String
    public let lines: [String]
}

public struct StepTerms: Codable, Sendable, Equatable {
    public let key: String
    public let revision: String?
    public let summary: String?
    public let rows: [StepTermsRow]
    public let warnings: [String]

    public init(key: String, revision: String? = nil, summary: String? = nil, rows: [StepTermsRow] = [], warnings: [String] = []) {
        self.key = key
        self.revision = revision
        self.summary = summary
        self.rows = rows
        self.warnings = warnings
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decodeIfPresent(String.self, forKey: .key) ?? ""
        revision = try c.decodeIfPresent(String.self, forKey: .revision)
        rows = try c.decodeIfPresent([StepTermsRow].self, forKey: .rows) ?? []
        warnings = try c.decodeIfPresent([String].self, forKey: .warnings) ?? []
        if let explicit = try c.decodeIfPresent(String.self, forKey: .summary), !explicit.isEmpty {
            summary = explicit
        } else if !rows.isEmpty {
            summary = rows.map { "\($0.label): \($0.words)" }.joined(separator: " · ")
        } else {
            summary = nil
        }
    }
}

public struct StepCard: Codable, Sendable, Equatable, Identifiable {
    public var id: String { key }
    public let key: String
    public let label: String
    public let state: String
    public let mark: String
    public let sentence: String
    public let at: String?
    public let needsYou: Bool
    public let inChain: Bool
    public let agent: StepAgent?
    public let costUsd: Double?
    public let runs: [Int]
    public let terms: StepTerms?

    public init(
        key: String,
        label: String,
        state: String,
        mark: String,
        sentence: String,
        at: String? = nil,
        needsYou: Bool = false,
        inChain: Bool = true,
        agent: StepAgent? = nil,
        costUsd: Double? = nil,
        runs: [Int] = [],
        terms: StepTerms? = nil
    ) {
        self.key = key
        self.label = label
        self.state = state
        self.mark = mark
        self.sentence = sentence
        self.at = at
        self.needsYou = needsYou
        self.inChain = inChain
        self.agent = agent
        self.costUsd = costUsd
        self.runs = runs
        self.terms = terms
    }

    enum CodingKeys: String, CodingKey {
        case key, label, state, mark, sentence, at, agent, runs, terms
        case needsYou = "needs_you"
        case inChain = "in_chain"
        case costUsd = "cost_usd"
    }

    private enum CamelKeys: String, CodingKey {
        case needsYou, inChain, costUsd
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let alt = try decoder.container(keyedBy: CamelKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        state = try c.decode(String.self, forKey: .state)
        mark = try c.decodeIfPresent(String.self, forKey: .mark) ?? ""
        sentence = try c.decodeIfPresent(String.self, forKey: .sentence) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: .at)
        needsYou = (try? c.decodeIfPresent(Bool.self, forKey: .needsYou))
            ?? (try? alt.decodeIfPresent(Bool.self, forKey: .needsYou))
            ?? false
        inChain = (try? c.decodeIfPresent(Bool.self, forKey: .inChain))
            ?? (try? alt.decodeIfPresent(Bool.self, forKey: .inChain))
            ?? true
        agent = try c.decodeIfPresent(StepAgent.self, forKey: .agent)
        costUsd = (try? c.decodeIfPresent(Double.self, forKey: .costUsd))
            ?? (try? alt.decodeIfPresent(Double.self, forKey: .costUsd))
        runs = try c.decodeIfPresent([Int].self, forKey: .runs) ?? []
        terms = try c.decodeIfPresent(StepTerms.self, forKey: .terms)
    }
}

public struct StepTaskSummary: Codable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let project: String?
    public let state: String?
}

public struct StepCardsResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let task: StepTaskSummary
    public let headline: String?
    public let liveRun: Int?
    public let cards: [StepCard]

    enum CodingKeys: String, CodingKey {
        case version, task, headline, cards
        case liveRun = "live_run"
    }

    private enum CamelKeys: String, CodingKey { case liveRun }

    public init(version: Int = 1, task: StepTaskSummary, headline: String? = nil, liveRun: Int? = nil, cards: [StepCard] = []) {
        self.version = version
        self.task = task
        self.headline = headline
        self.liveRun = liveRun
        self.cards = cards
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let alt = try decoder.container(keyedBy: CamelKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        task = try c.decode(StepTaskSummary.self, forKey: .task)
        headline = try c.decodeIfPresent(String.self, forKey: .headline)
        liveRun = (try? c.decodeIfPresent(Int.self, forKey: .liveRun))
            ?? (try? alt.decodeIfPresent(Int.self, forKey: .liveRun))
        cards = try c.decodeIfPresent([StepCard].self, forKey: .cards) ?? []
    }
}

// MARK: - Presence (GET /api/presence)

public struct TaskPresence: Codable, Sendable, Equatable {
    public let viewers: [String]
    public let terminalController: String?
    public let terminalProgram: String?
    public let terminalViewers: Int

    public init(
        viewers: [String] = [],
        terminalController: String? = nil,
        terminalProgram: String? = nil,
        terminalViewers: Int = 0
    ) {
        self.viewers = viewers
        self.terminalController = terminalController
        self.terminalProgram = terminalProgram
        self.terminalViewers = terminalViewers
    }

    public var summary: String? {
        var parts: [String] = []
        if let ctrl = terminalController, !ctrl.isEmpty {
            let prog = terminalProgram ?? "terminal"
            parts.append("\(ctrl) typing in \(prog)")
        }
        if viewers.count == 1 {
            parts.append("\(viewers[0]) viewing")
        } else if viewers.count > 1 {
            parts.append("\(viewers[0]) +\(viewers.count - 1) viewing")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

public struct PresenceSnapshot: Codable, Sendable, Equatable {
    public let me: String
    public let tasks: [String: TaskPresence]
    public let owners: [String: String?]
    public let accounts: [String]

    public init(
        me: String = "",
        tasks: [String: TaskPresence] = [:],
        owners: [String: String?] = [:],
        accounts: [String] = []
    ) {
        self.me = me
        self.tasks = tasks
        self.owners = owners
        self.accounts = accounts
    }

    public var teammates: [String] {
        accounts.filter { $0 != me }
    }
}

// MARK: - Candidates & Promotion (GET/POST /api/handoff/task/<task>/candidates)

public struct CandidatePublication: Codable, Sendable, Equatable {
    public let id: Int
    public let state: String
    public let prNumber: Int?
    public let prUrl: String?

    public init(id: Int, state: String, prNumber: Int? = nil, prUrl: String? = nil) {
        self.id = id
        self.state = state
        self.prNumber = prNumber
        self.prUrl = prUrl
    }
}

public struct HandoffCandidate: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let author: String
    public let createdAt: String
    public let files: [String]
    public let note: String
    public let stale: Bool
    public let promotedAt: String?
    public let promotedBy: String?
    public let runId: Int?
    public let branch: String?
    public let headCommit: String?
    public let checkStatus: String?
    public let liveCheckState: String?
    public let publication: CandidatePublication?
    public let canOpenPr: Bool

    public init(
        id: String,
        author: String,
        createdAt: String,
        files: [String] = [],
        note: String = "",
        stale: Bool = false,
        promotedAt: String? = nil,
        promotedBy: String? = nil,
        runId: Int? = nil,
        branch: String? = nil,
        headCommit: String? = nil,
        checkStatus: String? = nil,
        liveCheckState: String? = nil,
        publication: CandidatePublication? = nil,
        canOpenPr: Bool = false
    ) {
        self.id = id
        self.author = author
        self.createdAt = createdAt
        self.files = files
        self.note = note
        self.stale = stale
        self.promotedAt = promotedAt
        self.promotedBy = promotedBy
        self.runId = runId
        self.branch = branch
        self.headCommit = headCommit
        self.checkStatus = checkStatus
        self.liveCheckState = liveCheckState
        self.publication = publication
        self.canOpenPr = canOpenPr
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        author = try c.decode(String.self, forKey: .author)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
        stale = try c.decodeIfPresent(Bool.self, forKey: .stale) ?? false
        promotedAt = try c.decodeIfPresent(String.self, forKey: .promotedAt)
        promotedBy = try c.decodeIfPresent(String.self, forKey: .promotedBy)
        runId = try c.decodeIfPresent(Int.self, forKey: .runId)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        headCommit = try c.decodeIfPresent(String.self, forKey: .headCommit)
        checkStatus = try c.decodeIfPresent(String.self, forKey: .checkStatus)
        liveCheckState = try c.decodeIfPresent(String.self, forKey: .liveCheckState)
        publication = try c.decodeIfPresent(CandidatePublication.self, forKey: .publication)
        canOpenPr = try c.decodeIfPresent(Bool.self, forKey: .canOpenPr) ?? false
    }
}

public struct CandidatesListResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let taskId: String
    public let currentBaseCommit: String?
    public let candidates: [HandoffCandidate]

    public init(ok: Bool = true, taskId: String, currentBaseCommit: String? = nil, candidates: [HandoffCandidate] = []) {
        self.ok = ok
        self.taskId = taskId
        self.currentBaseCommit = currentBaseCommit
        self.candidates = candidates
    }
}

public struct PromoteCandidateResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let taskId: String
    public let candidateId: String
    public let runId: Int?
    public let branch: String?
    public let headCommit: String?
}

public struct OpenCandidatePrResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let taskId: String
    public let candidateId: String
    public let runId: Int
    public let publication: CandidatePublication
}

public struct AssignPersonResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let taskId: String
    public let person: String
    public let warning: String?
}

// MARK: - Diffs (GET /t/<task>/diff)

public struct DiffTotals: Codable, Sendable, Equatable {
    public let files: Int
    public let added: Int
    public let removed: Int

    public init(files: Int, added: Int, removed: Int) {
        self.files = files
        self.added = added
        self.removed = removed
    }

    enum CodingKeys: String, CodingKey {
        case files, added, removed, additions, deletions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        files = try c.decodeIfPresent(Int.self, forKey: .files) ?? 0
        added = (try? c.decodeIfPresent(Int.self, forKey: .additions))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .added))
            ?? 0
        removed = (try? c.decodeIfPresent(Int.self, forKey: .deletions))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .removed))
            ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(files, forKey: .files)
        try c.encode(added, forKey: .additions)
        try c.encode(removed, forKey: .deletions)
    }
}

public struct DiffFileEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String { path }
    public let fileIndex: Int
    public let path: String
    public let added: Int?
    public let removed: Int?
    public let status: String?

    public init(fileIndex: Int = 0, path: String, added: Int? = nil, removed: Int? = nil, status: String? = nil) {
        self.fileIndex = fileIndex
        self.path = path
        self.added = added
        self.removed = removed
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case file, path, added, removed, additions, deletions, status
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fileIndex = try c.decodeIfPresent(Int.self, forKey: .file) ?? 0
        path = try c.decode(String.self, forKey: .path)
        added = (try? c.decodeIfPresent(Int.self, forKey: .additions))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .added))
        removed = (try? c.decodeIfPresent(Int.self, forKey: .deletions))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .removed))
        status = try c.decodeIfPresent(String.self, forKey: .status)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(fileIndex, forKey: .file)
        try c.encode(path, forKey: .path)
        try c.encodeIfPresent(added, forKey: .additions)
        try c.encodeIfPresent(removed, forKey: .deletions)
        try c.encodeIfPresent(status, forKey: .status)
    }
}

public struct DiffLine: Codable, Sendable, Equatable, Identifiable {
    public let id = UUID()
    public let kind: String
    public let text: String
    public let oldLine: Int?
    public let newLine: Int?

    enum CodingKeys: String, CodingKey {
        case kind, text, oldLine, newLine
    }

    public init(kind: String, text: String, oldLine: Int? = nil, newLine: Int? = nil) {
        self.kind = kind
        self.text = text
        self.oldLine = oldLine
        self.newLine = newLine
    }
}

public struct DiffHunk: Codable, Sendable, Equatable, Identifiable {
    public let id = UUID()
    public let header: String
    public let lines: [DiffLine]

    enum CodingKeys: String, CodingKey {
        case header, lines
    }

    public init(header: String, lines: [DiffLine]) {
        self.header = header
        self.lines = lines
    }
}

public struct ResultDiffResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let task: String
    public let run: Int?
    public let totals: DiffTotals?
    public let files: [DiffFileEntry]
    public let problem: String?

    public init(version: Int = 1, task: String, run: Int? = nil, totals: DiffTotals? = nil, files: [DiffFileEntry] = [], problem: String? = nil) {
        self.version = version
        self.task = task
        self.run = run
        self.totals = totals
        self.files = files
        self.problem = problem
    }
}

public struct ResultDiffFileResponse: Codable, Sendable, Equatable {
    public let path: String
    public let hunks: [DiffHunk]

    public init(path: String, hunks: [DiffHunk] = []) {
        self.path = path
        self.hunks = hunks
    }

    private struct NestedFile: Decodable {
        let path: String
        let hunks: [DiffHunk]
    }

    enum CodingKeys: String, CodingKey {
        case path, hunks, file
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let nested = try? c.decode(NestedFile.self, forKey: .file) {
            path = nested.path
            hunks = nested.hunks
        } else {
            path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
            hunks = try c.decodeIfPresent([DiffHunk].self, forKey: .hunks) ?? []
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(path, forKey: .path)
        try c.encode(hunks, forKey: .hunks)
    }
}

// MARK: - Live Terminals

public struct TerminalSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let repo: String
    public let project: String
    public let program: String
    public let branch: String
    public let startedAt: String
    public let endedAt: String?
    public let task: String?
    public let run: Int?
}

public struct TermStateResponse: Codable, Sendable, Equatable {
    public let available: Bool
    public let problem: String?
    public let programs: [String]
    public let sessions: [TerminalSummary]
}

public struct StartRemoteTerminalResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let id: String
    public let branch: String
    public let program: String
    public let reused: Bool
}

// MARK: - Lead Chat (GET /engine/chat)

public struct LeadMessage: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let role: String
    public let text: String
    public let at: String?

    public init(id: Int, role: String, text: String, at: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
    }
}

public struct LeadChatResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let room: String
    public let leadName: String
    public let canSend: Bool
    public let problem: String?
    public let busy: Bool
    public let messages: [LeadMessage]

    enum CodingKeys: String, CodingKey {
        case version, room, busy, messages, problem
        case leadName = "lead_name"
        case canSend = "can_send"
    }

    private enum CamelKeys: String, CodingKey { case leadName, canSend }

    public init(version: Int = 1, room: String = "chat", leadName: String = "Lead", canSend: Bool = true, problem: String? = nil, busy: Bool = false, messages: [LeadMessage] = []) {
        self.version = version
        self.room = room
        self.leadName = leadName
        self.canSend = canSend
        self.problem = problem
        self.busy = busy
        self.messages = messages
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let alt = try decoder.container(keyedBy: CamelKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        room = try c.decodeIfPresent(String.self, forKey: .room) ?? "chat"
        leadName = (try? c.decodeIfPresent(String.self, forKey: .leadName))
            ?? (try? alt.decodeIfPresent(String.self, forKey: .leadName))
            ?? "Lead"
        canSend = (try? c.decodeIfPresent(Bool.self, forKey: .canSend))
            ?? (try? alt.decodeIfPresent(Bool.self, forKey: .canSend))
            ?? false
        problem = try c.decodeIfPresent(String.self, forKey: .problem)
        busy = try c.decodeIfPresent(Bool.self, forKey: .busy) ?? false
        messages = try c.decodeIfPresent([LeadMessage].self, forKey: .messages) ?? []
    }
}

// MARK: - Device Pairing (POST /api/connect/pair/start|poll)

public struct DevicePairStartResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let pairId: String
    public let userCode: String
    public let pollSecret: String
    public let verifyPath: String
    public let expiresAt: String
}

public struct DevicePairPollResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let status: String
    public let account: String?
    public let token: String?
    public let workspaceId: String?
    public let recoveryGeneration: String?
    public let label: String?
}

// MARK: - SSE Signal

public enum LiveSignal: Sendable, Equatable {
    case change(room: String)
    case turn(room: String)
    case reload
    case ended
}
