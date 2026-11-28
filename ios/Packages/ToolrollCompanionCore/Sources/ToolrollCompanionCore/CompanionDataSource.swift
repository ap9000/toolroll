import Foundation

/// Where the app's Work, task, diff and live data come from. Demo and live share the Engine API shapes,
/// so every screen has one decode path and one rendering path.
public protocol CompanionDataSource: Sendable {
    func workRows(view: WorkView, cursor: String?) async throws -> WorkRows
    func taskSteps(task: String) async throws -> StepCards
    /// The result's changed files (`run` nil: the task's current result).
    func taskDiff(task: String, run: Int?) async throws -> ResultDiff
    /// One file's hunks; `file` is the entry's index from `ResultDiff.files`.
    func taskDiffFile(task: String, run: Int, file: Int) async throws -> ResultDiffFile
    func runWindow(run: Int, cursor: String?) async throws -> LiveSessionWindow
    /// Live records as they happen. Ending the stream stops watching only; the run keeps going.
    func watchRun(run: Int, cursor: String?) async throws -> AsyncThrowingStream<LiveRecord, Error>

    // MARK: Gate 2 Passkey Registration & Approvals (ADR 0005)
    func passkeyStatus() async throws -> PasskeyStatus
    func passkeyLock() async throws -> PasskeyLockResponse
    func passkeyRegisterBegin() async throws -> PasskeyRegisterBeginResponse
    func passkeyRegisterFinish(
        challenge: String,
        credentialId: String,
        clientDataJSON: String,
        attestationObject: String,
        label: String?
    ) async throws -> PasskeyRegisterFinishResponse
    /// A challenge bound to one Approve or Accept. `forceFresh`: always a live passkey challenge, never the unlocked
    /// window ("Always ask on this iPhone").
    func approvalChallenge(
        verb: PasskeyApprovalVerb,
        task: String,
        digest: String?,
        runId: Int?,
        receiptDigest: String?,
        note: String?,
        publish: Bool?,
        forceFresh: Bool?
    ) async throws -> ApprovalChallengeResponse
    func approveTask(
        task: String,
        digest: String,
        challenge: String,
        idempotencyKey: String,
        assertion: WebAuthnAssertion?,
        useFreshSession: Bool
    ) async throws -> TaskApproveResponse
    func acceptTask(
        task: String,
        runId: Int?,
        receiptDigest: String,
        note: String?,
        publish: Bool,
        challenge: String,
        idempotencyKey: String,
        assertion: WebAuthnAssertion?,
        useFreshSession: Bool
    ) async throws -> TaskAcceptResponse

    // MARK: App unlock ("Unlock approvals when I open Toolroll")
    /// Whether this source can run the unlock ceremony (the demo can't).
    var supportsApprovalsUnlock: Bool { get }
    /// A challenge for one unlock of `minutes` (the Mac clamps it to its window).
    func approvalsUnlockChallenge(minutes: Int) async throws -> ApprovalChallengeResponse
    /// `passkey.unlock`: opens this iPhone's unlocked window with one live assertion.
    func approvalsUnlock(minutes: Int, challenge: String, assertion: WebAuthnAssertion) async throws -> ApprovalsUnlockResponse
}

// MARK: - Live (RPCs over the relay)

public struct LiveCompanionSource: CompanionDataSource {
    private let client: CompanionRelayClient

    public init(client: CompanionRelayClient) {
        self.client = client
    }

    private struct WorkParams: Encodable, Sendable {
        let view: String
        let cursor: String?
    }

    private struct TaskParams: Encodable, Sendable {
        let task: String
    }

    private struct DiffParams: Encodable, Sendable {
        let task: String
        let run: String?
    }

    private struct DiffFileParams: Encodable, Sendable {
        let task: String
        let run: String
        let file: Int
    }

    private struct RunParams: Encodable, Sendable {
        let run: String
        let cursor: String?
    }

