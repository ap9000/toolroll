import Foundation

/// Which web content may carry the local session, and where a web view showing it may go.
///
/// Cookies ignore ports: a cookie for 127.0.0.1 reaches every server on 127.0.0.1. So authenticated Toolroll pages and a
/// repository's preview pages never share a data store: a preview web view gets its own non-persistent store and never
/// the session cookie; a console web view gets its own non-persistent store with an HttpOnly cookie, and its frames stay
/// on the console's origin (scheme, host and port).
public enum WebContentPolicy {
    public enum Navigation: Equatable, Sendable {
        case allow
        /// A link the person clicked to somewhere else: open it in their default browser, never in the console's view.
        case openInBrowser
        case refuse
    }

    /// scheme://host:port, lowercased, with the scheme's default port filled in; nil for anything but http(s).
    public static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty
        else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)"
    }

    public static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard let left = origin(of: a), let right = origin(of: b) else { return false }
        return left == right
    }

    /// Whether `target` is the console the session belongs to: only then may a web view showing it get the cookie.
    public static func isConsole(_ target: String, consoleOrigin: String?) -> Bool {
        guard let consoleOrigin, let console = URL(string: consoleOrigin), let url = URL(string: target) else { return false }
        return sameOrigin(url, console)
    }

    /// The session cookie for a console web view: HttpOnly, Secure when the console is https, host-only on its host.
    public static func consoleCookieProperties(name: String, value: String, consoleOrigin: String) -> [HTTPCookiePropertyKey: Any]? {
        guard let console = URL(string: consoleOrigin), origin(of: console) != nil, let host = console.host,
              !name.isEmpty, !value.isEmpty
        else { return nil }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .domain: host,
            .path: "/",
            .name: name,
            .value: value,
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict.rawValue,
        ]
        if console.scheme?.lowercased() == "https" { properties[.secure] = "TRUE" }
        return properties
    }

    /// Where a console web view may navigate (main frame, subframes and redirects alike): only its own origin. A link the
    /// person clicked elsewhere opens in their browser; anything else off-origin is refused.
    public static func consoleNavigation(to url: URL?, consoleOrigin: String, userClickedLink: Bool) -> Navigation {
        guard let url else { return .refuse }
        if url.absoluteString == "about:blank" { return .allow }
        if let console = URL(string: consoleOrigin), sameOrigin(url, console) { return .allow }
        if userClickedLink, origin(of: url) != nil { return .openInBrowser }
        return .refuse
    }
}
