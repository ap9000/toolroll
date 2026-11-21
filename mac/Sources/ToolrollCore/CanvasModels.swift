import CryptoKit
import Foundation

// MARK: - youiyoux Native Canvas Contracts (.youi/screens, .youi/requests, ~/.cache/toolroll/canvas)

public enum CanvasTool: String, CaseIterable, Identifiable, Sendable {
    case select = "Select"
    case pin = "Pin"
    case options = "Options"
    case compare = "Compare"
    public var id: String { rawValue }
}

public enum PinBatchGrouping: String, CaseIterable, Identifiable, Sendable {
    case perScreen = "Per screen"
    case singleTask = "Single task"
    case perPin = "Per pin"
    public var id: String { rawValue }
}

public enum CanvasViewportPreset: String, CaseIterable, Identifiable, Sendable {
    case desktop = "Desktop"
    case mobile = "Mobile"
    public var id: String { rawValue }

    /// Logical CSS viewport size rendered inside the WebView before GPU scaling into the artboard card.
    public var logicalWidth: Double {
        switch self {
        case .desktop: return 1440
        case .mobile: return 390
        }
    }

    public var logicalHeight: Double {
        switch self {
        case .desktop: return 900
        case .mobile: return 844
        }
    }

    /// Artboard box dimensions on the spatial canvas (preserving exact aspect ratio).
    public var width: Double {
        switch self {
        case .desktop: return 540
        case .mobile: return 230
        }
    }

    public var height: Double {
        switch self {
        case .desktop: return 337.5
        case .mobile: return 498
        }
    }
}

public enum CanvasPinKind: String, Codable, Sendable, Equatable {
    case comment
    case change
    case options
}

public struct YouiViewport: Codable, Sendable, Equatable {
    public let width: Int
    public let height: Int
    public init(width: Int = 1440, height: Int = 900) {
        self.width = width
        self.height = height
    }
}

public struct YouiScreenEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(route)::\(path)" }
    public let route: String
    public let path: String
    public let sourceFile: String?

    public init(route: String, path: String, sourceFile: String? = nil) {
        self.route = route
        self.path = path
        self.sourceFile = sourceFile
    }
}

public struct YouiScreensManifest: Codable, Sendable, Equatable {
    public let schema: String
    public let project: String
    public let source: String?
    public let capturedAt: String?
    public let viewport: YouiViewport?
    public let screens: [YouiScreenEntry]

    public init(
        schema: String = "youiyoux.screens/v1",
        project: String,
        source: String? = "Toolroll Canvas",
        capturedAt: String? = nil,
        viewport: YouiViewport? = YouiViewport(),
        screens: [YouiScreenEntry] = []
    ) {
        self.schema = schema
        self.project = project
        self.source = source
        self.capturedAt = capturedAt
        self.viewport = viewport
        self.screens = screens
    }
}

public struct CanvasArtboard: Sendable, Equatable, Identifiable {
    public let id: String
    public var route: String
    public var path: String
    public var sourceFile: String?
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var baselineImagePath: String?
    public var latestImagePath: String?
    public var cachedStateKey: String?
    public var isLiveInteractive: Bool
    public var isHydrating: Bool
    public var compareSplit: Double

    public init(
        id: String = UUID().uuidString,
        route: String,
        path: String,
        sourceFile: String? = nil,
        x: Double,
        y: Double,
        width: Double = 540,
        height: Double = 337.5,
        baselineImagePath: String? = nil,
        latestImagePath: String? = nil,
        cachedStateKey: String? = nil,
        isLiveInteractive: Bool = false,
        isHydrating: Bool = false,
        compareSplit: Double = 0.5
    ) {
        self.id = id
        self.route = route
        self.path = path
        self.sourceFile = sourceFile
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.baselineImagePath = baselineImagePath
        self.latestImagePath = latestImagePath
        self.cachedStateKey = cachedStateKey
        self.isLiveInteractive = isLiveInteractive
        self.isHydrating = isHydrating
        self.compareSplit = compareSplit
    }

    public var slug: String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = route.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let collapsed = String(cleaned).replacingOccurrences(of: #"-+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return collapsed.isEmpty ? "home" : collapsed.lowercased()
    }
}

public struct CanvasPin: Codable, Sendable, Equatable, Identifiable {
    public let id: String          // r-<10hex> matching youi.request/v1
    public let artboardRoute: String
    public let artboardPath: String
    public let xFrac: Double
    public let yFrac: Double
    public let kind: CanvasPinKind
    public let body: String
    public let author: String
    public let elementName: String?
    public let elementSelector: String?
    public let elementFile: String?
    public let elementLine: Int?
    public var isDraft: Bool
    public var linkedTaskId: String?
    public let createdAt: String

