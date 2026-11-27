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

/// The pairing QR code (`v: 2`). Build one with `parse(_:)`, which enforces every rule in the wire contract.
public struct PairingQRPayload: Codable, Equatable, Sendable {
    public static let version = 2

    public let v: Int
    public let paths: [CompanionPath]
    public let machineId: String
    public let workspaceId: String
    public let macStaticPub: String
    public let pairSessionId: String
    public let pairPsk: String
    /// Present exactly when a hosted path is.
    public let pairConnToken: String?

    public var hostedPath: CompanionPath? { paths.first { $0.kind == .hosted } }

    /// Decodes and validates a scanned or pasted pairing code.
    public static func parse(_ text: String) throws -> PairingQRPayload {
        let data = Data(text.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        struct Version: Decodable { let v: Int }
        guard let version = try? JSONDecoder().decode(Version.self, from: data) else {
            throw PairingPayloadError.invalid("not a pairing code")
        }
        if version.v < Self.version { throw PairingPayloadError.olderToolroll }
        if version.v > Self.version { throw PairingPayloadError.newerToolroll }
        let payload: PairingQRPayload
        do {
            payload = try JSONDecoder().decode(PairingQRPayload.self, from: data)
        } catch {
            throw PairingPayloadError.invalid("missing or malformed fields")
        }
        try payload.validate()
        return payload
    }

    /// The contract's rules: valid paths, a token iff there is a hosted path, ids present, 32-byte keys.
    public func validate() throws {
        guard v == Self.version else { throw PairingPayloadError.invalid("wrong version") }
        try CompanionPathRules.validate(paths)
        let hasHosted = hostedPath != nil
        let hasToken = !(pairConnToken ?? "").isEmpty
        if hasHosted, !hasToken { throw PairingPayloadError.invalid("hosted path without pairConnToken") }
        if !hasHosted, pairConnToken != nil { throw PairingPayloadError.invalid("pairConnToken without a hosted path") }
        guard !machineId.isEmpty, !workspaceId.isEmpty, !pairSessionId.isEmpty else {
            throw PairingPayloadError.invalid("missing id")
        }
        guard CompanionRelayAuth.base64UrlDecode(macStaticPub)?.count == 32,
              CompanionRelayAuth.base64UrlDecode(pairPsk)?.count == 32
        else { throw PairingPayloadError.invalid("bad key length") }
    }
}

public struct PairedWorkspaceRecord: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let workspaceLabel: String
    public let machineId: String
    /// How to reach the Mac, in the Mac's order (direct addresses, then hosted). Refreshed by every `device.hello`.
    public let paths: [CompanionPath]
    public let macStaticPubBase64Url: String
    public let deviceId: String
    public let recoveryGeneration: String
    public let pairedAt: Date

    public init(
        workspaceId: String, workspaceLabel: String, machineId: String, paths: [CompanionPath],
        macStaticPubBase64Url: String, deviceId: String, recoveryGeneration: String, pairedAt: Date
    ) {
        self.workspaceId = workspaceId
        self.workspaceLabel = workspaceLabel
        self.machineId = machineId
        self.paths = paths
        self.macStaticPubBase64Url = macStaticPubBase64Url
        self.deviceId = deviceId
        self.recoveryGeneration = recoveryGeneration
        self.pairedAt = pairedAt
    }

    /// This record with `paths` replaced.
    public func with(paths: [CompanionPath]) -> PairedWorkspaceRecord {
        PairedWorkspaceRecord(
            workspaceId: workspaceId, workspaceLabel: workspaceLabel, machineId: machineId, paths: paths,
            macStaticPubBase64Url: macStaticPubBase64Url, deviceId: deviceId,
            recoveryGeneration: recoveryGeneration, pairedAt: pairedAt
        )
    }
}
