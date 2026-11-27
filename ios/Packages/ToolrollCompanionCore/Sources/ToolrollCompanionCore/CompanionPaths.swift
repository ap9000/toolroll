import Foundation

// The ways this iPhone can reach its Mac (pairing QR v2 and `device.hello`): up to four direct addresses on the same
// Wi-Fi or tailnet, then at most one hosted relay. Both sides enforce the same rules; the phone rejects anything else.

/// One way to reach the Mac.
public struct CompanionPath: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// A plain WebSocket straight into the Mac (`ws://<private IPv4>:<port>/v1/direct`). No relay token.
        case direct
        /// The hosted end-to-end encrypted relay (`wss://…/v1/connect`), with a Bearer token.
        case hosted
    }

    public let kind: Kind
    public let url: String

    public init(kind: Kind, url: String) {
        self.kind = kind
        self.url = url
    }

    /// The hosted relay's host name, for "Connected through relay.toolroll.dev".
    public var host: String? { URLComponents(string: url)?.host }
}

/// Why a pairing code (or a path list) was refused.
public enum PairingPayloadError: Error, Equatable, Sendable {
    /// A `v: 1` code: the Mac runs a Toolroll from before direct connections.
    case olderToolroll
    /// A code from a Toolroll newer than this app understands.
    case newerToolroll
    /// `expiresAtMs` already passed, or lies implausibly far ahead (this iPhone's clock may be off).
    case expired
    /// Not a Toolroll pairing code, or one that breaks the rules. The reason is for tests and logs, not people.
    case invalid(String)

    /// What the person sees.
    public var userMessage: String {
        switch self {
        case .olderToolroll:
            return "This QR code is from an older Toolroll — update Toolroll on your Mac."
        case .newerToolroll:
            return "This QR code is from a newer Toolroll. Update this app, then scan again."
        case .expired:
            return "This pairing code has expired, or this iPhone's date & time is off. Show a new code on your Mac, and check Settings → General → Date & Time."
        case .invalid:
            return "That isn't a Toolroll pairing code. On your Mac, open Settings → Phone → Pair an iPhone for a new one."
        }
    }
}

public enum CompanionPathRules {
    public static let maxPaths = 5
    public static let maxDirect = 4
    public static let maxURLLength = 200

    /// Checks a whole path list: 1–5 entries, at most 4 direct, at most 1 hosted and it comes last, no duplicates,
    /// and every URL valid for its kind.
    public static func validate(_ paths: [CompanionPath]) throws {
        guard !paths.isEmpty else { throw PairingPayloadError.invalid("no paths") }
        guard paths.count <= maxPaths else { throw PairingPayloadError.invalid("more than \(maxPaths) paths") }
        let directCount = paths.filter { $0.kind == .direct }.count
        let hostedCount = paths.count - directCount
        guard directCount <= maxDirect else { throw PairingPayloadError.invalid("more than \(maxDirect) direct paths") }
        guard hostedCount <= 1 else { throw PairingPayloadError.invalid("more than one hosted path") }
        if hostedCount == 1, paths.last?.kind != .hosted {
            throw PairingPayloadError.invalid("hosted path is not last")
        }
        guard Set(paths.map(\.url)).count == paths.count else { throw PairingPayloadError.invalid("duplicate path") }
        for path in paths { try validate(path) }
    }

    // Canonical grammar, checked on the raw string (test/fixtures/companion-paths.json; src/companion/paths.ts runs
    // the same table):
    //   direct = ws://<private IPv4, four decimal octets, no leading zeros>:<port 1-65535, no leading zeros>/v1/direct
    //   hosted = wss://<lowercase host>[:port]/v1/connect, or (DEBUG builds only) ws://127.0.0.1|localhost:<port>/v1/connect
    // No userinfo, query, fragment or trailing slash: nothing may follow the path.

    /// One path's own rules.
    public static func validate(_ path: CompanionPath) throws {
        switch path.kind {
        case .direct: try validateDirect(path.url)
        case .hosted: try validateHosted(path.url)
        }
    }

