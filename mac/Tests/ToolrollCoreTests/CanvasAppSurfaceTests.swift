import Foundation
import Testing
@testable import ToolrollCore

private let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path

private func tempDir(_ prefix: String) throws -> String {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString)").resolvingSymlinksInPath().path
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    return root
}

private func write(_ text: String, _ path: String) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try text.write(toFile: path, atomically: false, encoding: .utf8)
}

private func git(_ args: [String], in root: String) throws {
    let out = try #require(HardenedGit.run(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"] + args, in: root, timeout: 10))
    #expect(out.status == 0, "git \(args) failed: \(out.stderr)")
}

private func twoSurfaceRepo() throws -> String {
    let root = try tempDir("tr-canvas")
    try git(["init", "-q"], in: root)
    try write("export const page = 1\n", "\(root)/src/page.tsx")
    try write("struct V {}\n", "\(root)/ios/App/V.swift")
    try FileManager.default.createDirectory(atPath: "\(root)/ios/App.xcodeproj", withIntermediateDirectories: true)
    try write("{}\n", "\(root)/ios/App.xcodeproj/project.pbxproj")
    let manifest = try String(contentsOfFile: "\(repoRoot)/.youi/screens/app.json", encoding: .utf8)
        .replacingOccurrences(of: "ios/ToolrollCompanion.xcodeproj", with: "ios/App.xcodeproj")
    try write(manifest, "\(root)/.youi/screens/app.json")
    try git(["add", "-A"], in: root)
    try git(["commit", "-q", "-m", "one"], in: root)
    return root
}

@Suite("Canvas app surface")
struct CanvasAppSurfaceTests {

    @Test("The repo's app.json declares the iPhone companion's screens, light and dark, each with its SwiftUI view")
    func repoManifest() throws {
        let manifest = try #require(AppSurfaceStorage.loadManifest(projectRoot: repoRoot))
        #expect(manifest.schema == "toolroll.app-screens/v1")
        let ios = try #require(manifest.surfaces.first)
        #expect(ios.id == "ios" && ios.kind == "ios" && ios.paths == ["ios"] && ios.appearances == ["light", "dark"])
        #expect(ios.capture == "scripts/canvas-capture-ios.sh")
        #expect(ios.screens.count >= 9)
        for screen in ios.screens {
            #expect(FileManager.default.fileExists(atPath: "\(repoRoot)/\(screen.view)"), "\(screen.id): \(screen.view) is missing")
        }
        let ids = ios.screens.map(\.id)
        #expect(ids.contains("inbox") && ids.contains("task-decide") && ids.contains("settings") && ids.contains("welcome"))
        #expect(ios.screens.first(where: { $0.id == "welcome" })?.launch == [])
        #expect(ios.screens.first(where: { $0.id == "diff" })?.launch == ["--demo", "--screen", "diff:t-frame-limits:0"])
    }

    @Test("A surface or screen that breaks a rule is left out, never half-shown")
    func manifestRules() throws {
        func manifest(screen: String, surfacePaths: String = #"["ios"]"#, schema: String = "toolroll.app-screens/v1") -> Data {
            Data("""
            {"schema": "\(schema)", "project": "p", "surfaces": [{"id": "ios", "kind": "ios", "label": "iPhone",
              "build": {"project": "ios/A.xcodeproj", "scheme": "A", "bundleId": "a.b"}, "device": "iPhone 17 Pro",
              "paths": \(surfacePaths), "appearances": ["light", "dark"], "capture": "scripts/c.sh",
              "screens": [{"id": "ok", "title": "OK", "launch": [], "view": "ios/A/V.swift"}, \(screen)]}]}
            """.utf8)
        }
        let good = try #require(AppSurfaceStorage.parseManifest(manifest(screen: #"{"id": "two", "title": "Two", "launch": ["--demo"], "view": "ios/A/W.swift"}"#)))
        #expect(good.surfaces.first?.screens.map(\.id) == ["ok", "two"])
        for bad in [#"{"id": "Bad Id", "title": "x", "launch": [], "view": "ios/A/W.swift"}"#,
                    #"{"id": "up", "title": "x", "launch": [], "view": "../etc/passwd"}"#,
                    #"{"id": "abs", "title": "x", "launch": [], "view": "/etc/passwd"}"#,
                    #"{"id": "sepia", "title": "x", "launch": [], "view": "ios/A/W.swift", "appearances": ["sepia"]}"#,
                    #"{"id": "ok", "title": "dup", "launch": [], "view": "ios/A/W.swift"}"#] {
            let parsed = try #require(AppSurfaceStorage.parseManifest(manifest(screen: bad)))
            #expect(parsed.surfaces.first?.screens.map(\.id) == ["ok"], "\(bad)")
        }
        #expect(AppSurfaceStorage.parseManifest(manifest(screen: #"{"id": "x", "title": "x", "launch": [], "view": "a"}"#, surfacePaths: #"["../up"]"#))?.surfaces.isEmpty == true)
        #expect(AppSurfaceStorage.parseManifest(manifest(screen: "{}", schema: "youiyoux.screens/v1")) == nil)
    }

