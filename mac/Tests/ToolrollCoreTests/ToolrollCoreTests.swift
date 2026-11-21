import Foundation
import Testing
@testable import ToolrollCore

@Suite("ToolrollCore")
struct ToolrollCoreTests {

    @Test("Decodes snake_case and camelCase Toolroll Engine payloads")
    func decodesEnginePayloads() throws {
        let rowsJson = """
        {
          "version": 1,
          "project": null,
          "project_name": "All projects",
          "needs_count": 2,
          "room": "home",
          "spend": { "todayUsd": 3.45, "planPercent": 28 },
          "rows": [
            {
              "id": "t-1",
              "title": "Fix lease handoff",
              "href": "/t/t-1",
              "project": "toolroll",
              "age": "3m",
              "status": "needs",
              "word": "Needs you",
              "ask": "Approve plan r2",
              "group": "needs",
              "rank": 1
            }
          ]
        }
        """
        let decoded = try JSONDecoder().decode(WorkRowsResponse.self, from: Data(rowsJson.utf8))
        #expect(decoded.needsCount == 2)
        #expect(decoded.projectName == "All projects")
        #expect(decoded.rows.count == 1)
        #expect(decoded.rows[0].status == .needs)
        #expect(decoded.spend?.todayUsd == 3.45)

        let candsJson = """
        {
          "ok": true,
          "taskId": "t-1",
          "currentBaseCommit": "1ed67ca1",
          "candidates": [
            {
              "id": "cand-1234abcd",
              "author": "alex",
              "createdAt": "2026-11-21T18:00:00Z",
              "files": ["src/handoff-cli.ts"],
              "note": "Add handoff status",
              "stale": false,
              "promotedAt": "2026-11-21T18:02:00Z",
              "promotedBy": "alex",
              "runId": 9,
              "branch": "tr/t-1/c-1234",
              "headCommit": "abcd1234",
              "checkStatus": "passed",
              "liveCheckState": "passed",
              "publication": { "id": 7, "state": "intended", "prNumber": 488, "prUrl": "https://github.com/ap9000/toolroll/pull/488" },
              "canOpenPr": false
            }
          ]
        }
        """
        let cands = try JSONDecoder().decode(CandidatesListResponse.self, from: Data(candsJson.utf8))
        #expect(cands.candidates.count == 1)
        #expect(cands.candidates[0].runId == 9)
        #expect(cands.candidates[0].publication?.prNumber == 488)
        #expect(cands.candidates[0].canOpenPr == false)
    }

