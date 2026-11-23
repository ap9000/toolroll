import Foundation
@testable import ToolrollCore

/// One request a stub answered: what the client actually sent.
struct RecordedRequest: Sendable {
    let method: String
    let path: String
    let query: String?
    let headers: [String: String]
    let body: String

    /// The form body as ordered pairs (`application/x-www-form-urlencoded`, `+` never means a space here).
    var formPairs: [(String, String)] {
        body.split(separator: "&", omittingEmptySubsequences: true).map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let decode = { (s: Substring) in String(s).removingPercentEncoding ?? String(s) }
            return (decode(parts[0]), parts.count > 1 ? decode(parts[1]) : "")
        }
    }

    var form: [String: String] {
        Dictionary(formPairs, uniquingKeysWith: { first, _ in first })
    }

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

struct StubReply: Sendable {
    let status: Int
    let body: Data
    let headers: [String: String]

    static func json(_ status: Int, _ text: String) -> StubReply {
        StubReply(status: status, body: Data(text.utf8), headers: ["Content-Type": "application/json"])
    }

    static func refused(_ status: Int, _ words: String) -> StubReply {
        let obj = try! JSONSerialization.data(withJSONObject: ["outcome": "refused", "words": words])
        return StubReply(status: status, body: obj, headers: ["Content-Type": "application/json"])
    }

    static func done(_ words: String) -> StubReply {
        let obj = try! JSONSerialization.data(withJSONObject: ["outcome": "done", "words": words])
        return StubReply(status: 200, body: obj, headers: ["Content-Type": "application/json"])
    }
}

/// A canned server: records every request and answers each from `handler`, which sees the request and how many came before.
final class StubServer: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [RecordedRequest] = []
    private let handler: @Sendable (RecordedRequest, Int) -> StubReply

    init(handler: @escaping @Sendable (RecordedRequest, Int) -> StubReply) {
        self.handler = handler
    }

    var requests: [RecordedRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    func answer(_ request: RecordedRequest) -> StubReply {
        lock.lock()
        let index = recorded.count
        recorded.append(request)
        lock.unlock()
        return handler(request, index)
    }
}

/// Which stub answers which loopback port. Ports here are only names: nothing listens on them.
enum StubRegistry {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var servers: [Int: StubServer] = [:]
    nonisolated(unsafe) private static var nextPort = 47_100

    /// A fresh port no other test uses, bound to `server`.
    static func register(_ server: StubServer) -> Int {
        lock.lock(); defer { lock.unlock() }
        nextPort += 1
        servers[nextPort] = server
        return nextPort
    }

    static func bind(port: Int, to server: StubServer?) {
        lock.lock(); defer { lock.unlock() }
        servers[port] = server
    }

    static func server(for port: Int) -> StubServer? {
        lock.lock(); defer { lock.unlock() }
        return servers[port]
    }
}

/// Answers every request of a test's own session from the registry; an unknown port fails, so nothing reaches the network.
class StubURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let port = url.port, let server = StubRegistry.server(for: port) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let recorded = RecordedRequest(
            method: request.httpMethod ?? "GET",
            path: url.path,
            query: url.query,
            headers: request.allHTTPHeaderFields ?? [:],
            body: String(data: Self.bodyData(of: request), encoding: .utf8) ?? ""
        )
        let reply = server.answer(recorded)
        guard let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func bodyData(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    /// A session whose every request is answered by the registry.
    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }
}

/// Registered process-wide so `URLSession.shared` (which `LocalConsoleConnector.discoverAndConnect()` uses to redeem its
/// one-time code) is answered too, but only for the fake console's own port: every other request is left alone.
final class FakeConsoleRedeemProtocol: StubURLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url, url.host == "127.0.0.1", let port = url.port else { return false }
        return port == FakeConsole.port
    }
}

extension LocalSessionCredentials {
    static func stub(port: Int, key: String = "key-1", csrf: String = "csrf-1", cookie: String = "tr_s=old") -> LocalSessionCredentials {
        LocalSessionCredentials(origin: "http://127.0.0.1:\(port)", account: "alice", cookieHeader: cookie, csrf: csrf,
                                key: key, epoch: "e1", databasePath: "/nonexistent/orders.db")
    }
}
