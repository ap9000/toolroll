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

    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])

    private func writeIndex(_ folder: URL, key: String, at: String, screens: [String]) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let entries = screens.map { #"{"screen": "\#($0)", "appearance": "dark", "file": "\#($0)-dark.png", "commit": "abc", "captured_at": "\#(at)"}"# }
        try write("""
        {"schema": "toolroll.app-captures/v1", "surface": "ios", "device": "iPhone 17 Pro", "os": "iOS 26.5",
         "state_key": "\(key)", "commit": "abc1234567", "captured_at": "\(at)", "captures": [\(entries.joined(separator: ","))]}
        """, folder.appendingPathComponent("index.json").path)
        for screen in screens { try png.write(to: folder.appendingPathComponent("\(screen)-dark.png")) }
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
        #expect(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-new", home: home)?.index.stateKey == "s-old")

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

    private func pin(id: String = "r-0123456789", kind: CanvasPinKind = .change, draft: Bool = true, app: Bool = false, author: String = "you") -> CanvasPin {
        CanvasPin(id: id, artboardRoute: app ? "Work · needs you" : "/flows", artboardPath: app ? "app:ios/inbox" : "/flows",
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

    @Test("The Mac runs the capture script built into it, identical to scripts/canvas-capture-ios.sh, never a project's")
    func embeddedScript() throws {
        let onDisk = try String(contentsOfFile: "\(repoRoot)/scripts/canvas-capture-ios.sh", encoding: .utf8)
        #expect(CanvasCaptureScript.source + "\n" == onDisk, "run mac/scripts/embed-canvas-capture.sh")
        let argv = AppCaptureRunner.bashArguments(arguments: ["--repo", "/p"])
        #expect(argv == ["-c", CanvasCaptureScript.source, "canvas-capture-ios.sh", "--repo", "/p"])
        let planted = Data("""
        {"schema": "toolroll.app-screens/v1", "project": "p", "surfaces": [{"id": "ios", "kind": "ios", "label": "iPhone",
          "build": {"project": "ios/A.xcodeproj", "scheme": "A", "bundleId": "a.b"}, "device": "iPhone 17 Pro",
          "paths": ["ios"], "appearances": ["light"], "capture": "/tmp/evil.sh",
          "screens": [{"id": "ok", "title": "OK", "launch": [], "view": "ios/A/V.swift"}]}]}
        """.utf8)
        let parsed = try #require(AppSurfaceStorage.parseManifest(planted))
        #expect(parsed.surfaces.count == 1)
        let encoded = String(decoding: try JSONEncoder().encode(parsed), as: UTF8.self)
        #expect(!encoded.contains("evil"))
    }

    @Test("The first Recapture of a project asks; the answer is remembered for that folder only, never in the repo")
    func captureTrust() throws {
        let suite = "tr-canvas-trust-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = try tempDir("tr-trust")
        let other = try tempDir("tr-trust-other")
        defer { try? FileManager.default.removeItem(atPath: root); try? FileManager.default.removeItem(atPath: other) }
        #expect(!CanvasCaptureTrust.isTrusted(projectRoot: root, defaults: defaults))
        CanvasCaptureTrust.trust(projectRoot: root, defaults: defaults)
        #expect(CanvasCaptureTrust.isTrusted(projectRoot: root, defaults: defaults))
        #expect(CanvasCaptureTrust.isTrusted(projectRoot: root + "/", defaults: defaults))
        #expect(!CanvasCaptureTrust.isTrusted(projectRoot: other, defaults: defaults))
        let link = other + "-link"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: root)
        defer { try? FileManager.default.removeItem(atPath: link) }
        #expect(CanvasCaptureTrust.isTrusted(projectRoot: link, defaults: defaults))
        #expect(!FileManager.default.fileExists(atPath: "\(root)/.youi"))
        #expect(CanvasCaptureTrust.question(projectName: "shop") == "Recapture builds and runs shop in the Simulator. Only do this for projects you trust.")
    }

    @Test("Capture images are read only from the cache folder: no links, no outside paths, PNGs under 20 MB with one link")
    func captureImageGuards() throws {
        let base = try tempDir("tr-shots")
        defer { try? FileManager.default.removeItem(atPath: base) }
        let folder = "\(base)/cache/s-1"
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try png.write(to: URL(fileURLWithPath: "\(folder)/ok.png"))
        #expect(AppSurfaceStorage.captureImage(path: "\(folder)/ok.png", within: folder) == png)

        try "ssh private key".write(toFile: "\(base)/secret", atomically: true, encoding: .utf8)
        try png.write(to: URL(fileURLWithPath: "\(base)/outside.png"))
        try FileManager.default.createSymbolicLink(atPath: "\(folder)/link.png", withDestinationPath: "\(base)/secret")
        try FileManager.default.createSymbolicLink(atPath: "\(folder)/linkpng.png", withDestinationPath: "\(base)/outside.png")
        try FileManager.default.linkItem(atPath: "\(base)/outside.png", toPath: "\(folder)/hard.png")
        try "not a png".write(toFile: "\(folder)/text.png", atomically: true, encoding: .utf8)
        let big = FileHandle(forWritingAtPath: { FileManager.default.createFile(atPath: "\(folder)/big.png", contents: png); return "\(folder)/big.png" }())!
        try big.truncate(atOffset: UInt64(AppSurfaceStorage.captureImageByteCap + 1))
        try big.close()
        for bad in ["\(folder)/link.png", "\(folder)/linkpng.png", "\(folder)/hard.png", "\(folder)/text.png", "\(folder)/big.png",
                    "\(base)/outside.png", "\(folder)/../outside.png", "\(base)/secret", "\(folder)/missing.png"] {
            #expect(AppSurfaceStorage.captureImage(path: bad, within: folder) == nil, "\(bad)")
            #expect(AppSurfaceStorage.captureImage(path: bad, within: folder, readAll: false) == nil, "\(bad)")
        }

        let set = AppCaptureSet(index: AppCaptureIndex(schema: AppCaptureIndex.schemaName, surface: "ios", device: nil, os: nil, stateKey: "s-1",
                                                        commit: "c", capturedAt: "2026-11-01T00:00:00Z", captures: [
            AppCaptureEntry(screen: "a", appearance: "dark", file: "ok.png", commit: "c", capturedAt: "x"),
            AppCaptureEntry(screen: "b", appearance: "dark", file: "link.png", commit: "c", capturedAt: "x"),
            AppCaptureEntry(screen: "c", appearance: "dark", file: "../outside.png", commit: "c", capturedAt: "x"),
        ]), folder: folder, isStale: false)
        #expect(set.imagePath(screen: "a", appearance: "dark") != nil)
        #expect(set.imagePath(screen: "b", appearance: "dark") == nil)
        #expect(set.imagePath(screen: "c", appearance: "dark") == nil)
    }

    @Test("A planted capture set in the repo mirror, or a linked cache folder, is never read")
    func mirrorAndLinkedFoldersIgnored() throws {
        let home = URL(fileURLWithPath: try tempDir("tr-home"))
        let root = try tempDir("tr-proj")
        let elsewhere = try tempDir("tr-elsewhere")
        defer { for p in [home.path, root, elsewhere] { try? FileManager.default.removeItem(atPath: p) } }
        try writeIndex(AppSurfaceStorage.mirrorDir(projectRoot: root, surface: "ios"), key: "s-1", at: "2026-11-02T10:00:00Z", screens: ["inbox"])
        #expect(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-1", home: home) == nil)

        try writeIndex(URL(fileURLWithPath: elsewhere), key: "s-1", at: "2026-11-02T10:00:00Z", screens: ["inbox"])
        let cache = AppSurfaceStorage.surfaceCacheDir(projectRoot: root, surface: "ios", home: home)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: cache.appendingPathComponent("s-1").path, withDestinationPath: elsewhere)
        #expect(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-1", home: home) == nil)
        #expect(AppSurfaceStorage.latestCaptures(projectRoot: root, surface: "ios", stateKey: "s-other", home: home) == nil)
    }

    @Test("A pin's id is a plain file name: a path in it is never written, and a loaded pin must match its file")
    func pinIdsArePlainNames() throws {
        #expect(CanvasPin.isPlainRequestId("r-0123456789"))
        for bad in ["", "../escape", "a/b", ".hidden", "r-..", String(repeating: "a", count: 65), "r 1"] {
            #expect(!CanvasPin.isPlainRequestId(bad))
        }
        let root = try tempDir("pin-id")
        let evil = pin(id: "../../escaped", draft: false)
        #expect(YouiCanvasStorage.writeYouiRequest(projectRoot: root, projectName: "p", pin: evil) == nil)
        #expect(YouiCanvasStorage.savePinScreenshot(Data([0x89, 0x50]), projectRoot: root, pinId: "../shot") == nil)
        #expect(!FileManager.default.fileExists(atPath: (root as NSString).appendingPathComponent("escaped.json")))

        let dir = (root as NSString).appendingPathComponent(".youi/requests")
        try write(#"{"id":"../../planted","body":"x"}"#, (dir as NSString).appendingPathComponent("r-aaaaaaaaaa.json"))
        try write(#"{"id":"r-bbbbbbbbbb","body":"x"}"#, (dir as NSString).appendingPathComponent("r-cccccccccc.json"))
        try write(#"{"id":"r-dddddddddd","body":"ok"}"#, (dir as NSString).appendingPathComponent("r-dddddddddd.json"))
        #expect(YouiCanvasStorage.loadPins(projectRoot: root).map(\.id) == ["r-dddddddddd"])
    }

    @Test("A linked .youi or .youi/requests folder is never written through; a plain project still works")
    func linkedRequestsFolderRefused() throws {
        let root = try tempDir("pin-link"), elsewhere = try tempDir("pin-elsewhere")
        try FileManager.default.createDirectory(atPath: (root as NSString).appendingPathComponent(".youi"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: (root as NSString).appendingPathComponent(".youi/requests"), withDestinationPath: elsewhere)
        #expect(YouiCanvasStorage.writeYouiRequest(projectRoot: root, projectName: "p", pin: pin(draft: false)) == nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: elsewhere).isEmpty)

        let root2 = try tempDir("pin-link2"), elsewhere2 = try tempDir("pin-elsewhere2")
        try FileManager.default.createDirectory(atPath: (elsewhere2 as NSString).appendingPathComponent("requests"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: (root2 as NSString).appendingPathComponent(".youi"), withDestinationPath: elsewhere2)
        #expect(YouiCanvasStorage.writeYouiRequest(projectRoot: root2, projectName: "p", pin: pin(draft: false)) == nil)
        #expect(YouiCanvasStorage.savePinScreenshot(Data([0x89, 0x50]), projectRoot: root2, pinId: "r-0123456789") == nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: (elsewhere2 as NSString).appendingPathComponent("requests")).isEmpty)

        let root3 = try tempDir("pin-ok")
        #expect(YouiCanvasStorage.writeYouiRequest(projectRoot: root3, projectName: "p", pin: pin(draft: false)) != nil)
    }
}
