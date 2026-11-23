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

    /// A Work row's status (contracts/engine-api.ts WORK_STATUS_TONES). The token says what happened and wins where
    /// the tone is shared: a Cancelled row is "muted" like a Queued one, but it has ended and belongs in Settled.
    public init(workTone tone: String, token: String) {
        switch token {
        // The server's tokens are `assignment-<state>` (work-index.ts); the bare words are older fixtures' spelling.
        case "cancelled", "assignment-cancelled", "complete", "assignment-complete": self = .finished
        case "failed", "assignment-failed": self = .failed
        default:
            switch tone {
            case "attention": self = .needs
            case "live": self = .running
            case "problem": self = .failed
            case "done": self = .finished
            // A finished result waiting for the person to check it is theirs to act on (work-index.ts ranks it with
            // Needs you); any other "ready" row is waiting its turn.
            case "ready": self = token == "assignment-ready-to-check" ? .needs : .queued
            case "muted", "neutral": self = .queued   // waiting its turn, retrying later, or on hold
            default: self = TaskStatusTone(fromWire: token)
            }
        }
    }

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

public struct QuestionOption: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let consequence: String
    public let recommended: Bool

    public init(id: String, label: String, consequence: String = "", recommended: Bool = false) {
        self.id = id
        self.label = label
        self.consequence = consequence
        self.recommended = recommended
    }
}

public struct TaskQuestion: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let text: String
    public let recap: String
    public let options: [QuestionOption]

    public init(id: Int, text: String, recap: String = "", options: [QuestionOption] = []) {
        self.id = id
        self.text = text
        self.recap = recap
        self.options = options
    }
}

public struct NeedRow: Codable, Sendable, Equatable {
    public let id: String
    public let state: String
    public let ask: String?
    public let reason: String?
    public let line: String?
    public let question: TaskQuestion?

