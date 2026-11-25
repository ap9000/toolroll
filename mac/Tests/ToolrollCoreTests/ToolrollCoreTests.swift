import CoreGraphics
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

        let firstResult = session.requestTakeControl()
        #expect(firstResult == false)
        #expect(session.takeoverArmed == true)
        #expect(session.role == .observer)

        let secondResult = session.requestTakeControl()
        #expect(secondResult == true)
        #expect(session.takeoverArmed == false)
        #expect(session.role == .controller)
        #expect(session.controller == "alex")

        session.releaseControl()
        #expect(session.role == .observer)
        #expect(session.controller == nil)
        #expect(session.requiresTakeoverConfirm == false)

        let idleTake = session.requestTakeControl()
        #expect(idleTake == true)
        #expect(session.role == .controller)

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

    @Test("ElementLiveEdit summarizes visual deltas and findSourceFile locates local component source")
    func elementContextAndLiveEditDiff() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-src-lookup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let compDir = tmpDir.appendingPathComponent("src/components", isDirectory: true)
        try FileManager.default.createDirectory(at: compDir, withIntermediateDirectories: true)
        let source = """
        export function RetryCard() {
          return (
            <section data-testid="retry-card">
              <h2>Retry scheduled</h2>
            </section>
          );
        }
        """
        try Data(source.utf8).write(to: compDir.appendingPathComponent("RetryCard.tsx"))

        let found = YouiCanvasStorage.findSourceFile(
            projectRoot: tmpDir.path,
            testId: "retry-card",
            textExcerpt: "Retry scheduled",
            selector: "section"
        )
        #expect(found?.file == "src/components/RetryCard.tsx")
        #expect(found?.line == 3)

        let ctx = SelectedElementContext(
            elId: "tr-el-1",
            displayName: "RetryCard",
            tag: "section",
            selector: "[data-testid=\"retry-card\"]",
            testId: "retry-card",
            textExcerpt: "Retry scheduled",
            category: .card,
            file: found?.file,
            line: found?.line,
            metrics: ElementStyleMetrics(width: 480, height: 96, padding: 16, gap: 8, fontSize: 14, fontWeight: 500, borderRadius: 8, opacity: 1.0)
        )
        var edit = ElementLiveEdit(from: ctx)
        #expect(!edit.hasChanges)
        edit.editedText = "Retrying shortly"
        edit.padding = 12
        edit.borderRadius = 4
        #expect(edit.hasChanges)
        let formatted = edit.formattedForTask()
        #expect(formatted.contains("RetryCard"))
        #expect(formatted.contains("src/components/RetryCard.tsx:3"))
        #expect(formatted.contains("padding: 16px → 12px"))
        #expect(formatted.contains("border-radius: 8px → 4px"))
        #expect(formatted.contains("Retrying shortly"))
    }

    @Test("CanvasVisualDiff detects identical vs modified pixels and generates heatmap overlay")
    func visualDiffHeatmapAndCheckpoints() throws {
        func makeSolidCGImage(w: Int, h: Int, fillBox: CGRect? = nil) -> CGImage {
            let cs = CGColorSpace(name: CGColorSpace.sRGB)!
            let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.setFillColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1.0)
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            if let box = fillBox {
                ctx.setFillColor(red: 0.95, green: 0.95, blue: 0.95, alpha: 1.0)
                ctx.fill(box)
            }
            return ctx.makeImage()!
        }

        let before = makeSolidCGImage(w: 200, h: 100)
        let same = makeSolidCGImage(w: 200, h: 100)
        let sameDiff = CanvasVisualDiff.compare(before: before, after: same, maxWidth: 200)
        #expect(sameDiff.isIdentical == true)
        #expect(sameDiff.changedPercent == 0.0)

        let after = makeSolidCGImage(w: 200, h: 100, fillBox: CGRect(x: 0, y: 0, width: 100, height: 50))
        let changedDiff = CanvasVisualDiff.compare(before: before, after: after, maxWidth: 200)
        #expect(changedDiff.isIdentical == false)
        #expect(changedDiff.changedPercent > 24.0 && changedDiff.changedPercent < 26.0)
        #expect(changedDiff.heatmapImage != nil)
    }

    @Test("WorkspaceThemeStore parses Lead's tui.toml themes and preserves custom themes on preference updates")
    func workspaceThemeStoreRoundTrip() throws {
        let tmpFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-theme-\(UUID().uuidString).toml")
        defer { try? FileManager.default.removeItem(at: tmpFile) }

        let sample = """
        # Lead-created theme
        theme = "neon-night"
        density = "compact"
        list_side = "right"
        show_costs = false

        [themes.neon-night]
        base = "dark"
        ground = "#090918"
        paper = "#101027"
        ink = "#e8f4ff"
        selection = "#5fffe1"
        """
        try Data(sample.utf8).write(to: tmpFile)

        let parsed = WorkspaceThemeStore.load(from: tmpFile)
        #expect(parsed.activeTheme == "neon-night")
        #expect(parsed.isCompact == true)
        #expect(parsed.isSidebarOnRight == true)
        #expect(parsed.showCosts == false)
        #expect(parsed.effectiveCustomPalette?.paper == "#101027")
        #expect(parsed.effectiveCustomPalette?.selection == "#5fffe1")

        WorkspaceThemeStore.savePreferences(theme: "signal", density: "comfortable", listSide: "left", glassChrome: false, to: tmpFile)
        let reloaded = WorkspaceThemeStore.load(from: tmpFile)
        #expect(reloaded.activeTheme == "signal")
        #expect(reloaded.isCompact == false)
        #expect(reloaded.isSidebarOnRight == false)
        #expect(reloaded.glassChrome == false)
        #expect(reloaded.savedThemes["neon-night"]?.paper == "#101027")
    }

    @Test("ApprovalPlanDigest extracts Goal, file deltas (+ Added / - Removed), and tagged Checks cleanly")
    func approvalPlanDigestParsing() {
        let terms = [
            ApprovalTerm(label: "Revision", words: "This revises build #13. One limit changes from that build: files."),
            ApprovalTerm(label: "Changed", words: "files: was only README.md, src/routes/index.tsx, now only README.md, src/routes/index.tsx, node-compile-cache/v26"),
            ApprovalTerm(label: "Goal", words: "Create a distinctive, modern homepage with clean editorial typography."),
            ApprovalTerm(label: "Won't touch", words: "No backend or CMS changes."),
            ApprovalTerm(label: "Done when", words: "Homepage shows prominent heading. (shown in a screenshot)\npnpm build succeeds. (runs automatically)"),
            ApprovalTerm(label: "Agent", words: "Codex · gpt-6-astra plans, builds, fixes and reviews"),
            ApprovalTerm(label: "Files", words: "only README.md, src/routes/index.tsx, node-compile-cache/v26"),
        ]
        let digest = ApprovalPlanDigest.parse(from: terms)
        #expect(digest.goal?.contains("editorial typography") == true)
        #expect(digest.addedFiles == ["node-compile-cache/v26"])
        #expect(digest.removedFiles.isEmpty)
        #expect(digest.files.count == 3)
        #expect(digest.checks.count == 2)
        #expect(digest.checks[0].badge == "Visual")
        #expect(digest.checks[1].badge == "Auto")
        #expect(digest.wontTouch == "No backend or CMS changes.")
    }

    @Test("ToolrollClient.parseRedirectFeedback extracts ?problem= and ?said= from 303 redirect URLs")
    func redirectFeedbackParsing() {
        let probURL = URL(string: "http://127.0.0.1:4180/settings/models?problem=Enter%20your%20Toolroll%20password%20to%20change%20models.")!
        let probRes = ToolrollClient.parseRedirectFeedback(finalURL: probURL, locationHeader: nil)
        #expect(probRes.problem == "Enter your Toolroll password to change models.")
        #expect(probRes.said == nil)

        let saidURL = URL(string: "http://127.0.0.1:4180/settings/models?said=All%20projects%3A%201%20change%20saved.")!
        let saidRes = ToolrollClient.parseRedirectFeedback(finalURL: saidURL, locationHeader: nil)
        #expect(saidRes.said == "All projects: 1 change saved.")
        #expect(saidRes.problem == nil)
    }

    @Test("Local session WebSocket request carries toolroll.key.<key> protocol and live terminal start works when TOOLROLL_TEST_LOCAL_TERM=1")
    func localWebSocketMutationKeyAndOptionalLiveTerm() async throws {
        let fakeKey = String(repeating: "a", count: 64)
        let creds = LocalSessionCredentials(
            origin: "http://127.0.0.1:4180",
            account: "alex",
            cookieHeader: "toolroll_session=abc",
            csrf: "csrf123",
            key: fakeKey,
            epoch: "e1",
            databasePath: "/tmp/orders.db"
        )
        let client = ToolrollClient(localSession: creds)
        let wsReq = try await client.webSocketRequest(terminalId: String(repeating: "f", count: 32))
        #expect(wsReq.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == "toolroll, toolroll.key.\(fakeKey)")
        #expect(wsReq.value(forHTTPHeaderField: "x-toolroll-key") == fakeKey)
        #expect(wsReq.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:4180")

        guard ProcessInfo.processInfo.environment["TOOLROLL_TEST_LOCAL_TERM"] == "1" else { return }
        let liveCreds = await LocalConsoleConnector.discoverAndConnect()
        #expect(liveCreds != nil)
        guard let liveCreds else { return }
        let liveClient = ToolrollClient(localSession: liveCreds)
        let state = try await liveClient.fetchTerminals()
        #expect(state.available == true)
        let projects = state.projects ?? []
        #expect(!projects.isEmpty)
        let term = try await liveClient.startOrReuseTerminal(
            taskId: "smoke-test",
            project: projects.first?.name,
            runId: nil,
            program: "shell"
        )
        #expect(!term.id.isEmpty)
        let liveSession = await LiveTerminalSession()
        await liveSession.attach(client: liveClient, terminalId: term.id, taskId: nil, program: term.program, branch: term.branch)
        try await Task.sleep(for: .milliseconds(700))
        await MainActor.run {
            #expect(liveSession.connectionState == .connected)
            #expect(!liveSession.renderLines.isEmpty)
            liveSession.disconnect()
        }
    }

    @Test("DiffLine classifies engine-api addition, deletion, context, and meta kinds accurately")
    func diffLineKindClassification() {
        let added = DiffLine(kind: "addition", text: "let x = 1", oldLine: nil, newLine: 10)
        let deleted = DiffLine(kind: "deletion", text: "let x = 0", oldLine: 10, newLine: nil)
        let context = DiffLine(kind: "context", text: "return x", oldLine: 11, newLine: 11)
        let meta = DiffLine(kind: "meta", text: "\\ No newline at end of file", oldLine: nil, newLine: nil)

        #expect(added.isAddition && !added.isDeletion && !added.isMeta)
        #expect(deleted.isDeletion && !deleted.isAddition && !deleted.isMeta)
        #expect(!context.isAddition && !context.isDeletion && !context.isMeta)
        #expect(meta.isMeta && !meta.isAddition && !meta.isDeletion)
    }

    @Test("ElementStyleMetrics safely clamps Tailwind rounded-full 3.4e38, Infinity, and NaN without Int overflow")
    func elementStyleMetricsOverflowProtection() {
        let metrics = ElementStyleMetrics(
            width: 120,
            height: 36,
            padding: .nan,
            gap: .infinity,
            fontSize: 14,
            fontWeight: 600,
            borderRadius: Double(Float.greatestFiniteMagnitude),
            opacity: .nan
        )
        #expect(metrics.padding == 0)
        #expect(metrics.gap == 9999)
        #expect(metrics.borderRadius == 9999)
        #expect(metrics.opacity == 1)
        #expect(ElementStyleMetrics.safeInt(Double(Float.greatestFiniteMagnitude)) == 9999)
        #expect(ElementStyleMetrics.safeInt(.infinity) == 9999)
        #expect(ElementStyleMetrics.safeInt(.nan) == 0)
    }

    @Test("ModelOption.formValue prefixes provider|model for POST /settings/models/agent")
    func modelOptionFormValueFormatting() async throws {
        let raw = ModelOption(value: "claude-opus-5-5", label: "Claude Opus 5.5")
        #expect(raw.formValue(forProvider: "claude") == "claude|claude-opus-5-5")
        let alreadyPrefixed = ModelOption(value: "codex|gpt-6-astra", label: "GPT-6 Astra")
        #expect(alreadyPrefixed.formValue(forProvider: "codex") == "codex|gpt-6-astra")

        guard ProcessInfo.processInfo.environment["TOOLROLL_TEST_LOCAL_MODELS"] == "1" else { return }
        let creds = await LocalConsoleConnector.discoverAndConnect()
        #expect(creds != nil)
        guard let creds else { return }
        let client = ToolrollClient(localSession: creds)
        let before = try await client.fetchModels()
        guard let planRole = before.roles.first(where: { $0.key == "plan" }),
              let buildRole = before.roles.first(where: { $0.key == "build" }),
              let reviewRole = before.roles.first(where: { $0.key == "review" })
        else { return }
        let origPlan = planRole.current
        let origBuild = buildRole.current
        let origReview = reviewRole.current

        let gemTarget = "gemini|gemini-4-argon"
        let opusTarget = "claude|claude-opus-5-5"
        let astraTarget = "codex|gpt-6.2-astra"
        let reply = try await client.updateModels(
            digest: before.digest,
            fields: ["plan": gemTarget, "build": opusTarget, "review": astraTarget]
        )
        #expect(!reply.isEmpty)
        let mid = try await client.fetchModels()
        #expect(mid.roles.first(where: { $0.key == "plan" })?.current == gemTarget)
        #expect(mid.roles.first(where: { $0.key == "build" })?.current == opusTarget)
        #expect(mid.roles.first(where: { $0.key == "review" })?.current == astraTarget)
        var restore: [String: String] = [:]
        if !origPlan.isEmpty { restore["plan"] = origPlan }
        if !origBuild.isEmpty { restore["build"] = origBuild }
        if !origReview.isEmpty { restore["review"] = origReview }
        if !restore.isEmpty {
            _ = try await client.updateModels(digest: mid.digest, fields: restore)
        }
    }

    @Test("LiveActivityTimeline collapses consecutive redacted commands and pairs step status")
    func testLiveActivityTimelineGrouping() {
        let records: [LiveAgentRecord] = [
            LiveAgentRecord(k: "open", detail: "base"),
            LiveAgentRecord(k: "say", textLines: ["I'll inspect the repo."]),
            LiveAgentRecord(k: "step", stepId: "s1", kind: "command"),
            LiveAgentRecord(k: "done", stepId: "s1", ok: true),
            LiveAgentRecord(k: "step", stepId: "s2", kind: "command"),
            LiveAgentRecord(k: "done", stepId: "s2", ok: true),
            LiveAgentRecord(k: "step", stepId: "s3", kind: "command"),
            LiveAgentRecord(k: "done", stepId: "s3", ok: false),
            LiveAgentRecord(k: "say", textLines: ["Found the issue."]),
            LiveAgentRecord(k: "step", stepId: "s4", kind: "edit", target: "STANDING-ORDERS-PLAN.json"),
            LiveAgentRecord(k: "done", stepId: "s4", ok: true),
            LiveAgentRecord(k: "step", stepId: "s5", kind: "command", target: "pnpm build"),
            LiveAgentRecord(k: "done", stepId: "s5", ok: true, out: ["Built in 1.2s"]),
            LiveAgentRecord(k: "end")
        ]

        let timeline = LiveActivityTimeline.build(from: records, isLive: false)
        #expect(timeline.hasHiddenCommands == true)
        #expect(timeline.items.count == 5)

        if case .message(_, let text) = timeline.items[0] {
            #expect(text == "I'll inspect the repo.")
        } else {
            Issue.record("Expected message first")
        }

        if case .hiddenSteps(_, let kind, let count, let failedCount, let runningCount) = timeline.items[1] {
            #expect(kind == "command")
            #expect(count == 3)
            #expect(failedCount == 1)
            #expect(runningCount == 0)
            #expect(
                LiveActivityItem.hiddenStepLabel(kind: kind, count: count, failedCount: failedCount, runningCount: runningCount)
                == "Ran 3 shell commands · 1 failed"
            )
        } else {
            Issue.record("Expected collapsed hiddenSteps second")
        }

        if case .step(_, let kind, let summary, let status, _) = timeline.items[3] {
            #expect(kind == "edit")
            #expect(summary == "STANDING-ORDERS-PLAN.json")
            #expect(status == .succeeded)
        } else {
            Issue.record("Expected named edit step fourth")
        }

        if case .step(_, let kind, let summary, let status, let out) = timeline.items[4] {
            #expect(kind == "command")
            #expect(summary == "pnpm build")
            #expect(status == .succeeded)
            #expect(out == ["Built in 1.2s"])
        } else {
            Issue.record("Expected visible command step fifth")
        }
    }

    @Test("ComposerAttachmentStore saves pasted images, detects folders, and formats context submissions")
    func testComposerAttachmentStore() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-att-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let savedImg = try ComposerAttachmentStore.saveImageData(
            Data([0x89, 0x50, 0x4E, 0x47]),
            pixelSize: "1440×900",
            suggestedName: "Homepage mock",
            in: tmpDir
        )
        #expect(savedImg.kind == .image)
        #expect(FileManager.default.fileExists(atPath: savedImg.path))
        #expect(savedImg.pixelSize == "1440×900")

        let folderAtt = ComposerAttachmentStore.makeAttachment(for: tmpDir)
        #expect(folderAtt?.kind == .folder)
        #expect(folderAtt?.path == tmpDir.standardizedFileURL.path)

        let composed = ComposerAttachmentStore.composeSubmission(
            text: "Match the spacing in this screenshot",
            attachments: [folderAtt!, savedImg]
        )
        #expect(composed.title == "Match the spacing in this screenshot")
        #expect(composed.goal.contains("Attached context:"))
        #expect(composed.goal.contains("- Folder: \(tmpDir.standardizedFileURL.path)"))
        #expect(composed.goal.contains("- Image: \(savedImg.path) (1440×900)"))

        let imageOnly = ComposerAttachmentStore.composeSubmission(text: "", attachments: [savedImg])
        #expect(imageOnly.title.contains("Homepage mock"))
        #expect(imageOnly.combinedMessage.contains(savedImg.path))
    }

    @Test("LocalWorkspaceDiscovery detects Git repos, setup commands, and Claude/Codex/Gemini CLI threads")
    func testLocalWorkspaceDiscovery() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-discovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let repo = root.appendingPathComponent("sample-web", isDirectory: true)
        try FileManager.default.createDirectory(at: repo.appendingPathComponent(".git", isDirectory: true), withIntermediateDirectories: true)
        try "ref: refs/heads/feat/hero\n".write(to: repo.appendingPathComponent(".git/HEAD"), atomically: true, encoding: .utf8)
        try "lockfileVersion: 9.0\n".write(to: repo.appendingPathComponent("pnpm-lock.yaml"), atomically: true, encoding: .utf8)

        let repos = LocalWorkspaceDiscovery.scanGitRepositories(roots: [root], maxDepth: 2, limit: 10)
        #expect(repos.count == 1)
        #expect(repos[0].name == "sample-web")
        #expect(repos[0].branch == "feat/hero")
        #expect(repos[0].suggestedSetupCommand == "pnpm install --frozen-lockfile")

        let claudeDir = root.appendingPathComponent(".claude/projects/-tmp-sample-web", isDirectory: true)
        try FileManager.default.createDirectory(at: claudeDir, withIntermediateDirectories: true)
        let claudeSession = """
        {"type":"user","sessionId":"cl-123","cwd":"\(repo.path)","gitBranch":"feat/hero","message":{"role":"user","content":"Polish the homepage spacing and typography"}}
        {"type":"assistant","sessionId":"cl-123","message":{"role":"assistant","content":[{"type":"text","text":"Updated the hero grid and type scale."}]}}
        """
        try claudeSession.write(to: claudeDir.appendingPathComponent("cl-123.jsonl"), atomically: true, encoding: .utf8)

        let codexDir = root.appendingPathComponent(".codex/sessions/2026/11/21", isDirectory: true)
        try FileManager.default.createDirectory(at: codexDir, withIntermediateDirectories: true)
        let codexSession = """
        {"type":"session_meta","payload":{"id":"cx-456","cwd":"\(repo.path)","git":{"branch":"feat/hero"}}}
        {"type":"event_msg","payload":{"type":"user_message","message":"Add dark mode contrast checks"}}
        {"type":"event_msg","payload":{"type":"agent_message","message":"Added contrast assertions."}}
        """
        try codexSession.write(to: codexDir.appendingPathComponent("rollout-cx-456.jsonl"), atomically: true, encoding: .utf8)

        let geminiDir = root.appendingPathComponent(".gemini/tmp/sample-web/chats", isDirectory: true)
        try FileManager.default.createDirectory(at: geminiDir, withIntermediateDirectories: true)
        try repo.path.write(to: root.appendingPathComponent(".gemini/tmp/sample-web/.project_root"), atomically: true, encoding: .utf8)
        let geminiSession = """
        {"sessionId":"gm-789","startTime":"2026-11-21T20:00:00Z"}
        {"type":"user","content":[{"text":"<session_context>ignore me</session_context>"}]}
        {"type":"user","content":[{"text":"Plan the release update flow"}]}
        {"type":"gemini","content":[{"text":"Here is a 3-step plan."}]}
        """
        try geminiSession.write(to: geminiDir.appendingPathComponent("session-gm-789.jsonl"), atomically: true, encoding: .utf8)

        let threads = LocalWorkspaceDiscovery.scanCliThreads(home: root, limit: 10)
        #expect(threads.count == 3)
        let providers = Set(threads.map(\.provider))
        #expect(providers == [.claude, .codex, .gemini])

        let geminiThread = try #require(threads.first(where: { $0.provider == .gemini }))
        #expect(geminiThread.title == "Plan the release update flow")
        #expect(geminiThread.resumeCommand == "gemini --resume gm-789")

        let geminiMsgs = LocalWorkspaceDiscovery.loadCliThreadMessages(thread: geminiThread)
        #expect(geminiMsgs.count == 2)
        #expect(geminiMsgs[0].role == "user")
        #expect(geminiMsgs[1].role == "assistant")
    }

    @Test("ToolrollClient.parseProjectSettingsHTML extracts live-view nonce, network switches, and concurrency")
    func testParseProjectSettingsHTML() {
        let html = """
        <span data-live-view-setting="base"> · Commands hidden</span>
        <form id="live-view-form" action="/settings/project/live-view" method="post">
          <input type="hidden" name="repo" value="/tmp/site">
          <input type="hidden" name="act" value="on">
          <input type="hidden" name="nonce" value="nonce-abc-999">
        </form>
        <input id="network-local" name="local" type="checkbox" value="any" checked>
        <input id="network-open" name="mode" type="checkbox" value="open">
        <textarea id="network-hosts" name="hosts">api.stripe.com\n*.github.com</textarea>
        <input id="builds-at-once-n" name="concurrency" type="number" value="3">
        """
        let snap = ToolrollClient.parseProjectSettingsHTML(html, repo: "/tmp/site")
        #expect(snap.projectName == "site")
        #expect(snap.liveCommandsShown == false)
        #expect(snap.liveViewNonce == "nonce-abc-999")
        #expect(snap.networkLocalAny == true)
        #expect(snap.networkOpen == false)
        #expect(snap.networkHosts == "api.stripe.com\n*.github.com")
        #expect(snap.concurrency == 3)
    }

    @Test("A shell start says whether it is a scratch shell and why; an older server's reply still decodes")
    func shellStartScratchAndNote() throws {
        let legacy = try JSONDecoder().decode(StartRemoteTerminalResponse.self, from: Data(#"{"ok":true,"id":"t1","branch":"toolroll/live-1","program":"shell","reused":false}"#.utf8))
        #expect(legacy.scratch == nil)
        #expect(legacy.note == nil)
        let scratch = StartRemoteTerminalResponse(ok: true, id: "t2", branch: "toolroll/live-2", program: "shell", reused: false, scratch: true, note: "This build has no saved commit yet.")
        let round = try JSONDecoder().decode(StartRemoteTerminalResponse.self, from: JSONEncoder().encode(scratch))
        #expect(round == scratch)
        #expect(round.scratch == true)
    }

    @Test("The server's two local-owner sentences never become a password box; other password refusals do")
    func signInRefusalsMapExactly() {
        #expect(ToolrollClient.refusal("Set a password to do this.") == .passwordNotSet("Set a password to do this."))
        #expect(ToolrollClient.refusal("Sign in with your password to do this.") == .fullSignInNeeded("Sign in with your password to do this."))
        #expect(ToolrollClient.refusal("Enter your Toolroll password to change what builds may reach.") == .passwordRequired("Enter your Toolroll password to change what builds may reach."))
        #expect(ToolrollClient.refusal("An approver for this project changes what its builds may reach.") == .refused("An approver for this project changes what its builds may reach."))
    }

    @Test("A password reaches the server exactly as typed: + & = % and spaces are encoded")
    func formEncodingKeepsEveryCharacter() {
        #expect(ToolrollClient.formEncoded([("password", "a+b&c=d %e")]) == "password=a%2Bb%26c%3Dd%20%25e")
        #expect(ToolrollClient.formEncoded([("csrf", "ab12"), ("local", "any")]) == "csrf=ab12&local=any")
        #expect(ToolrollClient.formEncoded([("password", "pässword")]) == "password=p%C3%A4ssword")
    }

    @Test("A session from an older console doesn't say whether a password is set")
    func sessionPasswordSetDefaultsToUnknown() {
        let creds = LocalSessionCredentials(origin: "http://127.0.0.1:4180", account: "alex", cookieHeader: "s=1", csrf: "c", key: "k", epoch: "e", databasePath: "/tmp/x.db")
        #expect(creds.passwordSet == nil)
        let told = LocalSessionCredentials(origin: "http://127.0.0.1:4180", account: "alex", cookieHeader: "s=1", csrf: "c", key: "k", epoch: "e", databasePath: "/tmp/x.db", passwordSet: false)
        #expect(told.passwordSet == false)
    }

    @Test("AgentRequestStore decodes Node-filed requests from .toolroll-run and resolves them atomically")
    func agentRequestStoreRoundTripAndResolve() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-agent-req-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

        let dbPath = tmpDir.appendingPathComponent("orders.db").path
        let filePath = AgentRequestStore.requestsFilePath(databasePath: dbPath)
        #expect(filePath.hasSuffix("/.toolroll-run/agent-requests.json"))

        let req = AgentRequest(
            id: "req_abc1234567",
            kind: .network,
            repo: "/tmp/site",
            projectName: "site",
            requester: "Claude Code",
            summary: "Allow this Mac's local services (localhost / ::1)",
            why: "Vite prerender needs localhost:3000",
            params: AgentRequestParams(local: "any", mode: "allowlist", hosts: ["api.stripe.com"])
        )
        AgentRequestStore.appendForTesting(databasePath: dbPath, request: req)

        let pending = AgentRequestStore.loadPending(databasePath: dbPath)
        #expect(pending.count == 1)
        #expect(pending[0].id == "req_abc1234567")
        #expect(pending[0].params.local == "any")

        let resolved = AgentRequestStore.resolve(databasePath: dbPath, id: req.id, status: .approved, note: "Touch ID")
        #expect(resolved?.status == .approved)
        #expect(resolved?.resolutionNote == "Touch ID")
        #expect(AgentRequestStore.loadPending(databasePath: dbPath).isEmpty)
        #expect(AgentRequestStore.load(databasePath: dbPath).count == 1)
    }

    @Test("AgentChatStreamParser parses Claude, Codex, and Gemini streams and builds resume commands")
    func agentChatParserAndPersistence() throws {
        let claudeEvents = AgentChatStreamParser.parse(
            line: #"{"type":"result","session_id":"cl-123","is_error":false,"result":"Done"}"#,
            provider: .claude
        )
        #expect(claudeEvents.contains(.sessionId("cl-123")))
        #expect(claudeEvents.contains(.textReplace("Done")))
        #expect(claudeEvents.contains(.completed))

        let codexStart = AgentChatStreamParser.parse(
            line: #"{"type":"thread.started","thread_id":"cx-999"}"#,
            provider: .codex
        )
        #expect(codexStart == [.sessionId("cx-999")])
        let codexMsg = AgentChatStreamParser.parse(
            line: #"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Shipped"}}"#,
            provider: .codex
        )
        #expect(codexMsg == [.textReplace("Shipped")])

        let geminiDelta = AgentChatStreamParser.parse(
            line: #"{"event":"step_update","conversation_id":"gm-42","step_update":{"step_type":"agent_response","text_delta":"Hi"}}"#,
            provider: .gemini
        )
        #expect(geminiDelta.contains(.sessionId("gm-42")))
        #expect(geminiDelta.contains(.textDelta("Hi")))

        let codexResume = AgentChatRunner.buildCommand(provider: .codex, modelId: "gpt-6-astra", prompt: "Next", sessionId: "cx-999")
        #expect(codexResume.prefix(3) == ["exec", "resume", "--json"])
        #expect(codexResume.contains("cx-999"))

        let geminiResume = AgentChatRunner.buildCommand(provider: .gemini, modelId: "gemini-4-neon-high", prompt: "Next", sessionId: "gm-42")
        #expect(geminiResume.contains("--conversation"))
        #expect(geminiResume.contains("gm-42"))

        let tmpUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-chat-test-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmpUrl) }

        let thread = AgentChatThread(
            title: "Build chat mode",
            projectName: "toolroll",
            projectPath: "/tmp/toolroll",
            provider: .gemini,
            modelId: "gemini-4-neon-high",
            sessionId: "gm-42",
            messages: [AgentChatMessage(role: .user, text: "Hi")]
        )
        AgentChatPersistence.save([thread], to: tmpUrl)
        let loaded = AgentChatPersistence.load(from: tmpUrl)
        #expect(loaded.count == 1)
        #expect(loaded[0].sessionId == "gm-42")
        #expect(loaded[0].provider == .gemini)
    }

    @Test("A cancel names the newest run, not the live one: a queued task with a finished run has no live run")
    func cancelNamesLatestRun() throws {
        let json = """
        {"version":1,"task":{"id":"t1","root":"t1","title":"Fix","state":"queued","project":null},
         "headline":null,"liveRun":null,"latestRun":3,"models":[{"phase":"build","provider":"codex","model":"gpt-6-sol","chosen":"override"}],"cards":[{"key":"build","label":"Build","state":"stuck","mark":"stuck","sentence":"x","runs":[3]}]}
        """
        let steps = try JSONDecoder().decode(StepCardsResponse.self, from: Data(json.utf8))
        #expect(steps.liveRun == nil)
        #expect(steps.latestRun == 3)
        #expect(steps.shownRunForCancel == 3)
        #expect(steps.modelLabel(forPhase: "build") == "codex · gpt-6-sol")
        #expect(steps.modelLabel(forPhase: "plan") == nil)
        let old = try JSONDecoder().decode(StepCardsResponse.self, from: Data(json.replacingOccurrences(of: "\"latestRun\":3,", with: "").utf8))
        #expect(old.latestRun == nil)
        #expect(old.shownRunForCancel == 3)
    }

    @Test("Work rows land in the right sidebar section: a Cancelled row is muted like Queued but has ended")
    func workRowStatusFromToneAndToken() {
        #expect(TaskStatusTone(workTone: "muted", token: "cancelled") == .finished)
        #expect(TaskStatusTone(workTone: "muted", token: "ready") == .queued)
        #expect(TaskStatusTone(workTone: "attention", token: "assignment-needs-decision") == .needs)
        #expect(TaskStatusTone(workTone: "live", token: "assignment-working") == .running)
        #expect(TaskStatusTone(workTone: "neutral", token: "assignment-working") == .queued)
        #expect(TaskStatusTone(workTone: "problem", token: "failed") == .failed)
        #expect(TaskStatusTone(workTone: "done", token: "assignment-complete") == .finished)
    }

    @Test("A task's own model choices, its shown digest and a change waiting for the run to end decode from the steps read")
    func taskModelChoicesDecode() throws {
        let json = """
        {"version":1,"task":{"id":"t1.2","root":"t1","title":"Fix","state":"queued","project":null},"headline":null,
         "liveRun":5,"latestRun":5,"scopeDigest":"abc","cards":[],
         "agentChoices":{"plan":[{"provider":"claude","model":"sonnet"},{"provider":"codex","model":"gpt-6-sol"}],
                         "build":[{"provider":"codex","model":"gpt-6-sol"}]},
         "pendingAgentChange":{"phase":"build","provider":"codex","model":"gpt-6-sol","when":"next-run","by":"alex","at":"2026-11-22T10:00:00Z","problem":null}}
        """
        let steps = try JSONDecoder().decode(StepCardsResponse.self, from: Data(json.utf8))
        #expect(steps.task.root == "t1")
        #expect(steps.scopeDigest == "abc")
        #expect(steps.agentChoices?.forRole("plan").count == 2)
        #expect(steps.agentChoices?.forRole("all").map(\.formValue) == ["codex|gpt-6-sol"])
        #expect(steps.pendingAgentChange?.when == "next-run")
        #expect(steps.pendingAgentChange?.problem == nil)
    }

    @Test("The server's real Work rows fixture decodes with its groups, non-task asks and paging cursor kept")
    func workRowsKeepsGroupsNeedsNext() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/engine-api/work-rows-every-kind.json")
        let data = try Data(contentsOf: url)
        let decoded = try JSONDecoder().decode(WorkRowsResponse.self, from: data)
        let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(decoded.rows.count == (raw["rows"] as! [Any]).count)
        #expect(decoded.needs.count == (raw["needs"] as! [Any]).count)
        #expect((decoded.groups?.count ?? 0) == ((raw["groups"] as? [Any])?.count ?? 0))
        #expect(decoded.rows.allSatisfy { (0...4).contains($0.rank) })
    }

    @Test("The Work layout falls back to the standard one when missing, unreadable or newer, and never drops a built-in")
    func workLayoutFallsBack() throws {
        let defaults = UserDefaults(suiteName: "work-layout-\(UUID().uuidString)")!
        #expect(WorkLayout.load(from: defaults) == .standard)
        defaults.set(Data("not json".utf8), forKey: WorkLayout.defaultsKey)
        #expect(WorkLayout.load(from: defaults) == .standard)
        WorkLayout(schema: "toolroll.work-layout/v9", widgets: []).save(to: defaults)
        #expect(WorkLayout.load(from: defaults) == .standard)
        WorkLayout(widgets: [WorkWidgetInstance(id: "list", kind: .list, isHidden: false),
                             WorkWidgetInstance(id: "list2", kind: .list, isHidden: true)]).save(to: defaults)
        let loaded = WorkLayout.load(from: defaults)
        #expect(loaded.widgets.map(\.kind) == [.list, .header, .limits, .automations])
        let edited = loaded.moving("header", by: -1).togglingHidden("limits")
        edited.save(to: defaults)
        #expect(WorkLayout.load(from: defaults).widgets.map(\.kind) == [.header, .list, .limits, .automations])
        #expect(WorkLayout.load(from: defaults).widgets.first { $0.kind == .limits }?.isHidden == true)
    }

    @Test("Limits read honestly: plain window names, plan casing, and a passed reset means probably clear, not reached")
    func providerLimitWords() {
        let now = ISO8601DateFormatter().date(from: "2026-11-23T05:00:00Z")!
        let claude = ProviderLimit(provider: "claude", plan: nil, window: "seven_day", usedPercent: 100, reached: true,
                                   resetsAt: "2026-11-21T07:00:00.000Z", observedAt: "2026-11-19T07:17:40.670Z")
        let codex = ProviderLimit(provider: "codex", plan: "pro", window: "seven_day", usedPercent: 24, reached: false,
                                  resetsAt: "2026-11-25T17:19:22.000Z", observedAt: "2026-11-23T04:07:34.515Z")
        #expect(claude.windowLabel == "Weekly")
        #expect(codex.planLabel == "Pro")
        #expect(claude.planLabel == nil)
        #expect(claude.isReachedNow(now: now) == false)
        if case .passed = claude.resetState(now: now) {} else { Issue.record("Claude's reset is in the past") }
        if case .upcoming = codex.resetState(now: now) {} else { Issue.record("Codex's reset is ahead") }
        #expect(ProviderLimit(provider: "x", window: "five_hour", usedPercent: 1, reached: false).resetState(now: now) == .unknown)
    }

    @Test("A dev server on a project's port counts as that project's only when it runs from inside its folder")
    func previewServerOwnership() {
        #expect(PreviewServerManager.isInside("/Users/a/Documents/toolroll", root: "/Users/a/Documents/toolroll"))
        #expect(PreviewServerManager.isInside("/Users/a/Documents/toolroll/web", root: "/Users/a/Documents/toolroll"))
        #expect(!PreviewServerManager.isInside("/Users/a/Documents/alekseypelletier.com", root: "/Users/a/Documents/toolroll"))
        #expect(!PreviewServerManager.isInside("/Users/a/Documents/toolroll-old", root: "/Users/a/Documents/toolroll"))
    }

    @Test("Automations decode, and Run now presses a button trigger, else checks a scheduled one, never a paused one")
    func automationsRunNow() throws {
        let json = """
        {"version":1,"canAct":true,"automations":[
          {"id":1,"name":"Morning triage","project":"oddcircle","group":"on","starts":"Every weekday at 09:00","nextAt":"2026-11-24T09:00:00.000Z",
           "waiting":0,"inProgress":0,"trouble":null,
           "triggers":[{"id":7,"kind":"schedule","words":"Every weekday at 09:00","state":"active","nextAt":"2026-11-24T09:00:00.000Z",
                        "lastAt":null,"lastOutcome":null,"failures":0,"canPress":false,"canCheck":true}]},
          {"id":2,"name":"Ship notes","project":null,"group":"paused","starts":"When someone presses Ship","nextAt":null,
           "waiting":0,"inProgress":0,"trouble":null,
           "triggers":[{"id":8,"kind":"button","words":"Ship","state":"paused","nextAt":null,"lastAt":null,"lastOutcome":null,
                        "failures":0,"canPress":true,"canCheck":false}]}]}
        """
        let read = try JSONDecoder().decode(AutomationsResponse.self, from: Data(json.utf8))
        #expect(read.automations.count == 2)
        #expect(read.automations[0].runNowTrigger?.id == 7)
        #expect(read.automations[0].isPaused == false)
        #expect(read.automations[1].isPaused == true)
        #expect(read.automations[1].runNowTrigger == nil)
    }

    @Test("Projects decode: the console's projects and the repositories it found")
    func projectsDecode() throws {
        let json = """
        {"version":1,"canAdd":true,
         "projects":[{"name":"toolroll","path":"/Users/me/Documents/toolroll"}],
         "found":[{"name":"crate","path":"/Users/me/Documents/crate"}]}
        """
        let read = try JSONDecoder().decode(ProjectsResponse.self, from: Data(json.utf8))
        #expect(read.canAdd)
        #expect(read.projects.map(\.name) == ["toolroll"])
        #expect(read.found.first?.id == "/Users/me/Documents/crate")
    }

    @Test("Ask Lead from Canvas carries the screen, source and question; a bare question stays bare")
    func leadAskContext() {
        let withPlace = LeadAskContext.message(question: " how do we change this? ", project: "site", route: "/",
                                               file: "src/routes/index.tsx", line: 61, element: nil)
        #expect(withPlace.hasPrefix("how do we change this?"))
        #expect(withPlace.contains("Screen: site /"))
        #expect(withPlace.contains("Source: src/routes/index.tsx:61"))
        let bare = LeadAskContext.message(question: "why?", project: nil, route: "", file: nil, line: nil, element: nil)
        #expect(bare == "why?")
    }

    @Test("A Lead send's request id is the 32 hex characters the server takes, and the chat read keeps its session")
    func leadSendShape() throws {
        let id = ToolrollClient.leadRequestId()
        #expect(id.count == 32)
        #expect(id.allSatisfy { "0123456789abcdef".contains($0) })
        let read = try JSONDecoder().decode(LeadChatResponse.self, from: Data(#"{"version":1,"room":"chat","session":7,"leadName":"Lead","canSend":true,"busy":false,"messages":[]}"#.utf8))
        #expect(read.session == 7)
    }

    @Test("Interrupted Claude chat turn recovers sessionId, tool steps, and final reply from Claude project transcript")
    func claudeInterruptedTurnRecovery() throws {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("toolroll-claude-recover-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let projPath = "/Users/alex/Documents/site.com"
        let projDir = AgentChatPersistence.claudeProjectDirectory(for: projPath, claudeProjectsRoot: tmpRoot)
        try FileManager.default.createDirectory(at: projDir, withIntermediateDirectories: true)

        let sessionId = "597a2366-ceb7-419e-ab4e-7c645bd4bff5"
        let transcript = """
        {"type":"user","message":{"role":"user","content":"Fix the corner peel"}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/alex/Documents/site.com/src/styles.css"}}]}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Simplified the corner and replaced the orange accent with muted cobalt."}]}}
        """
        try Data(transcript.utf8).write(to: projDir.appendingPathComponent("\(sessionId).jsonl"))

        var thread = AgentChatThread(
            title: "Fix the corner peel",
            projectName: "site.com",
            projectPath: projPath,
            provider: .claude,
            modelId: "opus",
            sessionId: nil,
            messages: [
                AgentChatMessage(role: .user, text: "Fix the corner peel"),
                AgentChatMessage(role: .assistant, text: "", isStreaming: true),
            ]
        )

        let recovered = AgentChatPersistence.recoverInterruptedClaudeTurn(&thread, claudeProjectsRoot: tmpRoot)
        #expect(recovered == true)
        #expect(thread.sessionId == sessionId)
        #expect(thread.messages[1].isStreaming == false)
        #expect(thread.messages[1].tools.count == 1)
        #expect(thread.messages[1].tools[0].name == "Read")
        #expect(thread.messages[1].text.contains("muted cobalt"))
    }
}
