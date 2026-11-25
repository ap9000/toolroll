import AppKit
import ToolrollCore
import WebKit

/// Web views that show a project's pages (WebContentPolicy). Each web view has its own non-persistent data store, so
/// nothing one page stores reaches another. Only a web view whose page is the console the session belongs to gets the
/// session cookie, and it stays on that origin.
@MainActor
enum SessionWebViews {
    typealias Cookie = (name: String, value: String, origin: String)

    /// A fresh configuration with a private, non-persistent data store (never the shared default store).
    static func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        return config
    }

    /// The console origin a web view for `urlString` may carry the cookie for, or nil for a repository preview.
    static func consoleOrigin(for urlString: String, cookie: Cookie?) -> String? {
        guard let cookie, WebContentPolicy.isConsole(urlString, consoleOrigin: cookie.origin) else { return nil }
        return cookie.origin
    }

    /// Loads `urlString`. A console web view (`consoleOrigin` set when it was made) gets the cookie in its own store
    /// first; a preview web view never does, and a console web view loads nothing off its origin.
    static func load(_ webView: WKWebView, urlString: String, consoleOrigin: String?, cookie: Cookie?) {
        guard let url = URL(string: urlString) else { return }
        guard let consoleOrigin else {
            webView.load(URLRequest(url: url))
            return
        }
        guard WebContentPolicy.isConsole(urlString, consoleOrigin: consoleOrigin) else { return }
        guard let cookie, cookie.origin == consoleOrigin,
              let properties = WebContentPolicy.consoleCookieProperties(name: cookie.name, value: cookie.value, consoleOrigin: consoleOrigin),
              let httpCookie = HTTPCookie(properties: properties)
        else {
            webView.load(URLRequest(url: url))
            return
        }
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(httpCookie) {
            webView.load(URLRequest(url: url))
        }
    }

    /// The navigation policy for a web view: a console web view stays on its origin (every frame, every redirect hop); a
    /// link clicked elsewhere opens in the default browser. A preview web view goes where its page goes.
    static func decide(_ action: WKNavigationAction, consoleOrigin: String?) -> WKNavigationActionPolicy {
        guard let consoleOrigin else { return .allow }
        switch WebContentPolicy.consoleNavigation(to: action.request.url, consoleOrigin: consoleOrigin,
                                                  userClickedLink: action.navigationType == .linkActivated) {
        case .allow:
            return .allow
        case .openInBrowser:
            if let url = action.request.url { NSWorkspace.shared.open(url) }
            return .cancel
        case .refuse:
            return .cancel
        }
    }

    /// Belt for redirects: a console web view whose provisional load was redirected off its origin stops at once.
    static func checkRedirect(_ webView: WKWebView, consoleOrigin: String?) {
        guard let consoleOrigin else { return }
        if WebContentPolicy.consoleNavigation(to: webView.url, consoleOrigin: consoleOrigin, userClickedLink: false) != .allow {
            webView.stopLoading()
        }
    }
}
