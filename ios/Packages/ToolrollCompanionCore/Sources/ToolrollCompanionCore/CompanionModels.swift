import Foundation

/// Truthful connection state (ADR 0004): losing contact never claims why (asleep, restored, …).
public enum CompanionConnectionState: Equatable, Sendable {
    case unpaired
    case demo
    /// Paired; the first connection of this launch is being made.
    case connecting
    case connected(workspaceLabel: String, since: Date)
    /// A reconnect actually failed. Cached data stays on screen, dimmed.
    case unreachable(lastUpdated: Date?)
    /// The Mac refused this iPhone's keys (or hello failed). The pairing is kept; Retry or Pair again.
    case notRecognized
}

/// Where a pairing attempt stands (shown over everything else while it runs).
public enum CompanionPairingPhase: Equatable, Sendable {
    case idle
    case contacting
    case awaitingMacConfirm(code: String)
}

public struct PairingQRPayload: Codable, Equatable, Sendable {
    public let v: Int
    public let relayUrl: String
    public let machineId: String
    public let workspaceId: String
    public let macStaticPub: String
    public let pairSessionId: String
    public let pairPsk: String
    public let pairConnToken: String
}

public struct PairedWorkspaceRecord: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let workspaceLabel: String
    public let machineId: String
    public let relayUrl: String
    public let macStaticPubBase64Url: String
    public let deviceId: String
    public let recoveryGeneration: String
    public let pairedAt: Date
}