    public func workRows(view: WorkView, cursor: String?) async throws -> WorkRows {
        try await client.call("work.rows", params: WorkParams(view: view.rawValue, cursor: cursor))
    }

    public func taskSteps(task: String) async throws -> StepCards {
        try await client.call("task.steps", params: TaskParams(task: task))
    }

    public func taskDiff(task: String, run: Int?) async throws -> ResultDiff {
        try await client.call("task.diff", params: DiffParams(task: task, run: run.map(String.init)))
    }

    public func taskDiffFile(task: String, run: Int, file: Int) async throws -> ResultDiffFile {
        try await client.call("task.diff", params: DiffFileParams(task: task, run: String(run), file: file))
    }

    public func runWindow(run: Int, cursor: String?) async throws -> LiveSessionWindow {
        try await client.call("run.window.read", params: RunParams(run: String(run), cursor: cursor))
    }

    public func watchRun(run: Int, cursor: String?) async throws -> AsyncThrowingStream<LiveRecord, Error> {
        let raw = try await client.watch(method: "run.watch.subscribe", params: RunParams(run: String(run), cursor: cursor))
        return Self.decodeRecords(raw)
    }

    private struct EmptyParams: Encodable, Sendable {}

    private struct PasskeyFinishParams: Encodable, Sendable {
        let challenge: String
        let credentialId: String
        let clientDataJSON: String
        let attestationObject: String
        let label: String?
    }

    private struct ApprovalChallengeParams: Encodable, Sendable {
        let verb: String
        let task: String?
        let digest: String?
        let runId: Int?
        let receiptDigest: String?
        let note: String?
        let publish: Bool?
        let forceFresh: Bool?
    }

    private struct ApproveParams: Encodable, Sendable {
        let task: String
        let digest: String
        let challenge: String
        let idempotencyKey: String
        let assertion: WebAuthnAssertion?
        let useFreshSession: Bool
    }

    private struct AcceptParams: Encodable, Sendable {
        let task: String
        let runId: Int?
        let receiptDigest: String
        let note: String?
        let publish: Bool
        let challenge: String
        let idempotencyKey: String
        let assertion: WebAuthnAssertion?
        let useFreshSession: Bool
    }

    /// The unlock ceremony: `approval.challenge` with verb `unlock`, then `passkey.unlock` (no idempotency key: a retry is
    /// a fresh challenge).
    static let unlockMethod = "passkey.unlock"

    private struct UnlockChallengeParams: Encodable, Sendable {
        let verb = "unlock"
        let minutes: Int
    }

    private struct UnlockParams: Encodable, Sendable {
        let challenge: String
        let assertion: WebAuthnAssertion
        let minutes: Int
    }

    /// The unlock params exactly as sent.
    static func unlockChallengeParams(minutes: Int) -> some Encodable & Sendable { UnlockChallengeParams(minutes: minutes) }
    static func unlockParams(minutes: Int, challenge: String, assertion: WebAuthnAssertion) -> some Encodable & Sendable {
        UnlockParams(challenge: challenge, assertion: assertion, minutes: minutes)
    }

    public func passkeyStatus() async throws -> PasskeyStatus {
        try await client.call("passkey.status", params: EmptyParams())
    }

    public func passkeyLock() async throws -> PasskeyLockResponse {
        try await client.call("passkey.lock", params: EmptyParams())
    }

    public func passkeyRegisterBegin() async throws -> PasskeyRegisterBeginResponse {
        try await client.call("passkey.register.begin", params: EmptyParams())
    }

    public func passkeyRegisterFinish(
        challenge: String,
        credentialId: String,
        clientDataJSON: String,
        attestationObject: String,
        label: String?
    ) async throws -> PasskeyRegisterFinishResponse {
        try await client.call(
            "passkey.register.finish",
            params: PasskeyFinishParams(
                challenge: challenge,
                credentialId: credentialId,
                clientDataJSON: clientDataJSON,
                attestationObject: attestationObject,
                label: label
            )
        )
    }

