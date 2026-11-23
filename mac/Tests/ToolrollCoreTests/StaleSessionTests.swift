import Foundation
import Testing
@testable import ToolrollCore

/// RS2: after a console restart the client reconnects (the fake console's handshake and one-time code) and resends once;
/// a second stale refusal is shown, never looped. Serialized: every case shares the one fake console and its port.
@Suite("ToolrollClient stale session", .serialized)
struct StaleSessionTests {
    /// The server's words for a key from before a restart (server/mutation-key.ts RESTARTED_LOCAL, NOT_CONNECTED_LOCAL).
    static let restarted = "Toolroll restarted — run `toolroll --web` to reconnect."
    static let notConnected = "This tab isn't connected to Toolroll — run `toolroll --web` to reconnect."

    static let redeemed = """
    {"version":1,"account":"alice","cookie":{"name":"tr_s","value":"fresh"},"csrf":"csrf-2","key":"key-2","epoch":"e2","passwordSet":true}
    """

    final class Renewals: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [LocalSessionCredentials] = []
        func add(_ creds: LocalSessionCredentials) { lock.lock(); seen.append(creds); lock.unlock() }
        var all: [LocalSessionCredentials] { lock.lock(); defer { lock.unlock() }; return seen }
    }

    /// `old` answers the first send; `fresh` (bound to the fake console's port) answers the redeem and any resend.
    private func setUp(refuseReconnect: Bool, old: @escaping @Sendable (RecordedRequest, Int) -> StubReply,
                       resend: @escaping @Sendable (RecordedRequest) -> StubReply) async -> (ToolrollClient, StubServer, StubServer, Renewals) {
        FakeConsole.shared.reset(refuse: refuseReconnect)
        let oldServer = StubServer(handler: old)
        let freshServer = StubServer { request, _ in
            request.path == "/login/once" ? .json(200, Self.redeemed) : resend(request)
        }
        StubRegistry.bind(port: FakeConsole.port, to: freshServer)
        let port = StubRegistry.register(oldServer)
        let client = ToolrollClient(localSession: .stub(port: port), session: StubURLProtocol.session())
        let renewals = Renewals()
        await client.onSessionRenewed { renewals.add($0) }
        return (client, oldServer, freshServer, renewals)
    }

    @Test("A stale refusal reconnects and resends once with the fresh session")
    func resendsOnceAfterReconnect() async throws {
        let (client, old, fresh, renewals) = await setUp(refuseReconnect: false,
                                                          old: { _, _ in .refused(409, Self.restarted) },
                                                          resend: { _ in .done("Archived.") })
        let reply = try await client.archiveTask(taskId: "t-7", reason: "r")
        #expect(reply == "Archived.")
        #expect(old.requests.count == 1)
        #expect(FakeConsole.shared.handshakeCount == 1)
        let redeem = fresh.requests.filter { $0.path == "/login/once" }
        #expect(redeem.count == 1)
        #expect(redeem.first?.body.contains("code-1") == true)
        let resent = fresh.requests.filter { $0.path == "/t/t-7/archive" }
        #expect(resent.count == 1)
        // The resend carries the fresh session's key, csrf and cookie, never the stale ones.
        #expect(resent.first?.header("x-toolroll-key") == "key-2")
        #expect(resent.first?.header("Cookie") == "tr_s=fresh")
        #expect(resent.first?.form["csrf"] == "csrf-2")
        #expect(resent.first?.form["reason"] == "r")
        #expect(renewals.all.map(\.key) == ["key-2"])
        #expect(await client.transport.origin == "http://127.0.0.1:\(FakeConsole.port)")
    }

    @Test("A second stale refusal after reconnecting is shown, not looped")
    func secondStaleRefusalSurfaces() async throws {
        let (client, old, fresh, _) = await setUp(refuseReconnect: false,
                                                  old: { _, _ in .refused(409, Self.restarted) },
                                                  resend: { _ in .refused(409, Self.restarted) })
        do {
            _ = try await client.cancelTask(taskId: "t-7", state: "queued", runId: 2)
            Issue.record("the second stale refusal should be thrown")
        } catch {
            #expect(error as? ToolrollClientError == .refused(Self.restarted))
        }
        #expect(old.requests.count == 1)
        #expect(fresh.requests.filter { $0.path == "/t/t-7/cancel" }.count == 1)
        #expect(FakeConsole.shared.handshakeCount == 1)
    }

    @Test("\"isn't connected to Toolroll\" (a key the console doesn't know) renews the same way")
    func notConnectedAlsoRenews() async throws {
        let (client, old, fresh, _) = await setUp(refuseReconnect: false,
                                                  old: { _, _ in .refused(403, Self.notConnected) },
                                                  resend: { _ in .done("Models changed for this task.") })
        _ = try await client.routeTask(taskId: "t-7", phase: "build", agent: "codex|gpt-6-sol", sawDigest: "d1")
        #expect(old.requests.count == 1)
        #expect(fresh.requests.filter { $0.path == "/t/t-7/route" }.count == 1)
    }

    @Test("When reconnecting fails, the stale refusal is shown after the one send")
    func reconnectFailureSurfacesOriginal() async throws {
        let (client, old, fresh, renewals) = await setUp(refuseReconnect: true,
                                                          old: { _, _ in .refused(409, Self.restarted) },
                                                          resend: { _ in .done("should not be sent") })
        do {
            _ = try await client.restoreTask(taskId: "t-7")
            Issue.record("the stale refusal should be thrown")
        } catch {
            #expect(error as? ToolrollClientError == .refused(Self.restarted))
        }
        #expect(old.requests.count == 1)
        #expect(fresh.requests.isEmpty)
        #expect(renewals.all.isEmpty)
    }

    @Test("Any other refusal never reconnects or resends")
    func otherRefusalDoesNotRenew() async throws {
        let (client, old, fresh, _) = await setUp(refuseReconnect: false,
                                                  old: { _, _ in .refused(409, "not cancelled: claimed") },
                                                  resend: { _ in .done("should not be sent") })
        await #expect(throws: ToolrollClientError.refused("not cancelled: claimed")) {
            try await client.cancelTask(taskId: "t-7", state: "running", runId: 9)
        }
        #expect(old.requests.count == 1)
        #expect(fresh.requests.isEmpty)
        #expect(FakeConsole.shared.handshakeCount == 0)
    }
}
