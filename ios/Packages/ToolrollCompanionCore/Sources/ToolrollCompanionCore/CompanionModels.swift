import Foundation

/// Truthful connection state (ADR 0004): losing contact never claims why (asleep, restored, …).
public enum CompanionConnectionState: Equatable, Sendable {
    case unpaired
    case demo
    /// Paired; the first connection of this launch is being made.
    case connecting
    /// `device.hello` passed on the current session.
    case connected
    /// A reconnect actually failed. Cached data stays on screen under a "Last updated" banner; the phone keeps
    /// retrying, and `hint` says what the person can do.
    case unreachable(hint: CompanionUnreachableHint)
    /// The Mac removed this iPhone (an authenticated refusal, or the relay's 403 `device_revoked`). Terminal: no
    /// retries; Pair again or Remove from this iPhone.
    case refused(reason: String)
    /// This iPhone's pairing data is unreadable or invalid. Terminal: Pair again or Remove from this iPhone.
    case damaged
}

/// Where a pairing attempt stands (shown over everything else while it runs).
public enum CompanionPairingPhase: Equatable, Sendable {
    case idle
    case contacting
    /// msg2 arrived and `pair.ready` went out: the Mac shows the same code in a moment.
    case awaitingMacConfirm(code: String)
    /// The owner confirmed: keys are stored, waiting for `pair.done` or the first hello.
    case finishing
}

/// Which pairing attempt owns the pairing UI. Every scan starts a new attempt; a late callback from an older one
/// (its code, its result, its failure) is dropped instead of overwriting the newer scan's state.
public struct CompanionPairingGate: Equatable, Sendable {
    public private(set) var phase: CompanionPairingPhase = .idle
    public private(set) var current: UInt64 = 0

    public init() {}

    /// A new scan: it owns the pairing UI from now on.
    public mutating func begin() -> UInt64 {
        current &+= 1
        phase = .contacting
        return current
    }

    /// True while `attempt` is the newest scan and hasn't ended or been cancelled.
    public func owns(_ attempt: UInt64) -> Bool {
        attempt == current && phase != .idle
    }

    /// `attempt`'s keys are stored; the final screen waits for `pair.done` or the first hello.
    @discardableResult
    public mutating func finishing(attempt: UInt64) -> Bool {
        guard owns(attempt) else { return false }
        phase = .finishing
        return true
    }

    /// Shows `attempt`'s confirmation code, if it still owns the UI.
    @discardableResult
    public mutating func codeReady(_ code: String, attempt: UInt64) -> Bool {
        guard owns(attempt) else { return false }
        phase = .awaitingMacConfirm(code: code)
        return true
    }

    /// `attempt` finished (paired or failed). Only its owner may clear the UI; false means drop the outcome's UI.
    @discardableResult
    public mutating func end(_ attempt: UInt64) -> Bool {
        guard owns(attempt) else { return false }
        phase = .idle
        return true
    }

    /// The person cancelled (or left for the demo): no running attempt owns the UI any more. The cancelled attempt
    /// stays the newest, so if its Mac had already confirmed it may still finish (`mayComplete`).
    public mutating func cancel() {
        phase = .idle
    }

    /// True when `attempt` finished pairing (the Mac answered `pair.ready`) and no newer scan began since. Its keys
    /// must be kept even after Cancel: the Mac already keeps this device.
    public func mayComplete(_ attempt: UInt64) -> Bool {
        attempt == current
    }
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
    /// When the Mac stops waiting for this pairing (Mac clock, ms). The phone waits at most until then.
    public let expiresAtMs: Double?

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
        if let expiresAtMs, !(expiresAtMs.isFinite && expiresAtMs > 0 && expiresAtMs < 1e15) { throw PairingPayloadError.invalid("bad expiresAtMs") }
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
