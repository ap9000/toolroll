import CryptoKit
import Foundation

public struct AppScreen: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let launch: [String]
    public let view: String
    public let appearances: [String]?
    public let note: String?

    public init(id: String, title: String, launch: [String], view: String, appearances: [String]? = nil, note: String? = nil) {
        self.id = id
        self.title = title
        self.launch = launch
        self.view = view
        self.appearances = appearances
        self.note = note
    }
}

public struct AppSurfaceBuild: Codable, Sendable, Equatable {
    public let project: String
    public let scheme: String
    public let bundleId: String
}

public struct AppSurface: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let build: AppSurfaceBuild
    public let device: String
    public let paths: [String]
    public let appearances: [String]
    public let screens: [AppScreen]

    public func appearances(for screen: AppScreen) -> [String] {
        screen.appearances ?? appearances
    }

    public var deviceWord: String {
        kind == "ios" ? "iPhone" : label
    }
}

public struct AppScreensManifest: Codable, Sendable, Equatable {
    public static let schemaName = "toolroll.app-screens/v1"
    public let schema: String
    public let project: String
    public let surfaces: [AppSurface]
}

public struct AppCaptureEntry: Codable, Sendable, Equatable {
    public let screen: String
    public let appearance: String
    public let file: String
    public let commit: String
    public let capturedAt: String

    enum CodingKeys: String, CodingKey {
        case screen, appearance, file, commit
        case capturedAt = "captured_at"
    }
}

public struct AppCaptureIndex: Codable, Sendable, Equatable {
    public static let schemaName = "toolroll.app-captures/v1"
    public let schema: String
    public let surface: String
    public let device: String?
    public let os: String?
    public let stateKey: String
    public let commit: String
    public let capturedAt: String
    public let captures: [AppCaptureEntry]

    enum CodingKeys: String, CodingKey {
        case schema, surface, device, os, commit, captures
        case stateKey = "state_key"
        case capturedAt = "captured_at"
    }
}

public struct AppCaptureSet: Sendable, Equatable {
    public let index: AppCaptureIndex
    public let folder: String
    public let isStale: Bool

    public func imagePath(screen: String, appearance: String) -> String? {
        guard let entry = index.captures.first(where: { $0.screen == screen && $0.appearance == appearance }),
              AppSurfaceStorage.isPlainName(entry.file)
        else { return nil }
        let path = (folder as NSString).appendingPathComponent(entry.file)
        return AppSurfaceStorage.captureImage(path: path, within: folder, readAll: false) != nil ? path : nil
    }
}

public enum AppSurfaceStorage {
    public static let manifestPath = ".youi/screens/app.json"
    public static let mirrorRoot = ".youi/screens/toolroll"
    static let appearanceWords: Set<String> = ["light", "dark"]

    public static func loadManifest(projectRoot: String) -> AppScreensManifest? {
        let path = URL(fileURLWithPath: projectRoot).appendingPathComponent(manifestPath).path
        guard let data = readPlainFile(path: path, cap: 256 * 1024) else { return nil }
        return parseManifest(data)
    }

    public static let captureImageByteCap = 20 * 1024 * 1024
    static let pngMagic: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

