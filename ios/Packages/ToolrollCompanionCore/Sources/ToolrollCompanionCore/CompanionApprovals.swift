import Foundation

// MARK: - In-app approvals (Gate 2, ADR 0005): one driver for Approve and Accept

/// One person's intent: what they tapped, bound to exactly what they saw. Two taps on the same thing are the same
/// intent (so a retry reuses its idempotency key); anything that changes what is signed (a new plan digest, another
/// result, another note) is a different intent.
public enum ApprovalIntent: Hashable, Sendable {
    case approve(task: String, digest: String)
    case accept(task: String, runId: Int?, receiptDigest: String, note: String?, publish: Bool)

    public var verb: PasskeyApprovalVerb {
        switch self {
        case .approve: return .approve
        case .accept: return .accept
        }
    }

    public var task: String {
        switch self {
        case .approve(let task, _), .accept(let task, _, _, _, _): return task
        }
    }
}

/// How an approval went through.
public enum ApprovalResult: Equatable, Sendable {
    case approved(TaskApproveResponse, usedPasskey: Bool)
    case accepted(TaskAcceptResponse, usedPasskey: Bool)

    /// A live passkey assertion confirmed it (false: inside the Mac's unlocked window).
    public var usedPasskey: Bool {
        switch self {
        case .approved(_, let used), .accepted(_, let used): return used
        }
    }
}

/// One idempotency key per user intent, kept until the Mac gives a definite answer.
///
/// The companion contract (`docs/plans/central-workspace-tui-contract.md`): an unconfirmed response keeps its request
/// key, so the retry is the same request and the Mac replays what happened instead of acting twice. A key is dropped on
/// success and on a definite refusal; it is kept when the outcome is unknown to the phone (the socket closed, the call
/// timed out, the Mac says it is still running it).
@MainActor
public final class ApprovalKeyLedger {
    private var keys: [ApprovalIntent: String] = [:]
    private let mint: () -> String

    public init(mint: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.mint = mint
    }

    /// The intent's key: the one kept from an unconfirmed attempt, or a new one.
    public func key(for intent: ApprovalIntent) -> String {
        if let key = keys[intent] { return key }
        let key = mint()
        keys[intent] = key
        return key
    }

    /// A new key for the same intent: the old one is settled on the Mac and must not be replayed.
    public func rotate(for intent: ApprovalIntent) -> String {
        let key = mint()
        keys[intent] = key
        return key
    }

    /// The attempt ended: forget the key unless the outcome is unknown.
    public func settle(_ intent: ApprovalIntent, error: Error?) {
        if let error, Self.outcomeUnknownToPhone(error) { return }
        keys[intent] = nil
    }

    public func pendingKey(for intent: ApprovalIntent) -> String? { keys[intent] }

    /// True when the request may have reached the Mac and nothing definite came back.
    public nonisolated static func outcomeUnknownToPhone(_ error: Error) -> Bool {
        if error is CompanionConnectionError { return true }
        if let rpc = error as? CompanionRPCError {
            return rpc.code == CompanionRPCError.deadlineExceeded || rpc.code == ApprovalCopy.inProgress
                || rpc.code == CompanionRPCError.invalidResponse
        }
        // Local failures (the passkey sheet, a cancelled task) happen before or around the call: keeping the key is
        // harmless, and it keeps the retry the same request if the call had gone out.
        return !(error is ApprovalLocalRefusal)
    }
}