    public init(
        id: String = CanvasPin.newRequestId(),
        artboardRoute: String,
        artboardPath: String,
        xFrac: Double,
        yFrac: Double,
        kind: CanvasPinKind,
        body: String,
        author: String = "alex",
        elementName: String? = nil,
        elementSelector: String? = nil,
        elementFile: String? = nil,
        elementLine: Int? = nil,
        isDraft: Bool = true,
        linkedTaskId: String? = nil,
        createdAt: String = ISO8601DateFormatter().string(from: Date())
    ) {
        self.id = id
        self.artboardRoute = artboardRoute
        self.artboardPath = artboardPath
        self.xFrac = min(0.98, max(0.02, xFrac))
        self.yFrac = min(0.98, max(0.02, yFrac))
        self.kind = kind
        self.body = body
        self.author = author
        self.elementName = elementName
        self.elementSelector = elementSelector
        self.elementFile = elementFile
        self.elementLine = elementLine
        self.isDraft = isDraft
        self.linkedTaskId = linkedTaskId
        self.createdAt = createdAt
    }

    public static func newRequestId() -> String {
        let hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(10)
        return "r-\(hex)"
    }
}

/// Content-addressed disk tile cache + framework route discovery + `.youi/requests` persistence.
public enum YouiCanvasStorage {

    // MARK: - Priority Route Discovery (Q10)

    /// Discovers routes in priority order:
    /// 1. `.youi/screens/screens.json` if present
    /// 2. Framework filesystem scan (`src/routes/`, `app/**/page.*`, `src/app/**/page.*`, `src/pages/`, `pages/`)
    /// 3. Fallback `/` root route
    public static func discoverRoutes(projectRoot: String) -> [YouiScreenEntry] {
        if let manifest = loadManifest(projectRoot: projectRoot), !manifest.screens.isEmpty {
            return manifest.screens
        }

        var found: [YouiScreenEntry] = []
        let fm = FileManager.default

        // 1. TanStack Router (`src/routes/`)
        let tanstackDir = "\(projectRoot)/src/routes"
        if fm.fileExists(atPath: tanstackDir) {
            found.append(contentsOf: scanFileRoutes(baseDir: tanstackDir, repoRoot: projectRoot, mode: .tanstack))
        }

        // 2. Next.js App Router (`app/` or `src/app/`)
        if found.isEmpty {
            for rel in ["app", "src/app"] {
                let dir = "\(projectRoot)/\(rel)"
                if fm.fileExists(atPath: dir) {
                    found.append(contentsOf: scanFileRoutes(baseDir: dir, repoRoot: projectRoot, mode: .nextApp))
                }
            }
        }

        // 3. Astro / Vite / Next Pages (`src/pages/` or `pages/`)
        if found.isEmpty {
            for rel in ["src/pages", "pages"] {
                let dir = "\(projectRoot)/\(rel)"
                if fm.fileExists(atPath: dir) {
                    found.append(contentsOf: scanFileRoutes(baseDir: dir, repoRoot: projectRoot, mode: .pages))
                }
            }
        }

        // Deduplicate & sort (`/` always first)
        var seen = Set<String>()
        let unique = found.filter { seen.insert($0.path).inserted }
            .sorted { a, b in
                if a.path == "/" { return true }
                if b.path == "/" { return false }
                return a.path < b.path
            }

        return unique.isEmpty ? [YouiScreenEntry(route: "/", path: "/")] : unique
    }

    private enum RouteScanMode { case tanstack, nextApp, pages }