    public func approvalChallenge(
        verb: PasskeyApprovalVerb,
        task: String,
        digest: String?,
        runId: Int?,
        receiptDigest: String?,
        note: String?,
        publish: Bool?,
        forceFresh: Bool?
    ) async throws -> ApprovalChallengeResponse {
        try await client.call("approval.challenge", params: Self.challengeParams(
            verb: verb, task: task, digest: digest, runId: runId, receiptDigest: receiptDigest, note: note, publish: publish,
            forceFresh: forceFresh
        ))
    }

    /// The `approval.challenge` params exactly as sent (nil fields are omitted).
    static func challengeParams(
        verb: PasskeyApprovalVerb, task: String, digest: String?, runId: Int?, receiptDigest: String?, note: String?,
        publish: Bool?, forceFresh: Bool?
    ) -> some Encodable & Sendable {
        ApprovalChallengeParams(
            verb: verb.rawValue, task: task, digest: digest, runId: runId, receiptDigest: receiptDigest, note: note,
            publish: publish, forceFresh: forceFresh
        )
    }

    public func approveTask(
        task: String,
        digest: String,
        challenge: String,
        idempotencyKey: String,
        assertion: WebAuthnAssertion?,
        useFreshSession: Bool
    ) async throws -> TaskApproveResponse {
        try await client.call("task.approve", params: Self.approveParams(
            task: task, digest: digest, challenge: challenge, idempotencyKey: idempotencyKey, assertion: assertion,
            useFreshSession: useFreshSession
        ))
    }

    /// The `task.approve` params exactly as sent.
    static func approveParams(
        task: String, digest: String, challenge: String, idempotencyKey: String, assertion: WebAuthnAssertion?, useFreshSession: Bool
    ) -> some Encodable & Sendable {
        ApproveParams(task: task, digest: digest, challenge: challenge, idempotencyKey: idempotencyKey, assertion: assertion, useFreshSession: useFreshSession)
    }

    public func acceptTask(
        task: String,
        runId: Int?,
        receiptDigest: String,
        note: String?,
        publish: Bool,
        challenge: String,
        idempotencyKey: String,
        assertion: WebAuthnAssertion?,
        useFreshSession: Bool
    ) async throws -> TaskAcceptResponse {
        try await client.call(
            "task.accept",
            params: AcceptParams(task: task, runId: runId, receiptDigest: receiptDigest, note: note, publish: publish, challenge: challenge, idempotencyKey: idempotencyKey, assertion: assertion, useFreshSession: useFreshSession)
        )
    }

    /// The Mac answers `passkey.unlock`; an older Mac refuses the `unlock` verb (`invalid_params`) or the route, and the
    /// app then unlocks viewing only (AppLockPolicy.fallback).
    public var supportsApprovalsUnlock: Bool { true }

    public func approvalsUnlockChallenge(minutes: Int) async throws -> ApprovalChallengeResponse {
        try await client.call("approval.challenge", params: Self.unlockChallengeParams(minutes: minutes))
    }

    public func approvalsUnlock(minutes: Int, challenge: String, assertion: WebAuthnAssertion) async throws -> ApprovalsUnlockResponse {
        try await client.call(Self.unlockMethod, params: Self.unlockParams(minutes: minutes, challenge: challenge, assertion: assertion))
    }

    /// Maps a stream of CHUNK payloads to live records. A record this build can't read, or of a kind it doesn't know,
    /// is skipped, never fatal (B3).
    /// Pulled on demand (nothing reads ahead of the consumer), so the watch's credit tracks what's actually been
    /// taken. Dropping the returned stream drops the inner one, which sends CANCEL.
    static func decodeRecords(_ raw: AsyncThrowingStream<Data, Error>) -> AsyncThrowingStream<LiveRecord, Error> {
        let pull = RecordPull(raw)
        return AsyncThrowingStream { try await pull.next() }
    }
}