/// A refusal the phone makes itself before anything is sent (nothing to reconcile).
public struct ApprovalLocalRefusal: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// The one Approve / Accept driver: challenge → (unlocked window or live passkey) → submit, with the Mac's step-up.
public enum ApprovalRunner {
    /// `alwaysAsk`: this iPhone's "Always ask" setting. The phone then asks the Mac for a live challenge
    /// (`forceFresh: true`) and never uses the unlocked window: it can only tighten what the Mac allows.
    /// `confirm` runs the passkey ceremony for a challenge (and shows its wording).
    @MainActor
    public static func run(
        _ intent: ApprovalIntent,
        source: any CompanionDataSource,
        keys: ApprovalKeyLedger,
        alwaysAsk: Bool,
        confirm: (ApprovalChallengeResponse) async throws -> WebAuthnAssertion
    ) async throws -> ApprovalResult {
        let challenge = try await requestChallenge(intent, source: source, forceFresh: alwaysAsk ? true : nil)
        if challenge.freshApproved == true, !alwaysAsk {
            do {
                return try await submit(intent, source: source, key: keys.key(for: intent), challenge: "", assertion: nil)
            } catch let rpc as CompanionRPCError where rpc.code == ApprovalCopy.stepUpRequired {
                // The window ran out (or this action always asks): step up once with a live passkey. This MUST use a new
                // key: the Mac settled the first one with the step-up refusal, and re-sending it would replay that.
                let key = keys.rotate(for: intent)
                let live = try await requestChallenge(intent, source: source, forceFresh: true)
                let assertion = try await confirm(live)
                return try await submit(intent, source: source, key: key, challenge: live.challenge, assertion: assertion)
            }
        }
        let assertion = try await confirm(challenge)
        return try await submit(intent, source: source, key: keys.key(for: intent), challenge: challenge.challenge, assertion: assertion)
    }

    static func requestChallenge(_ intent: ApprovalIntent, source: any CompanionDataSource, forceFresh: Bool?) async throws -> ApprovalChallengeResponse {
        switch intent {
        case .approve(let task, let digest):
            return try await source.approvalChallenge(
                verb: .approve, task: task, digest: digest, runId: nil, receiptDigest: nil, note: nil, publish: nil,
                forceFresh: forceFresh
            )
        case .accept(let task, let runId, let receipt, let note, let publish):
            return try await source.approvalChallenge(
                verb: .accept, task: task, digest: nil, runId: runId, receiptDigest: receipt, note: note, publish: publish,
                forceFresh: forceFresh
            )
        }
    }

    static func submit(
        _ intent: ApprovalIntent, source: any CompanionDataSource, key: String, challenge: String, assertion: WebAuthnAssertion?
    ) async throws -> ApprovalResult {
        let fresh = assertion == nil
        switch intent {
        case .approve(let task, let digest):
            let result = try await source.approveTask(
                task: task, digest: digest, challenge: challenge, idempotencyKey: key, assertion: assertion, useFreshSession: fresh
            )
            return .approved(result, usedPasskey: !fresh)
        case .accept(let task, let runId, let receipt, let note, let publish):
            let result = try await source.acceptTask(
                task: task, runId: runId, receiptDigest: receipt, note: note, publish: publish, challenge: challenge,
                idempotencyKey: key, assertion: assertion, useFreshSession: fresh
            )
            return .accepted(result, usedPasskey: !fresh)
        }
    }
}

// MARK: - What the person reads

/// How a failed approval shows: inline in the dock, or (only when the outcome is unknown) an alert that interrupts.
public enum ApprovalFailureKind: Equatable, Sendable {
    /// The plan or result changed on the Mac while it was on screen. Nothing was approved.
    case changed
    /// The outcome isn't known (the Mac restarted mid-action, or the answer never came). Refresh before anything else.
    case outcomeUnknown
    /// Anything else: a plain sentence in the dock.
    case failed
}

public struct ApprovalFailure: Equatable, Sendable {
    public let kind: ApprovalFailureKind
    public let message: String

    public init(kind: ApprovalFailureKind, message: String) {
        self.kind = kind
        self.message = message
    }
}

/// The words for every way an approval can fail. The codes are the Mac's (`src/companion/actions.ts`
/// `CompanionActionError`); nothing here shows a raw system description.
public enum ApprovalCopy {
    public static let invalidParams = "invalid_params"
    public static let notFound = "not_found"
    public static let standingRevoked = "standing_revoked"
    public static let enrollmentClosed = "enrollment_closed"
    public static let noPasskey = "no_passkey"
    public static let passkeyFailed = "passkey_failed"
    public static let stepUpRequired = "passkey_step_up_required"
    public static let keyConflict = "idempotency_key_conflict"
    public static let inProgress = "in_progress"
    public static let outcomeUnknown = "outcome_unknown"
    public static let refused = "refused"
    public static let unavailable = "unavailable"
    /// `passkey.unlock` / an unlock challenge: the Mac asks on every approval, so nothing can be unlocked.
    public static let windowOff = "approvals_window_off"