    @Test("Normalizes HTTPS and loopback HTTP origins and refuses remote plaintext HTTP")
    func originValidation() throws {
        let https = try ToolrollClient.normalizedOrigin("https://toolroll.team.internal/")
        #expect(https.absoluteString == "https://toolroll.team.internal")

        let loopback = try ToolrollClient.normalizedOrigin("http://127.0.0.1:4141/")
        #expect(loopback.absoluteString == "http://127.0.0.1:4141")

        #expect(throws: ToolrollClientError.self) {
            _ = try ToolrollClient.normalizedOrigin("http://example.com:4141")
        }
    }

    @Test("SSEParser handles change, turn, and reload frames")
    func sseParserFrames() {
        #expect(SSEParser.parseFrame(event: "change", data: #"{"room":"home"}"#) == .change(room: "home"))
        #expect(SSEParser.parseFrame(event: "turn", data: #"{"room":"task:t-1"}"#) == .turn(room: "task:t-1"))
        #expect(SSEParser.parseFrame(event: "reload", data: "") == .reload)
        #expect(SSEParser.parseFrame(event: "ping", data: "ok") == nil)
    }

    @Test("ProfileStore round-trips profiles with 0600 permissions")
    func profileStoreRoundTrip() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-mac-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }
        let fileURL = tmpDir.appendingPathComponent("profiles.json")
        let store = ProfileStore(fileURL: fileURL)

        let p = ConnectionProfile(
            name: "central",
            origin: "https://toolroll.team.internal",
            account: "alex",
            token: "tr_tok_secret",
            workspaceId: "ws-1",
            recoveryGeneration: "gen-2",
            label: "Central Team"
        )
        try store.save(profile: p, makeActive: true)

        let loaded = store.load()
        #expect(loaded.activeName == "central")
        #expect(loaded.active == p)

        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let perms = (attrs[.posixPermissions] as? NSNumber)?.intValue
        #expect(perms == 0o600)
    }

    @Test("VT100Emulator handles ANSI SGR, CR overwrite, scrollback, and split UTF-8")
    func vt100EmulatorBehavior() {
        var emu = VT100Emulator(cols: 40, rows: 4, maxScrollback: 100)
        emu.feedText("\u{1B}[32m✓\u{1B}[0m ok\r\n")
        emu.feedText("progress 10%\rprogress 100%\r\n")
        emu.feedText("line3\r\nline4\r\nline5")

        let text = emu.plainText()
        #expect(text.contains("✓ ok"))
        #expect(text.contains("progress 100%"))
        #expect(!text.contains("progress 10%"))
        #expect(emu.scrollbackCount >= 1)

        // Split multi-byte UTF-8 checkmark across two chunks
        let checkBytes = Array("✓".utf8)
        var utf8Emu = VT100Emulator(cols: 40, rows: 4)
        utf8Emu.feed(Data(checkBytes.prefix(2)))
        utf8Emu.feed(Data(checkBytes.suffix(from: 2)))
        #expect(utf8Emu.plainText().contains("✓"))
    }

    @Test("LiveTerminalSession requires 1-step confirmation before preempting active human Controller")
    @MainActor
    func terminalLeaseTakeoverStateMachine() {
        let session = LiveTerminalSession()
        session.attachDemo(taskId: "t-1", program: "shell", branch: "tr/t-1/live", controller: "sam", me: "alex")

        #expect(session.role == .observer)
        #expect(session.requiresTakeoverConfirm == true)
        #expect(session.takeoverArmed == false)

        // First click arms confirmation instead of abruptly kicking sam
        let firstResult = session.requestTakeControl()
        #expect(firstResult == false)
        #expect(session.takeoverArmed == true)
        #expect(session.role == .observer)

        // Second click confirms takeover
        let secondResult = session.requestTakeControl()
        #expect(secondResult == true)
        #expect(session.takeoverArmed == false)
        #expect(session.role == .controller)
        #expect(session.controller == "alex")

        // Release returns to idle observer
        session.releaseControl()
        #expect(session.role == .observer)
        #expect(session.controller == nil)
        #expect(session.requiresTakeoverConfirm == false)

        // When idle, requestTakeControl succeeds immediately without extra confirm
        let idleTake = session.requestTakeControl()
        #expect(idleTake == true)
        #expect(session.role == .controller)

        // Remote preemption frame updates role cleanly
        session.applyControlFrame(text: #"{"t":"control","role":"observer","controller":"maya","viewers":["alex","maya"],"epoch":4}"#)
        #expect(session.role == .observer)
        #expect(session.controller == "maya")
        #expect(session.statusNote?.contains("maya") == true)
    }

    @Test("CommandPaletteEngine surfaces contextual Candidate Open PR and fuzzy-ranks queries")
    func commandPaletteFiltering() {
        let items = CommandPaletteEngine.buildItems(
            rows: DemoFixtures.workRows.rows,
            selectedTaskId: "t-handoff-rebase",
            presence: DemoFixtures.presence,
            candidates: DemoFixtures.candidates(for: "t-handoff-rebase").candidates,
            profiles: [ProfileStore.demoProfile()],
            activeProfileName: "demo",
            terminalControlling: false
        )

        let prMatches = CommandPaletteEngine.filter(items: items, query: "open pr")
        #expect(prMatches.first?.title.contains("Open PR") == true)

        let promoteMatches = CommandPaletteEngine.filter(items: items, query: "promote")
        #expect(promoteMatches.first?.title.contains("Promote Candidate") == true)

        let handoffMatches = CommandPaletteEngine.filter(items: items, query: "hand off sam")
        #expect(handoffMatches.contains(where: { $0.action == .handOff(taskId: "t-handoff-rebase", person: "sam") }))
    }

    @Test("Live end-to-end check against running Toolroll central server (when TOOLROLL_LIVE_ORIGIN is set)")
    @MainActor
    func liveServerEndToEnd() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["TOOLROLL_LIVE_ORIGIN"],
              let token = env["TOOLROLL_LIVE_TOKEN"],
              let taskId = env["TOOLROLL_LIVE_TASK"],
              !origin.isEmpty, !token.isEmpty
        else {
            return
        }

        let profile = ConnectionProfile(
            name: "live-test",
            origin: origin,
            account: env["TOOLROLL_LIVE_ACCOUNT"] ?? "alice",
            token: token,
            workspaceId: env["TOOLROLL_LIVE_WORKSPACE"],
            recoveryGeneration: env["TOOLROLL_LIVE_RECOVERY"]
        )
        let client = ToolrollClient(profile: profile)

        let rows = try await client.fetchWorkRows()
        #expect(rows.rows.contains(where: { $0.id == taskId }))

        let presence = try await client.fetchPresence()
        #expect(!presence.me.isEmpty)

        let steps = try await client.fetchSteps(taskId: taskId)
        #expect(steps.task.id == taskId)

        let cands = try await client.fetchCandidates(taskId: taskId)
        #expect(cands.ok == true)
        if let firstUnpromoted = cands.candidates.first(where: { $0.promotedAt == nil && !$0.stale }) {
            let promoted = try await client.promoteCandidate(taskId: taskId, candidateId: firstUnpromoted.id)
            #expect(promoted.ok == true)
            #expect(promoted.runId != nil)

            let diff = try await client.fetchDiff(taskId: taskId, runId: promoted.runId)
            #expect(diff.task == taskId)
            if let firstFile = diff.files.first {
                let fileHunks = try await client.fetchDiffFile(taskId: taskId, fileIndex: firstFile.fileIndex, runId: diff.run)
                #expect(fileHunks.path == firstFile.path)
            }
        }

        let started = try await client.startOrReuseTerminal(taskId: taskId, program: "shell")
        #expect(started.ok == true)

        let session = LiveTerminalSession()
        await session.attach(
            client: client,
            terminalId: started.id,
            taskId: taskId,
            program: started.program,
            branch: started.branch
        )

        // Wait briefly for hello + control frames, then take control and echo a sentinel
        for _ in 0..<40 {
            try await Task.sleep(nanoseconds: 50_000_000)
            if session.isControlling || !session.requiresTakeoverConfirm {
                break
            }
        }
        _ = session.requestTakeControl()
        try await Task.sleep(nanoseconds: 150_000_000)
        session.sendInput("echo MAC_SWIFT_LIVE_OK\r")

        var sawSentinel = false
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 50_000_000)
            let joined = session.renderLines.map(\.plainText).joined(separator: "\n")
            if joined.contains("MAC_SWIFT_LIVE_OK") {
                sawSentinel = true
                break
            }
        }
        session.releaseControl()
        session.disconnect(clearOutput: true)
        #expect(sawSentinel == true)
    }

    @Test("Auto-discovers live local Toolroll console via Unix socket and redeems /login/once (when TOOLROLL_TEST_LOCAL_DISCOVER=1)")
    func localConsoleAutoDiscover() async throws {
        guard ProcessInfo.processInfo.environment["TOOLROLL_TEST_LOCAL_DISCOVER"] == "1" else { return }
        let creds = await LocalConsoleConnector.discoverAndConnect()
        #expect(creds != nil)
        guard let creds else { return }
        let client = ToolrollClient(localSession: creds)
        let rows = try await client.fetchWorkRows()
        #expect(rows.version == 1)
        let agents = try await client.fetchAgents()
        #expect(agents.version == 1)
        #expect(!agents.agents.isEmpty)
        let models = try await client.fetchModels()
        #expect(models.version == 1)
    }

    @Test("YouiCanvasStorage round-trips youi.request/v1 spatial pins and layouts artboards cleanly")
    func canvasStorageRoundTrip() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-canvas-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let boards = YouiCanvasStorage.layoutArtboards(
            from: [
                YouiScreenEntry(route: "/work", path: "/work"),
                YouiScreenEntry(route: "/chat", path: "/chat"),
            ],
            projectRoot: tmpDir.path,
            columns: 2,
            viewport: .desktop
        )
        #expect(boards.count == 2)
        #expect(boards[1].x > boards[0].x)

        let pin = CanvasPin(
            artboardRoute: "/work",
            artboardPath: "/work",
            xFrac: 0.42,
            yFrac: 0.25,
            kind: .options,
            body: "Explore tighter header spacing",
            author: "alex",
            linkedTaskId: "t-ui-1"
        )
        let written = YouiCanvasStorage.writeYouiRequest(projectRoot: tmpDir.path, projectName: "toolroll", pin: pin)
        #expect(written != nil)

        let loaded = YouiCanvasStorage.loadPins(projectRoot: tmpDir.path)
        #expect(loaded.count == 1)
        #expect(loaded[0].id == pin.id)
        #expect(loaded[0].kind == .options)
        #expect(loaded[0].linkedTaskId == "t-ui-1")
        #expect(abs(loaded[0].xFrac - 0.42) < 0.001)
    }

    @Test("Discovers TanStack routes and detects pnpm Vite dev command & port automatically")
    func routeDiscoveryAndDevCommandDetection() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-routes-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let routesDir = tmpDir.appendingPathComponent("src/routes/work", isDirectory: true)
        try FileManager.default.createDirectory(at: routesDir, withIntermediateDirectories: true)
        try Data("export default {}".utf8).write(to: tmpDir.appendingPathComponent("src/routes/index.tsx"))
        try Data("export default {}".utf8).write(to: tmpDir.appendingPathComponent("src/routes/shelf.tsx"))
        try Data("export default {}".utf8).write(to: tmpDir.appendingPathComponent("src/routes/work/index.tsx"))
        try Data("export default {}".utf8).write(to: tmpDir.appendingPathComponent("src/routes/__root.tsx"))
        try Data("lockfileVersion: 9".utf8).write(to: tmpDir.appendingPathComponent("pnpm-lock.yaml"))
        try Data(#"{"scripts":{"dev":"vite dev --port 3000"}}"#.utf8).write(to: tmpDir.appendingPathComponent("package.json"))

        let discovered = YouiCanvasStorage.discoverRoutes(projectRoot: tmpDir.path)
        #expect(discovered.map(\.path) == ["/", "/shelf", "/work"])
        #expect(discovered.first(where: { $0.path == "/shelf" })?.sourceFile == "src/routes/shelf.tsx")

        let detected = PreviewServerManager.detectDevCommand(projectRoot: tmpDir.path)
        #expect(detected?.displayCommand == "pnpm dev")
        #expect(detected?.expectedPort == 3000)
    }
}
