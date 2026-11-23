import Foundation
import Testing
@testable import ToolrollCore

/// Request shape of the task acts (mac-app-qa.md level S): the exact path, form fields and headers `ToolrollClient` sends,
/// against canned answers. Nothing here reaches a real server.
@Suite("ToolrollClient task acts")
struct ClientRequestTests {
    /// A local-session client whose requests all go to `server`.
    private func client(_ server: StubServer) -> (ToolrollClient, Int) {
        let port = StubRegistry.register(server)
        return (ToolrollClient(localSession: .stub(port: port), session: StubURLProtocol.session()), port)
    }

    private func expectFormAct(_ request: RecordedRequest, path: String, fields: [(String, String)]) {
        #expect(request.method == "POST")
        #expect(request.path == path)
        #expect(request.formPairs.map(\.0) == ["csrf"] + fields.map(\.0))
        #expect(request.formPairs.map(\.1) == ["csrf-1"] + fields.map(\.1))
        #expect(request.header("Content-Type") == "application/x-www-form-urlencoded")
        #expect(request.header("x-toolroll-key") == "key-1")
        #expect(request.header("x-toolroll-act") == "in-place")
        #expect(request.header("x-toolroll-client") == "terminal")
        #expect(request.header("x-csrf-token") == "csrf-1")
        #expect(request.header("Cookie") == "tr_s=old")
        #expect(request.header("Accept") == "application/json")
    }

    @Test("Cancel posts the shown state and newest run to /t/<id>/cancel")
    func cancelSendsStateAndRun() async throws {
        let server = StubServer { _, _ in .done("Task cancelled.") }
        let (client, _) = client(server)
        let reply = try await client.cancelTask(taskId: "t-7", state: "queued", runId: 3)
        #expect(reply == "Task cancelled.")
        #expect(server.requests.count == 1)
        expectFormAct(server.requests[0], path: "/t/t-7/cancel", fields: [("state", "queued"), ("run", "3")])
    }

    @Test("Cancel of a task with no run names it \"none\"")
    func cancelWithoutRunSaysNone() async throws {
        let server = StubServer { _, _ in .done("Task cancelled.") }
        let (client, _) = client(server)
        _ = try await client.cancelTask(taskId: "t-7", state: "failed", runId: nil)
        expectFormAct(server.requests[0], path: "/t/t-7/cancel", fields: [("state", "failed"), ("run", "none")])
    }

