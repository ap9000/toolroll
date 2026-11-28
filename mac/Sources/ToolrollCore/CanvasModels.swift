import CoreGraphics
import CryptoKit
import Foundation

public enum CanvasTool: String, CaseIterable, Identifiable, Sendable {
    case select = "Select"
    case hand = "Hand"
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
    public var surface: String = "web"
    public var appearance: String?
    public var title: String?

    public var isAppScreen: Bool { surface != "web" }

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
    public let id: String
    public let artboardRoute: String
    public let artboardPath: String
    public let xFrac: Double
    public let yFrac: Double
    public let kind: CanvasPinKind
    public let body: String
    public let author: String
    public let authorKind: String
    public let elementName: String?
    public let elementSelector: String?
    public let elementFile: String?
    public let elementLine: Int?
    public var screenshotPath: String?
    public var isDraft: Bool
    public var linkedTaskId: String?
    public let createdAt: String
    public let surface: String?
    public let appearance: String?
    public let device: String?
    public let captureStateKey: String?

    public var isAppPin: Bool { surface != nil }

    public init(
        id: String = CanvasPin.newRequestId(),
        artboardRoute: String,
        artboardPath: String,
        xFrac: Double,
        yFrac: Double,
        kind: CanvasPinKind,
        body: String,
        author: String,
        authorKind: String = "person",
        elementName: String? = nil,
        elementSelector: String? = nil,
        elementFile: String? = nil,
        elementLine: Int? = nil,
        screenshotPath: String? = nil,
        isDraft: Bool = true,
        linkedTaskId: String? = nil,
        createdAt: String = ISO8601DateFormatter().string(from: Date()),
        surface: String? = nil,
        appearance: String? = nil,
        device: String? = nil,
        captureStateKey: String? = nil
    ) {
        self.id = id
        self.artboardRoute = artboardRoute
        self.artboardPath = artboardPath
        self.xFrac = min(0.98, max(0.02, xFrac))
        self.yFrac = min(0.98, max(0.02, yFrac))
        self.kind = kind
        self.body = body
        self.author = author
        self.authorKind = authorKind == "agent" ? "agent" : "person"
        self.elementName = elementName
        self.elementSelector = elementSelector
        self.elementFile = elementFile
        self.elementLine = elementLine
        self.screenshotPath = screenshotPath
        self.isDraft = isDraft
        self.linkedTaskId = linkedTaskId
        self.createdAt = createdAt
        self.surface = surface
        self.appearance = appearance
        self.device = device
        self.captureStateKey = captureStateKey
    }

    public static func newRequestId() -> String {
        let hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(10)
        return "r-\(hex)"
    }

    public static let unnamedAuthor = "you"

    public static func authorName(account: String?) -> String {
        let trimmed = account?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? unnamedAuthor : trimmed
    }

    public var proposalId: String { "p-" + id.dropFirst(2) }
    public var proposalFile: String { ".youi/proposals/\(proposalId).json" }
}

public enum ElementCategory: String, Sendable, Equatable {
    case text
    case button
    case card
    case input
    case image
    case container

    public struct QuickChip: Sendable, Equatable, Identifiable {
        public var id: String { label }
        public let label: String
        public let prompt: String
        public let isOptions: Bool

        public init(label: String, prompt: String, isOptions: Bool = false) {
            self.label = label
            self.prompt = prompt
            self.isOptions = isOptions
        }
    }