    static func readPlainFile(path: String, cap: Int, prefixOnly: Int? = nil) -> Data? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_nlink == 1,
              st.st_size >= 0, Int(st.st_size) <= cap
        else { return nil }
        let want = min(Int(st.st_size), prefixOnly ?? Int(st.st_size))
        var data = Data(count: want)
        var got = 0
        let ok = data.withUnsafeMutableBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return want == 0 }
            while got < want {
                let n = read(fd, base + got, want - got)
                if n <= 0 { return false }
                got += n
            }
            return true
        }
        return ok ? data : nil
    }

    public static func captureImage(path: String, within folder: String, readAll: Bool = true) -> Data? {
        let name = (path as NSString).lastPathComponent
        guard isPlainName(name), name.lowercased().hasSuffix(".png") else { return nil }
        let canonicalFolder = URL(fileURLWithPath: folder).resolvingSymlinksInPath().path
        let parent = URL(fileURLWithPath: (path as NSString).deletingLastPathComponent).resolvingSymlinksInPath().path
        guard !canonicalFolder.isEmpty, parent == canonicalFolder else { return nil }
        let full = (canonicalFolder as NSString).appendingPathComponent(name)
        guard let data = readPlainFile(path: full, cap: captureImageByteCap, prefixOnly: readAll ? nil : pngMagic.count),
              data.count >= pngMagic.count, Array(data.prefix(pngMagic.count)) == pngMagic
        else { return nil }
        return data
    }

    public static func parseManifest(_ data: Data) -> AppScreensManifest? {
        guard let raw = try? JSONDecoder().decode(AppScreensManifest.self, from: data),
              raw.schema == AppScreensManifest.schemaName
        else { return nil }
        let surfaces = raw.surfaces.prefix(8).compactMap { surface -> AppSurface? in
            guard isSlug(surface.id), surface.kind == "ios",
                  isPlainRelativePath(surface.build.project),
                  !surface.paths.isEmpty, surface.paths.allSatisfy(isPlainRelativePath),
                  !surface.appearances.isEmpty, surface.appearances.allSatisfy(appearanceWords.contains)
            else { return nil }
            var seen = Set<String>()
            let screens = surface.screens.prefix(60).filter { screen in
                isSlug(screen.id) && seen.insert(screen.id).inserted
                    && !screen.title.isEmpty && screen.title.count <= 80
                    && screen.launch.count <= 12 && screen.launch.allSatisfy { $0.count <= 200 && !$0.contains("\u{0}") }
                    && isPlainRelativePath(screen.view)
                    && (screen.appearances ?? surface.appearances).allSatisfy(appearanceWords.contains)
            }
            return AppSurface(id: surface.id, kind: surface.kind, label: surface.label, build: surface.build,
                              device: surface.device, paths: surface.paths, appearances: surface.appearances,
                              screens: Array(screens))
        }
        return AppScreensManifest(schema: raw.schema, project: raw.project, surfaces: Array(surfaces))
    }

    static func isSlug(_ value: String) -> Bool {
        value.range(of: #"^[a-z0-9][a-z0-9-]{0,39}$"#, options: .regularExpression) != nil
    }

    static func isPlainName(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$"#, options: .regularExpression) != nil && !value.contains("..")
    }

    public static func isPlainRelativePath(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 300, !value.hasPrefix("/"), !value.hasPrefix("~"),
              value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f })
        else { return false }
        return !value.split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty || $0 == ".." }
    }

    public static func repoCacheDir(projectRoot: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        let hash = SHA256.hash(data: Data(projectRoot.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
        return home.appendingPathComponent(".cache/toolroll/canvas", isDirectory: true).appendingPathComponent(hash, isDirectory: true)
    }

    public static func surfaceCacheDir(projectRoot: String, surface: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        repoCacheDir(projectRoot: projectRoot, home: home)
            .appendingPathComponent("app", isDirectory: true)
            .appendingPathComponent(surface, isDirectory: true)
    }

    public static func mirrorDir(projectRoot: String, surface: String) -> URL {
        URL(fileURLWithPath: projectRoot).appendingPathComponent(mirrorRoot, isDirectory: true).appendingPathComponent(surface, isDirectory: true)
    }

    static func isRealDirectory(_ path: String) -> Bool {
        var st = stat()
        return lstat(path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
    }

    static func readIndex(folder: URL) -> AppCaptureIndex? {
        guard isRealDirectory(folder.path),
              let data = readPlainFile(path: folder.appendingPathComponent("index.json").path, cap: 512 * 1024),
              let index = try? JSONDecoder().decode(AppCaptureIndex.self, from: data),
              index.schema == AppCaptureIndex.schemaName
        else { return nil }
        return index
    }

    public static func latestCaptures(projectRoot: String, surface: String, stateKey: String,
                                      home: URL = FileManager.default.homeDirectoryForCurrentUser) -> AppCaptureSet? {
        let cache = surfaceCacheDir(projectRoot: projectRoot, surface: surface, home: home)
        if isPlainName(stateKey) {
            let current = cache.appendingPathComponent(stateKey, isDirectory: true)
            if let index = readIndex(folder: current), index.surface == surface {
                return AppCaptureSet(index: index, folder: current.path, isStale: index.stateKey != stateKey)
            }
        }
        let folders = (try? FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: nil)) ?? []
        let newest = folders.compactMap { folder -> (URL, AppCaptureIndex)? in
            guard isPlainName(folder.lastPathComponent), let index = readIndex(folder: folder), index.surface == surface else { return nil }
            return (folder, index)
        }.max { $0.1.capturedAt < $1.1.capturedAt }
        guard let (folder, index) = newest else { return nil }
        return AppCaptureSet(index: index, folder: folder.path, isStale: index.stateKey != stateKey)
    }

    public static func layoutAppArtboards(
        surface: AppSurface,
        captures: AppCaptureSet?,
        originX: Double = 60,
        originY: Double,
        pairsPerRow: Int = 3
    ) -> [CanvasArtboard] {
        let w = CanvasViewportPreset.mobile.width
        let h = CanvasViewportPreset.mobile.height
        let gapX: Double = 28
        let pairGap: Double = 52
        let gapY: Double = 64
        var boards: [CanvasArtboard] = []
        for (index, screen) in surface.screens.enumerated() {
            let col = index % max(1, pairsPerRow)
            let row = index / max(1, pairsPerRow)
            let appearances = surface.appearances(for: screen)
            for (slot, appearance) in appearances.enumerated() {
                let pairWidth = Double(appearances.count) * w + Double(max(0, appearances.count - 1)) * gapX
                let x = originX + Double(col) * (max(pairWidth, 2 * w + gapX) + pairGap) + Double(slot) * (w + gapX)
                let y = originY + Double(row) * (h + gapY)
                let route = appRoute(surface: surface.id, screen: screen.id)
                var board = CanvasArtboard(
                    id: "\(route)#\(appearance)",
                    route: route,
                    path: route,
                    sourceFile: screen.view,
                    x: x, y: y, width: w, height: h
                )
                board.surface = surface.id
                board.appearance = appearance
                board.title = screen.title
                if let path = captures?.imagePath(screen: screen.id, appearance: appearance) {
                    board.latestImagePath = path
                    board.baselineImagePath = path
                    board.cachedStateKey = captures?.index.stateKey
                }
                boards.append(board)
            }
        }
        return boards
    }

    public static func appRoute(surface: String, screen: String) -> String {
        "app:\(surface)/\(screen)"
    }

    public static func placeWords(surface: AppSurface?, appearance: String?) -> String {
        let device = surface?.deviceWord ?? "App"
        guard let appearance, !appearance.isEmpty else { return device }
        return "\(device) · \(appearance)"
    }

    public static func pathspecs(including: [String]) -> [String] {
        including.filter(isPlainRelativePath)
    }

    public static func pathspecs(excluding: [String]) -> [String] {
        ["."] + excluding.filter(isPlainRelativePath).map { ":(exclude)\($0)" }
    }

    public static func surfaceStateKey(projectRoot: String, pathspecs specs: [String], limit: Int = 20_000) -> String {
        guard HardenedGit.refusal(in: projectRoot) == nil, !specs.isEmpty else { return "unread" }
        guard let staged = HardenedGit.run(["ls-files", "-s", "-z", "--"] + specs, in: projectRoot, timeout: 10), staged.status == 0 else {
            return "nogit"
        }
        let changedOut = HardenedGit.run(["ls-files", "-z", "-m", "-o", "--exclude-standard", "--"] + specs, in: projectRoot, timeout: 10)
        let changed = changedOut.flatMap { $0.status == 0 ? $0.stdout : nil } ?? Data()
        return stateKey(projectRoot: projectRoot, staged: staged.stdout, changed: changed, limit: limit)
    }

    static func stateKey(projectRoot: String, staged: Data, changed: Data, limit: Int) -> String {
        var hasher = SHA256()
        hasher.update(data: staged)
        hasher.update(data: Data("\n--\n".utf8))
        let names = Array(Set(changed.split(separator: 0).map { Data($0) }))
            .sorted { $0.lexicographicallyPrecedes($1) }
            .prefix(limit)
        var present: [String] = []
        for name in names {
            let rel = String(decoding: name, as: UTF8.self)
            var st = stat()
            if lstat(projectRoot + "/" + rel, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG { present.append(rel) }
        }
        var hashes: [String: String] = [:]
        for chunk in stride(from: 0, to: present.count, by: 400).map({ Array(present[$0..<min($0 + 400, present.count)]) }) {
            guard let out = HardenedGit.run(["hash-object", "--no-filters", "--"] + chunk, in: projectRoot, timeout: 10), out.status == 0 else { continue }
            let lines = String(decoding: out.stdout, as: UTF8.self).split(separator: "\n").map(String.init)
            for (rel, hash) in zip(chunk, lines) { hashes[rel] = hash }
        }
        for name in names {
            let rel = String(decoding: name, as: UTF8.self)
            hasher.update(data: name)
            hasher.update(data: Data("\u{0}\(hashes[rel] ?? "missing")\n".utf8))
        }
        let hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return "s-" + hex.prefix(12)
    }
}

public enum CanvasCaptureTrust {
    static let keyPrefix = "toolroll.canvasCaptureTrusted|"

    public static func key(projectRoot: String) -> String {
        keyPrefix + URL(fileURLWithPath: projectRoot).resolvingSymlinksInPath().standardizedFileURL.path
    }

    public static func isTrusted(projectRoot: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: key(projectRoot: projectRoot))
    }

    public static func trust(projectRoot: String, defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: key(projectRoot: projectRoot))
    }

    public static func question(projectName: String) -> String {
        "Recapture builds and runs \(projectName) in the Simulator. Only do this for projects you trust."
    }
}

