import Foundation
import Testing
@testable import ToolrollCompanionCore

/// A data source that answers approvals from a script and records what the phone sent.
private final class ScriptedApprovals: CompanionDataSource, @unchecked Sendable {
    struct Sent: Equatable {
        let method: String
        let key: String?
        let fresh: Bool?
        let forceFresh: Bool?
        let hasAssertion: Bool
    }

    private let lock = NSLock()
    private var _sent: [Sent] = []
    private var submits: [Result<Void, Error>]
    private let freshApproved: Bool

    init(freshApproved: Bool = false, submits: [Result<Void, Error>]) {
        self.freshApproved = freshApproved
        self.submits = submits
    }

    var sent: [Sent] { lock.withLock { _sent } }

    private func record(_ s: Sent) { lock.withLock { _sent.append(s) } }
    private func nextSubmit() throws {
        let next: Result<Void, Error> = lock.withLock { submits.isEmpty ? .success(()) : submits.removeFirst() }
        try next.get()
    }

    func approvalChallenge(verb: PasskeyApprovalVerb, task: String, digest: String?, runId: Int?, receiptDigest: String?, note: String?, publish: Bool?, forceFresh: Bool?) async throws -> ApprovalChallengeResponse {
        record(Sent(method: "approval.challenge", key: nil, fresh: nil, forceFresh: forceFresh, hasAssertion: false))
        let fresh = freshApproved && forceFresh != true
        return ApprovalChallengeResponse(
            challenge: fresh ? "" : "Y2hhbGxlbmdl", rpId: "toolroll.dev", allowCredentials: [], userVerification: "required",
            verb: verb.rawValue, wording: "Approve task \(task) plan", expiresAt: "2026-11-27T10:00:00Z", freshApproved: fresh
        )
    }

    func approveTask(task: String, digest: String, challenge: String, idempotencyKey: String, assertion: WebAuthnAssertion?, useFreshSession: Bool) async throws -> TaskApproveResponse {
        record(Sent(method: "task.approve", key: idempotencyKey, fresh: useFreshSession, forceFresh: nil, hasAssertion: assertion != nil))
        try nextSubmit()
        return TaskApproveResponse(ok: true, approved: true, task: task, digest: digest)
    }

    func acceptTask(task: String, runId: Int?, receiptDigest: String, note: String?, publish: Bool, challenge: String, idempotencyKey: String, assertion: WebAuthnAssertion?, useFreshSession: Bool) async throws -> TaskAcceptResponse {
        record(Sent(method: "task.accept", key: idempotencyKey, fresh: useFreshSession, forceFresh: nil, hasAssertion: assertion != nil))
        try nextSubmit()
        return TaskAcceptResponse(ok: true, accepted: true, published: publish)
    }

    // Unused by these tests.
    func workRows(view: WorkView, cursor: String?) async throws -> WorkRows { throw CancellationError() }
    func taskSteps(task: String) async throws -> StepCards { throw CancellationError() }
    func taskDiff(task: String, run: Int?) async throws -> ResultDiff { throw CancellationError() }
    func taskDiffFile(task: String, run: Int, file: Int) async throws -> ResultDiffFile { throw CancellationError() }
    func runWindow(run: Int, cursor: String?) async throws -> LiveSessionWindow { throw CancellationError() }
    func watchRun(run: Int, cursor: String?) async throws -> AsyncThrowingStream<LiveRecord, Error> { throw CancellationError() }
    func passkeyStatus() async throws -> PasskeyStatus { throw CancellationError() }
    func passkeyLock() async throws -> PasskeyLockResponse { throw CancellationError() }
    func passkeyRegisterBegin() async throws -> PasskeyRegisterBeginResponse { throw CancellationError() }
    func passkeyRegisterFinish(challenge: String, credentialId: String, clientDataJSON: String, attestationObject: String, label: String?) async throws -> PasskeyRegisterFinishResponse { throw CancellationError() }
    var supportsApprovalsUnlock: Bool { false }
    func approvalsUnlockChallenge(minutes: Int) async throws -> ApprovalChallengeResponse { throw CancellationError() }
    func approvalsUnlock(minutes: Int, challenge: String, assertion: WebAuthnAssertion) async throws -> ApprovalsUnlockResponse { throw CancellationError() }
}