    @Test("Cancel names exactly what the steps read showed: its state and latestRun (or none)")
    func cancelUsesStepsRead() async throws {
        let withRun = """
        {"version":1,"task":{"id":"t-7.2","root":"t-7","title":"Fix","state":"queued","project":null},"chain":"plan-first",
         "headline":"Queued","liveRun":null,"latestRun":5,"models":null,"cards":[{"key":"build","label":"Build","state":"stuck","mark":"stuck","sentence":"x","runs":[2]}]}
        """
        let noRun = """
        {"version":1,"task":{"id":"t-8","root":"t-8","title":"New","state":"queued","project":null},"chain":"just-code",
         "headline":"Queued","liveRun":null,"latestRun":null,"models":null,"cards":[]}
        """
        let server = StubServer { request, _ in
            switch request.path {
            case "/t/t-7/steps": return .json(200, withRun)
            case "/t/t-8/steps": return .json(200, noRun)
            default: return .done("Task cancelled.")
            }
        }
        let (client, _) = client(server)
        for root in ["t-7", "t-8"] {
            let steps = try await client.fetchSteps(taskId: root)
            _ = try await client.cancelTask(taskId: steps.task.id, state: try #require(steps.task.state), runId: steps.shownRunForCancel)
        }
        let acts = server.requests.filter { $0.method == "POST" }
        #expect(acts.count == 2)
        // The current version's id from the steps read, not the row's root.
        expectFormAct(acts[0], path: "/t/t-7.2/cancel", fields: [("state", "queued"), ("run", "5")])
        expectFormAct(acts[1], path: "/t/t-8/cancel", fields: [("state", "queued"), ("run", "none")])
    }

    @Test("A remote workspace never sends a cancel, archive or restore")
    func remoteRefusesWithoutSending() async throws {
        let server = StubServer { _, _ in .done("no") }
        let port = StubRegistry.register(server)
        let profile = ConnectionProfile(name: "r", origin: "http://127.0.0.1:\(port)", account: "alice", token: "tok", label: "Remote")
        let client = ToolrollClient(profile: profile, session: StubURLProtocol.session())
        await #expect(throws: ToolrollClientError.self) { try await client.cancelTask(taskId: "t-7", state: "queued", runId: 1) }
        await #expect(throws: ToolrollClientError.self) { try await client.archiveTask(taskId: "t-7", reason: "x") }
        await #expect(throws: ToolrollClientError.self) { try await client.restoreTask(taskId: "t-7") }
        #expect(server.requests.isEmpty)
    }

    @Test("Archive posts reason and return to /t/<id>/archive; restore posts return to /t/<id>/restore")
    func archiveAndRestoreShape() async throws {
        let server = StubServer { request, _ in .done(request.path.hasSuffix("/archive") ? "Archived." : "Restored.") }
        let (client, _) = client(server)
        #expect(try await client.archiveTask(taskId: "t-7", reason: "Archived from the Mac app") == "Archived.")
        #expect(try await client.restoreTask(taskId: "t-7") == "Restored.")
        expectFormAct(server.requests[0], path: "/t/t-7/archive", fields: [("reason", "Archived from the Mac app"), ("return", "/")])
        expectFormAct(server.requests[1], path: "/t/t-7/restore", fields: [("return", "/")])
    }

    @Test("Archive refused while work goes on surfaces the server's words (the app retries on that phrase only)")
    func archiveRefusalWords() async throws {
        let words = "Not archived: t-7 still has work going on. Stop it first."
        let server = StubServer { _, _ in .refused(409, words) }
        let (client, _) = client(server)
        do {
            _ = try await client.archiveTask(taskId: "t-7", reason: "x")
            Issue.record("archive should have been refused")
        } catch {
            #expect(error as? ToolrollClientError == .refused(words))
            #expect(error.localizedDescription.contains("still has work going on"))
        }
        #expect(server.requests.count == 1)
    }

    @Test("Bulk Undo (restoreAll): one restore per archived task, each to its own id")
    func restoreAllSendsOnePerTask() async throws {
        let server = StubServer { _, _ in .done("Restored.") }
        let (client, _) = client(server)
        let ids = ["t-1", "t-2", "t-3"]
        for id in ids { _ = try await client.restoreTask(taskId: id) }
        #expect(server.requests.map(\.path) == ids.map { "/t/\($0)/restore" })
        for request in server.requests { #expect(request.form["return"] == "/") }
    }

    @Test("Route posts phase, agent=provider|model, the digest shown and when to /t/<id>/route")
    func routeShape() async throws {
        let server = StubServer { _, _ in .done("Models changed for this task.") }
        let (client, _) = client(server)
        _ = try await client.routeTask(taskId: "t-7.2", phase: "build", agent: "codex|gpt-6-sol", sawDigest: "d1", when: "next-run")
        expectFormAct(server.requests[0], path: "/t/t-7.2/route",
                      fields: [("phase", "build"), ("agent", "codex|gpt-6-sol"), ("sawDigest", "d1"), ("when", "next-run")])
        // The pipe is percent-encoded on the wire, never sent raw.
        #expect(server.requests[0].body.contains("agent=codex%7Cgpt-6-sol"))
    }

    @Test("Work rows: the default list and ?view=archived")
    func workRowsPaths() async throws {
        let empty = #"{"version":1,"project":null,"projectName":"All projects","needsCount":0,"rows":[],"room":"workspace","spend":null}"#
        let server = StubServer { _, _ in .json(200, empty) }
        let (client, _) = client(server)
        _ = try await client.fetchWorkRows()
        _ = try await client.fetchWorkRows(view: "archived")
        #expect(server.requests.map(\.path) == ["/work/rows", "/work/rows"])
        #expect(server.requests.map(\.query) == [nil, "view=archived"])
        #expect(server.requests.allSatisfy { $0.method == "GET" })
    }

    // MARK: CA4 (client side): an already-cancelled task

    @Test("An already-cancelled task's steps read decodes as ended: state cancelled, no road (cards null)")
    func cancelledStepsRead() throws {
        let json = """
        {"version":1,"task":{"id":"t-9","root":"t-9","title":"Old","state":"cancelled","project":null},"chain":"just-code",
         "headline":"Cancelled","liveRun":null,"latestRun":4,"models":null,"cards":null,"review":null}
        """
        let steps = try JSONDecoder().decode(StepCardsResponse.self, from: Data(json.utf8))
        #expect(steps.task.state == "cancelled")
        #expect(steps.cards.isEmpty)
        #expect(steps.liveRun == nil)
        // The app's cancellable states (WorkbenchStore.cancellableStates: queued, failed, running) exclude it, so the app
        // says it has ended without sending a cancel.
        #expect(!["queued", "failed", "running"].contains(steps.task.state ?? ""))
    }

    @Test("A cancel the server refuses as changed is shown in its words once, never retried")
    func changedRefusalIsShownOnce() async throws {
        let words = "This task changed since it was shown — look again before cancelling."
        let server = StubServer { _, _ in .refused(409, words) }
        let (client, _) = client(server)
        do {
            _ = try await client.cancelTask(taskId: "t-9", state: "queued", runId: 4)
            Issue.record("cancel should have been refused")
        } catch {
            #expect(error as? ToolrollClientError == .refused(words))
            #expect(!ToolrollClient.isStaleSession(error))
        }
        #expect(server.requests.count == 1)
    }
}