public enum CanvasProjectRoot {
    public static func resolve(
        projectName: String,
        recorded: [ProjectRef],
        home: String = FileManager.default.homeDirectoryForCurrentUser.path,
        isDirectory: (String) -> Bool = { path in
            var dir: ObjCBool = false
            return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
        },
        listDirectory: (String) -> [String] = { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] }
    ) -> String? {
        let name = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !name.contains("/"), name != ".", name != ".." else {
            return recorded.first(where: { $0.path == projectName && isDirectory($0.path) })?.path
        }
        let byName = recorded.filter { $0.name == name } + recorded.filter { $0.name != name && $0.name.lowercased() == name.lowercased() }
        if let hit = byName.first(where: { $0.path.hasPrefix("/") && isDirectory($0.path) }) { return hit.path }
        if let hit = recorded.first(where: { ($0.path as NSString).lastPathComponent == name && isDirectory($0.path) }) { return hit.path }

        let parents = ["Developer", "Documents", "Documents/firstmate/projects", "code", "Projects"].map { "\(home)/\($0)" }
        for parent in parents {
            let direct = "\(parent)/\(name)"
            if isDirectory(direct) { return direct }
        }
        for parent in ["\(home)/Developer", "\(home)/Documents"] {
            if let match = listDirectory(parent).first(where: { $0.lowercased() == name.lowercased() }), isDirectory("\(parent)/\(match)") {
                return "\(parent)/\(match)"
            }
        }
        return nil
    }
}

