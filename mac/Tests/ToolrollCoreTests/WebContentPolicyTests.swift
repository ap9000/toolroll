import Foundation
import Testing
@testable import ToolrollCore

@Suite("Web content policy")
struct WebContentPolicyTests {
    static let console = "http://127.0.0.1:4180"

    @Test("Only the console's exact origin may carry the session; another port on the same host is a preview",
          arguments: [
            ("http://127.0.0.1:4180/projects", true),
            ("http://127.0.0.1:4180", true),
            ("HTTP://127.0.0.1:4180/x", true),
            ("http://127.0.0.1:3000/", false),
            ("http://localhost:4180/", false),
            ("https://127.0.0.1:4180/", false),
            ("http://127.0.0.1/", false),
            ("file:///tmp/x.html", false),
            ("not a url", false),
          ])
    func consoleIsExactOrigin(_ target: String, _ expected: Bool) {
        #expect(WebContentPolicy.isConsole(target, consoleOrigin: Self.console) == expected)
    }

    @Test("Without a session there is no console to match")
    func noSessionNoConsole() {
        #expect(!WebContentPolicy.isConsole("http://127.0.0.1:4180/", consoleOrigin: nil))
    }

    @Test("The console cookie is HttpOnly and SameSite strict, and Secure only over https")
    func cookieFlags() throws {
        let plain = try #require(WebContentPolicy.consoleCookieProperties(name: "tr_s", value: "v", consoleOrigin: Self.console))
        let cookie = try #require(HTTPCookie(properties: plain))
        #expect(cookie.isHTTPOnly)
        #expect(!cookie.isSecure)
        #expect(cookie.domain == "127.0.0.1")
        #expect(cookie.sameSitePolicy == .sameSiteStrict)
        let tls = try #require(WebContentPolicy.consoleCookieProperties(name: "tr_s", value: "v", consoleOrigin: "https://team.example.com"))
        let secure = try #require(HTTPCookie(properties: tls))
        #expect(secure.isSecure)
        #expect(secure.isHTTPOnly)
        #expect(WebContentPolicy.consoleCookieProperties(name: "tr_s", value: "", consoleOrigin: Self.console) == nil)
        #expect(WebContentPolicy.consoleCookieProperties(name: "tr_s", value: "v", consoleOrigin: "file:///x") == nil)
    }

    @Test("A console view stays on its origin: elsewhere a clicked link opens in the browser, anything else is refused",
          arguments: [
            ("http://127.0.0.1:4180/settings", false, WebContentPolicy.Navigation.allow),
            ("http://127.0.0.1:4180/settings", true, .allow),
            ("about:blank", false, .allow),
            ("http://127.0.0.1:3000/", false, .refuse),
            ("http://127.0.0.1:3000/", true, .openInBrowser),
            ("https://example.com/", false, .refuse),
            ("https://example.com/", true, .openInBrowser),
            ("javascript:alert(1)", true, .refuse),
            ("file:///etc/hosts", true, .refuse),
          ])
    func consoleNavigation(_ target: String, _ clicked: Bool, _ expected: WebContentPolicy.Navigation) {
        #expect(WebContentPolicy.consoleNavigation(to: URL(string: target), consoleOrigin: Self.console, userClickedLink: clicked) == expected)
    }

    @Test("A navigation with no URL is refused")
    func noURLRefused() {
        #expect(WebContentPolicy.consoleNavigation(to: nil, consoleOrigin: Self.console, userClickedLink: true) == .refuse)
    }
}