    private static func scanFileRoutes(baseDir: String, repoRoot: String, mode: RouteScanMode) -> [YouiScreenEntry] {
        let fm = FileManager.default
        let canonBase = URL(fileURLWithPath: baseDir).resolvingSymlinksInPath().path
        let canonRepo = URL(fileURLWithPath: repoRoot).resolvingSymlinksInPath().path
        let baseURL = URL(fileURLWithPath: canonBase)
        guard let enumerator = fm.enumerator(
            at: baseURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        let allowedExts: Set<String> = ["tsx", "ts", "jsx", "js", "astro", "svelte", "mdx"]
        var results: [YouiScreenEntry] = []

        for case let fileURL as URL in enumerator {
            let ext = fileURL.pathExtension.lowercased()
            guard allowedExts.contains(ext) else { continue }
            let fileName = fileURL.deletingPathExtension().lastPathComponent
            if fileName.hasPrefix("__") || fileName.hasPrefix("_") || fileName.contains(".test") || fileName.contains(".spec") {
                continue
            }
            let canonFile = fileURL.resolvingSymlinksInPath().path
            guard canonFile.hasPrefix(canonBase + "/") else { continue }
            let relPath = String(canonFile.dropFirst(canonBase.count + 1))
            if relPath.contains("$") || relPath.contains("[") || relPath.contains("api/") {
                continue
            }

            let sourceFile = canonFile.hasPrefix(canonRepo + "/")
                ? String(canonFile.dropFirst(canonRepo.count + 1))
                : relPath
            switch mode {
            case .tanstack:
                let noExt = (relPath as NSString).deletingPathExtension
                var routePath: String
                if noExt == "index" {
                    routePath = "/"
                } else if noExt.hasSuffix("/index") {
                    routePath = "/" + String(noExt.dropLast(6))
                } else {
                    routePath = "/" + noExt.replacingOccurrences(of: ".", with: "/")
                }
                if !routePath.hasPrefix("/") { routePath = "/" + routePath }
                results.append(YouiScreenEntry(route: routePath, path: routePath, sourceFile: sourceFile))

            case .nextApp:
                guard fileName == "page" else { continue }
                let dirPart = (relPath as NSString).deletingLastPathComponent
                let segments = dirPart.split(separator: "/").filter { !($0.hasPrefix("(") && $0.hasSuffix(")")) }
                let routePath = segments.isEmpty ? "/" : "/" + segments.joined(separator: "/")
                results.append(YouiScreenEntry(route: routePath, path: routePath, sourceFile: sourceFile))

            case .pages:
                let noExt = (relPath as NSString).deletingPathExtension
                let routePath: String
                if noExt == "index" {
                    routePath = "/"
                } else if noExt.hasSuffix("/index") {
                    routePath = "/" + String(noExt.dropLast(6))
                } else {
                    routePath = "/" + noExt
                }
                results.append(YouiScreenEntry(route: routePath, path: routePath, sourceFile: sourceFile))
            }
        }
        return results
    }

    public static func loadManifest(projectRoot: String) -> YouiScreensManifest? {
        let url = URL(fileURLWithPath: projectRoot)
            .appendingPathComponent(".youi/screens/screens.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(YouiScreensManifest.self, from: data)
    }

    // MARK: - Content-Addressed Disk Tile Cache (~/.cache/toolroll/canvas)

    /// Computes a short fingerprint of `projectRoot`'s git HEAD + working-tree status so cached
    /// tiles automatically invalidate the moment code changes, and stay valid at 0% CPU when unchanged.
    public static func gitStateKey(projectRoot: String) -> String {
        let head = runGit(["rev-parse", "--short=10", "HEAD"], in: projectRoot) ?? "nogit"
        let status = runGit(["status", "--porcelain"], in: projectRoot) ?? ""
        if status.isEmpty { return head }
        let digest = SHA256.hash(data: Data(status.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
        return "\(head)-\(digest)"
    }

    public static func mainBranchKey(projectRoot: String) -> String {
        runGit(["rev-parse", "--short=10", "main"], in: projectRoot)
            ?? runGit(["rev-parse", "--short=10", "HEAD"], in: projectRoot)
            ?? "baseline"
    }

    private static func repoCacheDir(projectRoot: String) -> URL {
        let hash = SHA256.hash(data: Data(projectRoot.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/toolroll/canvas", isDirectory: true)
        return base.appendingPathComponent(hash, isDirectory: true)
    }

    public static func cachedTilePath(projectRoot: String, stateKey: String, slug: String, viewport: CanvasViewportPreset) -> URL {
        repoCacheDir(projectRoot: projectRoot)
            .appendingPathComponent(stateKey, isDirectory: true)
            .appendingPathComponent("\(slug)-\(viewport.rawValue.lowercased()).png")
    }

    public static func saveTilePNG(
        _ pngData: Data,
        projectRoot: String,
        stateKey: String,
        baselineKey: String,
        slug: String,
        viewport: CanvasViewportPreset
    ) -> (baseline: String, latest: String)? {
        let latestURL = cachedTilePath(projectRoot: projectRoot, stateKey: stateKey, slug: slug, viewport: viewport)
        let baselineURL = cachedTilePath(projectRoot: projectRoot, stateKey: baselineKey, slug: slug, viewport: viewport)
        do {
            try FileManager.default.createDirectory(at: latestURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try pngData.write(to: latestURL, options: .atomic)
            if !FileManager.default.fileExists(atPath: baselineURL.path) {
                try FileManager.default.createDirectory(at: baselineURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try pngData.write(to: baselineURL, options: .atomic)
            }
            return (baselineURL.path, latestURL.path)
        } catch {
            return nil
        }
    }

    public static func layoutArtboards(
        from screens: [YouiScreenEntry],
        projectRoot: String?,
        stateKey: String = "latest",
        baselineKey: String = "baseline",
        columns: Int = 3,
        viewport: CanvasViewportPreset = .desktop
    ) -> [CanvasArtboard] {
        let gapX: Double = 44
        let gapY: Double = 60
        let cols = max(1, columns)
        let w = viewport.width
        let h = viewport.height

        return screens.enumerated().map { idx, entry in
            let col = idx % cols
            let row = idx / cols
            let x = 60 + Double(col) * (w + gapX)
            let y = 56 + Double(row) * (h + gapY)
            var board = CanvasArtboard(
                id: entry.id,
                route: entry.route,
                path: entry.path,
                sourceFile: entry.sourceFile,
                x: x,
                y: y,
                width: w,
                height: h
            )
            if let root = projectRoot {
                let latest = cachedTilePath(projectRoot: root, stateKey: stateKey, slug: board.slug, viewport: viewport).path
                let base = cachedTilePath(projectRoot: root, stateKey: baselineKey, slug: board.slug, viewport: viewport).path
                if FileManager.default.fileExists(atPath: latest) {
                    board.latestImagePath = latest
                    board.cachedStateKey = stateKey
                }
                if FileManager.default.fileExists(atPath: base) {
                    board.baselineImagePath = base
                } else if board.latestImagePath != nil {
                    board.baselineImagePath = board.latestImagePath
                }
            }
            return board
        }
    }

    // MARK: - .youi/requests Persistence (youi.request/v1)

    @discardableResult
    public static func writeYouiRequest(projectRoot: String, projectName: String, pin: CanvasPin) -> URL? {
        let dir = URL(fileURLWithPath: projectRoot).appendingPathComponent(".youi/requests", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var target: [String: Any] = [
                "route": pin.artboardPath,
                "scope": pin.elementName != nil ? "element" : "here",
                "name": pin.elementName ?? pin.artboardRoute,
            ]
            if let file = pin.elementFile, !file.isEmpty { target["file"] = file }
            if let line = pin.elementLine, line > 0 { target["line"] = line }

            let payload: [String: Any] = [
                "schema": "youi.request/v1",
                "id": pin.id,
                "project": projectName,
                "kind": pin.kind.rawValue,
                "status": "open",
                "body": pin.body,
                "author": ["kind": "person", "name": pin.author],
                "createdAt": pin.createdAt,
                "updatedAt": pin.createdAt,
                "target": target,
                "canvas": [
                    "xFrac": pin.xFrac,
                    "yFrac": pin.yFrac,
                    "route": pin.artboardRoute,
                    "selector": pin.elementSelector as Any,
                    "isDraft": pin.isDraft,
                    "linkedTaskId": pin.linkedTaskId as Any,
                ],
                "thread": [],
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            let fileURL = dir.appendingPathComponent("\(pin.id).json")
            try data.write(to: fileURL, options: .atomic)
            return fileURL
        } catch {
            return nil
        }
    }

    public static func loadPins(projectRoot: String) -> [CanvasPin] {
        let dir = URL(fileURLWithPath: projectRoot).appendingPathComponent(".youi/requests", isDirectory: true)
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            return []
        }
        var pins: [CanvasPin] = []
        for url in files where url.pathExtension == "json" && !url.lastPathComponent.hasSuffix(".task.json") {
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = obj["id"] as? String,
                  let body = obj["body"] as? String
            else { continue }
            let target = obj["target"] as? [String: Any]
            let canvas = obj["canvas"] as? [String: Any]
            let authorObj = obj["author"] as? [String: Any]
            let kind = CanvasPinKind(rawValue: obj["kind"] as? String ?? "change") ?? .change

            var linkedTaskId = canvas?["linkedTaskId"] as? String
            if linkedTaskId == nil {
                let taskMeta = dir.appendingPathComponent("\(id).task.json")
                if let tData = try? Data(contentsOf: taskMeta),
                   let tObj = try? JSONSerialization.jsonObject(with: tData) as? [String: Any] {
                    linkedTaskId = tObj["task"] as? String
                }
            }

            pins.append(CanvasPin(
                id: id,
                artboardRoute: (canvas?["route"] as? String) ?? (target?["route"] as? String) ?? "/",
                artboardPath: (target?["route"] as? String) ?? "/",
                xFrac: (canvas?["xFrac"] as? Double) ?? 0.5,
                yFrac: (canvas?["yFrac"] as? Double) ?? 0.35,
                kind: kind,
                body: body,
                author: (authorObj?["name"] as? String) ?? "alex",
                elementName: target?["name"] as? String,
                elementSelector: canvas?["selector"] as? String,
                elementFile: target?["file"] as? String,
                elementLine: target?["line"] as? Int,
                isDraft: (canvas?["isDraft"] as? Bool) ?? (linkedTaskId == nil),
                linkedTaskId: linkedTaskId,
                createdAt: (obj["createdAt"] as? String) ?? ""
            ))
        }
        return pins.sorted { $0.createdAt < $1.createdAt }
    }

    private static func runGit(_ args: [String], in cwd: String) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }
}
