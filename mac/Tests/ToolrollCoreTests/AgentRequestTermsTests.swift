import Foundation
import Testing
@testable import ToolrollCore

@Suite("Agent network request terms")
struct AgentRequestTermsTests {
    static let digest = "0123456789abcdef0123456789abcdef"

    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    static func termsJSON(id: String = "req_aa11", digest: String = digest, words: [String] = ["Allow api.example.com", "Builds may then reach api.example.com."]) -> String {
        let wordsJSON = words.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        {"id":"\(id)","repo":"/work/my-site","change":{"add":["api.example.com"],"remove":[],"mode":null,"local":null},\
        "before":{"mode":"allowlist","hosts":[],"loopback":"proxy-only"},\
        "after":{"mode":"allowlist","hosts":["api.example.com"],"loopback":"proxy-only"},\
        "digest":"\(digest)","words":[\(wordsJSON)]}
        """
    }

    static func block(id: String = "req_aa11", digest: String = digest, json: String = termsJSON()) -> String {
        "<div data-agent-request=\"\(id)\" data-agent-request-digest=\"\(digest)\" data-agent-request-terms=\"\(escape(json))\"><p class=\"k-note\"><b>Agent asks:</b> x</p></div>"
    }

    @Test("The page's block parses into the server's exact terms")
    func parsesServerTerms() throws {
        let html = "<main>\(Self.block())<textarea id=\"network-hosts\"></textarea></main>"
        let parsed = AgentNetworkRequestTerms.parse(projectSettingsHTML: html)
        let terms = try #require(parsed.first)
        #expect(parsed.count == 1)
        #expect(terms.id == "req_aa11")
        #expect(terms.repo == "/work/my-site")
        #expect(terms.digest == Self.digest)
        #expect(terms.change.add == ["api.example.com"])
        #expect(terms.before.hosts.isEmpty)
        #expect(terms.after.hosts == ["api.example.com"])
        #expect(terms.words == ["Allow api.example.com", "Builds may then reach api.example.com."])
        let snapshot = ToolrollClient.parseProjectSettingsHTML(html, repo: "/work/my-site")
        #expect(snapshot.networkRequests == parsed)
    }

    @Test("A block whose attributes disagree with its terms, or carries a malformed digest, is never shown",
          arguments: [
            block(id: "req_other"),
            block(digest: "ffffffffffffffffffffffffffffffff"),
            block(digest: "0123", json: termsJSON(digest: "0123")),
            block(digest: "0123456789ABCDEF0123456789ABCDEF", json: termsJSON(digest: "0123456789ABCDEF0123456789ABCDEF")),
            block(json: termsJSON(words: [])),
            block(json: "{not json"),
          ])
    func dropsMismatched(_ html: String) {
        #expect(AgentNetworkRequestTerms.parse(projectSettingsHTML: html).isEmpty)
    }

    @Test("An older server page with no terms shows no approvable request")
    func olderPageHasNone() {
        let html = "<section id=\"network\"><p>Builds reach no extra hosts.</p></section>"
        #expect(AgentNetworkRequestTerms.parse(projectSettingsHTML: html).isEmpty)
        #expect(ToolrollClient.parseProjectSettingsHTML(html, repo: "/work/my-site").networkRequests.isEmpty)
    }

    @Test("Escaped quotes and ampersands in the server's words survive exactly")
    func unescapesOnce() throws {
        let json = Self.termsJSON(words: ["Allow a&amp;b \\\"x\\\" <y>"])
        let terms = try #require(AgentNetworkRequestTerms.parse(projectSettingsHTML: Self.block(json: json)).first)
        #expect(terms.words == ["Allow a&amp;b \"x\" <y>"])
    }

    @Test("Approve sends only the request id and the digest shown, never hosts, mode or local")
    func approveSendsIdAndDigest() async throws {
        let server = StubServer { _, _ in .done("Approved the agent's request.") }
        let port = StubRegistry.register(server)
        let client = ToolrollClient(localSession: .stub(port: port), session: StubURLProtocol.session())
        let reply = try await client.approveNetworkRequest(repo: "/work/my-site", id: "req_aa11", digest: Self.digest, password: "pw")
        #expect(reply == "Approved the agent's request.")
        let sent = try #require(server.requests.first)
        #expect(sent.path == "/settings/project/network")
        #expect(sent.formPairs.map(\.0) == ["csrf", "repo", "request", "digest", "password"])
        #expect(sent.formPairs.map(\.1) == ["csrf-1", "/work/my-site", "req_aa11", Self.digest, "pw"])
    }

    @Test("A changed request comes back as the server's exact refusal, so the app reads the terms again")
    func changedRefusal() async throws {
        let server = StubServer { _, _ in .refused(409, AgentNetworkRequestTerms.changedRefusal) }
        let port = StubRegistry.register(server)
        let client = ToolrollClient(localSession: .stub(port: port), session: StubURLProtocol.session())
        do {
            _ = try await client.approveNetworkRequest(repo: "/work/my-site", id: "req_aa11", digest: Self.digest, password: "pw")
            Issue.record("expected a refusal")
        } catch {
            #expect(error.localizedDescription == AgentNetworkRequestTerms.changedRefusal)
        }
    }

    @Test("The other kinds describe exactly the values they would apply, never the file's summary or why")
    func appliedWordsComeFromParams() {
        func request(_ kind: AgentRequestKind, _ params: AgentRequestParams) -> AgentRequest {
            AgentRequest(id: "r", kind: kind, repo: "/work/my-site", projectName: "my-site", requester: "Agent",
                         summary: "Harmless tweak", why: "Trust me", params: params)
        }
        #expect(request(.network, AgentRequestParams(mode: "open")).appliedWords == nil)
        #expect(request(.worktreeSetup, AgentRequestParams(command: "pnpm install")).appliedWords == "Run pnpm install in /work/my-site before each build")
        #expect(request(.worktreeSetup, AgentRequestParams(command: "  ")).appliedWords == nil)
        #expect(request(.liveView, AgentRequestParams(showCommands: false)).appliedWords == "Hide commands in the live view")
        #expect(request(.liveView, AgentRequestParams()).appliedWords == "Show commands in the live view")
    }
}