    /// `nil`: the person cancelled the passkey sheet — say nothing.
    public static func failure(_ error: Error, verb: PasskeyApprovalVerb) -> ApprovalFailure? {
        if error is CancellationError { return nil }
        if let local = error as? ApprovalLocalRefusal { return ApprovalFailure(kind: .failed, message: local.message) }
        if let rpc = error as? CompanionRPCError { return failure(code: rpc.code, message: rpc.message, verb: verb) }
        if error is CompanionConnectionError {
            return ApprovalFailure(
                kind: .outcomeUnknown,
                message: "Lost the connection to your Mac before it confirmed. Check the task before trying again."
            )
        }
        return ApprovalFailure(kind: .failed, message: "Something went wrong on this iPhone. Try again.")
    }

    public static func failure(code: String, message: String, verb: PasskeyApprovalVerb) -> ApprovalFailure {
        switch code {
        case refused:
            // The Mac's stale-plan / stale-result refusals say "changed"; its other refusals are already plain words.
            if message.localizedCaseInsensitiveContains("changed") {
                return ApprovalFailure(kind: .changed, message: changedMessage(verb))
            }
            return ApprovalFailure(kind: .failed, message: message.isEmpty ? "Your Mac refused that." : message)
        case outcomeUnknown, CompanionRPCError.deadlineExceeded, CompanionRPCError.invalidResponse:
            return ApprovalFailure(
                kind: .outcomeUnknown,
                message: "Your Mac didn't confirm whether that went through. Check the task before trying again."
            )
        case inProgress:
            return ApprovalFailure(kind: .failed, message: "That's already running on your Mac. Give it a moment.")
        case passkeyFailed:
            return ApprovalFailure(kind: .failed, message: "Your Mac couldn't verify that passkey. Try again, or add a new passkey in Settings.")
        case stepUpRequired:
            return ApprovalFailure(kind: .failed, message: "This needs your passkey. Try again.")
        case noPasskey:
            return ApprovalFailure(kind: .failed, message: "Set up a passkey in Settings before approving from this iPhone.")
        case enrollmentClosed:
            return ApprovalFailure(kind: .failed, message: "On your Mac, open Settings → Phone and choose Enable passkey on iPhone first.")
        case standingRevoked:
            return ApprovalFailure(kind: .failed, message: "This iPhone can't approve for your account anymore. Pair again from your Mac.")
        case notFound:
            return ApprovalFailure(kind: .failed, message: "This task isn't on your Mac anymore, or your account can't see it.")
        case keyConflict, invalidParams, CompanionRPCError.unsupported, CompanionRPCError.routeNotAllowed:
            return ApprovalFailure(kind: .failed, message: "Your Mac and this iPhone don't agree on this. Update Toolroll on both.")
        case unavailable:
            return ApprovalFailure(kind: .failed, message: "Your Mac can't do that right now. Try again in a moment.")
        default:
            return ApprovalFailure(kind: .failed, message: message.isEmpty ? "Your Mac couldn't complete that." : message)
        }
    }

    public static func changedMessage(_ verb: PasskeyApprovalVerb) -> String {
        verb == .approve
            ? "Nothing was approved. Changes are highlighted above."
            : "Nothing was accepted. Review the new result before accepting."
    }

    /// The one confirmation after a successful approval.
    public static func confirmation(_ result: ApprovalResult) -> String {
        switch result {
        case .approved(let response, let used):
            if response.secondApprover == true || !response.approved {
                if let have = response.have, let need = response.need {
                    return "Your approval is recorded · \(have) of \(need)"
                }
                return "Your approval is recorded · another approver is needed"
            }
            return used ? "Approved with passkey · build started" : "Approved · build started"
        case .accepted(let response, let used):
            if let pr = response.prNumber { return "Accepted · opened PR #\(pr)" }
            return used ? "Accepted with passkey · task complete" : "Accepted · task complete"
        }
    }
}