public struct CanvasAppSection: Sendable, Equatable, Identifiable {
    public let surface: AppSurface
    public let stateKey: String
    public let captures: AppCaptureSet?

    public init(surface: AppSurface, stateKey: String, captures: AppCaptureSet?) {
        self.surface = surface
        self.stateKey = stateKey
        self.captures = captures
    }

    public var id: String { surface.id }
    public var title: String { surface.kind == "ios" ? "App · iPhone" : "App · \(surface.label)" }
    public var isStale: Bool { captures?.isStale ?? false }
    public var tileCount: Int { surface.screens.reduce(0) { $0 + surface.appearances(for: $1).count } }
}

public enum AppCaptureRunState: Sendable, Equatable {
    case idle
    case running(progress: String)
    case failed(reason: String, log: String)

    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }
}

public enum AppCaptureLine: Sendable, Equatable {
    case progress(String)
    case error(String)
    case log(String)

    public static func parse(_ raw: String) -> AppCaptureLine {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for (prefix, make) in [("progress:", AppCaptureLine.progress), ("error:", AppCaptureLine.error)] as [(String, (String) -> AppCaptureLine)] {
            if line.hasPrefix(prefix) {
                return make(String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces))
            }
        }
        return .log(line)
    }
}

public final class AppCaptureRunner: @unchecked Sendable {
    public struct Outcome: Sendable, Equatable {
        public let status: Int32
        public let error: String?
        public let tail: [String]
    }

    public init() {}

    public static func environment(inherited: [String: String], home: String) -> [String: String] {
        var env: [String: String] = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": home,
            "LANG": inherited["LANG"] ?? "en_US.UTF-8",
        ]
        for key in ["TMPDIR", "DEVELOPER_DIR", "USER", "LOGNAME"] {
            if let value = inherited[key], !value.isEmpty { env[key] = value }
        }
        return env
    }

    public static func bashArguments(arguments: [String]) -> [String] {
        ["-c", CanvasCaptureScript.source, CanvasCaptureScript.name] + arguments
    }

    public func run(arguments: [String], cwd: String, onLine: @escaping @Sendable (AppCaptureLine) -> Void) async -> Outcome {
        await withCheckedContinuation { continuation in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/bin/bash")
            proc.arguments = Self.bashArguments(arguments: arguments)
            proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
            proc.environment = Self.environment(inherited: ProcessInfo.processInfo.environment,
                                                home: FileManager.default.homeDirectoryForCurrentUser.path)
            proc.standardInput = FileHandle.nullDevice
            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = pipe
            let collector = LineCollector(onLine: onLine)
            pipe.fileHandleForReading.readabilityHandler = { handle in collector.feed(handle.availableData) }
            proc.terminationHandler = { finished in
                pipe.fileHandleForReading.readabilityHandler = nil
                collector.feed(pipe.fileHandleForReading.readDataToEndOfFile())
                collector.flush()
                continuation.resume(returning: Outcome(status: finished.terminationStatus, error: collector.lastError, tail: collector.tail))
            }
            do { try proc.run() } catch {
                pipe.fileHandleForReading.readabilityHandler = nil
                continuation.resume(returning: Outcome(status: -1, error: "The capture script couldn't start: \(error.localizedDescription)", tail: []))
            }
        }
    }
}

