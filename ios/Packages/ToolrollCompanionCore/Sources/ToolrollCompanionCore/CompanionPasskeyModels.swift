import Foundation

// MARK: - Gate 2 Passkey Registration & Approval RPC Contracts (ADR 0005)

public struct PasskeyStatus: Codable, Equatable, Sendable {
    public let registered: Bool
    public let count: Int
    public let enrollmentOpen: Bool
    public let rpId: String

    public init(registered: Bool, count: Int, enrollmentOpen: Bool, rpId: String) {
        self.registered = registered
        self.count = count
        self.enrollmentOpen = enrollmentOpen
        self.rpId = rpId
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

public enum PasskeyApprovalVerb: String, Codable, Equatable, Sendable {
    case approve
    case accept
    case land
    case ship
}

public struct ApprovalChallengeResponse: Codable, Equatable, Sendable {
    public let challenge: String
    public let rpId: String
    public let allowCredentials: [PasskeyCredentialDescriptor]
    public let userVerification: String
    public let verb: PasskeyApprovalVerb
    public let wording: String
    public let expiresAt: String

    public init(
        challenge: String,
        rpId: String,
        allowCredentials: [PasskeyCredentialDescriptor],
        userVerification: String,
        verb: PasskeyApprovalVerb,
        wording: String,
        expiresAt: String
    ) {
        self.challenge = challenge
        self.rpId = rpId
        self.allowCredentials = allowCredentials
        self.userVerification = userVerification
        self.verb = verb
        self.wording = wording
        self.expiresAt = expiresAt
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

public struct TaskApproveResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let approved: Bool
    public let secondApprover: Bool?
    public let have: Int?
    public let need: Int?
    public let task: String?
    public let digest: String?
}

public struct TaskAcceptResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let accepted: Bool
    public let published: Bool
    public let prUrl: String?
    public let prNumber: Int?
}

public struct TaskLandResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let landed: Bool
    public let replayed: Bool?
    public let branch: String?
    public let commit: String?
    public let mode: String?
    public let handoffCommand: String?
}

public struct TaskShipResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let shipped: Bool
    public let commit: String?
}