    @Test("Each surface's key covers only its own files: an ios edit leaves the web key alone, and the reverse")
    func perSurfaceKeys() throws {
        let root = try twoSurfaceRepo()
        defer { try? FileManager.default.removeItem(atPath: root) }
        let iosSpecs = AppSurfaceStorage.pathspecs(including: ["ios"])
        let iosKey = { AppSurfaceStorage.surfaceStateKey(projectRoot: root, pathspecs: iosSpecs) }
        let webKey = { YouiCanvasStorage.gitStateKey(projectRoot: root, excluding: ["ios"]) }
        let ios0 = iosKey(), web0 = webKey()
        #expect(ios0.hasPrefix("s-") && web0.hasPrefix("s-") && ios0 != web0)

        try write("struct V { let x = 1 }\n", "\(root)/ios/App/V.swift")
        let ios1 = iosKey()
        #expect(ios1 != ios0)
        #expect(webKey() == web0)

        try write("export const page = 2\n", "\(root)/src/page.tsx")
        #expect(webKey() != web0)
        #expect(iosKey() == ios1)

        try write("struct W {}\n", "\(root)/ios/App/W.swift")
        #expect(iosKey() != ios1)

        let ios2 = iosKey()
        try git(["add", "src/page.tsx"], in: root)
        try git(["commit", "-q", "-m", "web only"], in: root)
        #expect(iosKey() == ios2)
    }