private final class LineCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()
    private var lines: [String] = []
    private(set) var lastError: String?
    private let onLine: @Sendable (AppCaptureLine) -> Void

    init(onLine: @escaping @Sendable (AppCaptureLine) -> Void) { self.onLine = onLine }

    var tail: [String] {
        lock.lock(); defer { lock.unlock() }
        return lines
    }

    func feed(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock()
        pending.append(chunk)
        var complete: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            complete.append(String(decoding: pending[pending.startIndex..<newline], as: UTF8.self))
            pending.removeSubrange(pending.startIndex...newline)
        }
        lock.unlock()
        complete.forEach(emit)
    }

    func flush() {
        lock.lock()
        let rest = pending.isEmpty ? nil : String(decoding: pending, as: UTF8.self)
        pending.removeAll()
        lock.unlock()
        if let rest { emit(rest) }
    }

    private func emit(_ raw: String) {
        let parsed = AppCaptureLine.parse(raw)
        lock.lock()
        lines.append(String(raw.prefix(400)))
        if lines.count > 40 { lines.removeFirst(lines.count - 40) }
        if case .error(let reason) = parsed { lastError = reason }
        lock.unlock()
        onLine(parsed)
    }
}

public enum CanvasPinTaskText {
    public static func screenLabel(_ pin: CanvasPin) -> String {
        pin.isAppPin ? pin.artboardPath : pin.artboardRoute
    }

    static func screenName(_ pin: CanvasPin, surfaces: [AppSurface]) -> String {
        guard pin.isAppPin else { return pin.artboardRoute }
        let surface = surfaces.first(where: { $0.id == pin.surface })
        return "\(surface?.deviceWord ?? "App") · \(pin.artboardRoute)"
    }

    public static func title(label: String, batch: [CanvasPin], surfaces: [AppSurface]) -> String {
        if batch.count == 1, let only = batch.first {
            let prefix = only.kind == .options ? "[UI Options A/B/C/D] " : "[UI] "
            return String("\(prefix)\(screenName(only, surfaces: surfaces)): \(only.body)".prefix(118))
        }
        let screens = Set(batch.map(screenLabel))
        let named = screens.count == 1 ? screenName(batch[0], surfaces: surfaces) : label
        return String("[UI] \(named) (\(batch.count) changes)".prefix(118))
    }

    public static func body(batch: [CanvasPin], surfaces: [AppSurface]) -> String {
        batch.enumerated().map { idx, p -> String in
            var meta: String
            if p.isAppPin {
                let surface = surfaces.first(where: { $0.id == p.surface })
                meta = AppSurfaceStorage.placeWords(surface: surface, appearance: p.appearance)
                meta += " · screen `\(p.artboardRoute)` (`\(p.artboardPath)`) at (\(Int(p.xFrac * 100))%, \(Int(p.yFrac * 100))%)"
                if let device = p.device { meta += " · captured on \(device)" }
            } else {
                meta = "route `\(p.artboardPath)` at (\(Int(p.xFrac * 100))%, \(Int(p.yFrac * 100))%)"
            }
            if let el = p.elementName { meta += " · element `\(el)`" }
            if let f = p.elementFile {
                meta += p.elementLine.map { " · `\(f):\($0)`" } ?? " · `\(f)`"
            }
            if let shot = p.screenshotPath {
                meta += p.isAppPin ? " · screenshot `\(shot)`" : " · element screenshot `\(shot)`"
            }
            let kindTag = p.kind == .options ? "[Options A/B/C/D] " : ""
            return "\(idx + 1). \(kindTag)\(p.body) (\(meta))"
        }.joined(separator: "\n")
    }
}
