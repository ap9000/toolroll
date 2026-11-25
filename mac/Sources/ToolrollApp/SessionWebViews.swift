import AppKit
import ToolrollCore
import WebKit

@MainActor
enum SessionWebViews {
    typealias Cookie = (name: String, value: String, origin: String)

    static func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        return config
    }

    static func consoleOrigin(for urlString: String, cookie: Cookie?) -> String? {
        guard let cookie, WebContentPolicy.isConsole(urlString, consoleOrigin: cookie.origin) else { return nil }
        return cookie.origin
    }

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

    static func checkRedirect(_ webView: WKWebView, consoleOrigin: String?) {
        guard let consoleOrigin else { return }
        if WebContentPolicy.consoleNavigation(to: webView.url, consoleOrigin: consoleOrigin, userClickedLink: false) != .allow {
            webView.stopLoading()
        }
    }
}