    public var quickChips: [QuickChip] {
        switch self {
        case .text:
            return [
                QuickChip(label: "Tighten copy", prompt: "Tighten this copy so it is shorter, clearer, and more direct."),
                QuickChip(label: "Stronger hierarchy", prompt: "Strengthen the typographic hierarchy and readability of this text."),
                QuickChip(label: "Muted tone", prompt: "Make this secondary text quieter and lower visual weight."),
                QuickChip(label: "Options A/B/C/D", prompt: "Propose 3–4 typographic and copy variations for this element.", isOptions: true),
            ]
        case .button:
            return [
                QuickChip(label: "Make primary", prompt: "Give this action primary visual emphasis matching our design system."),
                QuickChip(label: "Make subtle", prompt: "Make this action quieter (ghost/secondary styling) so it competes less."),
                QuickChip(label: "Fix alignment", prompt: "Fix vertical/horizontal alignment and padding inside this control."),
                QuickChip(label: "Options A/B/C/D", prompt: "Propose 3–4 visual treatments for this button/control.", isOptions: true),
            ]
        case .input:
            return [
                QuickChip(label: "Cleaner border", prompt: "Refine the border, padding, and surface contrast of this input."),
                QuickChip(label: "Better focus state", prompt: "Improve the focus ring and placeholder clarity for this input."),
                QuickChip(label: "Tighter height", prompt: "Make this input slightly more compact and balanced."),
                QuickChip(label: "Options A/B/C/D", prompt: "Propose 3–4 layout and styling variations for this input.", isOptions: true),
            ]
        case .image:
            return [
                QuickChip(label: "Refined framing", prompt: "Improve framing, aspect ratio, and visual alignment of this media element."),
                QuickChip(label: "Subtle border", prompt: "Add a subtle 1px hairline border and clean corner radius."),
                QuickChip(label: "Options A/B/C/D", prompt: "Propose 3–4 framing/presentation options for this visual.", isOptions: true),
            ]
        case .card, .container:
            return [
                QuickChip(label: "Tighter spacing", prompt: "Tighten internal padding and spacing so this block feels denser and crisper."),
                QuickChip(label: "Higher contrast", prompt: "Improve surface/border contrast and visual separation for this container."),
                QuickChip(label: "Simplify layout", prompt: "Reduce visual noise and simplify the layout hierarchy inside this block."),
                QuickChip(label: "Options A/B/C/D", prompt: "Propose 3–4 layout and styling directions for this component.", isOptions: true),
            ]
        }
    }
}

public struct ElementAncestorRef: Sendable, Equatable, Identifiable {
    public let depthFromSelected: Int
    public let label: String
    public let tag: String

    public var id: Int { depthFromSelected }

    public init(depthFromSelected: Int, label: String, tag: String) {
        self.depthFromSelected = depthFromSelected
        self.label = label
        self.tag = tag
    }
}

public struct ElementStyleMetrics: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let padding: Double
    public let gap: Double
    public let fontSize: Double
    public let fontWeight: Int
    public let borderRadius: Double
    public let opacity: Double
    public let display: String
    public let color: String
    public let backgroundColor: String

    public init(
        width: Int = 0,
        height: Int = 0,
        padding: Double = 0,
        gap: Double = 0,
        fontSize: Double = 14,
        fontWeight: Int = 400,
        borderRadius: Double = 0,
        opacity: Double = 1.0,
        display: String = "block",
        color: String = "",
        backgroundColor: String = ""
    ) {
        self.width = max(0, min(100_000, width))
        self.height = max(0, min(100_000, height))
        self.padding = Self.sanitize(padding, min: 0, max: 9999, fallback: 0)
        self.gap = Self.sanitize(gap, min: 0, max: 9999, fallback: 0)
        self.fontSize = Self.sanitize(fontSize, min: 0, max: 9999, fallback: 14)
        self.fontWeight = max(100, min(1000, fontWeight))
        self.borderRadius = Self.sanitize(borderRadius, min: 0, max: 9999, fallback: 0)
        self.opacity = Self.sanitize(opacity, min: 0, max: 1, fallback: 1)
        self.display = display
        self.color = color
        self.backgroundColor = backgroundColor
    }

    public static func sanitize(_ value: Double, min lower: Double, max upper: Double, fallback: Double) -> Double {
        guard !value.isNaN else { return fallback }
        if value.isInfinite { return value > 0 ? upper : lower }
        return Swift.min(upper, Swift.max(lower, value))
    }

    public static func safeInt(_ value: Double, min lower: Int = 0, max upper: Int = 9999) -> Int {
        let clamped = sanitize(value, min: Double(lower), max: Double(upper), fallback: Double(lower))
        return Int(clamped.rounded())
    }
}

