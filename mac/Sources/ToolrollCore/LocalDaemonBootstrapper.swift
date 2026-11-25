import Foundation

public enum LocalDaemonLaunchPlan: Equatable, Sendable {
    case bundledScript(nodePath: String, cliPath: String)
    case cliBinary(path: String)
    case npxFallback(npxPath: String)
    case missingRuntime(installCommand: String)

    public var supportsSilentAutoStart: Bool {
        switch self {
        case .bundledScript, .cliBinary:
            return true
        case .npxFallback, .missingRuntime:
            return false
        }
    }
}

public struct LocalDaemonBootstrapResult: @unchecked Sendable {
    public let connected: Bool
    public let credentials: LocalSessionCredentials?
    public let process: Process?
    public let message: String
    public let installCommand: String?
    public let logPath: String?

    public init(
        connected: Bool,
        credentials: LocalSessionCredentials?,
        process: Process?,
        message: String,
        installCommand: String? = nil,
        logPath: String? = nil
    ) {
        self.connected = connected
        self.credentials = credentials
        self.process = process
        self.message = message
        self.installCommand = installCommand
        self.logPath = logPath
    }
}

public enum LocalDaemonBootstrapper {
    public static let recommendedInstallCommand = "brew install --cask ap9000/toolroll/toolroll"
    public static let cliInstallCommand = "curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh"

    public static func enrichedPATH(
        base: String? = ProcessInfo.processInfo.environment["PATH"],
        home: String = FileManager.default.homeDirectoryForCurrentUser.path,
        fileManager: FileManager = .default
    ) -> String {
        var dirs: [String] = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "\(home)/.local/bin",
            "\(home)/.npm-global/bin",
            "\(home)/Library/pnpm",
            "\(home)/.volta/bin",
            "\(home)/.bun/bin",
            "\(home)/.asdf/shims",
            "\(home)/.local/share/mise/shims",
        ]

        dirs.append(contentsOf: versionedNodeBins(
            root: "\(home)/.nvm/versions/node",
            suffix: "bin",
            fileManager: fileManager
        ))
        dirs.append(contentsOf: versionedNodeBins(
            root: "\(home)/Library/Application Support/fnm/node-versions",
            suffix: "installation/bin",
            fileManager: fileManager
        ))

        if let base, !base.isEmpty {
            dirs.append(contentsOf: base.split(separator: ":").map(String.init))
        }