    public init(id: String, state: String = "", ask: String? = nil, reason: String? = nil, line: String? = nil, question: TaskQuestion? = nil) {
        self.id = id
        self.state = state
        self.ask = ask
        self.reason = reason
        self.line = line
        self.question = question
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
    public let need: NeedRow?

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
        problem: String? = nil,
        need: NeedRow? = nil
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
        self.need = need
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
        case id, title, href, project, age, status, word, ask, chip, group, rank, detail, problem, need
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
        need = try? c.decodeIfPresent(NeedRow.self, forKey: .need)

        if let sObj = try? c.decode(WireStatus.self, forKey: .status) {
            status = TaskStatusTone(workTone: sObj.tone, token: sObj.token ?? group)
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

/// One of the Work list's own groups, in the server's order and words.
public struct WorkGroupSummary: Codable, Sendable, Equatable {
    public let key: String
    public let label: String
    public let count: Int
}

/// Waiting asks that are no task row (a held release, a flow card, a setup step), by Work's three groups.
public struct WorkNeedGroup: Codable, Sendable, Equatable {
    public let key: String
    public let label: String
    public let count: Int
    public let rows: [NeedRow]
}

public struct WorkRowsResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let project: String?
    public let projectName: String
    public let needsCount: Int
    public let rows: [WorkRow]
    public let room: String
    public let spend: SpendSummary?
    /// The list's own groups (null: one plain list).
    public var groups: [WorkGroupSummary]? = nil
    /// Waiting asks that are no task row.
    public var needs: [WorkNeedGroup] = []
    /// The next page's cursor (null: this is all of it).
    public var next: String? = nil

    enum CodingKeys: String, CodingKey {
        case version
        case project
        case projectName = "project_name"
        case needsCount = "needs_count"
        case rows
        case room
        case spend
        case groups, needs, next
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
        groups = try? c.decodeIfPresent([WorkGroupSummary].self, forKey: .groups)
        needs = (try? c.decodeIfPresent([WorkNeedGroup].self, forKey: .needs)) ?? []
        next = try? c.decodeIfPresent(String.self, forKey: .next)
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

    public var displayLabel: String {
        if let model, !model.isEmpty {
            return "\(provider) · \(model)"
        }
        return provider
    }
}

/// The agent one step of a task runs, from the task's own route (`chosen` "override": set for this task by a person).
public struct TaskStepModel: Codable, Sendable, Equatable {
    public let phase: String
    public let provider: String
    public let model: String
    public let chosen: String

    public init(phase: String, provider: String, model: String, chosen: String) {
        self.phase = phase
        self.provider = provider
        self.model = model
        self.chosen = chosen
    }

    public var displayLabel: String { "\(provider) · \(model)" }
}

/// One agent a task's step may run (the server's configured choices for that step; what the route accepts).
public struct TaskAgentChoice: Codable, Sendable, Equatable, Hashable {
    public let provider: String
    public let model: String
    public var formValue: String { "\(provider)|\(model)" }
}

/// The agents this task's own steps may switch to; review is never per-task.
public struct TaskAgentChoices: Codable, Sendable, Equatable {
    public let plan: [TaskAgentChoice]
    public let build: [TaskAgentChoice]

    public func forRole(_ role: String) -> [TaskAgentChoice] {
        switch role {
        case "plan": return plan
        case "build": return build
        default: return plan.filter { build.contains($0) }   // "all": what both steps accept
        }
    }
}

/// A model change waiting for the task's live run to end (kept by the server; `problem` when it couldn't apply).
public struct PendingAgentChange: Codable, Sendable, Equatable {
    public let phase: String
    public let provider: String
    public let model: String
    public let when: String
    public let by: String?
    public let at: String?
    public let problem: String?
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
    /// The family's first version (a sidebar row's id); `id` is the current version.
    public var root: String? = nil
    public let title: String
    public let project: String?
    public let state: String?
}

public struct ApprovalTerm: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(label)-\(words)" }
    public let label: String
    public let words: String

    public init(label: String, words: String) {
        self.label = label
        self.words = words
    }
}

public struct ApprovalCard: Codable, Sendable, Equatable {
    public let version: Int
    public let task: String
    public let key: String?
    public let digest: String?
    public let nonce: String?
    public let terms: [ApprovalTerm]
    public let problem: String?

    public init(
        version: Int = 1,
        task: String,
        key: String? = nil,
        digest: String? = nil,
        nonce: String? = nil,
        terms: [ApprovalTerm] = [],
        problem: String? = nil
    ) {
        self.version = version
        self.task = task
        self.key = key
        self.digest = digest
        self.nonce = nonce
        self.terms = terms
        self.problem = problem
    }
}

/// Structured, scannable digest parsed from raw `ApprovalTerm` rows so the approval UI
/// shows a clear Goal, smart `+ Added / - Removed` file deltas, check tags, and collapsible fine print.
public struct ApprovalPlanDigest: Sendable, Equatable {
    public struct CheckItem: Sendable, Equatable, Identifiable {
        public var id: String { text }
        public let text: String
        public let badge: String?

        public init(text: String, badge: String? = nil) {
            self.text = text
            self.badge = badge
        }
    }

    public let goal: String?
    public let revision: String?
    public let addedFiles: [String]
    public let removedFiles: [String]
    public let changedFallback: String?
    public let agent: String?
    public let files: [String]
    public let checks: [CheckItem]
    public let wontTouch: String?
    public let extraTerms: [ApprovalTerm]

    public static func parse(from terms: [ApprovalTerm]) -> ApprovalPlanDigest {
        var goal: String?
        var revision: String?
        var addedFiles: [String] = []
        var removedFiles: [String] = []
        var changedFallback: String?
        var agent: String?
        var files: [String] = []
        var checks: [CheckItem] = []
        var wontTouch: String?
        var extraTerms: [ApprovalTerm] = []

        for term in terms {
            let key = term.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let val = term.words.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !val.isEmpty else { continue }

            switch key {
            case "goal":
                goal = val
            case "revision":
                revision = val
            case "changed":
                if let diff = parseFileDelta(val) {
                    addedFiles = diff.added
                    removedFiles = diff.removed
                } else {
                    changedFallback = val
                }
            case "agent":
                agent = val
            case "files":
                files = splitFileList(val)
            case "done when":
                checks = parseChecks(val)
            case "won't touch", "wont touch", "not", "boundaries":
                wontTouch = val
            default:
                extraTerms.append(term)
            }
        }

        return ApprovalPlanDigest(
            goal: goal,
            revision: revision,
            addedFiles: addedFiles,
            removedFiles: removedFiles,
            changedFallback: changedFallback,
            agent: agent,
            files: files,
            checks: checks,
            wontTouch: wontTouch,
            extraTerms: extraTerms
        )
    }

    private static func splitFileList(_ raw: String) -> [String] {
        var cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.lowercased().hasPrefix("only ") {
            cleaned = String(cleaned.dropFirst(5))
        }
        return cleaned
            .components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func parseFileDelta(_ raw: String) -> (added: [String], removed: [String])? {
        let lower = raw.lowercased()
        guard let wasRange = lower.range(of: "was "),
              let nowRange = lower.range(of: ", now ", range: wasRange.upperBound..<lower.endIndex)
        else { return nil }
        let beforeStr = String(raw[wasRange.upperBound..<nowRange.lowerBound])
        let afterStr = String(raw[nowRange.upperBound...])
        let beforeList = splitFileList(beforeStr)
        let afterList = splitFileList(afterStr)
        guard !beforeList.isEmpty || !afterList.isEmpty else { return nil }
        let beforeSet = Set(beforeList)
        let afterSet = Set(afterList)
        let added = afterList.filter { !beforeSet.contains($0) }
        let removed = beforeList.filter { !afterSet.contains($0) }
        guard !added.isEmpty || !removed.isEmpty else { return nil }
        return (added, removed)
    }

    private static func parseChecks(_ raw: String) -> [CheckItem] {
        let lines = raw
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return lines.map { line in
            var text = line
            var badge: String? = nil
            let tagMap: [(suffix: String, badge: String)] = [
                ("(runs automatically)", "Auto"),
                ("(shown in a screenshot)", "Visual"),
                ("(seen in the changed files)", "Diff"),
                ("(checked manually)", "Manual"),
            ]
            for item in tagMap {
                if text.lowercased().hasSuffix(item.suffix) {
                    text = String(text.dropLast(item.suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                    badge = item.badge
                    break
                }
            }
            return CheckItem(text: text, badge: badge)
        }
    }
}

public struct TaskReviewAccept: Codable, Sendable, Equatable {
    public let owed: String?
    public let blockers: [String]
    public let needs: String?

    public init(owed: String? = nil, blockers: [String] = [], needs: String? = nil) {
        self.owed = owed
        self.blockers = blockers
        self.needs = needs
    }
}

public struct TaskReview: Codable, Sendable, Equatable {
    public let run: Int
    public let receipt: String
    public let source: String
    public let accept: TaskReviewAccept

    public init(run: Int, receipt: String, source: String, accept: TaskReviewAccept = TaskReviewAccept()) {
        self.run = run
        self.receipt = receipt
        self.source = source
        self.accept = accept
    }
}

public struct TaskFailure: Codable, Sendable, Equatable {
    public let line: String
    public let failedInARow: Int
    public let suggestion: String?
    public let agentSaid: [String]?

    enum CodingKeys: String, CodingKey {
        case line, suggestion
        case failedInARow = "failedInARow"
        case agentSaid = "agentSaid"
    }

    public init(line: String, failedInARow: Int = 1, suggestion: String? = nil, agentSaid: [String]? = nil) {
        self.line = line
        self.failedInARow = failedInARow
        self.suggestion = suggestion
        self.agentSaid = agentSaid
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        line = try c.decodeIfPresent(String.self, forKey: .line) ?? ""
        failedInARow = try c.decodeIfPresent(Int.self, forKey: .failedInARow) ?? 1
        suggestion = try c.decodeIfPresent(String.self, forKey: .suggestion)
        agentSaid = try c.decodeIfPresent([String].self, forKey: .agentSaid)
    }
}

public struct PlanAsk: Codable, Sendable, Equatable {
    public let source: String
    public init(source: String) { self.source = source }
}

public struct PlanStopped: Codable, Sendable, Equatable {
    public let incident: Int
    public let kind: String
    public let line: String
    public let problems: [String]?
    public let agentSaid: [String]?
    public let again: PlanAsk?

    public init(incident: Int, kind: String = "plan", line: String, problems: [String]? = nil, agentSaid: [String]? = nil, again: PlanAsk? = nil) {
        self.incident = incident
        self.kind = kind
        self.line = line
        self.problems = problems
        self.agentSaid = agentSaid
        self.again = again
    }
}

public struct RetryPins: Codable, Sendable, Equatable {
    public let run: Int
    public let digest: String
    public init(run: Int, digest: String) { self.run = run; self.digest = digest }
}

public struct TaskHold: Codable, Sendable, Equatable {
    public let id: Int
    public let reason: String
    public let lastFailure: String?
    public init(id: Int, reason: String, lastFailure: String? = nil) {
        self.id = id
        self.reason = reason
        self.lastFailure = lastFailure
    }
}

public struct StepCardsResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let task: StepTaskSummary
    public let headline: String?
    public let liveRun: Int?
    /// The task's newest run, live or finished: the build a cancel names as the one it showed.
    public let latestRun: Int?
    /// This task's own agent per step; nil from an older server or for a task without an exact route.
    public let models: [TaskStepModel]?
    /// The scope digest this read shows: a model change sends it back so it applies only to what the person saw.
    public let scopeDigest: String?
    public let agentChoices: TaskAgentChoices?
    public let pendingAgentChange: PendingAgentChange?
    public let cards: [StepCard]
    public let review: TaskReview?
    public let failure: TaskFailure?
    public let planStopped: PlanStopped?
    public let plan: PlanAsk?
    public let retry: RetryPins?
    public let held: TaskHold?

    enum CodingKeys: String, CodingKey {
        case version, task, headline, cards, review, failure, plan, retry, held, models, scopeDigest, agentChoices, pendingAgentChange
        case liveRun = "live_run"
        case latestRun = "latest_run"
        case planStopped = "plan_stopped"
    }

    private enum CamelKeys: String, CodingKey { case liveRun, latestRun, planStopped }

    public init(
        version: Int = 1,
        task: StepTaskSummary,
        headline: String? = nil,
        liveRun: Int? = nil,
        latestRun: Int? = nil,
        models: [TaskStepModel]? = nil,
        scopeDigest: String? = nil,
        agentChoices: TaskAgentChoices? = nil,
        pendingAgentChange: PendingAgentChange? = nil,
        cards: [StepCard] = [],
        review: TaskReview? = nil,
        failure: TaskFailure? = nil,
        planStopped: PlanStopped? = nil,
        plan: PlanAsk? = nil,
        retry: RetryPins? = nil,
        held: TaskHold? = nil
    ) {
        self.version = version
        self.task = task
        self.headline = headline
        self.liveRun = liveRun
        self.latestRun = latestRun
        self.models = models
        self.scopeDigest = scopeDigest
        self.agentChoices = agentChoices
        self.pendingAgentChange = pendingAgentChange
        self.cards = cards
        self.review = review
        self.failure = failure
        self.planStopped = planStopped
        self.plan = plan
        self.retry = retry
        self.held = held
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let alt = try decoder.container(keyedBy: CamelKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        task = try c.decode(StepTaskSummary.self, forKey: .task)
        headline = try c.decodeIfPresent(String.self, forKey: .headline)
        liveRun = (try? c.decodeIfPresent(Int.self, forKey: .liveRun))
            ?? (try? alt.decodeIfPresent(Int.self, forKey: .liveRun))
        latestRun = (try? c.decodeIfPresent(Int.self, forKey: .latestRun))
            ?? (try? alt.decodeIfPresent(Int.self, forKey: .latestRun))
        models = try? c.decodeIfPresent([TaskStepModel].self, forKey: .models)
        scopeDigest = try? c.decodeIfPresent(String.self, forKey: .scopeDigest)
        agentChoices = try? c.decodeIfPresent(TaskAgentChoices.self, forKey: .agentChoices)
        pendingAgentChange = try? c.decodeIfPresent(PendingAgentChange.self, forKey: .pendingAgentChange)
        cards = (try? c.decodeIfPresent([StepCard].self, forKey: .cards)) ?? []
        review = try? c.decodeIfPresent(TaskReview.self, forKey: .review)
        failure = try? c.decodeIfPresent(TaskFailure.self, forKey: .failure)
        planStopped = (try? c.decodeIfPresent(PlanStopped.self, forKey: .planStopped))
            ?? (try? alt.decodeIfPresent(PlanStopped.self, forKey: .planStopped))
        plan = try? c.decodeIfPresent(PlanAsk.self, forKey: .plan)
        retry = try? c.decodeIfPresent(RetryPins.self, forKey: .retry)
        held = try? c.decodeIfPresent(TaskHold.self, forKey: .held)
    }

    /// The run a cancel must name as shown: the server's newest run. An older server without `latestRun` falls back
    /// to the newest run the cards mention, which is the same id whenever every run sits on a card.
    /// This task's model for a step ("plan", "build", "review"), as a label; nil when the server didn't say.
    public func modelLabel(forPhase phase: String) -> String? {
        models?.first { $0.phase == phase }?.displayLabel
    }

    public var shownRunForCancel: Int? {
        latestRun ?? (cards.flatMap(\.runs) + [liveRun].compactMap { $0 }).max()
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

    public var isAddition: Bool {
        let k = kind.lowercased()
        return k == "addition" || k == "add" || k == "+"
    }

    public var isDeletion: Bool {
        let k = kind.lowercased()
        return k == "deletion" || k == "del" || k == "-"
    }

    public var isMeta: Bool {
        kind.lowercased() == "meta"
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

public struct TermProjectSummary: Codable, Sendable, Equatable {
    public let path: String
    public let name: String

    public init(path: String, name: String) {
        self.path = path
        self.name = name
    }
}

public struct TermStateResponse: Codable, Sendable, Equatable {
    public let available: Bool
    public let problem: String?
    public let programs: [String]
    public let projects: [TermProjectSummary]?
    public let sessions: [TerminalSummary]

    public init(
        available: Bool,
        problem: String? = nil,
        programs: [String] = [],
        projects: [TermProjectSummary]? = nil,
        sessions: [TerminalSummary] = []
    ) {
        self.available = available
        self.problem = problem
        self.programs = programs
        self.projects = projects
        self.sessions = sessions
    }
}

public struct StartRemoteTerminalResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let id: String
    public let branch: String
    public let program: String
    public let reused: Bool
    /// A scratch shell at the project's own branch (not a copy of this task's build). Nil: the server didn't say.
    public let scratch: Bool?
    /// Why the task's build couldn't be taken over, in the server's own words, when a scratch shell opened instead.
    public let note: String?

    public init(ok: Bool, id: String, branch: String, program: String, reused: Bool, scratch: Bool? = nil, note: String? = nil) {
        self.ok = ok
        self.id = id
        self.branch = branch
        self.program = program
        self.reused = reused
        self.scratch = scratch
        self.note = note
    }
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

// MARK: - Agents & Models (GET /engine/agents, GET /engine/models)

public struct AgentSetup: Codable, Sendable, Equatable {
    public let install: String?
    public let canInstall: Bool
    public let signIn: String?
    public let canSignIn: Bool
    public let key: String?
    public let note: String?

    public init(
        install: String? = nil,
        canInstall: Bool = false,
        signIn: String? = nil,
        canSignIn: Bool = false,
        key: String? = nil,
        note: String? = nil
    ) {
        self.install = install
        self.canInstall = canInstall
        self.signIn = signIn
        self.canSignIn = canSignIn
        self.key = key
        self.note = note
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        install = try c.decodeIfPresent(String.self, forKey: .install)
        canInstall = try c.decodeIfPresent(Bool.self, forKey: .canInstall) ?? false
        signIn = try c.decodeIfPresent(String.self, forKey: .signIn)
        canSignIn = try c.decodeIfPresent(Bool.self, forKey: .canSignIn) ?? false
        key = try c.decodeIfPresent(String.self, forKey: .key)
        note = try c.decodeIfPresent(String.self, forKey: .note)
    }
}

public struct AgentRow: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let state: String // signed-in | signed-out | unknown | not-installed
    public let how: String?
    public let signIn: String?
    public let ready: Bool
    public let next: String?
    public let setup: AgentSetup

    public init(
        id: String,
        name: String,
        state: String,
        how: String? = nil,
        signIn: String? = nil,
        ready: Bool = false,
        next: String? = nil,
        setup: AgentSetup = AgentSetup()
    ) {
        self.id = id
        self.name = name
        self.state = state
        self.how = how
        self.signIn = signIn
        self.ready = ready
        self.next = next
        self.setup = setup
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "unknown"
        how = try c.decodeIfPresent(String.self, forKey: .how)
        signIn = try c.decodeIfPresent(String.self, forKey: .signIn)
        ready = try c.decodeIfPresent(Bool.self, forKey: .ready) ?? false
        next = try c.decodeIfPresent(String.self, forKey: .next)
        setup = (try? c.decodeIfPresent(AgentSetup.self, forKey: .setup)) ?? AgentSetup()
    }
}

public struct FirstTaskAgent: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct AgentsReadResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let checkedAt: String?
    public let agents: [AgentRow]
    public let firstTask: FirstTaskAgent?
    public let lines: [String]

    public init(version: Int = 1, checkedAt: String? = nil, agents: [AgentRow] = [], firstTask: FirstTaskAgent? = nil, lines: [String] = []) {
        self.version = version
        self.checkedAt = checkedAt
        self.agents = agents
        self.firstTask = firstTask
        self.lines = lines
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        checkedAt = try c.decodeIfPresent(String.self, forKey: .checkedAt)
        agents = try c.decodeIfPresent([AgentRow].self, forKey: .agents) ?? []
        firstTask = try c.decodeIfPresent(FirstTaskAgent.self, forKey: .firstTask)
        lines = try c.decodeIfPresent([String].self, forKey: .lines) ?? []
    }
}

public struct ModelOption: Codable, Sendable, Equatable, Identifiable {
    public var id: String { value }
    public let value: String
    public let label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }

    /// Canonical `"provider|model"` value expected by `POST /settings/models/agent` and `ModelRoleSummary.current`.
    public func formValue(forProvider provider: String) -> String {
        value.contains("|") ? value : "\(provider)|\(value)"
    }
}

public struct ModelChoice: Codable, Sendable, Equatable, Identifiable {
    public var id: String { provider }
    public let provider: String
    public let label: String
    public let models: [ModelOption]

    public init(provider: String, label: String, models: [ModelOption] = []) {
        self.provider = provider
        self.label = label
        self.models = models
    }
}

public struct AgentPreset: Codable, Sendable, Equatable, Identifiable {
    public var id: String { agent }
    public let agent: String
    public let name: String
    public let words: String
    public let fields: [String: String]

    public init(agent: String, name: String, words: String, fields: [String: String] = [:]) {
        self.agent = agent
        self.name = name
        self.words = words
        self.fields = fields
    }
}

public struct ModelRoleSummary: Codable, Sendable, Equatable, Identifiable {
    public var id: String { key }
    public let key: String
    public let label: String
    public let current: String
    public let words: String
    public let choices: [ModelChoice]

    public init(key: String, label: String, current: String, words: String, choices: [ModelChoice] = []) {
        self.key = key
        self.label = label
        self.current = current
        self.words = words
        self.choices = choices
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        current = try c.decodeIfPresent(String.self, forKey: .current) ?? ""
        words = try c.decodeIfPresent(String.self, forKey: .words) ?? ""
        choices = try c.decodeIfPresent([ModelChoice].self, forKey: .choices) ?? []
    }
}

public struct ModelsReadResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let canChange: Bool
    public let digest: String
    public let problem: String?
    public let defaultAgent: String?
    public let roles: [ModelRoleSummary]
    public let presets: [AgentPreset]

    public init(
        version: Int = 1,
        canChange: Bool = true,
        digest: String = "",
        problem: String? = nil,
        defaultAgent: String? = nil,
        roles: [ModelRoleSummary] = [],
        presets: [AgentPreset] = []
    ) {
        self.version = version
        self.canChange = canChange
        self.digest = digest
        self.problem = problem
        self.defaultAgent = defaultAgent
        self.roles = roles
        self.presets = presets
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        canChange = try c.decodeIfPresent(Bool.self, forKey: .canChange) ?? false
        digest = try c.decodeIfPresent(String.self, forKey: .digest) ?? ""
        problem = try c.decodeIfPresent(String.self, forKey: .problem)
        defaultAgent = try c.decodeIfPresent(String.self, forKey: .defaultAgent)
        roles = try c.decodeIfPresent([ModelRoleSummary].self, forKey: .roles) ?? []
        presets = try c.decodeIfPresent([AgentPreset].self, forKey: .presets) ?? []
    }
}

// MARK: - Live Agent Run Records (GET /agents/live/run/<run>?file=main)

public struct LiveAgentRecord: Codable, Sendable, Equatable, Identifiable {
    public let id = UUID()
    public let k: String // open | start | say | step | done | cut | cap | child | end | over
    public let at: String?
    public let detail: String?
    public let textLines: [String]
    public let stepId: String?
    public let kind: String?
    public let target: String?
    public let ok: Bool?
    public let out: [String]
    public let desc: String?

    enum CodingKeys: String, CodingKey {
        case k, at, detail, kind, target, ok, out, desc
        case textLines = "t"
        case stepId = "id"
    }

    public init(k: String, at: String? = nil, detail: String? = nil, textLines: [String] = [], stepId: String? = nil, kind: String? = nil, target: String? = nil, ok: Bool? = nil, out: [String] = [], desc: String? = nil) {
        self.k = k
        self.at = at
        self.detail = detail
        self.textLines = textLines
        self.stepId = stepId
        self.kind = kind
        self.target = target
        self.ok = ok
        self.out = out
        self.desc = desc
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        k = try c.decodeIfPresent(String.self, forKey: .k) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: .at)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        textLines = (try? c.decodeIfPresent([String].self, forKey: .textLines)) ?? []
        stepId = try c.decodeIfPresent(String.self, forKey: .stepId)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        target = try c.decodeIfPresent(String.self, forKey: .target)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
        out = (try? c.decodeIfPresent([String].self, forKey: .out)) ?? []
        desc = try c.decodeIfPresent(String.self, forKey: .desc)
    }
}

public struct LiveRunWindowResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let live: Bool
    public let records: [LiveAgentRecord]
    public let cursor: String?

    private struct WindowInner: Decodable {
        let ok: Bool?
        let records: [LiveAgentRecord]?
        let cursor: String?
    }

    enum CodingKeys: String, CodingKey {
        case version, live, window
    }

    public init(version: Int = 1, live: Bool = false, records: [LiveAgentRecord] = [], cursor: String? = nil) {
        self.version = version
        self.live = live
        self.records = records
        self.cursor = cursor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        live = try c.decodeIfPresent(Bool.self, forKey: .live) ?? false
        if let inner = try? c.decode(WindowInner.self, forKey: .window) {
            records = inner.records ?? []
            cursor = inner.cursor
        } else {
            records = []
            cursor = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version)
        try c.encode(live, forKey: .live)
    }
}

public struct InlineDiffComment: Sendable, Equatable, Identifiable {
    public let id = UUID()
    public let path: String
    public let line: Int
    public let text: String

    public init(path: String, line: Int, text: String) {
        self.path = path
        self.line = line
        self.text = text
    }
}

// MARK: - SSE Signal

public enum LiveSignal: Sendable, Equatable {
    case change(room: String)
    case turn(room: String)
    case reload
    case ended
}
