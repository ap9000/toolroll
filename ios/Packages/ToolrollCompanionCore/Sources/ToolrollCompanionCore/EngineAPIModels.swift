import Foundation

// Codable mirrors of the Engine API response bodies the phone reads (src/contracts/engine-api.ts).
// The Mac returns these exact shapes inside `{ "ok": true, "result": … }`; demo fixtures use them too,
// so demo and live share one decode path.
//
// Decoding is tolerant on purpose: an enum value this build doesn't know maps to `.other`, and fields the
// phone doesn't draw are simply not declared (JSONDecoder ignores unknown keys).

/// A string enum that decodes unknown values to `.other` instead of failing the whole response.
public protocol CompanionOpenEnum: RawRepresentable, Codable, Sendable, Hashable where RawValue == String {
    static var other: Self { get }
}

extension CompanionOpenEnum {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.other
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// `{ "ok": true, "result": R }` — every unary success payload (src/companion/daemon.ts sendRpcResult).
public struct CompanionRPCEnvelope<R: Decodable>: Decodable {
    public let ok: Bool
    public let result: R
}

// MARK: - device.hello

public struct DeviceHello: Codable, Equatable, Sendable {
    public let version: Int?
    public let workspaceId: String
    public let workspaceLabel: String?
    public let account: String?
    public let deviceId: String
    /// The Mac's current ways to reach it (same rules as the pairing QR). Nil when absent or malformed: a bad
    /// list never fails the hello, it just isn't stored.
    public let paths: [CompanionPath]?
    /// The Mac's console origin (for Handoff to `/t/<task>`), or nil when unknown.
    public let consoleUrl: String?

    private enum CodingKeys: String, CodingKey {
        case version, workspaceId, workspaceLabel, account, deviceId, paths, consoleUrl
    }

    public init(
        version: Int? = 1, workspaceId: String, workspaceLabel: String? = nil, account: String? = nil,
        deviceId: String, paths: [CompanionPath]? = nil, consoleUrl: String? = nil
    ) {
        self.version = version
        self.workspaceId = workspaceId
        self.workspaceLabel = workspaceLabel
        self.account = account
        self.deviceId = deviceId
        self.paths = paths
        self.consoleUrl = consoleUrl
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version)
        workspaceId = try c.decode(String.self, forKey: .workspaceId)
        workspaceLabel = try c.decodeIfPresent(String.self, forKey: .workspaceLabel)
        account = try c.decodeIfPresent(String.self, forKey: .account)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        paths = (try? c.decodeIfPresent([CompanionPath].self, forKey: .paths)) ?? nil
        consoleUrl = (try? c.decodeIfPresent(String.self, forKey: .consoleUrl)) ?? nil
    }

    /// `paths` if present and valid under the pairing rules; otherwise nil.
    public var validPaths: [CompanionPath]? {
        guard let paths, (try? CompanionPathRules.validate(paths)) != nil else { return nil }
        return paths
    }
}

// MARK: - Work rows (`work.rows`, workRowsSchema)

/// The Work list's server views (src/workspace-ui.ts parseWorkView).
public enum WorkView: String, CaseIterable, Sendable, Hashable {
    case needsYou = "needs-you"
    case all = "all"
    case running = "running"
    case completed = "completed"
}

public enum WorkStatusTone: String, CompanionOpenEnum {
    case attention, problem, live, ready, done, muted, neutral, other
}

public enum WorkWordTone: String, CompanionOpenEnum {
    case none = ""
    case needs, ask, live, done, failed, other
}

public enum WorkRowGroup: String, CompanionOpenEnum {
    case decide, review, unblock, building, rest, other
}

public enum WorkAsk: String, CompanionOpenEnum {
    case release, approve, answer, flow, wrong, review, setup, other
}

public enum NeedState: String, CompanionOpenEnum {
    case needs, running, queued, done, other
}

public enum NeedGroupKey: String, CompanionOpenEnum {
    case decide, review, unblock, other
}

public enum WorkCheck: String, CompanionOpenEnum {
    case failed, stale, unreadable, other
}