        dirs.append(contentsOf: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])

        var seen = Set<String>()
        var unique: [String] = []
        for dir in dirs where !dir.isEmpty {
            if seen.insert(dir).inserted {
                unique.append(dir)
            }
        }
        return unique.joined(separator: ":")
    }

    private static func versionedNodeBins(
        root: String,
        suffix: String,
        fileManager: FileManager
    ) -> [String] {
        guard let entries = try? fileManager.contentsOfDirectory(atPath: root) else { return [] }
        let sorted = entries.sorted { lhs, rhs in
            compareSemver(lhs, rhs) == .orderedDescending
        }
        return sorted.map { "\(root)/\($0)/\(suffix)" }
    }

    static func compareSemver(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let lParts = lhs.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            .split(separator: ".")
            .map { Int($0) ?? 0 }
        let rParts = rhs.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            .split(separator: ".")
            .map { Int($0) ?? 0 }
        let count = max(lParts.count, rParts.count)
        for index in 0..<count {
            let lv = index < lParts.count ? lParts[index] : 0
            let rv = index < rParts.count ? rParts[index] : 0
            if lv != rv {
                return lv < rv ? .orderedAscending : .orderedDescending
            }
        }
        return lhs.compare(rhs)
    }

    public static func findExecutable(
        named binary: String,
        searchPath: String,
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> String? {
        for dir in searchPath.split(separator: ":").map(String.init) where !dir.isEmpty {
            let full = (dir as NSString).appendingPathComponent(binary)
            if isExecutable(full) {
                return full
            }
        }
        return nil
    }

    public static func locateToolrollBinary(
        home: String = FileManager.default.homeDirectoryForCurrentUser.path,
        env: [String: String] = ProcessInfo.processInfo.environment,
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> String? {
        let searchPath = enrichedPATH(base: env["PATH"], home: home)
        return findExecutable(named: "toolroll", searchPath: searchPath, isExecutable: isExecutable)
    }

    public static func resolvePlan(
        home: String = FileManager.default.homeDirectoryForCurrentUser.path,
        bundleResourcePath: String? = Bundle.main.resourcePath,
        env: [String: String] = ProcessInfo.processInfo.environment,
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> LocalDaemonLaunchPlan {
        let searchPath = enrichedPATH(base: env["PATH"], home: home)

        if let resourceRoot = bundleResourcePath, !resourceRoot.isEmpty {
            let bundledCli = (resourceRoot as NSString).appendingPathComponent("daemon/dist/bin.js")
            if fileExists(bundledCli) {
                let bundledNode = (resourceRoot as NSString).appendingPathComponent("daemon/node")
                if isExecutable(bundledNode) {
                    return .bundledScript(nodePath: bundledNode, cliPath: bundledCli)
                }
                if let systemNode = findExecutable(named: "node", searchPath: searchPath, isExecutable: isExecutable) {
                    return .bundledScript(nodePath: systemNode, cliPath: bundledCli)
                }
            }
        }

        if let bin = findExecutable(named: "toolroll", searchPath: searchPath, isExecutable: isExecutable) {
            return .cliBinary(path: bin)
        }

        if let npx = findExecutable(named: "npx", searchPath: searchPath, isExecutable: isExecutable),
           findExecutable(named: "node", searchPath: searchPath, isExecutable: isExecutable) != nil
        {
            return .npxFallback(npxPath: npx)
        }

        return .missingRuntime(installCommand: recommendedInstallCommand)
    }

    public static func canAutoStart(
        home: String = FileManager.default.homeDirectoryForCurrentUser.path,
        bundleResourcePath: String? = Bundle.main.resourcePath
    ) -> Bool {
        resolvePlan(home: home, bundleResourcePath: bundleResourcePath).supportsSilentAutoStart
    }

    public static func defaultDatabasePath(
        home: String = FileManager.default.homeDirectoryForCurrentUser.path,
        env: [String: String] = ProcessInfo.processInfo.environment,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> String {
        if let envDb = env["TOOLROLL_DB"], !envDb.isEmpty {
            return envDb
        }
        let xdg = env["XDG_CONFIG_HOME"]
        let configRoot = (xdg != nil && !(xdg ?? "").isEmpty) ? xdg! : "\(home)/.config"
        let candidates = [
            "\(configRoot)/nightorders/orders.db",
            "\(configRoot)/toolroll/orders.db",
            "\(configRoot)/standing-orders/orders.db",
        ]
        if let existing = candidates.first(where: fileExists) {
            return existing
        }
        return "\(configRoot)/nightorders/orders.db"
    }

    public static func daemonLogURL(
        home: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) -> URL {
        URL(fileURLWithPath: home)
            .appendingPathComponent("Library/Logs/Toolroll", isDirectory: true)
            .appendingPathComponent("daemon.log")
    }

    public static func launchSpec(
        for plan: LocalDaemonLaunchPlan,
        databasePath: String,
        existingDatabase: Bool
    ) -> (executable: String, arguments: [String])? {
        var upArgs = ["up", "--laptop", "--no-open"]
        if existingDatabase {
            upArgs.append(contentsOf: ["--db", databasePath, "--port", "4180"])
        }
        switch plan {
        case .bundledScript(let nodePath, let cliPath):
            return (nodePath, [cliPath] + upArgs)
        case .cliBinary(let path):
            return (path, upArgs)
        case .npxFallback(let npxPath):
            return (npxPath, ["--yes", "toolroll"] + upArgs)
        case .missingRuntime:
            return nil
        }
    }

    public static func startAndConnect(
        allowNpxFallback: Bool = false,
        timeoutSeconds: Double = 10.0,
        session: URLSession = .shared
    ) async -> LocalDaemonBootstrapResult {
        if let existing = await LocalConsoleConnector.discoverAndConnect(session: session) {
            return LocalDaemonBootstrapResult(
                connected: true,
                credentials: existing,
                process: nil,
                message: "Connected to Local Toolroll at \(existing.origin)."
            )
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let env = ProcessInfo.processInfo.environment
        let plan = resolvePlan(home: home, bundleResourcePath: Bundle.main.resourcePath, env: env)

        if case .missingRuntime(let installCmd) = plan {
            return LocalDaemonBootstrapResult(
                connected: false,
                credentials: nil,
                process: nil,
                message: "Install the Toolroll CLI once to run locally on this Mac.",
                installCommand: installCmd
            )
        }

        if case .npxFallback = plan, !allowNpxFallback {
            return LocalDaemonBootstrapResult(
                connected: false,
                credentials: nil,
                process: nil,
                message: "Toolroll CLI isn't installed yet. Click Start Local Engine or install with Homebrew.",
                installCommand: recommendedInstallCommand
            )
        }

        let dbPath = defaultDatabasePath(home: home, env: env)
        let dbExists = FileManager.default.fileExists(atPath: dbPath)
        guard let spec = launchSpec(for: plan, databasePath: dbPath, existingDatabase: dbExists) else {
            return LocalDaemonBootstrapResult(
                connected: false,
                credentials: nil,
                process: nil,
                message: "Install the Toolroll CLI once to run locally on this Mac.",
                installCommand: recommendedInstallCommand
            )
        }

        let logURL = daemonLogURL(home: home)
        let logHandle = openLogHandle(at: logURL)
        defer { try? logHandle?.close() }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: spec.executable)
        proc.arguments = spec.arguments
        var procEnv = env
        procEnv["PATH"] = enrichedPATH(base: env["PATH"], home: home)
        proc.environment = procEnv
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = logHandle ?? FileHandle.nullDevice
        proc.standardError = logHandle ?? FileHandle.nullDevice

        do {
            try proc.run()
        } catch {
            return LocalDaemonBootstrapResult(
                connected: false,
                credentials: nil,
                process: nil,
                message: "Could not start local engine: \(error.localizedDescription)",
                logPath: logURL.path
            )
        }

        let deadline = Date().addingTimeInterval(max(2.0, timeoutSeconds))
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 350_000_000)
            if let creds = await LocalConsoleConnector.discoverAndConnect(session: session) {
                return LocalDaemonBootstrapResult(
                    connected: true,
                    credentials: creds,
                    process: proc,
                    message: "Connected to Local Toolroll at \(creds.origin).",
                    logPath: logURL.path
                )
            }
            if !proc.isRunning {
                let tail = readLogTail(at: logURL)
                let suffix = tail.isEmpty ? "exit \(proc.terminationStatus)" : tail
                return LocalDaemonBootstrapResult(
                    connected: false,
                    credentials: nil,
                    process: nil,
                    message: "Local engine stopped during startup: \(suffix)",
                    logPath: logURL.path
                )
            }
        }

        return LocalDaemonBootstrapResult(
            connected: false,
            credentials: nil,
            process: proc,
            message: "Local engine is still starting… click Rescan in a moment.",
            logPath: logURL.path
        )
    }

    private static func openLogHandle(at url: URL) -> FileHandle? {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return nil }
        _ = try? handle.seekToEnd()
        return handle
    }

    private static func readLogTail(at url: URL) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        let lines = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return lines.suffix(2).joined(separator: " — ")
    }
}
