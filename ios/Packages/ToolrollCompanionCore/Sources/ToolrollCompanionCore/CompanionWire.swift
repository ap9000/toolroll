import Foundation

// The frozen wire contract as the phone sees it (test/fixtures/companion-wire.json; Node reads the same file).

public enum CompanionWire {
    public static let protocolVersion = 1
    /// Every msg2 payload (pair and session, every status) is JSON padded with a `pad` field to exactly this many
    /// plaintext bytes, so a refusal looks like any other answer on the wire.
    public static let paddedMsg2Bytes = 160
    public static let padField = "pad"

    /// `pair.ready` (stream 1) and `pair.done` (stream 3).
    public static let pairReadyStream: UInt32 = 1
    public static let pairDoneStream: UInt32 = 3
    /// While waiting for the owner to confirm, the phone pings this often so neither relay nor Mac sees silence.
    public static let pairingKeepalive: Duration = .seconds(20)
    /// `pair.ready` carries a name of at most this many characters (the Mac sanitizes it again).
    public static let maxDeviceNameLength = 48

    /// The Mac's concurrency caps (src/companion/framing.ts): 8 open streams, 2 of them watches.
    public static let maxStreams = 8
    public static let maxWatches = 2
    /// Credit is granted back in batches of this many chunks (half the Mac's initial window of 16), so the phone sends
    /// one CREDIT per 8 records instead of one per record. The Mac never runs dry: it always holds ≥ 9 credits.
    public static let creditBatch: UInt32 = CompanionFramingConstants.initialStreamCredit / 2

    /// Relay refusals carry their code in this header (and the body).
    public static let relayErrorHeader = "Toolroll-Relay-Error"

    public static let bonjourService = "_toolroll._tcp"
    public static let bonjourMachineIdKey = "m"
}

// MARK: - msg2

/// What the Mac said in message 2.
public enum CompanionHandshakeStatus: Equatable, Sendable {
    /// Pairing: send `pair.ready` next.
    case awaitingReady
    /// Session: send `device.hello` next.
    case awaitingHello
    /// Session: an authenticated refusal (`device_revoked` or `account_revoked`). Terminal.
    case refused(reason: String)
}

public enum CompanionHandshakeMode: Sendable {
    case pair
    case session
}

public enum CompanionHandshakeReply {
    public struct Mismatch: Error, Equatable, Sendable {
        public let detail: String
    }

    /// Reads a decrypted msg2 payload. The `pad` field is ignored; its length isn't enforced (the payload is already
    /// authenticated). A status that doesn't belong to `mode`, or a protocol version other than 1, is a mismatch.
    public static func parse(_ payload: Data, mode: CompanionHandshakeMode) throws -> CompanionHandshakeStatus {
        guard let object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any],
              let status = object["status"] as? String
        else { throw Mismatch(detail: "msg2 payload is not a status object") }
        if let version = object["protocolVersion"] as? Int, version != CompanionWire.protocolVersion {
            throw Mismatch(detail: "protocol version \(version)")
        }
        switch (mode, status) {
        case (.pair, "awaiting_ready"):
            return .awaitingReady
        case (.session, "awaiting_hello"):
            return .awaitingHello
        case (.session, "refused"):
            let reason = object["reason"] as? String ?? "device_revoked"
            return .refused(reason: reason == "account_revoked" ? "account_revoked" : "device_revoked")
        default:
            throw Mismatch(detail: "unexpected msg2 status \(status)")
        }
    }

    /// `fields` as JSON padded to exactly `CompanionWire.paddedMsg2Bytes` (what the Mac sends; used by tests and to
    /// check the fixture's size).
    static func padded(_ fields: [String: Any]) throws -> Data {
        let bare = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        let overhead = Data(",\"\(CompanionWire.padField)\":\"\"".utf8).count
        let room = CompanionWire.paddedMsg2Bytes - bare.count - overhead
        guard room >= 0 else { throw Mismatch(detail: "msg2 fields too long to pad") }
        var out = Data(bare.dropLast())
        out.append(Data(",\"\(CompanionWire.padField)\":\"\(String(repeating: " ", count: room))\"}".utf8))
        return out
    }
}

// MARK: - Session end

/// Why a live session ended on its own (reported to the connection-lost handler).
public enum CompanionSessionEnd: Equatable, Sendable {
    /// Socket closed, a PONG missed its deadline, a frame that didn't decrypt: reconnect.
    case lost
    /// The Mac's 24 h / 2^20 message limit (stream-0 ERROR `rekey`): reconnect at once, silently.
    case rekey
    /// Stream-0 ERROR `device_revoked` / `account_revoked`, or an RPC answered `standing_revoked`. Terminal.
    case refused(reason: String)
}

public enum CompanionStreamZeroCode {
    public static let deviceRevoked = "device_revoked"
    public static let accountRevoked = "account_revoked"
    public static let rekey = "rekey"
}

// MARK: - Relay refusals

/// A relay refusing the WebSocket upgrade: the status, its `Toolroll-Relay-Error` code, and the `Date` /
/// `Retry-After` headers when present.
public struct CompanionRelayRefusal: Error, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let serverDate: Date?
    public let retryAfter: TimeInterval?

    public init(status: Int, code: String?, serverDate: Date? = nil, retryAfter: TimeInterval? = nil) {
        self.status = status
        self.code = code
        self.serverDate = serverDate
        self.retryAfter = retryAfter
    }

    /// Reads the refusal from an upgrade response's status and headers (names compared case-insensitively).
    public init(status: Int, headers: [String: String]) {
        func header(_ name: String) -> String? {
            headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
        }
        let raw = header(CompanionWire.relayErrorHeader)?.trimmingCharacters(in: .whitespaces)
        let code = raw.flatMap { $0.range(of: #"^[a-z_]{1,40}$"#, options: .regularExpression) != nil ? $0 : nil }
        self.init(
            status: status,
            code: code,
            serverDate: header("Date").flatMap(Self.httpDate),
            retryAfter: header("Retry-After").flatMap { TimeInterval($0.trimmingCharacters(in: .whitespaces)) }
        )
    }

    /// Only an explicit 403 `device_revoked` is terminal for the phone; every other refusal keeps retrying.
    public var isTerminal: Bool { status == 403 && code == "device_revoked" }

    /// The relay judged the token's time window: `token_expired` / `token_not_yet_valid`.
    public var isClockSkew: Bool { status == 401 && (code == "token_expired" || code == "token_not_yet_valid") }

    /// What the person is told while the phone keeps retrying.
    public var hint: CompanionUnreachableHint {
        if isClockSkew { return .clockSkew }
        switch code {
        case "daemon_unavailable", "machine_unknown": return .macOffline
        case "rate_limited", "too_many_peers", "replay_cache_full": return .rateLimited
        default: return .relayRefused(code ?? "http_\(status)")
        }
    }

    private static func httpDate(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: value)
    }
}