public struct SelectedElementContext: Sendable, Equatable {
    public let elId: String
    public let displayName: String
    public let tag: String
    public let selector: String
    public let testId: String?
    public let textExcerpt: String
    public let category: ElementCategory
    public var file: String?
    public var line: Int?
    public let ancestors: [ElementAncestorRef]
    public let metrics: ElementStyleMetrics
    public let rectXFrac: Double
    public let rectYFrac: Double
    public let rectWFrac: Double
    public let rectHFrac: Double
    public let clickXFrac: Double
    public let clickYFrac: Double

    public init(
        elId: String,
        displayName: String,
        tag: String,
        selector: String,
        testId: String? = nil,
        textExcerpt: String = "",
        category: ElementCategory = .container,
        file: String? = nil,
        line: Int? = nil,
        ancestors: [ElementAncestorRef] = [],
        metrics: ElementStyleMetrics = ElementStyleMetrics(),
        rectXFrac: Double = 0.25,
        rectYFrac: Double = 0.25,
        rectWFrac: Double = 0.2,
        rectHFrac: Double = 0.1,
        clickXFrac: Double = 0.5,
        clickYFrac: Double = 0.5
    ) {
        self.elId = elId
        self.displayName = displayName
        self.tag = tag
        self.selector = selector
        self.testId = testId
        self.textExcerpt = textExcerpt
        self.category = category
        self.file = file
        self.line = line
        self.ancestors = ancestors
        self.metrics = metrics
        self.rectXFrac = rectXFrac
        self.rectYFrac = rectYFrac
        self.rectWFrac = rectWFrac
        self.rectHFrac = rectHFrac
        self.clickXFrac = clickXFrac
        self.clickYFrac = clickYFrac
    }

    public var hasParent: Bool {
        ancestors.contains(where: { $0.depthFromSelected >= 1 })
    }
}

public struct ElementLiveEdit: Sendable, Equatable, Identifiable {
    public let id: String
    public let elementLabel: String
    public let selector: String
    public let file: String?
    public let line: Int?
    public let originalText: String
    public var editedText: String?
    public let originalMetrics: ElementStyleMetrics
    public var padding: Double?
    public var gap: Double?
    public var fontSize: Double?
    public var fontWeight: Int?
    public var borderRadius: Double?
    public var opacity: Double?
    public var isHidden: Bool

    public init(from ctx: SelectedElementContext) {
        self.id = ctx.elId
        self.elementLabel = ctx.displayName
        self.selector = ctx.selector
        self.file = ctx.file
        self.line = ctx.line
        self.originalText = ctx.textExcerpt
        self.editedText = nil
        self.originalMetrics = ctx.metrics
        self.padding = nil
        self.gap = nil
        self.fontSize = nil
        self.fontWeight = nil
        self.borderRadius = nil
        self.opacity = nil
        self.isHidden = false
    }

    public var summaryLines: [String] {
        var out: [String] = []
        if isHidden {
            out.append("remove / hide element")
        }
        if let nextText = editedText, nextText != originalText {
            let before = originalText.isEmpty ? "(empty)" : "\"\(originalText.prefix(48))\""
            let after = "\"\(nextText.prefix(64))\""
            out.append("copy: \(before) → \(after)")
        }
        if let p = padding, abs(p - originalMetrics.padding) >= 0.5 {
            out.append("padding: \(ElementStyleMetrics.safeInt(originalMetrics.padding))px → \(ElementStyleMetrics.safeInt(p))px")
        }
        if let g = gap, abs(g - originalMetrics.gap) >= 0.5 {
            out.append("gap: \(ElementStyleMetrics.safeInt(originalMetrics.gap))px → \(ElementStyleMetrics.safeInt(g))px")
        }
        if let fs = fontSize, abs(fs - originalMetrics.fontSize) >= 0.5 {
            out.append("font-size: \(ElementStyleMetrics.safeInt(originalMetrics.fontSize))px → \(ElementStyleMetrics.safeInt(fs))px")
        }
        if let fw = fontWeight, fw != originalMetrics.fontWeight {
            out.append("font-weight: \(originalMetrics.fontWeight) → \(fw)")
        }
        if let br = borderRadius, abs(br - originalMetrics.borderRadius) >= 0.5 {
            let fromStr = originalMetrics.borderRadius >= 9999 ? "full" : "\(ElementStyleMetrics.safeInt(originalMetrics.borderRadius))px"
            let toStr = br >= 9999 ? "full" : "\(ElementStyleMetrics.safeInt(br))px"
            out.append("border-radius: \(fromStr) → \(toStr)")
        }
        if let op = opacity, abs(op - originalMetrics.opacity) >= 0.02 {
            out.append("opacity: \(ElementStyleMetrics.safeInt(originalMetrics.opacity * 100, min: 0, max: 100))% → \(ElementStyleMetrics.safeInt(op * 100, min: 0, max: 100))%")
        }
        return out
    }