private let assertion = WebAuthnAssertion(credentialId: "Y3JlZA", clientDataJSON: "e30", authenticatorData: "AA", signature: "AA", userHandle: "dQ")
private let intent = ApprovalIntent.approve(task: "t-1", digest: "7a4e")

@MainActor
private func counterLedger() -> ApprovalKeyLedger {
    var n = 0
    return ApprovalKeyLedger { n += 1; return "key-\(n)" }
}

@MainActor
private func attempt(_ source: ScriptedApprovals, _ keys: ApprovalKeyLedger, alwaysAsk: Bool = false, intent: ApprovalIntent = intent) async -> Error? {
    do {
        _ = try await ApprovalRunner.run(intent, source: source, keys: keys, alwaysAsk: alwaysAsk) { _ in assertion }
        keys.settle(intent, error: nil)
        return nil
    } catch {
        keys.settle(intent, error: error)
        return error
    }
}

@Test("a retry after the connection dropped re-sends the same idempotency key")
@MainActor
func retryReusesKeyAfterUnknownOutcome() async {
    let keys = counterLedger()
    let source = ScriptedApprovals(submits: [.failure(CompanionConnectionError.closed), .success(())])
    #expect(await attempt(source, keys) is CompanionConnectionError)
    #expect(await attempt(source, keys) == nil)
    let approveKeys = source.sent.filter { $0.method == "task.approve" }.map(\.key)
    #expect(approveKeys == ["key-1", "key-1"])
    #expect(keys.pendingKey(for: intent) == nil)
}

@Test("a timeout and in_progress keep the key; a definite refusal drops it")
@MainActor
func refusalDropsKey() async {
    let keys = counterLedger()
    let source = ScriptedApprovals(submits: [
        .failure(CompanionRPCError(code: CompanionRPCError.deadlineExceeded, message: "")),
        .failure(CompanionRPCError(code: "in_progress", message: "")),
        .failure(CompanionRPCError(code: "refused", message: "This plan changed. Refresh before approving.")),
        .success(()),
    ])
    for _ in 0..<4 { _ = await attempt(source, keys) }
    let approveKeys = source.sent.filter { $0.method == "task.approve" }.map(\.key)
    #expect(approveKeys == ["key-1", "key-1", "key-1", "key-2"])
}

@Test("a changed intent (new digest) gets its own key")
@MainActor
func newIntentNewKey() async {
    let keys = counterLedger()
    let source = ScriptedApprovals(submits: [.failure(CompanionConnectionError.closed), .success(())])
    _ = await attempt(source, keys)
    _ = await attempt(source, keys, intent: .approve(task: "t-1", digest: "b0b0"))
    #expect(source.sent.filter { $0.method == "task.approve" }.map(\.key) == ["key-1", "key-2"])
}

@Test("inside the unlocked window: no assertion; a step-up mints a new key and asks for a live challenge")
@MainActor
func stepUpRotatesKey() async throws {
    let keys = counterLedger()
    let source = ScriptedApprovals(freshApproved: true, submits: [
        .failure(CompanionRPCError(code: "passkey_step_up_required", message: "Your passkey window expired.")),
        .success(()),
    ])
    var prompted = 0
    let result = try await ApprovalRunner.run(intent, source: source, keys: keys, alwaysAsk: false) { _ in
        prompted += 1
        return assertion
    }
    #expect(result.usedPasskey)
    #expect(prompted == 1)
    let sent = source.sent
    #expect(sent.map(\.method) == ["approval.challenge", "task.approve", "approval.challenge", "task.approve"])
    #expect(sent[1] == .init(method: "task.approve", key: "key-1", fresh: true, forceFresh: nil, hasAssertion: false))
    #expect(sent[2].forceFresh == true)
    #expect(sent[3] == .init(method: "task.approve", key: "key-2", fresh: false, forceFresh: nil, hasAssertion: true))
}