public struct WorkStatus: Codable, Equatable, Sendable {
    public let label: String
    public let tone: WorkStatusTone
    public let token: String
}

public struct WorkWord: Codable, Equatable, Sendable {
    public let word: String
    public let tone: WorkWordTone
}

public struct WorkWaiting: Codable, Equatable, Sendable {
    public let retryAt: String?
    public let lastFailure: String?
    public let attempt: String?
}

public struct NeedAction: Codable, Equatable, Sendable {
    public let label: String
    public let href: String
}

public struct NeedQuestion: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let consequence: String
        public let recommended: Bool
    }

    public let id: Int
    public let text: String
    public let recap: String
    public let options: [Option]
}

/// A Needs-you row (needRowSchema): what a waiting row asks of a person.
public struct NeedRow: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let href: String
    public let project: String?
    public let age: String
    public let state: NeedState
    public let ask: WorkAsk?
    public let group: NeedGroupKey?
    public let reason: String?
    public let line: String?
    public let action: NeedAction?
    public let question: NeedQuestion?
}

public struct WorkGroup: Codable, Equatable, Sendable {
    public let key: String
    public let label: String
    public let count: Int
}

public struct NeedGroup: Codable, Equatable, Sendable {
    public let key: NeedGroupKey
    public let label: String
    public let count: Int
    public let rows: [NeedRow]
}

/// A task row of the Work list (workRowSchema).
public struct WorkRow: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let href: String
    public let project: String?
    public let age: String
    public let status: WorkStatus
    public let word: WorkWord
    public let ask: String?
    public let chip: String?
    public let group: WorkRowGroup
    /// 0 waits on a person, 1 runs, 2 queued or waiting, 3 finished, 4 stopped or put away.
    public let rank: Int
    public let check: WorkCheck?
    public let landed: String?
    public let detail: String?
    public let problem: String?
    public let need: NeedRow?
    public let waiting: WorkWaiting?
}

public struct WorkRows: Codable, Equatable, Sendable {
    public let version: Int
    public let project: String?
    public let projectName: String
    public let needsCount: Int
    public let groups: [WorkGroup]?
    public let rows: [WorkRow]
    /// Waiting asks that are no task row (a held release, a flow card, a setup step).
    public let needs: [NeedGroup]
    /// The next page's cursor, or nil on the last page.
    public let next: String?
    public let room: String?
}

// MARK: - Step cards (`task.steps`, stepCardsSchema)

public enum StepKey: String, CompanionOpenEnum {
    case plan, approve, build, checks, review, ready, other
}

public enum StepState: String, CompanionOpenEnum {
    case done, current, stuck, skipped, todo, other
}

public enum StepMark: String, CompanionOpenEnum {
    case done, needs, live, wait, stuck, skipped, todo, other
}

public enum StepChain: String, CompanionOpenEnum {
    case planFirst = "plan-first"
    case justCode = "just-code"
    case other
}

public struct StepAgent: Codable, Equatable, Sendable {
    public let provider: String
    public let model: String?
}

/// The approval terms an Approval card carries while an approval waits (approval-summary.ts).
public struct ApprovalTerms: Codable, Equatable, Sendable {
    public struct Row: Codable, Equatable, Sendable {
        public let label: String
        public let words: String
        public let lines: [String]
    }

    public struct Usual: Codable, Equatable, Sendable {
        public let label: String
        public let words: String
    }

    public let key: String
    public let revision: String?
    public let rows: [Row]
    public let warnings: [String]
    public let usualLabel: String
    public let usual: [Usual]
}

public struct StepCard: Codable, Equatable, Sendable, Identifiable {
    public var id: String { key.rawValue + ":" + label }

    public let key: StepKey
    public let label: String
    public let state: StepState
    public let mark: StepMark
    public let sentence: String
    public let at: String?
    public let needsYou: Bool
    public let inChain: Bool
    public let agent: StepAgent?
    public let startedAt: String?
    public let latestStartedAt: String?
    public let finishedAt: String?
    public let costUsd: Double?
    public let runs: [Int]
    public let terms: ApprovalTerms?
}