// MARK: - Stale plan: which terms changed

public enum ApprovalTermsChange {
    /// The labels of the rows whose words or lines differ between what the person read and the new plan.
    public static func changedLabels(old: ApprovalTerms, new: ApprovalTerms) -> Set<String> {
        var changed = Set<String>()
        let before = Dictionary(old.rows.map { ($0.label.lowercased(), $0) }, uniquingKeysWith: { first, _ in first })
        for row in new.rows {
            let key = row.label.lowercased()
            if let was = before[key] {
                if was.words != row.words || was.lines != row.lines { changed.insert(key) }
            } else {
                changed.insert(key)
            }
        }
        return changed
    }
}

// MARK: - Plan steps shown on Decide (from the step cards the phone already reads)

public struct PlanStep: Equatable, Sendable {
    public let number: Int
    public let key: StepKey
    public let title: String
    /// Agent and the step's own sentence, e.g. "Claude Opus 5.5 · Starts when you approve".
    public let detail: String?
    public let state: StepState
    public let mark: StepMark
}

public enum PlanSteps {
    /// The steps that run after the approval, in chain order. Never invents a step: only the cards the Mac sent.
    public static func after(approvalIn cards: StepCards) -> [PlanStep] {
        let chain = (cards.cards ?? []).filter(\.inChain)
        let start = (chain.firstIndex { $0.key == .approve }).map { $0 + 1 } ?? chain.firstIndex { $0.key != .plan } ?? 0
        let rest = start < chain.count ? Array(chain[start...]) : []
        return rest.enumerated().map { index, card in
            var parts: [String] = []
            if let agent = card.agent { parts.append(ModelName.display(provider: agent.provider, model: agent.model)) }
            if !card.sentence.isEmpty { parts.append(card.sentence) }
            let title = card.key == .ready || card.key == .review ? "Back to you for review" : card.label
            return PlanStep(
                number: index + 1, key: card.key, title: title,
                detail: parts.isEmpty ? nil : parts.joined(separator: " · "), state: card.state, mark: card.mark
            )
        }
    }

    /// "Build · step 1 of 3" while a step after the approval runs.
    public static func progress(_ cards: StepCards) -> (label: String, done: Int, total: Int)? {
        let steps = after(approvalIn: cards)
        guard !steps.isEmpty, let current = steps.first(where: { $0.state == .current || $0.mark == .live }) else { return nil }
        let done = steps.filter { $0.state == .done || $0.state == .skipped }.count
        return ("\(current.title) · step \(current.number) of \(steps.count)", done, steps.count)
    }
}

public enum ModelName {
    /// A readable model name from the Mac's ids ("claude-opus-5-5" → "Claude Opus 5.5"); unknown ids stay as sent.
    public static func display(provider: String, model: String?) -> String {
        guard let model, !model.isEmpty else { return provider.prefix(1).uppercased() + provider.dropFirst() }
        let parts = model.split(separator: "-").map(String.init)
        guard parts.first == "claude", parts.count >= 3 else { return model }
        var words: [String] = []
        var numbers: [String] = []
        for part in parts {
            if part.allSatisfy(\.isNumber) { numbers.append(part) } else { words.append(part.prefix(1).uppercased() + part.dropFirst()) }
        }
        return (words + (numbers.isEmpty ? [] : [numbers.joined(separator: ".")])).joined(separator: " ")
    }
}

// MARK: - App lock: "Unlock approvals when I open Toolroll"

/// How opening the app unlocks it.
public enum AppUnlockMethod: Equatable, Sendable {
    /// No cover (the setting is off, demo, or not paired).
    case none
    /// One live passkey assertion through the Mac (`approvals.unlock`): unlocks viewing and routine approvals.
    case passkey(minutes: Int)
    /// The device's own Face ID / passcode: unlocks viewing only. Approvals keep asking (or stay paused offline).
    case deviceOwner(ViewingOnlyReason)
}