@Test("inside the window without a step-up, the approval goes through with no passkey prompt")
@MainActor
func freshWindowApproves() async throws {
    let source = ScriptedApprovals(freshApproved: true, submits: [.success(())])
    let result = try await ApprovalRunner.run(intent, source: source, keys: counterLedger(), alwaysAsk: false) { _ in
        Issue.record("must not prompt")
        return assertion
    }
    #expect(!result.usedPasskey)
}

@Test("Always ask on this iPhone: forceFresh on the challenge and a live assertion, even when the Mac would allow the window")
@MainActor
func alwaysAskForcesLiveAssertion() async throws {
    let source = ScriptedApprovals(freshApproved: true, submits: [.success(())])
    let result = try await ApprovalRunner.run(intent, source: source, keys: counterLedger(), alwaysAsk: true) { _ in assertion }
    #expect(result.usedPasskey)
    #expect(source.sent.first?.forceFresh == true)
    #expect(source.sent.last?.fresh == false)
    #expect(source.sent.last?.hasAssertion == true)
}

@Test("cancelling the passkey sheet says nothing and sends nothing")
@MainActor
func cancelIsSilent() async {
    let source = ScriptedApprovals(submits: [])
    do {
        _ = try await ApprovalRunner.run(intent, source: source, keys: counterLedger(), alwaysAsk: false) { _ in throw CancellationError() }
        Issue.record("expected cancel")
    } catch {
        #expect(ApprovalCopy.failure(error, verb: .approve) == nil)
    }
    #expect(source.sent.map(\.method) == ["approval.challenge"])
}

private func json(_ value: some Encodable) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Test("approval.challenge params: verb as a string, forceFresh sent only when asked, nil fields omitted")
func challengeParamsEncoding() throws {
    let forced = try json(LiveCompanionSource.challengeParams(
        verb: .approve, task: "t-1", digest: "7a4e", runId: nil, receiptDigest: nil, note: nil, publish: nil, forceFresh: true
    ))
    #expect(forced["verb"] as? String == "approve")
    #expect(forced["digest"] as? String == "7a4e")
    #expect(forced["forceFresh"] as? Bool == true)
    #expect(forced["runId"] == nil && forced["note"] == nil && forced["key"] == nil)
    let plain = try json(LiveCompanionSource.challengeParams(
        verb: .accept, task: "t-1", digest: nil, runId: 38, receiptDigest: "4a8d", note: "flaky", publish: false, forceFresh: nil
    ))
    #expect(plain["forceFresh"] == nil)
    #expect(plain["runId"] as? Int == 38)
    #expect(plain["publish"] as? Bool == false)
}

@Test("task.approve params: the assertion is omitted inside the window, present otherwise; the key is lowercase UUIDv4")
func approveParamsEncoding() throws {
    let key = UUID().uuidString.lowercased()
    #expect(key.range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#, options: .regularExpression) != nil)
    let fresh = try json(LiveCompanionSource.approveParams(task: "t", digest: "d", challenge: "", idempotencyKey: key, assertion: nil, useFreshSession: true))
    #expect(fresh["assertion"] == nil)
    #expect(fresh["useFreshSession"] as? Bool == true)
    #expect(fresh["idempotencyKey"] as? String == key)
    let live = try json(LiveCompanionSource.approveParams(task: "t", digest: "d", challenge: "c", idempotencyKey: key, assertion: assertion, useFreshSession: false))
    #expect((live["assertion"] as? [String: Any])?["credentialId"] as? String == "Y3JlZA")
}

