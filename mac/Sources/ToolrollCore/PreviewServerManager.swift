import Foundation
import Observation

public enum PreviewServerStatus: Sendable, Equatable {
    case asleep
    case external(url: String)
    case starting(command: String)
    case running(url: String, command: String)
    case failed(String)
}

public struct DetectedDevCommand: Sendable, Equatable {
    public let executable: String
    public let arguments: [String]
    public let displayCommand: String
    public let expectedPort: Int
    public let expectedURL: String

    public init(executable: String, arguments: [String], displayCommand: String, expectedPort: Int) {
        self.executable = executable
        self.arguments = arguments
        self.displayCommand = displayCommand
        self.expectedPort = expectedPort
        self.expectedURL = "http://127.0.0.1:\(expectedPort)"
    }
}

/// Manages at most ONE local dev/preview server at a time for Toolroll Canvas:
/// - Auto-detects package manager (`pnpm`, `bun`, `yarn`, `npm`) and dev port from `package.json`.
/// - Reuses an already-running external dev server on that port (and never kills external servers).
/// - Lazy-wakes on demand and auto-sleeps after 5 minutes of Canvas inactivity (0 MB idle RAM).
@MainActor
@Observable
public final class PreviewServerManager {
    public private(set) var status: PreviewServerStatus = .asleep
    public private(set) var activeProjectRoot: String?
    public private(set) var managedByToolroll: Bool = false

    private var process: Process?
    private var idleSleepTask: Task<Void, Never>?
    private let idleTimeoutSeconds: UInt64 = 300 // 5 minutes

    public init() {}

    public var activeURL: String? {
        switch status {
        case .external(let url), .running(let url, _): return url
        default: return nil
        }
    }