    public var hasChanges: Bool { !summaryLines.isEmpty }

    public func formattedForTask() -> String {
        var header = "`\(elementLabel)` (`\(selector)`)"
        if let f = file {
            header += line.map { " in `\(f):\($0)`" } ?? " in `\(f)`"
        }
        return "\(header): " + summaryLines.joined(separator: "; ")
    }
}

public enum YouiCanvasStorage {

    public static func discoverRoutes(projectRoot: String) -> [YouiScreenEntry] {
        if let manifest = loadManifest(projectRoot: projectRoot), !manifest.screens.isEmpty {
            return manifest.screens
        }

        var found: [YouiScreenEntry] = []
        let fm = FileManager.default

        let tanstackDir = "\(projectRoot)/src/routes"
        if fm.fileExists(atPath: tanstackDir) {
            found.append(contentsOf: scanFileRoutes(baseDir: tanstackDir, repoRoot: projectRoot, mode: .tanstack))
        }

        if found.isEmpty {
            for rel in ["app", "src/app"] {
                let dir = "\(projectRoot)/\(rel)"
                if fm.fileExists(atPath: dir) {
                    found.append(contentsOf: scanFileRoutes(baseDir: dir, repoRoot: projectRoot, mode: .nextApp))
                }
            }
        }

        if found.isEmpty {
            for rel in ["src/pages", "pages"] {
                let dir = "\(projectRoot)/\(rel)"
                if fm.fileExists(atPath: dir) {
                    found.append(contentsOf: scanFileRoutes(baseDir: dir, repoRoot: projectRoot, mode: .pages))
                }
            }
        }

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

    public static func gitStateKey(projectRoot: String, excluding: [String] = []) -> String {
        AppSurfaceStorage.surfaceStateKey(projectRoot: projectRoot, pathspecs: AppSurfaceStorage.pathspecs(excluding: excluding))
    }

    public static func mainBranchKey(projectRoot: String) -> String {
        guard HardenedGit.refusal(in: projectRoot) == nil else { return "baseline" }
        return HardenedGit.text(["rev-parse", "--short=10", "main"], in: projectRoot)
            ?? HardenedGit.text(["rev-parse", "--short=10", "HEAD"], in: projectRoot)
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
        let checkpointURL = baselineCheckpointPath(projectRoot: projectRoot, slug: slug, viewport: viewport)
        do {
            try FileManager.default.createDirectory(at: latestURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try pngData.write(to: latestURL, options: .atomic)
            if !FileManager.default.fileExists(atPath: baselineURL.path) {
                try FileManager.default.createDirectory(at: baselineURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try pngData.write(to: baselineURL, options: .atomic)
            }
            let effectiveBase = FileManager.default.fileExists(atPath: checkpointURL.path) ? checkpointURL.path : baselineURL.path
            return (effectiveBase, latestURL.path)
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
        viewport: CanvasViewportPreset = .desktop,
        originY: Double = 56
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
            let y = originY + Double(row) * (h + gapY)
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
                let checkpoint = baselineCheckpointPath(projectRoot: root, slug: board.slug, viewport: viewport).path
                let base = cachedTilePath(projectRoot: root, stateKey: baselineKey, slug: board.slug, viewport: viewport).path
                if FileManager.default.fileExists(atPath: latest) {
                    board.latestImagePath = latest
                    board.cachedStateKey = stateKey
                }
                if FileManager.default.fileExists(atPath: checkpoint) {
                    board.baselineImagePath = checkpoint
                } else if FileManager.default.fileExists(atPath: base) {
                    board.baselineImagePath = base
                } else if board.latestImagePath != nil {
                    board.baselineImagePath = board.latestImagePath
                }
            }
            return board
        }
    }

    public static func baselineCheckpointPath(
        projectRoot: String,
        slug: String,
        viewport: CanvasViewportPreset
    ) -> URL {
        repoCacheDir(projectRoot: projectRoot)
            .appendingPathComponent("checkpoints", isDirectory: true)
            .appendingPathComponent("\(slug)-\(viewport.rawValue.lowercased()).png")
    }

    @discardableResult
    public static func saveBaselineCheckpoint(
        fromImagePath: String,
        projectRoot: String,
        slug: String,
        viewport: CanvasViewportPreset
    ) -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: fromImagePath)) else { return nil }
        let dest = baselineCheckpointPath(projectRoot: projectRoot, slug: slug, viewport: viewport)
        do {
            try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: dest, options: .atomic)
            return dest.path
        } catch {
            return nil
        }
    }

    @discardableResult
    public static func savePinScreenshot(
        _ pngData: Data,
        projectRoot: String,
        pinId: String
    ) -> String? {
        let dir = URL(fileURLWithPath: projectRoot).appendingPathComponent(".youi/requests", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let fileURL = dir.appendingPathComponent("\(pinId).png")
            try pngData.write(to: fileURL, options: .atomic)
            return ".youi/requests/\(pinId).png"
        } catch {
            return nil
        }
    }

    public static func youiRequestPayload(projectName: String, pin: CanvasPin) -> [String: Any] {
        var target: [String: Any] = [
            "route": pin.artboardPath,
            "scope": pin.elementName != nil ? "element" : "here",
            "name": clip(pin.elementName ?? pin.artboardRoute, 200),
        ]
        if let file = pin.elementFile, !file.isEmpty { target["file"] = file }
        if let line = pin.elementLine, line > 0 { target["line"] = line }
        if let shot = pin.screenshotPath, !shot.isEmpty { target["screenshot"] = shot }

        var canvas: [String: Any] = [
            "xFrac": pin.xFrac,
            "yFrac": pin.yFrac,
            "route": pin.artboardRoute,
            "selector": pin.elementSelector as Any,
            "screenshot": pin.screenshotPath as Any,
            "isDraft": pin.isDraft,
            "linkedTaskId": pin.linkedTaskId as Any,
        ]
        if let surface = pin.surface { canvas["surface"] = surface }
        if let appearance = pin.appearance { canvas["state"] = appearance }
        if let device = pin.device { canvas["device"] = device }
        if let key = pin.captureStateKey { canvas["captureStateKey"] = key }

        var payload: [String: Any] = [
            "schema": "youi.request/v1",
            "id": pin.id,
            "project": projectName,
            "kind": pin.kind.rawValue,
            "status": "open",
            "body": clip(pin.body, 4000),
            "author": ["kind": pin.authorKind, "name": clip(pin.author, 100)],
            "createdAt": pin.createdAt,
            "updatedAt": pin.createdAt,
            "target": target,
            "canvas": canvas,
            "thread": [],
        ]
        if pin.kind == .options && !pin.isDraft {
            payload["task"] = optionsTask(for: pin)
        }
        return payload
    }

    static func optionsTask(for pin: CanvasPin) -> [String: Any] {
        let place = pin.elementName ?? pin.artboardRoute
        var goal = "Propose 2–4 options (A–D) for \(place) on \(pin.artboardPath), as asked on the Toolroll Canvas:\n\n\(pin.body)\n\n"
        if let file = pin.elementFile {
            goal += "It is drawn by \(pin.elementLine.map { "\(file):\($0)" } ?? file). "
        }
        goal += "Write them as youi.proposal/v1 to \(pin.proposalFile) (for: \(pin.id)). Change no other file: a person picks one before anything is built."
        return [
            "title": clip("[UI Options A/B/C/D] \(place): \(pin.body)", 120),
            "goal": clip(goal, 4000),
            "touches": [pin.proposalFile],
            "touchesKnown": true,
            "not": ["Changes to any file other than \(pin.proposalFile)"],
            "acceptance": [[
                "statement": clip("\(pin.proposalFile) holds 2–4 options for \(place) as youi.proposal/v1", 300),
                "evidence": ["changed-path"],
            ]],
            "offer": [
                "proposal": pin.proposalId,
                "file": pin.proposalFile,
                "choices": [String: Any](),
                "text": true,
            ],
        ]
    }

    private static func clip(_ text: String, _ max: Int) -> String {
        text.count <= max ? text : String(text.prefix(max - 1)) + "…"
    }

    @discardableResult
    public static func writeYouiRequest(projectRoot: String, projectName: String, pin: CanvasPin) -> URL? {
        let dir = URL(fileURLWithPath: projectRoot).appendingPathComponent(".youi/requests", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let payload = youiRequestPayload(projectName: projectName, pin: pin)
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
                    linkedTaskId = ((tObj["task"] as? [String: Any])?["id"] as? String) ?? (tObj["task"] as? String)
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
                author: CanvasPin.authorName(account: authorObj?["name"] as? String),
                authorKind: (authorObj?["kind"] as? String) ?? "person",
                elementName: (target?["scope"] as? String) == "element" ? target?["name"] as? String : nil,
                elementSelector: canvas?["selector"] as? String,
                elementFile: target?["file"] as? String,
                elementLine: target?["line"] as? Int,
                screenshotPath: (target?["screenshot"] as? String) ?? (canvas?["screenshot"] as? String),
                isDraft: (canvas?["isDraft"] as? Bool) ?? (linkedTaskId == nil),
                linkedTaskId: linkedTaskId,
                createdAt: (obj["createdAt"] as? String) ?? "",
                surface: canvas?["surface"] as? String,
                appearance: canvas?["state"] as? String,
                device: canvas?["device"] as? String,
                captureStateKey: canvas?["captureStateKey"] as? String
            ))
        }
        return pins.sorted { $0.createdAt < $1.createdAt }
    }

    public static func findSourceFile(
        projectRoot: String,
        testId: String? = nil,
        textExcerpt: String? = nil,
        selector: String? = nil
    ) -> (file: String, line: Int)? {
        var needles: [String] = []
        if let tid = testId?.trimmingCharacters(in: .whitespacesAndNewlines), tid.count >= 3 {
            needles.append(tid)
        }
        if let txt = textExcerpt?.trimmingCharacters(in: .whitespacesAndNewlines) {
            let firstLine = txt.split(whereSeparator: \.isNewline).first.map(String.init)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if firstLine.count >= 4 && firstLine.count <= 60 {
                needles.append(firstLine)
            } else if firstLine.count > 60 {
                needles.append(String(firstLine.prefix(40)))
            }
        }
        if let sel = selector {
            if let hashRange = sel.range(of: "#") {
                let idToken = String(sel[hashRange.upperBound...]).split(separator: ".").first.map(String.init) ?? ""
                if idToken.count >= 3 { needles.append(idToken) }
            }
            let classes = sel.split(separator: ".").dropFirst().map(String.init)
                .filter { $0.count >= 4 && !$0.contains(":") && !$0.hasPrefix("flex") && !$0.hasPrefix("grid") && !$0.hasPrefix("text-") && !$0.hasPrefix("bg-") && !$0.hasPrefix("p-") && !$0.hasPrefix("m-") }
            if let rareClass = classes.first {
                needles.append(rareClass)
            }
        }
        guard !needles.isEmpty else { return nil }

        let fm = FileManager.default
        let canonRepo = URL(fileURLWithPath: projectRoot).resolvingSymlinksInPath().path
        let searchRoots = ["src", "app", "components", "web", "ui", "client"].map { "\(canonRepo)/\($0)" }
            .filter { fm.fileExists(atPath: $0) }
        let dirs = searchRoots.isEmpty ? [canonRepo] : searchRoots
        let exts: Set<String> = ["tsx", "ts", "jsx", "js", "svelte", "vue", "astro", "html"]

        var files: [URL] = []
        for dir in dirs {
            guard let en = fm.enumerator(
                at: URL(fileURLWithPath: dir),
                includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for case let url as URL in en {
                let name = url.lastPathComponent
                if name == "node_modules" || name == "dist" || name == ".next" || name == "build" || name == ".git" {
                    en.skipDescendants()
                    continue
                }
                guard exts.contains(url.pathExtension.lowercased()),
                      !name.contains(".test."), !name.contains(".spec.") else { continue }
                if let vals = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                   vals.isRegularFile == true,
                   (vals.fileSize ?? 0) <= 131_072 {
                    files.append(url)
                    if files.count >= 350 { break }
                }
            }
            if files.count >= 350 { break }
        }

        for needle in needles {
            for url in files {
                guard let content = try? String(contentsOf: url, encoding: .utf8),
                      content.contains(needle) else { continue }
                let lines = content.components(separatedBy: .newlines)
                if let idx = lines.firstIndex(where: { $0.contains(needle) }) {
                    let canonFile = url.resolvingSymlinksInPath().path
                    let rel = canonFile.hasPrefix(canonRepo + "/")
                        ? String(canonFile.dropFirst(canonRepo.count + 1))
                        : url.lastPathComponent
                    return (rel, idx + 1)
                }
            }
        }
        return nil
    }

}

