import Foundation

/// The exact terms of an agent's network request, as the server derived them from the project's setting now
/// (src/agent-network-request.ts). The request file's own summary, why and params are proposals anyone who can write that
/// file may edit: the app shows and approves only these terms, bound to their digest.
public struct AgentNetworkRequestTerms: Decodable, Equatable, Sendable {
    public struct Change: Decodable, Equatable, Sendable {
        public let add: [String]
        public let remove: [String]
        public let mode: String?
        public let local: String?
    }

    public struct Setting: Decodable, Equatable, Sendable {
        public let mode: String
        public let hosts: [String]
        public let loopback: String
    }

    public let id: String
    public let repo: String
    public let change: Change
    public let before: Setting
    public let after: Setting
    public let digest: String
    /// What changes, in the server's own words.
    public let words: [String]

    /// The server refuses an approval whose request or setting moved since the page was read.
    public static let changedRefusal = "This request or the project's network changed since you looked. Nothing changed; review it again."
    /// The server refuses a request filed in the older format (no explicit change).
    public static let oldRefusal = "This request was made by an older version of Toolroll. Ask the agent to request it again."

    /// Every pending request the project settings page lists with server terms. A block whose attributes disagree with
    /// its terms, or whose digest is not 32 lowercase hex characters, is dropped (never shown, never approvable).
    public static func parse(projectSettingsHTML html: String) -> [AgentNetworkRequestTerms] {
        guard let tagRe = try? NSRegularExpression(pattern: #"<div\s+data-agent-request="[^"]*"[^>]*>"#) else { return [] }
        let ns = html as NSString
        return tagRe.matches(in: html, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            let tag = ns.substring(with: match.range)
            guard let id = attribute("data-agent-request", in: tag),
                  let digest = attribute("data-agent-request-digest", in: tag),
                  let raw = attribute("data-agent-request-terms", in: tag),
                  isDigest(digest),
                  let data = unescapeHTML(raw).data(using: .utf8),
                  let terms = try? JSONDecoder().decode(AgentNetworkRequestTerms.self, from: data),
                  terms.id == unescapeHTML(id),
                  terms.digest == digest,
                  !terms.words.isEmpty
            else { return nil }
            return terms
        }
    }

    /// A setting in plain words: "Any host" or the hosts it lists, and whether this Mac's local services are reachable.
    public static func describe(_ setting: Setting) -> String {
        let hosts = setting.mode == "open" ? "any host" : (setting.hosts.isEmpty ? "no extra hosts" : setting.hosts.joined(separator: ", "))
        let local = setting.loopback == "any" ? "local services allowed" : "no local services"
        return "\(hosts); \(local)"
    }

    static func isDigest(_ value: String) -> Bool {
        value.count == 32 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    private static func attribute(_ name: String, in tag: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: #"\s"# + NSRegularExpression.escapedPattern(for: name) + #"="([^"]*)""#) else { return nil }
        let ns = tag as NSString
        guard let m = re.firstMatch(in: tag, range: NSRange(location: 0, length: ns.length)), m.numberOfRanges > 1 else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    /// Undoes the server's attribute escaping (src/html.ts: & < > " '). `&amp;` last so an escaped entity stays literal.
    static func unescapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}