public struct StepTask: Codable, Equatable, Sendable {
    public let id: String
    public let root: String
    public let title: String
    public let state: String
    public let project: String?
}

public struct StepReview: Codable, Equatable, Sendable {
    public struct Accept: Codable, Equatable, Sendable {
        public let owed: String?
        public let blockers: [String]
        public let needs: String?
    }

    public let run: Int
    public let receipt: String
    public let source: String
    public let accept: Accept?
}

public struct StepFailure: Codable, Equatable, Sendable {
    public let line: String
    public let failedInARow: Int
    public let suggestion: String?
    public let agentSaid: [String]?
}

public struct StepWaiting: Codable, Equatable, Sendable {
    public let retryAt: String?
    public let lastFailure: String?
    public let attempt: String?
    public let agentSaid: [String]?
}

public struct StepHeld: Codable, Equatable, Sendable {
    public let id: Int
    public let reason: String
    public let lastFailure: String?
}

public struct StepPlanStopped: Codable, Equatable, Sendable {
    public let incident: Int
    public let kind: String
    public let line: String
    public let problems: [String]?
    public let agentSaid: [String]?
}

public struct StepApproval: Codable, Equatable, Sendable {
    public let by: String
    public let you: Bool
    public let automatic: Bool
}

public struct StepLanding: Codable, Equatable, Sendable {
    public let words: String
    public let reverted: Bool
}

public struct StepModel: Codable, Equatable, Sendable {
    public let phase: String
    public let provider: String
    public let model: String
    public let chosen: String
}

public struct StepCards: Codable, Equatable, Sendable {
    public let version: Int
    public let task: StepTask
    public let chain: StepChain
    public let headline: String?
    public let liveRun: Int?
    public let latestRun: Int?
    public let familyBuilds: [Int]?
    public let models: [StepModel]?
    /// Null when the task has no road (cancelled, or no status yet).
    public let cards: [StepCard]?
    public let review: StepReview?
    public let failure: StepFailure?
    public let waiting: StepWaiting?
    public let held: StepHeld?
    public let approval: StepApproval?
    public let landing: StepLanding?
    public let check: WorkCheck?
    public let planStopped: StepPlanStopped?
    public let planQueued: Bool?
    public let room: String?

    /// The Approval card's terms while an approval waits on a person.
    public var waitingTerms: ApprovalTerms? {
        cards?.first(where: { $0.key == .approve && $0.terms != nil })?.terms
    }
}

// MARK: - Result diff (`task.diff`, resultDiffSchema / resultDiffFileSchema)

public struct ResultDiffTotals: Codable, Equatable, Sendable {
    public let files: Int
    public let additions: Int
    public let deletions: Int
    public let binary: Int
    public let filesTruncated: Bool
}

public struct ResultDiffEntry: Codable, Equatable, Sendable, Identifiable {
    public var id: Int { file }

    /// The file's index, sent back as `file` to read its hunks.
    public let file: Int
    public let path: String
    public let oldPath: String?
    public let additions: Int
    public let deletions: Int
    public let binary: Bool
    public let hunks: Int
}

public struct ResultDiff: Codable, Equatable, Sendable {
    public let version: Int
    public let task: String
    public let run: Int?
    public let totals: ResultDiffTotals?
    public let files: [ResultDiffEntry]
    public let patchTruncated: Bool
    /// Why there is no file list; nil when there is one.
    public let problem: String?
}

public enum DiffLineKind: String, CompanionOpenEnum {
    case context, addition, deletion, meta, other
}

public struct DiffLine: Codable, Equatable, Sendable {
    public let kind: DiffLineKind
    public let text: String
    public let oldLine: Int?
    public let newLine: Int?
}

public struct DiffHunk: Codable, Equatable, Sendable {
    public let header: String
    public let lines: [DiffLine]
}

public struct ResultDiffFileBody: Codable, Equatable, Sendable {
    public let file: Int
    public let path: String
    public let oldPath: String?
    public let meta: [String]
    public let hunks: [DiffHunk]
    public let lineCount: Int?
}

