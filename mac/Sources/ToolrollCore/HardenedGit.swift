import Foundation

public enum HardenedGit {
    public static let executable = "/usr/bin/git"

    public struct Output: Sendable, Equatable {
        public let status: Int32
        public let stdout: Data
        public let stderr: String
    }

    public static let forcedConfig: [String] = [
        "-c", "core.fsmonitor=false",
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.untrackedCache=false",
        "-c", "protocol.ext.allow=never",
    ]

    public static func arguments(_ command: [String]) -> [String] {
        forcedConfig + command
    }

    public static func environment(inherited: [String: String], home: String, forwardSSHAgent: Bool = false) -> [String: String] {
        var env: [String: String] = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": home,
            "LANG": inherited["LANG"] ?? "en_US.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_OPTIONAL_LOCKS": "0",
        ]
        if forwardSSHAgent, let sock = inherited["SSH_AUTH_SOCK"], !sock.isEmpty { env["SSH_AUTH_SOCK"] = sock }
        return env
    }

    public static func run(_ command: [String], in cwd: String, timeout: TimeInterval = 3, forwardSSHAgent: Bool = false) -> Output? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: executable)
        proc.arguments = arguments(command)
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        proc.environment = environment(inherited: ProcessInfo.processInfo.environment,
                                       home: FileManager.default.homeDirectoryForCurrentUser.path,
                                       forwardSSHAgent: forwardSSHAgent)
        proc.standardInput = FileHandle.nullDevice
        let outPipe = Pipe(), errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        let out = OutputBuffer(), err = OutputBuffer()
        outPipe.fileHandleForReading.readabilityHandler = { out.append($0.availableData) }
        errPipe.fileHandleForReading.readabilityHandler = { err.append($0.availableData) }
        let finished = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in finished.signal() }
        defer {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
        }
        do { try proc.run() } catch { return nil }
        guard finished.wait(timeout: .now() + timeout) == .success else {
            proc.terminate()
            return nil
        }
        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil
        out.append(outPipe.fileHandleForReading.readDataToEndOfFile())
        err.append(errPipe.fileHandleForReading.readDataToEndOfFile())
        return Output(status: proc.terminationStatus, stdout: out.data,
                      stderr: String(decoding: err.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public static func text(_ command: [String], in cwd: String, timeout: TimeInterval = 3) -> String? {
        guard let out = run(command, in: cwd, timeout: timeout), out.status == 0 else { return nil }
        return String(decoding: out.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func refusal(in cwd: String) -> String? {
        guard let out = run(["config", "--list", "--includes", "-z"], in: cwd), out.status == 0 else { return nil }
        return refusal(configList: out.stdout)
    }

    static func refusal(configList: Data) -> String? {
        for entry in configList.split(separator: 0) {
            let text = String(decoding: entry, as: UTF8.self)
            let parts = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
            let key = String(parts.first ?? "").lowercased()
            let value = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces).lowercased() : ""
            if key == "core.fsmonitor", !["", "false", "no", "off", "0"].contains(value) {
                return "This project's git settings run a program on every status check (core.fsmonitor), so Toolroll won't read it with git."
            }
            if key.hasPrefix("filter.") {
                return "This project's git settings run a program on its files (a git filter), so Toolroll won't read it with git."
            }
        }
        return nil
    }

    public static func isCloneURL(_ raw: String) -> Bool {
        let lower = raw.lowercased()
        if lower.hasPrefix("https://") || lower.hasPrefix("ssh://") { return URL(string: raw)?.host?.isEmpty == false }
        if let at = raw.firstIndex(of: "@"), let colon = raw.firstIndex(of: ":"), at < colon,
           !raw.contains("://"), !raw.hasPrefix("-"), !raw.contains(" ") {
            return raw[raw.index(after: at)..<colon].isEmpty == false
        }
        return false
    }
}

private final class OutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var collected = Data()

    func append(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock(); collected.append(chunk); lock.unlock()
    }

    var data: Data {
        lock.lock(); defer { lock.unlock() }
        return collected
    }
}