/// One consumer's pull through a watch's payloads, decoding as it goes.
private final class RecordPull: @unchecked Sendable {
    private var iterator: AsyncThrowingStream<Data, Error>.Iterator
    private let decoder = JSONDecoder()

    init(_ raw: AsyncThrowingStream<Data, Error>) {
        iterator = raw.makeAsyncIterator()
    }

    func next() async throws -> LiveRecord? {
        while let payload = try await iterator.next() {
            if let record = try? decoder.decode(LiveRecord.self, from: payload), record.kind != .other { return record }
        }
        return nil
    }
}

// MARK: - Demo (zero network)

/// The built-in demo workspace: fixed fixtures in the Engine API shapes, a simulated live watch.
public struct DemoCompanionSource: CompanionDataSource {
    /// Simulated latency, so loading states are real in the demo too.
    private let latency: Duration
    private let recordInterval: Duration

    public init(latency: Duration = .milliseconds(150), recordInterval: Duration = .milliseconds(1400)) {
        self.latency = latency
        self.recordInterval = recordInterval
    }

    public func workRows(view: WorkView, cursor: String?) async throws -> WorkRows {
        try await Task.sleep(for: latency)
        let all = try CompanionDemoFixtures.workRows()
        let rows: [WorkRow]
        switch view {
        case .all: rows = all.rows
        case .needsYou: rows = all.rows.filter { $0.rank == 0 }
        case .running: rows = all.rows.filter { $0.group == .building }
        case .completed: rows = all.rows.filter { $0.rank == 3 }
        }
        return WorkRows(
            version: all.version, project: all.project, projectName: all.projectName, needsCount: all.needsCount,
            groups: nil, rows: rows, needs: all.needs, next: nil, room: all.room
        )
    }

    public func taskSteps(task: String) async throws -> StepCards {
        try await Task.sleep(for: latency)
        return try CompanionDemoFixtures.steps(task: task)
    }

    public func taskDiff(task: String, run: Int?) async throws -> ResultDiff {
        try await Task.sleep(for: latency)
        return try CompanionDemoFixtures.diff(task: task)
    }

    public func taskDiffFile(task: String, run: Int, file: Int) async throws -> ResultDiffFile {
        try await Task.sleep(for: latency)
        return try CompanionDemoFixtures.diffFile(task: task, file: file)
    }

    public func runWindow(run: Int, cursor: String?) async throws -> LiveSessionWindow {
        try await Task.sleep(for: latency)
        let window = try CompanionDemoFixtures.liveWindow(run: run)
        // Rebase the sample records onto the last couple of minutes, so they read as live.
        let records = window.window.records ?? []
        let formatter = ISO8601DateFormatter()
        let now = Date()
        let rebased = records.enumerated().map { index, record in
            LiveRecord(
                kind: record.kind, at: formatter.string(from: now.addingTimeInterval(Double(index - records.count) * 20)),
                text: record.text, stepId: record.stepId, stepKind: record.stepKind, target: record.target,
                ok: record.ok, out: record.out, stream: record.stream, detail: record.detail, desc: record.desc,
                dropped: record.dropped
            )
        }
        let w = window.window
        return LiveSessionWindow(
            version: window.version, session: window.session, room: window.room, live: window.live, file: window.file,
            window: LiveWindow(
                ok: w.ok, records: rebased, cursor: w.cursor, restarted: w.restarted, earlier: w.earlier,
                quarantined: w.quarantined, skipped: w.skipped, more: w.more, reason: w.reason
            )
        )
    }

