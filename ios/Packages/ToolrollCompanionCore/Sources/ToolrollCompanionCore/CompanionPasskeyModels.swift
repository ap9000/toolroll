import Foundation

// MARK: - Gate 2 Passkey Registration & Approval RPC Contracts (ADR 0005)

public struct PasskeyStatus: Codable, Equatable, Sendable {
    public let registered: Bool
    public let count: Int
    public let enrollmentOpen: Bool
    public let rpId: String
    /// The Mac's prompt window in minutes (0: every approval asks).
    public let windowMinutes: Int?
    /// When this iPhone's unlocked window ends (nil: locked).
    public let freshUntil: String?
    /// The account's active passkeys, when the Mac sends them (optional on the wire).
    public let passkeys: [PasskeySummary]?

    public init(
        registered: Bool, count: Int, enrollmentOpen: Bool, rpId: String, windowMinutes: Int? = nil,
        freshUntil: String? = nil, passkeys: [PasskeySummary]? = nil
    ) {
        self.registered = registered
        self.count = count
        self.enrollmentOpen = enrollmentOpen
        self.rpId = rpId
        self.windowMinutes = windowMinutes
        self.freshUntil = freshUntil
        self.passkeys = passkeys
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        registered = try c.decode(Bool.self, forKey: .registered)
        count = try c.decode(Int.self, forKey: .count)
        enrollmentOpen = try c.decode(Bool.self, forKey: .enrollmentOpen)
        rpId = try c.decode(String.self, forKey: .rpId)
        windowMinutes = try c.decodeIfPresent(Int.self, forKey: .windowMinutes)
        freshUntil = try c.decodeIfPresent(String.self, forKey: .freshUntil)
        passkeys = (try? c.decodeIfPresent([PasskeySummary].self, forKey: .passkeys)) ?? nil
    }

    /// This copy with a new unlocked-until time.
    public func with(freshUntil: String?) -> PasskeyStatus {
        PasskeyStatus(
            registered: registered, count: count, enrollmentOpen: enrollmentOpen, rpId: rpId,
            windowMinutes: windowMinutes, freshUntil: freshUntil, passkeys: passkeys
        )
    }
}

/// One active passkey, as the Mac lists it.
public struct PasskeySummary: Codable, Equatable, Sendable {
    public let label: String
    public let createdAt: String?

    public init(label: String, createdAt: String?) {
        self.label = label
        self.createdAt = createdAt
    }
}

public struct PasskeyLockResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let locked: Bool

    public init(ok: Bool, locked: Bool) {
        self.ok = ok
        self.locked = locked
    }
}

public struct PasskeyRP: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
}

public struct PasskeyUser: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let displayName: String
}

public struct PasskeyCredentialDescriptor: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
}

public struct PasskeyRegisterBeginResponse: Codable, Equatable, Sendable {
    public let challenge: String
    public let rp: PasskeyRP
    public let user: PasskeyUser
    public let expiresAt: String
}

public struct PasskeyRegisterFinishResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let credentialId: String
    public let label: String
}

/// The verbs this iPhone asks to confirm. Landing and shipping stay on the Mac.
public enum PasskeyApprovalVerb: String, Codable, Equatable, Sendable {
    case approve
    case accept
}

public struct ApprovalChallengeResponse: Codable, Equatable, Sendable {
    public let challenge: String
    public let rpId: String
    public let allowCredentials: [PasskeyCredentialDescriptor]
    public let userVerification: String
    /// The verb the Mac bound (a string, so a verb this build doesn't send can't fail the decode).
    public let verb: String
    /// What is being signed, in the Mac's words ("Approve task … plan (7a4e91c0b2f3)"): shown during the ceremony.
    public let wording: String
    public let expiresAt: String
    public let freshApproved: Bool?
    public let freshUntil: String?

    public init(
        challenge: String,
        rpId: String,
        allowCredentials: [PasskeyCredentialDescriptor],
        userVerification: String,
        verb: String,
        wording: String,
        expiresAt: String,
        freshApproved: Bool? = nil,
        freshUntil: String? = nil
    ) {
        self.challenge = challenge
        self.rpId = rpId
        self.allowCredentials = allowCredentials
        self.userVerification = userVerification
        self.verb = verb
        self.wording = wording
        self.expiresAt = expiresAt
        self.freshApproved = freshApproved
        self.freshUntil = freshUntil
    }
}

