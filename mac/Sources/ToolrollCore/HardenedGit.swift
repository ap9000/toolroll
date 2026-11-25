import Foundation

/// The one way the Mac app runs git. A repository is untrusted: its `.git/config` (and anything it includes) can name
/// commands git runs by itself (core.fsmonitor, filter drivers, hooks), and the app's own environment holds tokens.
///
/// - The environment is built from nothing: PATH, HOME, LANG, no system or global config, no prompts, no optional locks.
/// - Every call disables fsmonitor, hooks, the untracked cache and the `ext::` transport on the command line.
/// - Only commands that never run filters or drivers are used on an existing repository (rev-parse, ls-files, config).
///   `git status`, `diff` and checkout-style commands are never run on a repository the app didn't just create.
/// - A repository whose config sets core.fsmonitor or any filter.* is refused (`refusal(in:)`), as a second line.
public enum HardenedGit {
    public static let executable = "/usr/bin/git"

    public struct Output: Sendable, Equatable {
        public let status: Int32
        public let stdout: Data
        public let stderr: String
    }

    /// Settings forced on every call, ahead of the command.
    public static let forcedConfig: [String] = [
        "-c", "core.fsmonitor=false",
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.untrackedCache=false",
        "-c", "protocol.ext.allow=never",
    ]

    public static func arguments(_ command: [String]) -> [String] {
        forcedConfig + command
    }

    /// The environment git runs with, made from nothing. `forwardSSHAgent` passes the person's ssh agent socket, only
    /// for a clone of a URL they typed themselves.
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

    /// Runs git in `cwd` with the hardened environment and arguments; nil when it couldn't start or ran past `timeout`.
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

    /// Trimmed stdout of a successful run, else nil.
    public static func text(_ command: [String], in cwd: String, timeout: TimeInterval = 3) -> String? {
        guard let out = run(command, in: cwd, timeout: timeout), out.status == 0 else { return nil }
        return String(decoding: out.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Why the app won't read this repository with git, in plain words; nil when its config names no command git would
    /// run by itself. Listing config runs nothing.
    public static func refusal(in cwd: String) -> String? {
        guard let out = run(["config", "--list", "--includes", "-z"], in: cwd), out.status == 0 else { return nil }
        return refusal(configList: out.stdout)
    }

    /// `git config --list -z` entries are `key\nvalue\0`.
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

    /// A clone URL the person typed: https or ssh only (never ext::, file:: or a local path).
    public static func isCloneURL(_ raw: String) -> Bool {
        let lower = raw.lowercased()
        if lower.hasPrefix("https://") || lower.hasPrefix("ssh://") { return URL(string: raw)?.host?.isEmpty == false }
        // scp-like ssh: user@host:path
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
