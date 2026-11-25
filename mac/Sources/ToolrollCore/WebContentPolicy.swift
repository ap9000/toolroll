import Foundation

public enum WebContentPolicy {
    public enum Navigation: Equatable, Sendable {
        case allow
        case openInBrowser
        case refuse
    }

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

    public static func isConsole(_ target: String, consoleOrigin: String?) -> Bool {
        guard let consoleOrigin, let console = URL(string: consoleOrigin), let url = URL(string: target) else { return false }
        return sameOrigin(url, console)
    }

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

    public static func consoleNavigation(to url: URL?, consoleOrigin: String, userClickedLink: Bool) -> Navigation {
        guard let url else { return .refuse }
        if url.absoluteString == "about:blank" { return .allow }
        if let console = URL(string: consoleOrigin), sameOrigin(url, console) { return .allow }
        if userClickedLink, origin(of: url) != nil { return .openInBrowser }
        return .refuse
    }
}