public struct VisualDiffResult: Sendable {
    public let changedPercent: Double
    public let changedPixels: Int
    public let totalPixels: Int
    public let heatmapImage: CGImage?

    public init(changedPercent: Double, changedPixels: Int, totalPixels: Int, heatmapImage: CGImage?) {
        self.changedPercent = changedPercent
        self.changedPixels = changedPixels
        self.totalPixels = totalPixels
        self.heatmapImage = heatmapImage
    }

    public var isIdentical: Bool { changedPixels == 0 }
}

public enum CanvasVisualDiff {
    public static func compare(
        before: CGImage,
        after: CGImage,
        maxWidth: Int = 720,
        tolerance: Int = 14
    ) -> VisualDiffResult {
        let srcW = max(1, after.width)
        let srcH = max(1, after.height)
        let w = min(maxWidth, srcW)
        let h = max(1, Int((Double(srcH) * Double(w) / Double(srcW)).rounded()))
        let bytesPerRow = w * 4
        let byteCount = bytesPerRow * h

        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            return VisualDiffResult(changedPercent: 0, changedPixels: 0, totalPixels: w * h, heatmapImage: nil)
        }
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

        var beforeBuf = [UInt8](repeating: 0, count: byteCount)
        var afterBuf = [UInt8](repeating: 0, count: byteCount)
        var heatBuf = [UInt8](repeating: 0, count: byteCount)