    public func watchRun(run: Int, cursor: String?) async throws -> AsyncThrowingStream<LiveRecord, Error> {
        let script = CompanionDemoFixtures.liveScript
        let interval = recordInterval
        let (stream, continuation) = AsyncThrowingStream<LiveRecord, Error>.makeStream()
        let task = Task {
            var index = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                if Task.isCancelled { break }
                let now = ISO8601DateFormatter().string(from: Date())
                let next = script[index % script.count]
                continuation.yield(LiveRecord(
                    kind: next.kind, at: now, text: next.text, stepId: next.stepId, stepKind: next.stepKind,
                    target: next.target, ok: next.ok
                ))
                index += 1
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    public static let demoPasskeyStatus = PasskeyStatus(
        registered: true, count: 1, enrollmentOpen: false, rpId: "toolroll.dev", windowMinutes: 15, freshUntil: nil,
        passkeys: [PasskeySummary(label: "iPhone", createdAt: "2026-11-27T09:00:00.000Z")]
    )

    public func passkeyStatus() async throws -> PasskeyStatus { Self.demoPasskeyStatus }

    public func passkeyLock() async throws -> PasskeyLockResponse {
        PasskeyLockResponse(ok: true, locked: true)
    }

    public func passkeyRegisterBegin() async throws -> PasskeyRegisterBeginResponse {
        throw CompanionRPCError(code: CompanionRPCError.unsupported, message: "The demo has no passkeys to set up.")
    }

    public func passkeyRegisterFinish(
        challenge: String, credentialId: String, clientDataJSON: String, attestationObject: String, label: String?
    ) async throws -> PasskeyRegisterFinishResponse {
        throw CompanionRPCError(code: CompanionRPCError.unsupported, message: "The demo has no passkeys to set up.")
    }

    public func approvalChallenge(
        verb: PasskeyApprovalVerb,
        task: String,
        digest: String?,
        runId: Int?,
        receiptDigest: String?,
        note: String?,
        publish: Bool?,
        forceFresh: Bool?
    ) async throws -> ApprovalChallengeResponse {
        try await Task.sleep(for: latency)
        let wording = verb == .approve
            ? "Approve task \(task) plan (\((digest ?? "").prefix(12)))"
            : "Accept task \(task) result (\((receiptDigest ?? "").prefix(12)))"
        return ApprovalChallengeResponse(
            challenge: "ZGVtby1jaGFsbGVuZ2U",
            rpId: "toolroll.dev",
            allowCredentials: [PasskeyCredentialDescriptor(id: "ZGVtby1jcmVk", type: "public-key")],
            userVerification: "required",
            verb: verb.rawValue,
            wording: wording,
            expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(120)),
            freshApproved: false,
            freshUntil: nil
        )
    }

    public func approveTask(task: String, digest: String, challenge: String, idempotencyKey: String, assertion: WebAuthnAssertion?, useFreshSession: Bool) async throws -> TaskApproveResponse {
        try await Task.sleep(for: latency)
        return TaskApproveResponse(ok: true, approved: true, task: task, digest: digest, freshUntil: ISO8601DateFormatter().string(from: Date().addingTimeInterval(900)))
    }

    public func acceptTask(task: String, runId: Int?, receiptDigest: String, note: String?, publish: Bool, challenge: String, idempotencyKey: String, assertion: WebAuthnAssertion?, useFreshSession: Bool) async throws -> TaskAcceptResponse {
        try await Task.sleep(for: latency)
        return TaskAcceptResponse(ok: true, accepted: true, published: publish, freshUntil: ISO8601DateFormatter().string(from: Date().addingTimeInterval(900)))
    }

    public var supportsApprovalsUnlock: Bool { false }

    public func approvalsUnlockChallenge(minutes: Int) async throws -> ApprovalChallengeResponse {
        throw CompanionRPCError(code: CompanionRPCError.unsupported, message: "The demo has nothing to unlock.")
    }

    public func approvalsUnlock(minutes: Int, challenge: String, assertion: WebAuthnAssertion) async throws -> ApprovalsUnlockResponse {
        throw CompanionRPCError(code: CompanionRPCError.unsupported, message: "The demo has nothing to unlock.")
    }
}