public struct WebAuthnAssertion: Codable, Equatable, Sendable {
    public let credentialId: String
    public let clientDataJSON: String
    public let authenticatorData: String
    public let signature: String
    public let userHandle: String

    public init(
        credentialId: String,
        clientDataJSON: String,
        authenticatorData: String,
        signature: String,
        userHandle: String
    ) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signature = signature
        self.userHandle = userHandle
    }
}

/// A stored refusal the Mac replays inside a success envelope (`{ok:false, code, message}`) is thrown as the RPC error it
/// was, never decoded as a success (and never fails as a confusing decode error).
private struct ReplayedRefusal: Decodable {
    let ok: Bool?
    let code: String?
    let message: String?

    static func check(_ decoder: Decoder) throws {
        let probe = try ReplayedRefusal(from: decoder)
        if probe.ok == false {
            throw CompanionRPCError(code: probe.code ?? "refused", message: probe.message ?? "Your Mac refused that.")
        }
    }
}

public struct TaskApproveResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let approved: Bool
    public let secondApprover: Bool?
    public let have: Int?
    public let need: Int?
    public let task: String?
    public let digest: String?
    public let freshUntil: String?

    public init(
        ok: Bool, approved: Bool, secondApprover: Bool? = nil, have: Int? = nil, need: Int? = nil, task: String? = nil,
        digest: String? = nil, freshUntil: String? = nil
    ) {
        self.ok = ok
        self.approved = approved
        self.secondApprover = secondApprover
        self.have = have
        self.need = need
        self.task = task
        self.digest = digest
        self.freshUntil = freshUntil
    }

    public init(from decoder: Decoder) throws {
        try ReplayedRefusal.check(decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        approved = try c.decode(Bool.self, forKey: .approved)
        secondApprover = try c.decodeIfPresent(Bool.self, forKey: .secondApprover)
        have = try c.decodeIfPresent(Int.self, forKey: .have)
        need = try c.decodeIfPresent(Int.self, forKey: .need)
        task = try c.decodeIfPresent(String.self, forKey: .task)
        digest = try c.decodeIfPresent(String.self, forKey: .digest)
        freshUntil = try c.decodeIfPresent(String.self, forKey: .freshUntil)
    }
}

public struct TaskAcceptResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let accepted: Bool
    public let published: Bool
    public let prUrl: String?
    public let prNumber: Int?
    public let freshUntil: String?

    public init(ok: Bool, accepted: Bool, published: Bool, prUrl: String? = nil, prNumber: Int? = nil, freshUntil: String? = nil) {
        self.ok = ok
        self.accepted = accepted
        self.published = published
        self.prUrl = prUrl
        self.prNumber = prNumber
        self.freshUntil = freshUntil
    }

    public init(from decoder: Decoder) throws {
        try ReplayedRefusal.check(decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        accepted = try c.decode(Bool.self, forKey: .accepted)
        published = try c.decodeIfPresent(Bool.self, forKey: .published) ?? false
        prUrl = try c.decodeIfPresent(String.self, forKey: .prUrl)
        prNumber = try c.decodeIfPresent(Int.self, forKey: .prNumber)
        freshUntil = try c.decodeIfPresent(String.self, forKey: .freshUntil)
    }
}

/// `passkey.unlock`: `{ok, unlocked, minutes, windowMinutes, freshUntil}` — `minutes` is the length the Mac granted
/// (clamped to its window). Optional fields so a shape change fails soft.
public struct ApprovalsUnlockResponse: Codable, Equatable, Sendable {
    public let ok: Bool?
    public let unlocked: Bool?
    public let minutes: Int?
    public let windowMinutes: Int?
    public let freshUntil: String?

    public init(ok: Bool?, unlocked: Bool?, minutes: Int?, windowMinutes: Int?, freshUntil: String?) {
        self.ok = ok
        self.unlocked = unlocked
        self.minutes = minutes
        self.windowMinutes = windowMinutes
        self.freshUntil = freshUntil
    }

    public init(from decoder: Decoder) throws {
        try ReplayedRefusal.check(decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
        unlocked = try c.decodeIfPresent(Bool.self, forKey: .unlocked)
        minutes = try c.decodeIfPresent(Int.self, forKey: .minutes)
        windowMinutes = try c.decodeIfPresent(Int.self, forKey: .windowMinutes)
        freshUntil = try c.decodeIfPresent(String.self, forKey: .freshUntil)
    }
}