    /// Detects the project's dev script, package manager, and expected port from `package.json`.
    nonisolated public static func detectDevCommand(projectRoot: String) -> DetectedDevCommand? {
        let pkgURL = URL(fileURLWithPath: projectRoot).appendingPathComponent("package.json")
        guard let data = try? Data(contentsOf: pkgURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let scripts = obj["scripts"] as? [String: String]
        else { return nil }

        let scriptName: String
        let scriptBody: String
        if let dev = scripts["dev"], !dev.isEmpty {
            scriptName = "dev"
            scriptBody = dev
        } else if let start = scripts["preview"], !start.isEmpty {
            scriptName = "preview"
            scriptBody = start
        } else {
            return nil
        }

        // Parse explicit `--port NNNN` or `-p NNNN` from script body, else framework default
        let port = parsePort(from: scriptBody) ?? defaultPort(for: scriptBody)
        let fm = FileManager.default
        let pm: String
        if fm.fileExists(atPath: "\(projectRoot)/pnpm-lock.yaml") { pm = "pnpm" }
        else if fm.fileExists(atPath: "\(projectRoot)/bun.lock") || fm.fileExists(atPath: "\(projectRoot)/bun.lockb") { pm = "bun" }
        else if fm.fileExists(atPath: "\(projectRoot)/yarn.lock") { pm = "yarn" }
        else { pm = "npm" }

        let exe = resolveExecutable(pm) ?? "/usr/bin/env"
        let args: [String]
        if exe == "/usr/bin/env" {
            args = pm == "npm" ? [pm, "run", scriptName] : [pm, scriptName]
        } else {
            args = pm == "npm" ? ["run", scriptName] : [scriptName]
        }
        return DetectedDevCommand(
            executable: exe,
            arguments: args,
            displayCommand: "\(pm) \(scriptName)",
            expectedPort: port
        )
    }

    public func touchActivity() {
        guard managedByToolroll else { return }
        scheduleIdleSleep()
    }

    /// Ensures a preview server is reachable for `projectRoot`, respecting the 1-server cap.
    public func ensureRunning(projectRoot: String, preferredOrigin: String? = nil) async -> String? {
        // Already running for this exact project
        if activeProjectRoot == projectRoot, let url = activeURL {
            touchActivity()
            return url
        }

        // If an explicit live server (e.g. Toolroll's own local console) is already serving this project
        if let preferred = preferredOrigin, await isReachable(urlString: preferred) {
            stopManagedServer()
            activeProjectRoot = projectRoot
            managedByToolroll = false
            status = .external(url: preferred)
            return preferred
        }

        guard let detected = Self.detectDevCommand(projectRoot: projectRoot) else {
            stopManagedServer()
            activeProjectRoot = projectRoot
            status = .asleep
            return nil
        }

        // Reuse already-running external dev server on the expected port!
        if await isReachable(urlString: detected.expectedURL) {
            stopManagedServer()
            activeProjectRoot = projectRoot
            managedByToolroll = false
            status = .external(url: detected.expectedURL)
            return detected.expectedURL
        }

        // Hard cap: stop any previously managed server before spawning a new one
        stopManagedServer()
        activeProjectRoot = projectRoot
        status = .starting(command: detected.displayCommand)

        do {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: detected.executable)
            proc.arguments = detected.arguments
            proc.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
            var env = ProcessInfo.processInfo.environment
            let extraPaths = "/opt/homebrew/bin:/usr/local/bin:\(FileManager.default.homeDirectoryForCurrentUser.path)/.local/bin"
            env["PATH"] = "\(extraPaths):\(env["PATH"] ?? "/usr/bin:/bin")"
            env["BROWSER"] = "none"
            proc.environment = env
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            try proc.run()
            self.process = proc
            self.managedByToolroll = true

            // Poll up to 15s for dev server to listen
            for _ in 0..<30 {
                if !proc.isRunning {
                    status = .failed("\(detected.displayCommand) exited early.")
                    managedByToolroll = false
                    self.process = nil
                    return nil
                }
                if await isReachable(urlString: detected.expectedURL) {
                    status = .running(url: detected.expectedURL, command: detected.displayCommand)
                    scheduleIdleSleep()
                    return detected.expectedURL
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            status = .failed("Timed out waiting for \(detected.displayCommand) on :\(detected.expectedPort).")
            stopManagedServer()
            return nil
        } catch {
            status = .failed("Could not start \(detected.displayCommand): \(error.localizedDescription)")
            return nil
        }
    }

    public func stopManagedServer() {
        idleSleepTask?.cancel()
        idleSleepTask = nil
        if let proc = process {
            if proc.isRunning {
                proc.terminate()
            }
            process = nil
        }
        managedByToolroll = false
        if case .running = status { status = .asleep }
        if case .starting = status { status = .asleep }
    }

    private func scheduleIdleSleep() {
        idleSleepTask?.cancel()
        let timeout = idleTimeoutSeconds
        idleSleepTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: timeout * 1_000_000_000)
            if Task.isCancelled { return }
            self?.stopManagedServer()
        }
    }

    private func isReachable(urlString: String) async -> Bool {
        guard let url = URL(string: urlString) else { return false }
        var req = URLRequest(url: url, timeoutInterval: 1.5)
        req.httpMethod = "HEAD"
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse) != nil
        } catch {
            // Fallback GET in case dev server doesn't answer HEAD
            var getReq = URLRequest(url: url, timeoutInterval: 1.5)
            getReq.httpMethod = "GET"
            return (try? await URLSession.shared.data(for: getReq)) != nil
        }
    }

    nonisolated private static func parsePort(from script: String) -> Int? {
        let patterns = [
            #"--port[=\s]+(\d{2,5})"#,
            #"-p\s+(\d{2,5})"#,
            #"PORT=(\d{2,5})"#,
        ]
        for pat in patterns {
            if let regex = try? NSRegularExpression(pattern: pat),
               let match = regex.firstMatch(in: script, range: NSRange(script.startIndex..., in: script)),
               let range = Range(match.range(at: 1), in: script),
               let port = Int(script[range]),
               (1024...65535).contains(port) {
                return port
            }
        }
        return nil
    }

    nonisolated private static func defaultPort(for script: String) -> Int {
        let lower = script.lowercased()
        if lower.contains("astro") { return 4321 }
        if lower.contains("vite") { return 5173 }
        return 3000
    }

    nonisolated private static func resolveExecutable(_ name: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let dirs = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.local/bin",
            "\(home)/.volta/bin",
            "\(home)/.bun/bin",
        ]
        for d in dirs {
            let full = "\(d)/\(name)"
            if FileManager.default.isExecutableFile(atPath: full) { return full }
        }
        return nil
    }
}