public enum ViewingOnlyReason: Equatable, Sendable {
    /// The Mac can't be reached: saved items only; approvals are paused.
    case offline
    /// The Mac asks for a passkey on every approval.
    case macAsksEveryTime
    /// "Always ask on this iPhone" is on.
    case alwaysAsk
    /// No passkey is set up for this account yet.
    case noPasskey
    /// The Mac doesn't offer the unlock yet (an older Toolroll).
    case macCantUnlock
}

/// After the app is unlocked: what approvals do.
public enum ApprovalsAccess: Equatable, Sendable {
    case unlocked(until: Date)
    case viewingOnly(ViewingOnlyReason)
}

public enum AppLockPolicy {
    /// The unlock lengths offered, capped by the Mac's window.
    public static let lengths = [5, 15, 30, 60]

    public static func lengths(macWindow: Int?) -> [Int] {
        guard let macWindow, macWindow > 0 else { return [] }
        return lengths.filter { $0 <= macWindow }
    }

    /// The length to ask for: the person's choice if the Mac still allows it, else the Mac's window.
    public static func minutes(chosen: Int?, macWindow: Int) -> Int {
        let offered = lengths(macWindow: macWindow)
        if let chosen, offered.contains(chosen) { return chosen }
        return offered.last ?? macWindow
    }

    public static func method(
        enabled: Bool, paired: Bool, demo: Bool, reachable: Bool, alwaysAsk: Bool,
        passkeyRegistered: Bool?, macWindow: Int?, chosenMinutes: Int?, macSupportsUnlock: Bool
    ) -> AppUnlockMethod {
        guard enabled, paired, !demo else { return .none }
        guard reachable else { return .deviceOwner(.offline) }
        if alwaysAsk { return .deviceOwner(.alwaysAsk) }
        if passkeyRegistered == false { return .deviceOwner(.noPasskey) }
        if let macWindow, macWindow <= 0 { return .deviceOwner(.macAsksEveryTime) }
        guard macSupportsUnlock else { return .deviceOwner(.macCantUnlock) }
        return .passkey(minutes: minutes(chosen: chosenMinutes, macWindow: macWindow ?? 15))
    }

    /// The unlock RPC failed: whether to fall back to viewing only (and why), or to stay covered.
    public static func fallback(after error: Error) -> ViewingOnlyReason? {
        if let rpc = error as? CompanionRPCError {
            switch rpc.code {
            // An older Mac: it refuses the `unlock` verb (invalid_params) or doesn't route `passkey.unlock`.
            case CompanionRPCError.unsupported, CompanionRPCError.routeNotAllowed, ApprovalCopy.invalidParams: return .macCantUnlock
            case ApprovalCopy.noPasskey: return .noPasskey
            case ApprovalCopy.windowOff: return .macAsksEveryTime
            default: return nil
            }
        }
        if error is CompanionConnectionError { return .offline }
        return nil
    }

    public static func viewingOnlyMessage(_ reason: ViewingOnlyReason) -> String {
        switch reason {
        case .offline: return "Approvals are paused until your Mac is back."
        case .macAsksEveryTime: return "Each approval asks for your passkey (set on your Mac)."
        case .alwaysAsk: return "Each approval asks for your passkey (Always ask is on)."
        case .noPasskey: return "Set up a passkey in Settings to approve from this iPhone."
        case .macCantUnlock: return "Each approval asks for your passkey. Update Toolroll on your Mac to unlock approvals here."
        }
    }
}

// MARK: - Accept with exception: the result the sheet was opened for

/// The run and receipt an exception sheet shows. The sheet submits for exactly this result or not at all: if the task's
/// current result is another one, the sheet closes (Codex C3).
public struct PinnedResult: Equatable, Sendable {
    public let run: Int
    public let receipt: String

    public init(run: Int, receipt: String) {
        self.run = run
        self.receipt = receipt
    }

    public init(_ review: StepReview) {
        self.init(run: review.run, receipt: review.receipt)
    }

    /// The current result is still this one.
    public func isCurrent(_ review: StepReview?) -> Bool {
        guard let review else { return false }
        return review.run == run && review.receipt == receipt
    }
}
