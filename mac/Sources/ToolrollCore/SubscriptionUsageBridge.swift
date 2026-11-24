import Foundation

public struct GeminiSubscriptionStatus: Codable, Equatable, Sendable {
    public let connected: Bool
    public let provider: String
    public let topModel: String?
    public let modelCount: Int
    public let observedAt: String
    public let note: String?

    public init(
        connected: Bool,
        provider: String = "antigravity",
        topModel: String? = nil,
        modelCount: Int = 0,
        observedAt: String = "",
        note: String? = nil
    ) {
        self.connected = connected
        self.provider = provider
        self.topModel = topModel
        self.modelCount = modelCount
        self.observedAt = observedAt
        self.note = note
    }
}

public enum SubscriptionUsageBridge {
    private struct FileEnvelope: Codable {
        let version: Int?
        let gemini: GeminiSubscriptionStatus?
    }

    private struct SpendRefreshPayload: Decodable {
        let ok: Bool?
        let gemini: GeminiSubscriptionStatus?
        let message: String?
    }

    public static func statusFilePath(databasePath: String) -> String {
        let dir = (databasePath as NSString).deletingLastPathComponent
        let runDir = (dir as NSString).appendingPathComponent(".toolroll-run")
        return (runDir as NSString).appendingPathComponent("subscription-status.json")
    }

    public static func loadGeminiStatus(databasePath: String) -> GeminiSubscriptionStatus? {
        let path = statusFilePath(databasePath: databasePath)
        guard FileManager.default.fileExists(atPath: path),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let envelope = try? JSONDecoder().decode(FileEnvelope.self, from: data)
        else {
            return nil
        }
        return envelope.gemini
    }

    public static func refreshAll(databasePath: String?) async -> (ok: Bool, gemini: GeminiSubscriptionStatus?, message: String?) {
        guard let bin = BackgroundServiceBridge.locateToolrollBinary() else {
            return (false, nil, "toolroll CLI not found.")
        }
        var args = ["spend", "--refresh", "--json"]
        if let databasePath, !databasePath.isEmpty {
            args.append(contentsOf: ["--db", databasePath])
        }
        let (code, stdout, stderr) = await runCommand(executable: bin, arguments: args)
        if let data = stdout.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(SpendRefreshPayload.self, from: data)
        {
            return (decoded.ok == true, decoded.gemini, decoded.message)
        }
        let err = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return (code == 0, databasePath.flatMap { loadGeminiStatus(databasePath: $0) }, err.isEmpty ? nil : err)
    }

    private static func runCommand(executable: String, arguments: [String]) async -> (Int32, String, String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: executable)
                proc.arguments = arguments
                let home = FileManager.default.homeDirectoryForCurrentUser.path
                var env = ProcessInfo.processInfo.environment
                let extra = "\(home)/.local/bin:\(home)/.gemini/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
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