    private nonisolated(unsafe) static let directPattern =
        try! Regex(#"ws://([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):([1-9][0-9]{0,4})/v1/direct"#)
    private nonisolated(unsafe) static let hostedPattern =
        try! Regex(#"wss://([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?/v1/connect"#)
    private nonisolated(unsafe) static let loopbackPattern =
        try! Regex(#"ws://(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})/v1/connect"#)

    static func validateDirect(_ url: String) throws {
        guard url.utf8.count <= maxURLLength else { throw PairingPayloadError.invalid("path URL too long") }
        guard let m = try? directPattern.wholeMatch(in: url),
              let host = m.output[1].substring, let port = m.output[2].substring
        else { throw PairingPayloadError.invalid("direct path is not ws://<IPv4>:<port>/v1/direct") }
        guard let octets = ipv4Octets(String(host)), isPrivateOrTailscale(octets) else {
            throw PairingPayloadError.invalid("direct host is not a private IPv4 address")
        }
        guard portAllowed(port) else { throw PairingPayloadError.invalid("direct port out of range") }
    }

    #if DEBUG
    static let allowsLoopbackHosted = true
    #else
    static let allowsLoopbackHosted = false
    #endif

    static func validateHosted(_ url: String) throws {
        guard url.utf8.count <= maxURLLength else { throw PairingPayloadError.invalid("path URL too long") }
        if let m = try? hostedPattern.wholeMatch(in: url) {
            if let port = m.output[2].substring, !portAllowed(port) {
                throw PairingPayloadError.invalid("hosted port out of range")
            }
            return
        }
        // A loopback relay is for development only: a release build never sends a token to its own loopback (E5).
        if allowsLoopbackHosted, let m = try? loopbackPattern.wholeMatch(in: url), let port = m.output[1].substring, portAllowed(port) {
            return
        }
        throw PairingPayloadError.invalid("hosted path is not wss://<host>/v1/connect")
    }

    /// Digits already checked by the pattern (no leading zero); 1–65535.
    private static func portAllowed(_ digits: Substring) -> Bool {
        guard let value = Int(digits) else { return false }
        return (1...65535).contains(value)
    }

    /// A strict dotted-quad: four decimal parts, 0–255, no leading zeros. Anything else (names, IPv6, `0x…`) is nil.
    static func ipv4Octets(_ host: String) -> [UInt8]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [UInt8] = []
        for part in parts {
            guard (1...3).contains(part.count), part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  part.count == 1 || part.first != "0",
                  let value = Int(part), value <= 255
            else { return nil }
            octets.append(UInt8(value))
        }
        return octets
    }

    /// 10/8, 172.16/12, 192.168/16, or 100.64/10 (Tailscale's CGNAT range).
    static func isPrivateOrTailscale(_ o: [UInt8]) -> Bool {
        guard o.count == 4 else { return false }
        if o[0] == 10 { return true }
        if o[0] == 172, (16...31).contains(o[1]) { return true }
        if o[0] == 192, o[1] == 168 { return true }
        if o[0] == 100, (64...127).contains(o[1]) { return true }
        return false
    }

    /// `ws://host:port/v1/direct` → `http://host:port/v1/health`.
    public static func healthURL(forDirect url: String) -> URL? {
        guard var c = URLComponents(string: url), c.scheme == "ws" else { return nil }
        c.scheme = "http"
        c.percentEncodedPath = "/v1/health"
        c.query = nil
        return c.url
    }

    /// The direct socket URL for one session: `…/v1/direct?role=device&id=<deviceId>` or `?role=pair&id=<pairSessionId>`.
    public static func directSocketURL(_ url: String, role: String, id: String) -> URL? {
        guard var c = URLComponents(string: url) else { return nil }
        c.queryItems = [URLQueryItem(name: "role", value: role), URLQueryItem(name: "id", value: id)]
        return c.url
    }
}

// MARK: - Health probe

/// Asks one direct address which Mac answers there: GET `http://<host:port>/v1/health`. Returns the `machineId`
/// from a 200 response, or nil (anything else, or no answer within `timeout`). Injectable so tests never touch the network.
public typealias CompanionHealthProbe = @Sendable (_ healthURL: URL, _ timeout: Duration) async -> String?

public enum URLSessionHealthProbe {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        return URLSession(configuration: config)
    }()

    private struct Health: Decodable {
        let machineId: String?
    }

    /// The client races this against `timeout` too; the request timeout just stops the socket early.
    @Sendable
    public static func probe(_ url: URL, timeout: Duration) async -> String? {
        let seconds = Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: seconds)
        request.httpMethod = "GET"
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              data.count <= 4096,
              let health = try? JSONDecoder().decode(Health.self, from: data)
        else { return nil }
        return health.machineId
    }
}