        let drawRect = CGRect(x: 0, y: 0, width: w, height: h)
        beforeBuf.withUnsafeMutableBytes { ptr in
            if let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo) {
                ctx.interpolationQuality = .medium
                ctx.draw(before, in: drawRect)
            }
        }
        afterBuf.withUnsafeMutableBytes { ptr in
            if let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo) {
                ctx.interpolationQuality = .medium
                ctx.draw(after, in: drawRect)
            }
        }

        var changed = 0
        let total = w * h
        for i in 0..<total {
            let o = i * 4
            let dr = abs(Int(beforeBuf[o]) - Int(afterBuf[o]))
            let dg = abs(Int(beforeBuf[o + 1]) - Int(afterBuf[o + 1]))
            let db = abs(Int(beforeBuf[o + 2]) - Int(afterBuf[o + 2]))
            let da = abs(Int(beforeBuf[o + 3]) - Int(afterBuf[o + 3]))
            if max(max(dr, dg), max(db, da)) > tolerance {
                changed += 1
                heatBuf[o] = 168
                heatBuf[o + 1] = 36
                heatBuf[o + 2] = 68
                heatBuf[o + 3] = 180
            }
        }

        let heatmap: CGImage? = heatBuf.withUnsafeMutableBytes { ptr in
            guard let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo) else {
                return nil
            }
            return ctx.makeImage()
        }

        let pct = total > 0 ? (Double(changed) / Double(total)) * 100.0 : 0.0
        return VisualDiffResult(changedPercent: pct, changedPixels: changed, totalPixels: total, heatmapImage: heatmap)
    }
}
