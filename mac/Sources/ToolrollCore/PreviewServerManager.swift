import Foundation
import Observation

public enum PreviewServerStatus: Sendable, Equatable {
    case asleep
    case needsInstall(packageManager: String, command: String)
    case installing(command: String)
    case needsStart(command: String, folder: String)
    case external(url: String)
    case starting(command: String)
    case running(url: String, command: String)
    case failed(String)
}

public struct DetectedDevCommand: Sendable, Hashable {
    public let packageManager: String
    public let executable: String
    public let arguments: [String]
    public let displayCommand: String
    public let scriptBody: String
    public let expectedPort: Int
    public let expectedURL: String

    public init(packageManager: String = "npm", executable: String, arguments: [String], displayCommand: String, scriptBody: String = "", expectedPort: Int) {
        self.packageManager = packageManager
        self.executable = executable
        self.arguments = arguments
        self.displayCommand = displayCommand
        self.scriptBody = scriptBody
        self.expectedPort = expectedPort
        self.expectedURL = "http://localhost:\(expectedPort)"
    }

    public var startWords: String {
        scriptBody.isEmpty ? displayCommand : "\(displayCommand) (\(scriptBody))"
    }
}

@MainActor
@Observable
public final class PreviewServerManager {
    public private(set) var status: PreviewServerStatus = .asleep
    public private(set) var activeProjectRoot: String?
    public private(set) var managedByToolroll: Bool = false

    private var process: Process?
    private var idleSleepTask: Task<Void, Never>?
    private var startConsent: StartConsent?
    private var startEpoch = 0
    public private(set) var pendingStart: (projectRoot: String, command: DetectedDevCommand)?

    private struct StartConsent: Hashable {
        let projectRoot: String
        let command: DetectedDevCommand
    }
    private let idleTimeoutSeconds: UInt64 = 300

    public init() {}