public struct ResultDiffFile: Codable, Equatable, Sendable {
    public let version: Int
    public let task: String
    public let run: Int
    public let file: ResultDiffFileBody
    public let linesTruncated: Bool
}

// MARK: - Live session (`run.window.read`, `run.watch.subscribe`)

public enum LiveRecordKind: String, CompanionOpenEnum {
    case open, start, say, you, step, done, cut, cap, child, end, over, other
}

/// One live record (liveRecordSchema), flattened: every field but `k` is optional.
public struct LiveRecord: Codable, Equatable, Sendable {
    public let kind: LiveRecordKind
    public let at: String?
    public let text: [String]?
    public let stepId: String?
    public let stepKind: String?
    public let target: String?
    public let ok: Bool?
    public let out: [String]?
    public let stream: Int?
    public let detail: String?
    public let desc: String?
    /// A watch stream's own "cut" record says how many records were dropped.
    public let dropped: Int?

    enum CodingKeys: String, CodingKey {
        case k, at, t, id, kind, target, ok, out, s, detail, desc, dropped
    }

    public init(
        kind: LiveRecordKind, at: String? = nil, text: [String]? = nil, stepId: String? = nil,
        stepKind: String? = nil, target: String? = nil, ok: Bool? = nil, out: [String]? = nil,
        stream: Int? = nil, detail: String? = nil, desc: String? = nil, dropped: Int? = nil
    ) {
        self.kind = kind
        self.at = at
        self.text = text
        self.stepId = stepId
        self.stepKind = stepKind
        self.target = target
        self.ok = ok
        self.out = out
        self.stream = stream
        self.detail = detail
        self.desc = desc
        self.dropped = dropped
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(LiveRecordKind.self, forKey: .k)
        at = try c.decodeIfPresent(String.self, forKey: .at)
        text = try c.decodeIfPresent([String].self, forKey: .t)
        stepId = try c.decodeIfPresent(String.self, forKey: .id)
        stepKind = try c.decodeIfPresent(String.self, forKey: .kind)
        target = try c.decodeIfPresent(String.self, forKey: .target)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
        out = try c.decodeIfPresent([String].self, forKey: .out)
        stream = try c.decodeIfPresent(Int.self, forKey: .s)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        desc = try c.decodeIfPresent(String.self, forKey: .desc)
        dropped = try c.decodeIfPresent(Int.self, forKey: .dropped)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .k)
        try c.encodeIfPresent(at, forKey: .at)
        try c.encodeIfPresent(text, forKey: .t)
        try c.encodeIfPresent(stepId, forKey: .id)
        try c.encodeIfPresent(stepKind, forKey: .kind)
        try c.encodeIfPresent(target, forKey: .target)
        try c.encodeIfPresent(ok, forKey: .ok)
        try c.encodeIfPresent(out, forKey: .out)
        try c.encodeIfPresent(stream, forKey: .s)
        try c.encodeIfPresent(detail, forKey: .detail)
        try c.encodeIfPresent(desc, forKey: .desc)
        try c.encodeIfPresent(dropped, forKey: .dropped)
    }
}

/// A run's id is an integer, a thread's a hex string.
public enum LiveSessionId: Codable, Equatable, Sendable {
    case run(Int)
    case thread(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) {
            self = .run(n)
        } else {
            self = .thread(try c.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .run(let n): try c.encode(n)
        case .thread(let s): try c.encode(s)
        }
    }
}

public struct LiveSessionRef: Codable, Equatable, Sendable {
    public let kind: String
    public let id: LiveSessionId
    public let task: String?
}

public struct LiveWindow: Codable, Equatable, Sendable {
    public let ok: Bool
    public let records: [LiveRecord]?
    public let cursor: String?
    public let restarted: Bool?
    public let earlier: Bool?
    public let quarantined: Int?
    public let skipped: Int?
    public let more: Bool?
    /// When `ok` is false: missing / unavailable / off.
    public let reason: String?
}

public struct LiveSessionWindow: Codable, Equatable, Sendable {
    public let version: Int
    public let session: LiveSessionRef
    public let room: String
    public let live: Bool
    public let file: String
    public let window: LiveWindow
}