@Test("a refusal the Mac replays inside a success envelope is thrown as that refusal")
func replayedRefusalThrows() throws {
    let body = Data(#"{"ok":true,"result":{"ok":false,"code":"refused","message":"This plan changed. Refresh and review the latest terms."}}"#.utf8)
    #expect(throws: CompanionRPCError(code: "refused", message: "This plan changed. Refresh and review the latest terms.")) {
        _ = try JSONDecoder().decode(CompanionRPCEnvelope<TaskApproveResponse>.self, from: body)
    }
    let ok = Data(#"{"ok":true,"result":{"ok":true,"approved":false,"secondApprover":true,"have":1,"need":2}}"#.utf8)
    let decoded = try JSONDecoder().decode(CompanionRPCEnvelope<TaskApproveResponse>.self, from: ok).result
    #expect(decoded.secondApprover == true && decoded.have == 1)
    let accept = Data(#"{"ok":true,"accepted":true,"published":false,"prUrl":null,"prNumber":null,"freshUntil":null}"#.utf8)
    #expect(try JSONDecoder().decode(TaskAcceptResponse.self, from: accept).accepted)
}

@Test("passkey.status decodes with and without the optional passkey list")
func passkeyStatusDecoding() throws {
    let bare = Data(#"{"registered":true,"count":1,"enrollmentOpen":false,"rpId":"toolroll.dev","windowMinutes":15,"freshUntil":null}"#.utf8)
    let status = try JSONDecoder().decode(PasskeyStatus.self, from: bare)
    #expect(status.passkeys == nil && status.windowMinutes == 15)
    let listed = Data(#"{"registered":true,"count":1,"enrollmentOpen":false,"rpId":"toolroll.dev","passkeys":[{"label":"iPhone","createdAt":"2026-11-27T09:00:00.000Z"}]}"#.utf8)
    #expect(try JSONDecoder().decode(PasskeyStatus.self, from: listed).passkeys?.first?.label == "iPhone")
}

@Test("every code the Mac sends maps to plain words; stale plans are inline, unknown outcomes interrupt")
func errorCopy() {
    let changed = ApprovalCopy.failure(CompanionRPCError(code: "refused", message: "This plan changed. Refresh before approving."), verb: .approve)
    #expect(changed?.kind == .changed)
    #expect(changed?.message == "Nothing was approved. Changes are highlighted above.")
    let resultChanged = ApprovalCopy.failure(CompanionRPCError(code: "refused", message: "This result changed. Refresh before accepting."), verb: .accept)
    #expect(resultChanged?.kind == .changed)
    let policy = ApprovalCopy.failure(CompanionRPCError(code: "refused", message: "Only an approver account can authorize actions from iPhone."), verb: .approve)
    #expect(policy == ApprovalFailure(kind: .failed, message: "Only an approver account can authorize actions from iPhone."))
    #expect(ApprovalCopy.failure(CompanionRPCError(code: "outcome_unknown", message: "x"), verb: .accept)?.kind == .outcomeUnknown)
    #expect(ApprovalCopy.failure(CompanionConnectionError.closed, verb: .approve)?.kind == .outcomeUnknown)
    for code in ["passkey_failed", "standing_revoked", "invalid_params", "no_passkey", "enrollment_closed", "in_progress",
                 "idempotency_key_conflict", "not_found", "unavailable", "passkey_step_up_required"] {
        let failure = ApprovalCopy.failure(CompanionRPCError(code: code, message: "raw \(code)"), verb: .approve)
        #expect(failure?.kind == .failed)
        #expect(failure?.message.contains("raw") == false, "\(code) shows plain words")
    }
    struct Weird: Error {}
    #expect(ApprovalCopy.failure(Weird(), verb: .approve)?.message == "Something went wrong on this iPhone. Try again.")
}

@Test("the one confirmation says how it was confirmed and what happens next")
func confirmations() {
    #expect(ApprovalCopy.confirmation(.approved(TaskApproveResponse(ok: true, approved: true), usedPasskey: true)) == "Approved with passkey · build started")
    #expect(ApprovalCopy.confirmation(.approved(TaskApproveResponse(ok: true, approved: true), usedPasskey: false)) == "Approved · build started")
    #expect(ApprovalCopy.confirmation(.approved(TaskApproveResponse(ok: true, approved: false, secondApprover: true, have: 1, need: 2), usedPasskey: true)) == "Your approval is recorded · 1 of 2")
    #expect(ApprovalCopy.confirmation(.approved(TaskApproveResponse(ok: true, approved: false, secondApprover: true), usedPasskey: true)) == "Your approval is recorded · another approver is needed")
    #expect(ApprovalCopy.confirmation(.accepted(TaskAcceptResponse(ok: true, accepted: true, published: false), usedPasskey: true)) == "Accepted with passkey · task complete")
}

@Test("a stale plan names the rows that changed")
func termsChange() {
    func terms(_ rows: [(String, String, [String])]) -> ApprovalTerms {
        ApprovalTerms(key: "k", revision: nil, rows: rows.map { .init(label: $0.0, words: $0.1, lines: $0.2) }, warnings: [], usualLabel: "", usual: [])
    }
    let old = terms([("Done when", "24 hours", []), ("Files", "two", ["a", "b"]), ("May cost", "$2", [])])
    let new = terms([("Done when", "48 hours", []), ("Files", "two", ["a", "b", "c"]), ("May cost", "$2", []), ("Network", "off", [])])
    #expect(ApprovalTermsChange.changedLabels(old: old, new: new) == ["done when", "files", "network"])
}

@Test("Decide's plan lists only the steps after the approval, with the agent")
func planSteps() throws {
    let cards = try CompanionDemoFixtures.steps(task: CompanionDemoFixtures.decideTask)
    let steps = PlanSteps.after(approvalIn: cards)
    #expect(steps.map(\.title) == ["Build", "Checks", "Back to you for review"])
    #expect(steps[0].detail == "Claude Opus 5.5 · Starts when you approve")
    #expect(steps.map(\.number) == [1, 2, 3])
    let running = try CompanionDemoFixtures.steps(task: CompanionDemoFixtures.runningTask)
    #expect(PlanSteps.progress(running)?.label == "Build · step 1 of 3")
    #expect(PlanSteps.progress(cards) == nil)
}

@Test("model ids read as names")
func modelNames() {
    #expect(ModelName.display(provider: "claude", model: "claude-opus-5-5") == "Claude Opus 5.5")
    #expect(ModelName.display(provider: "claude", model: "claude-sonnet-5-5") == "Claude Sonnet 5.5")
    #expect(ModelName.display(provider: "codex", model: "gpt-5.5-codex") == "gpt-5.5-codex")
    #expect(ModelName.display(provider: "codex", model: nil) == "Codex")
}

@Test("the exception sheet's result is pinned: another run or receipt is not the same result")
func pinnedResult() throws {
    let review = try #require(try CompanionDemoFixtures.steps(task: CompanionDemoFixtures.reviewTask).review)
    let pin = PinnedResult(review)
    #expect(pin.isCurrent(review))
    #expect(!pin.isCurrent(nil))
    let newer = StepReview(run: review.run + 1, receipt: review.receipt, source: review.source, accept: review.accept)
    #expect(!pin.isCurrent(newer))
    let reread = StepReview(run: review.run, receipt: String(repeating: "0", count: 64), source: review.source, accept: review.accept)
    #expect(!pin.isCurrent(reread))
}

@Test("unlocking on open: passkey when the Mac allows a window, viewing only otherwise")
func appLockMethod() {
    func method(enabled: Bool = true, reachable: Bool = true, alwaysAsk: Bool = false, registered: Bool? = true, window: Int? = 15, chosen: Int? = nil, supports: Bool = true) -> AppUnlockMethod {
        AppLockPolicy.method(enabled: enabled, paired: true, demo: false, reachable: reachable, alwaysAsk: alwaysAsk,
                             passkeyRegistered: registered, macWindow: window, chosenMinutes: chosen, macSupportsUnlock: supports)
    }
    #expect(method(enabled: false) == AppUnlockMethod.none)
    #expect(AppLockPolicy.method(enabled: true, paired: true, demo: true, reachable: true, alwaysAsk: false, passkeyRegistered: true, macWindow: 15, chosenMinutes: nil, macSupportsUnlock: true) == AppUnlockMethod.none)
    #expect(method() == .passkey(minutes: 15))
    #expect(method(window: 60, chosen: 30) == .passkey(minutes: 30))
    #expect(method(window: 15, chosen: 60) == .passkey(minutes: 15))
    #expect(method(reachable: false) == .deviceOwner(.offline))
    #expect(method(alwaysAsk: true) == .deviceOwner(.alwaysAsk))
    #expect(method(window: 0) == .deviceOwner(.macAsksEveryTime))
    #expect(method(registered: false) == .deviceOwner(.noPasskey))
    #expect(method(supports: false) == .deviceOwner(.macCantUnlock))
}

@Test("unlock lengths: only those the Mac allows; the Mac's window by default")
func unlockLengths() {
    #expect(AppLockPolicy.lengths(macWindow: 15) == [5, 15])
    #expect(AppLockPolicy.lengths(macWindow: 60) == [5, 15, 30, 60])
    #expect(AppLockPolicy.lengths(macWindow: 0) == [])
    #expect(AppLockPolicy.minutes(chosen: nil, macWindow: 60) == 60)
    #expect(AppLockPolicy.minutes(chosen: 5, macWindow: 60) == 5)
}

@Test("a failed unlock falls back to viewing only for known reasons, and stays covered otherwise")
func unlockFallback() {
    #expect(AppLockPolicy.fallback(after: CompanionRPCError(code: "route_not_allowed", message: "")) == .macCantUnlock)
    #expect(AppLockPolicy.fallback(after: CompanionRPCError(code: "approvals_window_off", message: "Your Mac asks for your passkey on every approval.")) == .macAsksEveryTime)
    #expect(AppLockPolicy.fallback(after: CompanionRPCError(code: "invalid_params", message: "verb must be approve, accept, land, or ship")) == .macCantUnlock)
    #expect(AppLockPolicy.fallback(after: CompanionConnectionError.closed) == .offline)
    #expect(AppLockPolicy.fallback(after: CompanionRPCError(code: "passkey_failed", message: "")) == nil)
}

@Test("unlock: approval.challenge with verb unlock and the minutes, then passkey.unlock with the same minutes")
func unlockParamsEncoding() throws {
    let challenge = try json(LiveCompanionSource.unlockChallengeParams(minutes: 15))
    #expect(challenge["verb"] as? String == "unlock")
    #expect(challenge["minutes"] as? Int == 15)
    let unlock = try json(LiveCompanionSource.unlockParams(minutes: 15, challenge: "c", assertion: assertion))
    #expect(unlock["minutes"] as? Int == 15)
    #expect(unlock["challenge"] as? String == "c")
    #expect(unlock["idempotencyKey"] == nil)
    #expect(LiveCompanionSource.unlockMethod == "passkey.unlock")
    let body = Data(#"{"ok":true,"unlocked":true,"minutes":15,"windowMinutes":60,"freshUntil":"2026-11-27T10:58:00.000Z"}"#.utf8)
    let decoded = try JSONDecoder().decode(ApprovalsUnlockResponse.self, from: body)
    #expect(decoded.unlocked == true && decoded.minutes == 15 && decoded.windowMinutes == 60)
}