    public var activeURL: String? {
        switch status {
        case .external(let url), .running(let url, _): return url
        default: return nil
        }
    }

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
            packageManager: pm,
            executable: exe,
            arguments: args,
            displayCommand: "\(pm) \(scriptName)",
            scriptBody: scriptBody,
            expectedPort: port
        )
    }

    public func touchActivity() {
        guard managedByToolroll else { return }
        scheduleIdleSleep()
    }

    public func ensureRunning(projectRoot: String, preferredOrigin: String? = nil) async -> String? {
        let consent = startConsent
        startConsent = nil
        startEpoch &+= 1
        let epoch = startEpoch
        if activeProjectRoot == projectRoot, let url = activeURL {
            touchActivity()
            return url
        }

        if let preferred = preferredOrigin, await isReachable(urlString: preferred) {
            guard epoch == startEpoch else { return nil }
            stopServerProcess()
            activeProjectRoot = projectRoot
            managedByToolroll = false
            status = .external(url: preferred)
            return preferred
        }

        let detectedCommand = await Task.detached(priority: .userInitiated) { Self.detectDevCommand(projectRoot: projectRoot) }.value
        guard epoch == startEpoch else { return nil }
        guard let detected = detectedCommand else {
            stopServerProcess()
            activeProjectRoot = projectRoot
            status = .asleep
            return nil
        }

        if await isReachable(urlString: detected.expectedURL) {
            let port = detected.expectedPort
            let listener = await Task.detached(priority: .userInitiated) { Self.listenerDirectory(port: port) }.value
            guard epoch == startEpoch else { return nil }
            if let owner = listener, !Self.isInside(owner, root: projectRoot) {
                stopServerProcess()
                activeProjectRoot = projectRoot
                status = .failed("Port \(detected.expectedPort) is in use by another project (\((owner as NSString).lastPathComponent)). Stop it, or start this project's dev server on another port.")
                return nil
            }
            stopServerProcess()
            activeProjectRoot = projectRoot
            managedByToolroll = false
            status = .external(url: detected.expectedURL)
            return detected.expectedURL
        }

        guard epoch == startEpoch else { return nil }
        stopServerProcess()
        activeProjectRoot = projectRoot

        let nodeModulesPath = "\(projectRoot)/node_modules"
        if !FileManager.default.fileExists(atPath: nodeModulesPath) {
            status = .needsInstall(packageManager: detected.packageManager, command: "\(detected.packageManager) install")
            return nil
        }

        guard consent == StartConsent(projectRoot: projectRoot, command: detected) else {
            pendingStart = (projectRoot, detected)
            status = .needsStart(command: detected.startWords, folder: projectRoot)
            return nil
        }
        pendingStart = nil
        status = .starting(command: detected.displayCommand)

        do {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: detected.executable)
            proc.arguments = detected.arguments
            proc.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
            proc.environment = Self.buildSubprocessEnvironment()
            let errPipe = Pipe()
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = errPipe
            try proc.run()
            self.process = proc
            self.managedByToolroll = true

            for _ in 0..<36 {
                if !proc.isRunning {
                    let errData = errPipe.fileHandleForReading.availableData
                    let errLine = Self.extractLastMeaningfulLine(from: errData)
                    status = .failed(errLine ?? "\(detected.displayCommand) exited early.")
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
            stopServerProcess()
            return nil
        } catch {
            status = .failed("Could not start \(detected.displayCommand): \(error.localizedDescription)")
            return nil
        }
    }

    @discardableResult
    public func consentToPendingStart() -> Bool {
        guard let pending = pendingStart else { return false }
        startConsent = StartConsent(projectRoot: pending.projectRoot, command: pending.command)
        return true
    }

    public func installDependenciesAndRun(projectRoot: String, preferredOrigin: String? = nil) async -> String? {
        let detectedCommand = await Task.detached(priority: .userInitiated) { Self.detectDevCommand(projectRoot: projectRoot) }.value
        guard let detected = detectedCommand else {
            return await ensureRunning(projectRoot: projectRoot, preferredOrigin: preferredOrigin)
        }
        stopManagedServer()
        activeProjectRoot = projectRoot
        let pm = detected.packageManager
        let installCmd = "\(pm) install"
        status = .installing(command: installCmd)

        let exe = Self.resolveExecutable(pm) ?? "/usr/bin/env"
        let args = exe == "/usr/bin/env" ? [pm, "install"] : ["install"]
        let env = Self.buildSubprocessEnvironment()

        let exitInfo: (code: Int32, errorLine: String?) = await Task.detached(priority: .userInitiated) {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: exe)
            proc.arguments = args
            proc.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
            proc.environment = env
            let errPipe = Pipe()
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = errPipe
            do {
                try proc.run()
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                proc.waitUntilExit()
                return (proc.terminationStatus, Self.extractLastMeaningfulLine(from: errData))
            } catch {
                return (-1, error.localizedDescription)
            }
        }.value

        guard exitInfo.code == 0 else {
            status = .failed(exitInfo.errorLine ?? "\(installCmd) failed (exit \(exitInfo.code)).")
            return nil
        }
        return await ensureRunning(projectRoot: projectRoot, preferredOrigin: preferredOrigin)
    }

    nonisolated private static func buildSubprocessEnvironment() -> [String: String] {
        minimalEnvironment(inherited: ProcessInfo.processInfo.environment, home: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    nonisolated static func minimalEnvironment(inherited: [String: String], home: String) -> [String: String] {
        let extraPaths = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.bun/bin",
            "\(home)/.volta/bin",
            "\(home)/.local/share/pnpm",
            "\(home)/.local/bin",
        ].joined(separator: ":")
        return [
            "PATH": "\(extraPaths):\(inherited["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")",
            "HOME": home,
            "LANG": inherited["LANG"] ?? "en_US.UTF-8",
            "TERM": inherited["TERM"] ?? "dumb",
            "BROWSER": "none",
        ]
    }

    nonisolated private static func extractLastMeaningfulLine(from data: Data) -> String? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let lines = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !$0.hasPrefix("ELIFECYCLE") }
        guard let last = lines.last else { return nil }
        return String(last.prefix(96))
    }

    public func stopManagedServer() {
        startEpoch &+= 1
        stopServerProcess()
    }

    private func stopServerProcess() {
        startConsent = nil
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

    nonisolated static func listenerDirectory(port: Int) -> String? {
        guard let pid = run("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"])?
            .split(separator: "\n").first.map(String.init) else { return nil }
        let out = run("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]) ?? ""
        return out.split(separator: "\n").first(where: { $0.hasPrefix("n") }).map { String($0.dropFirst()) }
    }

    nonisolated static func isInside(_ path: String, root: String) -> Bool {
        let resolve = { (p: String) in URL(fileURLWithPath: p).resolvingSymlinksInPath().standardizedFileURL.path }
        let child = resolve(path), parent = resolve(root)
        return child == parent || child.hasPrefix(parent.hasSuffix("/") ? parent : parent + "/")
    }

    nonisolated private static func run(_ tool: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private func isReachable(urlString: String) async -> Bool {
        guard let url = URL(string: urlString) else { return false }
        var req = URLRequest(url: url, timeoutInterval: 1.5)
        req.httpMethod = "HEAD"
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse) != nil
        } catch {
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
