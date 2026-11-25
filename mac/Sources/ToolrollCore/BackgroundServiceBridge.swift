import Foundation

public struct BackgroundServiceStatus: Equatable, Sendable {
    public let enabled: Bool
    public let loaded: Bool
    public let runningURL: String?
    public let detail: String

    public init(enabled: Bool, loaded: Bool, runningURL: String?, detail: String) {
        self.enabled = enabled
        self.loaded = loaded
        self.runningURL = runningURL
        self.detail = detail
    }
}

public enum BackgroundServiceBridge {
    private struct ShowPayload: Decodable {
        struct Running: Decodable {
            let url: String?
        }
        let ok: Bool?
        let background: String?
        let installed: String?
        let loaded: Bool?
        let running: Running?
        let message: String?
    }

    private struct ActionPayload: Decodable {
        let ok: Bool?
        let action: String?
        let url: String?
        let message: String?
    }

    public static func locateToolrollBinary() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/opt/homebrew/bin/toolroll",
            "/usr/local/bin/toolroll",
            "\(home)/.local/bin/toolroll",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return nil
    }

    public static func fetchStatus(databasePath: String?) async -> BackgroundServiceStatus {
        guard let bin = locateToolrollBinary() else {
            return BackgroundServiceStatus(
                enabled: false,
                loaded: false,
                runningURL: nil,
                detail: "toolroll CLI not found in /opt/homebrew/bin or /usr/local/bin."
            )
        }
        var args = ["background", "show", "--json"]
        if let databasePath, !databasePath.isEmpty {
            args.append(contentsOf: ["--db", databasePath])
        }
        let (code, stdout, stderr) = await runCommand(executable: bin, arguments: args)
        if let data = stdout.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(ShowPayload.self, from: data)
        {
            let enabled = decoded.background == "on" || (decoded.installed != nil && decoded.installed != "absent")
            let loaded = decoded.loaded ?? false
            let runningURL = decoded.running?.url
            let detail: String
            if enabled && loaded {
                detail = "Runs automatically at login (\(runningURL ?? "active"))."
            } else if enabled {
                detail = "Login item installed (not currently loaded)."
            } else if let runningURL {
                detail = "Running manually at \(runningURL) (not set to start at login)."
            } else {
                detail = decoded.message ?? "Not set to start at login."
            }
            return BackgroundServiceStatus(enabled: enabled, loaded: loaded, runningURL: runningURL, detail: detail)
        }
        let msg = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return BackgroundServiceStatus(
            enabled: false,
            loaded: false,
            runningURL: nil,
            detail: msg.isEmpty ? "Could not read background status (exit \(code))." : msg
        )
    }

    public static func setEnabled(_ enable: Bool, databasePath: String?) async -> (ok: Bool, message: String) {
        guard let bin = locateToolrollBinary() else {
            return (false, "toolroll CLI not found on PATH.")
        }
        var args = ["background", enable ? "on" : "off", "--json"]
        if let databasePath, !databasePath.isEmpty {
            args.append(contentsOf: ["--db", databasePath])
        }
        let (code, stdout, stderr) = await runCommand(executable: bin, arguments: args)
        if let data = stdout.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(ActionPayload.self, from: data)
        {
            if decoded.ok == true {
                if enable {
                    return (true, "Toolroll now runs in the background and starts at login.")
                } else {
                    return (true, "Background login item turned off.")
                }
            }
            return (false, decoded.message ?? "Could not update background service.")
        }
        let msg = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return (code == 0, msg.isEmpty ? (code == 0 ? "Updated background service." : "Command failed (exit \(code)).") : msg)
    }

    private static func runCommand(executable: String, arguments: [String]) async -> (Int32, String, String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: executable)
                proc.arguments = arguments
                var env = ProcessInfo.processInfo.environment
                let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
                env["PATH"] = [extra, env["PATH"]].compactMap { $0 }.joined(separator: ":")
                proc.environment = env

                let outPipe = Pipe()
                let errPipe = Pipe()
                proc.standardOutput = outPipe
                proc.standardError = errPipe

                do {
                    try proc.run()
                    proc.waitUntilExit()
                    let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                    let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                    continuation.resume(returning: (proc.terminationStatus, out, err))
                } catch {
                    continuation.resume(returning: (1, "", error.localizedDescription))
                }
            }
        }
    }
}