    @Test("The capture script computes the very same key as the Mac, clean or dirty")
    func scriptKeyParity() throws {
        let root = try twoSurfaceRepo()
        defer { try? FileManager.default.removeItem(atPath: root) }
        func scriptKey() throws -> String {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/bin/bash")
            proc.arguments = ["\(repoRoot)/scripts/canvas-capture-ios.sh", "--repo", root, "--print-state-key"]
            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = FileHandle.nullDevice
            try proc.run()
            proc.waitUntilExit()
            #expect(proc.terminationStatus == 0)
            return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let swiftKey = { AppSurfaceStorage.surfaceStateKey(projectRoot: root, pathspecs: AppSurfaceStorage.pathspecs(including: ["ios"])) }
        #expect(try scriptKey() == swiftKey())
        try write("struct V { let edited = true }\n", "\(root)/ios/App/V.swift")
        try write("new file\n", "\(root)/ios/App/New.swift")
        try write("x\n", "\(root)/ios/App/zz é.swift")
        try FileManager.default.removeItem(atPath: "\(root)/ios/App.xcodeproj/project.pbxproj")
        try write("{}\n", "\(root)/ios/App.xcodeproj/other.pbxproj")
        #expect(try scriptKey() == swiftKey())
    }

    private func writeIndex(_ folder: URL, key: String, at: String, screens: [String]) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let entries = screens.map { #"{"screen": "\#($0)", "appearance": "dark", "file": "\#($0)-dark.png", "commit": "abc", "captured_at": "\#(at)"}"# }
        try write("""
        {"schema": "toolroll.app-captures/v1", "surface": "ios", "device": "iPhone 17 Pro", "os": "iOS 26.5",
         "state_key": "\(key)", "commit": "abc1234567", "captured_at": "\(at)", "captures": [\(entries.joined(separator: ","))]}
        """, folder.appendingPathComponent("index.json").path)
        for screen in screens { try Data([0x89, 0x50]).write(to: folder.appendingPathComponent("\(screen)-dark.png")) }
    }

    @Test("Captures at the current key are fresh; otherwise the latest set shows, marked stale")
    func freshAndStale() throws {
        let home = URL(fileURLWithPath: try tempDir("tr-home"))
        let root = try tempDir("tr-proj")
        defer { try? FileManager.default.removeItem(at: home); try? FileManager.default.removeItem(atPath: root) }
        #expect(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-1", home: home) == nil)

        let cache = AppSurfaceStorage.surfaceCacheDir(projectRoot: root, surface: "ios", home: home)
        try writeIndex(cache.appendingPathComponent("s-old"), key: "s-old", at: "2026-11-01T10:00:00Z", screens: ["inbox"])
        let stale = try #require(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-new", home: home))
        #expect(stale.isStale && stale.index.stateKey == "s-old")
        #expect(stale.imagePath(screen: "inbox", appearance: "dark") != nil)
        #expect(stale.imagePath(screen: "inbox", appearance: "light") == nil)

        try writeIndex(AppSurfaceStorage.mirrorDir(projectRoot: root, surface: "ios"), key: "s-mid", at: "2026-11-02T10:00:00Z", screens: ["settings"])
        #expect(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-new", home: home)?.index.stateKey == "s-mid")

        try writeIndex(cache.appendingPathComponent("s-new"), key: "s-new", at: "2026-11-03T10:00:00Z", screens: ["inbox", "settings"])
        let fresh = try #require(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-new", home: home))
        #expect(!fresh.isStale && fresh.index.captures.count == 2)
    }

    @Test("App tiles: one per screen and appearance, light beside dark, each routed app:ios/<id> with its view file")
    func appLayout() throws {
        let surface = try #require(AppSurfaceStorage.loadManifest(projectRoot: repoRoot)?.surfaces.first)
        let boards = AppSurfaceStorage.layoutAppArtboards(surface: surface, captures: nil, originY: 1000)
        #expect(boards.count == surface.screens.count * 2)
        #expect(Set(boards.map(\.id)).count == boards.count)
        let inboxDark = try #require(boards.first(where: { $0.id == "app:ios/inbox#dark" }))
        let inboxLight = try #require(boards.first(where: { $0.id == "app:ios/inbox#light" }))
        #expect(inboxDark.route == "app:ios/inbox" && inboxDark.surface == "ios" && inboxDark.appearance == "dark" && inboxDark.isAppScreen)
        #expect(inboxDark.sourceFile == "ios/ToolrollCompanion/WorkInboxView.swift")
        #expect(inboxLight.y == inboxDark.y && inboxLight.x < inboxDark.x)
        #expect(boards.allSatisfy { $0.y >= 1000 && $0.width == CanvasViewportPreset.mobile.width })
    }

    @Test("The project folder: the console's recorded path first, then ~/Developer and the usual places")
    func projectRoot() {
        let dirs: Set<String> = ["/srv/toolroll", "/Users/me/Developer/so-canvas", "/Users/me/Documents/Old", "/Users/me/Developer/Shop"]
        let isDir = { (path: String) in dirs.contains(path) }
        let list = { (parent: String) -> [String] in parent == "/Users/me/Developer" ? ["so-canvas", "Shop"] : [] }
        func resolve(_ name: String, _ recorded: [ProjectRef]) -> String? {
            CanvasProjectRoot.resolve(projectName: name, recorded: recorded, home: "/Users/me", isDirectory: isDir, listDirectory: list)
        }
        #expect(resolve("toolroll", [ProjectRef(name: "toolroll", path: "/srv/toolroll")]) == "/srv/toolroll")
        #expect(resolve("so-canvas", []) == "/Users/me/Developer/so-canvas")
        #expect(resolve("shop", []) == "/Users/me/Developer/Shop")
        #expect(resolve("so-canvas", [ProjectRef(name: "so-canvas", path: "/elsewhere/so-canvas")]) == "/Users/me/Developer/so-canvas")
        #expect(resolve("missing", []) == nil)
        #expect(resolve("../etc", []) == nil)
    }

    private func pin(kind: CanvasPinKind = .change, draft: Bool = true, app: Bool = false, author: String = "you") -> CanvasPin {
        CanvasPin(id: "r-0123456789", artboardRoute: app ? "Work · needs you" : "/flows", artboardPath: app ? "app:ios/inbox" : "/flows",
                  xFrac: 0.4, yFrac: 0.3, kind: kind, body: "Make the primary button calmer.", author: author,
                  elementName: app ? nil : "Button", elementFile: app ? "ios/ToolrollCompanion/WorkInboxView.swift" : "src/button.tsx",
                  elementLine: app ? nil : 12, isDraft: draft, createdAt: "2026-11-01T12:00:00Z",
                  surface: app ? "ios" : nil, appearance: app ? "dark" : nil, device: app ? "iPhone 17 Pro" : nil,
                  captureStateKey: app ? "s-abc" : nil)
    }

    @Test("Nobody signed in by name: the pin says \"you\", never a made-up person")
    func authorName() {
        #expect(CanvasPin.authorName(account: "") == "you")
        #expect(CanvasPin.authorName(account: nil) == "you")
        #expect(CanvasPin.authorName(account: "  ") == "you")
        #expect(CanvasPin.authorName(account: "rosa") == "rosa")
    }

    @Test("The author's kind is written and read back, agent pins included")
    func authorKindRoundTrip() throws {
        let root = try tempDir("tr-pins")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let agent = CanvasPin(id: "r-aaaaaaaaaa", artboardRoute: "/", artboardPath: "/", xFrac: 0.5, yFrac: 0.5, kind: .comment,
                              body: "Suggestion", author: "mcp:planner", authorKind: "agent", createdAt: "2026-11-01T12:00:00Z")
        YouiCanvasStorage.writeYouiRequest(projectRoot: root, projectName: "p", pin: agent)
        YouiCanvasStorage.writeYouiRequest(projectRoot: root, projectName: "p", pin: pin(author: "rosa"))
        let read = YouiCanvasStorage.loadPins(projectRoot: root)
        #expect(read.first(where: { $0.id == "r-aaaaaaaaaa" })?.authorKind == "agent")
        #expect(read.first(where: { $0.id == "r-aaaaaaaaaa" })?.author == "mcp:planner")
        #expect(read.first(where: { $0.id == "r-0123456789" })?.authorKind == "person")
        #expect(read.first(where: { $0.id == "r-0123456789" })?.author == "rosa")
    }

    @Test("A draft options pin is marked a draft and asks nothing yet; a filed one carries youiyoux's task and offer")
    func optionsOffer() throws {
        let draft = YouiCanvasStorage.youiRequestPayload(projectName: "shop", pin: pin(kind: .options, draft: true))
        #expect(draft["task"] == nil)
        #expect((draft["canvas"] as? [String: Any])?["isDraft"] as? Bool == true)

        let filed = YouiCanvasStorage.youiRequestPayload(projectName: "shop", pin: pin(kind: .options, draft: false))
        let task = try #require(filed["task"] as? [String: Any])
        let offer = try #require(task["offer"] as? [String: Any])
        #expect(offer["proposal"] as? String == "p-0123456789")
        #expect(offer["file"] as? String == ".youi/proposals/p-0123456789.json")
        #expect(task["touches"] as? [String] == [".youi/proposals/p-0123456789.json"])
        #expect(task["touchesKnown"] as? Bool == true)
        #expect((task["acceptance"] as? [[String: Any]])?.isEmpty == false)
        #expect(((task["title"] as? String) ?? "").count <= 120)

        #expect(YouiCanvasStorage.youiRequestPayload(projectName: "shop", pin: pin(kind: .change, draft: false))["task"] == nil)
    }

    @Test("The filed options request matches the fixture Toolroll's intake test files (test/fixtures/canvas)")
    func optionsFixture() throws {
        let payload = YouiCanvasStorage.youiRequestPayload(projectName: "shop", pin: pin(kind: .options, draft: false, author: "Rosa"))
        let made = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        let fixturePath = "\(repoRoot)/test/fixtures/canvas/mac-options-request.json"
        let fixture = try Data(contentsOf: URL(fileURLWithPath: fixturePath))
        let a = try JSONSerialization.jsonObject(with: made) as? NSDictionary
        let b = try JSONSerialization.jsonObject(with: fixture) as? NSDictionary
        #expect(a == b, "regenerate \(fixturePath) from youiRequestPayload if the request's shape changed on purpose")
    }

    @Test("An app pin points at app:ios/<screen>, its SwiftUI file, and says which appearance and device")
    func appPinRequest() throws {
        let root = try tempDir("tr-app-pin")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let payload = YouiCanvasStorage.youiRequestPayload(projectName: "toolroll", pin: pin(app: true))
        let target = try #require(payload["target"] as? [String: Any])
        #expect(target["route"] as? String == "app:ios/inbox")
        #expect(target["scope"] as? String == "here")
        #expect(target["name"] as? String == "Work · needs you")
        #expect(target["file"] as? String == "ios/ToolrollCompanion/WorkInboxView.swift")
        let canvas = try #require(payload["canvas"] as? [String: Any])
        #expect(canvas["surface"] as? String == "ios" && canvas["state"] as? String == "dark" && canvas["device"] as? String == "iPhone 17 Pro")

        YouiCanvasStorage.writeYouiRequest(projectRoot: root, projectName: "toolroll", pin: pin(app: true))
        let back = try #require(YouiCanvasStorage.loadPins(projectRoot: root).first)
        #expect(back.isAppPin && back.surface == "ios" && back.appearance == "dark" && back.artboardPath == "app:ios/inbox")
        #expect(back.elementName == nil && back.artboardRoute == "Work · needs you")
    }

    @Test("The task a pin on an app screen becomes says \"iPhone · dark\" and names the screen and its file")
    func appTaskText() throws {
        let surface = try #require(AppSurfaceStorage.loadManifest(projectRoot: repoRoot)?.surfaces.first)
        let one = pin(app: true)
        let title = CanvasPinTaskText.title(label: CanvasPinTaskText.screenLabel(one), batch: [one], surfaces: [surface])
        #expect(title == "[UI] iPhone · Work · needs you: Make the primary button calmer.")
        let body = CanvasPinTaskText.body(batch: [one], surfaces: [surface])
        #expect(body.contains("iPhone · dark"))
        #expect(body.contains("`app:ios/inbox`"))
        #expect(body.contains("ios/ToolrollCompanion/WorkInboxView.swift"))
        let web = CanvasPinTaskText.body(batch: [pin()], surfaces: [surface])
        #expect(web.hasPrefix("1. Make the primary button calmer. (route `/flows` at (40%, 30%) · element `Button` · `src/button.tsx:12`"))
    }

    @Test("The filed task's id comes from the page the filing landed on, never from the list")
    func filedTaskId() {
        let base = URL(string: "http://127.0.0.1:4180/tasks/add")
        #expect(ToolrollClient.filedTaskId(landedAt: URL(string: "http://127.0.0.1:4180/t/ui-flows-calmer"), location: nil) == "ui-flows-calmer")
        #expect(ToolrollClient.filedTaskId(landedAt: base, location: "/t/make-it-calm") == "make-it-calm")
        #expect(ToolrollClient.filedTaskId(landedAt: URL(string: "http://h/console/t/abc.def-1"), location: nil) == "abc.def-1")
        #expect(ToolrollClient.filedTaskId(landedAt: base, location: nil) == nil)
        #expect(ToolrollClient.filedTaskId(landedAt: URL(string: "http://h/t/abc/steps"), location: nil) == nil)
        #expect(ToolrollClient.filedTaskId(landedAt: URL(string: "http://h/tasks?said=Filed"), location: nil) == nil)
    }

    @Test("The capture script's lines: progress moves the header, error is the reason, the rest is log")
    func captureLines() {
        #expect(AppCaptureLine.parse("progress: Capturing 3/24: inbox (dark)\n") == .progress("Capturing 3/24: inbox (dark)"))
        #expect(AppCaptureLine.parse("error: the Xcode build failed") == .error("the Xcode build failed"))
        #expect(AppCaptureLine.parse("Build settings from command line:") == .log("Build settings from command line:"))
    }

    @Test("Only a plain file inside the project runs as the capture script")
    func scriptPath() throws {
        let root = try tempDir("tr-script")
        defer { try? FileManager.default.removeItem(atPath: root) }
        try write("#!/bin/bash\n", "\(root)/scripts/c.sh")
        try write("#!/bin/bash\n", "\(root)/../outside-\(UUID().uuidString).sh")
        try FileManager.default.createSymbolicLink(atPath: "\(root)/scripts/link.sh", withDestinationPath: "/bin/sh")
        #expect(AppCaptureRunner.scriptPath(projectRoot: root, relative: "scripts/c.sh") == "\(root)/scripts/c.sh")
        #expect(AppCaptureRunner.scriptPath(projectRoot: root, relative: "scripts/link.sh") == nil)
        #expect(AppCaptureRunner.scriptPath(projectRoot: root, relative: "../x.sh") == nil)
        #expect(AppCaptureRunner.scriptPath(projectRoot: root, relative: "/bin/sh") == nil)
        #expect(AppCaptureRunner.scriptPath(projectRoot: root, relative: "scripts") == nil)
    }
}
