import Foundation

// MARK: - youiyoux Native Canvas Contracts (.youi/screens, .youi/requests, .youi/proposals)

public enum CanvasTool: String, CaseIterable, Identifiable, Sendable {
    case select = "Select"
    case pin = "Pin"
    case options = "Options"
    case compare = "Compare"
    public var id: String { rawValue }
}

public enum CanvasViewportPreset: String, CaseIterable, Identifiable, Sendable {
    case desktop = "Desktop"
    case mobile = "Mobile"
    public var id: String { rawValue }

    public var width: Double {
        switch self {
        case .desktop: return 520
        case .mobile: return 260
        }
    }

    public var height: Double {
        switch self {
        case .desktop: return 340
        case .mobile: return 460
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

    public init(route: String, path: String) {
        self.route = route
        self.path = path
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
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var baselineImagePath: String?
    public var latestImagePath: String?
    public var isLiveInteractive: Bool
    public var compareSplit: Double // 0.0...1.0 for Before/After scrub

    public init(
        id: String = UUID().uuidString,
        route: String,
        path: String,
        x: Double,
        y: Double,
        width: Double = 520,
        height: Double = 340,
        baselineImagePath: String? = nil,
        latestImagePath: String? = nil,
        isLiveInteractive: Bool = false,
        compareSplit: Double = 0.5
    ) {
        self.id = id
        self.route = route
        self.path = path
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.baselineImagePath = baselineImagePath
        self.latestImagePath = latestImagePath
        self.isLiveInteractive = isLiveInteractive
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
    public let xFrac: Double       // 0.0...1.0 relative to artboard
    public let yFrac: Double       // 0.0...1.0 relative to artboard
    public let kind: CanvasPinKind
    public let body: String
    public let author: String
    public let elementName: String?
    public let elementFile: String?
    public let elementLine: Int?
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
        elementFile: String? = nil,
        elementLine: Int? = nil,
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
        self.elementFile = elementFile
        self.elementLine = elementLine
        self.linkedTaskId = linkedTaskId
        self.createdAt = createdAt
    }

    public static func newRequestId() -> String {
        let hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(10)
        return "r-\(hex)"
    }
}

/// Reads and writes standard `.youi/` canvas manifests, requests (`youi.request/v1`), and PNG captures.
public enum YouiCanvasStorage {
    public static func loadManifest(projectRoot: String) -> YouiScreensManifest? {
        let url = URL(fileURLWithPath: projectRoot)
            .appendingPathComponent(".youi/screens/screens.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(YouiScreensManifest.self, from: data)
    }

    public static func layoutArtboards(
        from screens: [YouiScreenEntry],
        projectRoot: String?,
        columns: Int = 3,
        viewport: CanvasViewportPreset = .desktop
    ) -> [CanvasArtboard] {
        let gapX: Double = 44
        let gapY: Double = 64
        let cols = max(1, columns)
        let w = viewport.width
        let h = viewport.height

        return screens.enumerated().map { idx, entry in
            let col = idx % cols
            let row = idx / cols
            let x = 60 + Double(col) * (w + gapX)
            let y = 60 + Double(row) * (h + gapY)
            var board = CanvasArtboard(
                id: entry.id,
                route: entry.route,
                path: entry.path,
                x: x,
                y: y,
                width: w,
                height: h
            )
            if let root = projectRoot {
                let capDir = URL(fileURLWithPath: root).appendingPathComponent(".youi/screens/captures")
                let base = capDir.appendingPathComponent("\(board.slug)-baseline.png").path
                let latest = capDir.appendingPathComponent("\(board.slug)-latest.png").path
                if FileManager.default.fileExists(atPath: base) { board.baselineImagePath = base }
                if FileManager.default.fileExists(atPath: latest) { board.latestImagePath = latest }
            }
            return board
        }
    }

    /// Saves a `youi.request/v1` JSON file under `<projectRoot>/.youi/requests/<id>.json` so Toolroll's
    /// `youiyoux-intake.ts` and teammates see the exact same spatial pin.
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

    /// Reads previously saved canvas pins from `<projectRoot>/.youi/requests/*.json`.
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

            // Check sibling <id>.task.json written by Toolroll's youiyoux-intake.ts
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
                elementFile: target?["file"] as? String,
                elementLine: target?["line"] as? Int,
                linkedTaskId: linkedTaskId,
                createdAt: (obj["createdAt"] as? String) ?? ""
            ))
        }
        return pins.sorted { $0.createdAt < $1.createdAt }
    }

    public static func saveSnapshotPNG(_ pngData: Data, projectRoot: String, slug: String) -> (baseline: String, latest: String)? {
        let dir = URL(fileURLWithPath: projectRoot).appendingPathComponent(".youi/screens/captures", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let baselineURL = dir.appendingPathComponent("\(slug)-baseline.png")
            let latestURL = dir.appendingPathComponent("\(slug)-latest.png")
            if !FileManager.default.fileExists(atPath: baselineURL.path) {
                try pngData.write(to: baselineURL, options: .atomic)
            }
            try pngData.write(to: latestURL, options: .atomic)
            return (baselineURL.path, latestURL.path)
        } catch {
            return nil
        }
    }
}
