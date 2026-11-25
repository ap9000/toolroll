import Foundation

public enum AgentChatProvider: String, Codable, CaseIterable, Identifiable, Sendable {
    case claude
    case codex
    case gemini

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .gemini: return "Gemini"
        }
    }

    public var shortBadge: String {
        switch self {
        case .claude: return "CL"
        case .codex: return "CX"
        case .gemini: return "GM"
        }
    }

    public var defaultModelId: String {
        switch self {
        case .claude: return "opus"
        case .codex: return "gpt-6-astra"
        case .gemini: return "gemini-4-neon-high"
        }
    }

    public var presets: [(id: String, label: String)] {
        switch self {
        case .claude:
            return [
                ("opus", "Claude Opus 5.5"),
                ("sonnet", "Claude Sonnet 5.5"),
                ("haiku", "Claude Haiku"),
            ]
        case .codex:
            return [
                ("gpt-6-astra", "GPT-6 Astra"),
                ("gpt-6-sol", "GPT-6 Sol"),
                ("gpt-6-luna", "GPT-6 Luna"),
            ]
        case .gemini:
            return [
                ("gemini-4-neon-high", "Gemini 4 Neon"),
                ("gemini-4-carbon-high", "Gemini 4 Carbon"),
                ("gemini-3.8-flash-high", "Gemini 3.8 Flash"),
            ]
        }
    }

    public func label(for modelId: String) -> String {
        presets.first(where: { $0.id == modelId })?.label ?? modelId
    }
}

public struct AgentChatToolEvent: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let detail: String
    public var status: String

    public init(id: String = UUID().uuidString, name: String, detail: String, status: String = "done") {
        self.id = id
        self.name = name
        self.detail = detail
        self.status = status
    }
}

public enum AgentChatRole: String, Codable, Sendable {
    case user
    case assistant
}

public struct AgentChatMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let role: AgentChatRole
    public var text: String
    public var tools: [AgentChatToolEvent]
    public let timestamp: Date
    public var isStreaming: Bool
    public var isError: Bool

    public init(
        id: String = UUID().uuidString,
        role: AgentChatRole,
        text: String,
        tools: [AgentChatToolEvent] = [],
        timestamp: Date = Date(),
        isStreaming: Bool = false,
        isError: Bool = false
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.tools = tools
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.isError = isError
    }
}

public struct AgentChatThread: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var title: String
    public let projectName: String
    public let projectPath: String
    public var provider: AgentChatProvider
    public var modelId: String
    public var sessionId: String?
    public var messages: [AgentChatMessage]
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: String = UUID().uuidString,
        title: String,
        projectName: String,
        projectPath: String,
        provider: AgentChatProvider,
        modelId: String? = nil,
        sessionId: String? = nil,
        messages: [AgentChatMessage] = [],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.projectName = projectName
        self.projectPath = projectPath
        self.provider = provider
        self.modelId = modelId ?? provider.defaultModelId
        self.sessionId = sessionId
        self.messages = messages
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var relativeAge: String {
        let secs = max(0, Int(Date().timeIntervalSince(updatedAt)))
        if secs < 60 { return "now" }
        if secs < 3600 { return "\(secs / 60)m" }
        if secs < 86_400 { return "\(secs / 3600)h" }
        return "\(secs / 86_400)d"
    }
}

public struct AgentChatGitDiff: Equatable, Sendable {
    public let changedFiles: [String]
    public let diffText: String

    public init(changedFiles: [String] = [], diffText: String = "") {
        self.changedFiles = changedFiles
        self.diffText = diffText
    }

    public var isEmpty: Bool { changedFiles.isEmpty }
}

public enum AgentChatStreamEvent: Equatable, Sendable {
    case sessionId(String)
    case textDelta(String)
    case textReplace(String)
    case tool(AgentChatToolEvent)
    case completed
    case failed(String)
}

public enum AgentChatStreamParser {
    public static func parse(line: String, provider: AgentChatProvider) -> [AgentChatStreamEvent] {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return []
        }

        switch provider {
        case .claude:
            return parseClaude(json)
        case .codex:
            return parseCodex(json)
        case .gemini:
            return parseGemini(json)
        }
    }

    private static func parseClaude(_ json: [String: Any]) -> [AgentChatStreamEvent] {
        var events: [AgentChatStreamEvent] = []
        if let sid = json["session_id"] as? String, !sid.isEmpty {
            events.append(.sessionId(sid))
        }
        let type = json["type"] as? String ?? ""
        if type == "assistant",
           let message = json["message"] as? [String: Any],
           let content = message["content"] as? [[String: Any]]
        {
            var textParts: [String] = []
            for block in content {
                let bType = block["type"] as? String ?? ""
                if bType == "text", let text = block["text"] as? String, !text.isEmpty {
                    textParts.append(text)
                } else if bType == "tool_use" {
                    let name = block["name"] as? String ?? "Tool"
                    let input = block["input"] as? [String: Any]
                    let detail = summarizeToolInput(name: name, input: input)
                    let id = block["id"] as? String ?? UUID().uuidString
                    events.append(.tool(AgentChatToolEvent(id: id, name: name, detail: detail, status: "done")))
                }
            }
            if !textParts.isEmpty {
                events.append(.textReplace(textParts.joined(separator: "\n")))
            }
        } else if type == "result" {
            let isError = (json["is_error"] as? Bool) == true
            if let resultText = json["result"] as? String, !resultText.isEmpty {
                if isError {
                    events.append(.failed(resultText))
                } else {
                    events.append(.textReplace(resultText))
                    events.append(.completed)
                }
            } else if isError {
                events.append(.failed("Claude returned an error."))
            } else {
                events.append(.completed)
            }
        }
        return events
    }

    private static func parseCodex(_ json: [String: Any]) -> [AgentChatStreamEvent] {
        var events: [AgentChatStreamEvent] = []
        let type = json["type"] as? String ?? ""
        if type == "thread.started", let tid = json["thread_id"] as? String, !tid.isEmpty {
            events.append(.sessionId(tid))
        } else if type == "item.completed" || type == "item.started",
                  let item = json["item"] as? [String: Any]
        {
            let itemType = item["type"] as? String ?? ""
            let itemId = item["id"] as? String ?? UUID().uuidString
            if itemType == "agent_message", let text = item["text"] as? String, !text.isEmpty {
                events.append(.textReplace(text))
            } else if itemType == "command_execution" {
                let cmd = item["command"] as? String ?? "shell"
                let status = (type == "item.completed") ? "done" : "running"
                events.append(.tool(AgentChatToolEvent(id: itemId, name: "Shell", detail: cmd, status: status)))
            } else if itemType == "file_change" {
                let changes = (item["changes"] as? [[String: Any]]) ?? []
                let paths = changes.compactMap { $0["path"] as? String }.prefix(3).joined(separator: ", ")
                events.append(.tool(AgentChatToolEvent(id: itemId, name: "Edit", detail: paths.isEmpty ? "Updated files" : paths, status: "done")))
            } else if itemType == "mcp_tool_call" {
                let tool = item["tool"] as? String ?? "Tool"
                events.append(.tool(AgentChatToolEvent(id: itemId, name: tool, detail: item["server"] as? String ?? "", status: type == "item.completed" ? "done" : "running")))
            }
        } else if type == "turn.completed" {
            events.append(.completed)
        } else if type == "turn.failed" || type == "error" {
            let errObj = json["error"] as? [String: Any]
            let msg = (errObj?["message"] as? String) ?? (json["message"] as? String) ?? "Codex turn failed."
            events.append(.failed(msg))
        }
        return events
    }

    private static func parseGemini(_ json: [String: Any]) -> [AgentChatStreamEvent] {
        var events: [AgentChatStreamEvent] = []
        if let cid = json["conversation_id"] as? String, !cid.isEmpty {
            events.append(.sessionId(cid))
        }
        let event = json["event"] as? String ?? ""
        if event == "step_update", let step = json["step_update"] as? [String: Any] {
            let stepType = step["step_type"] as? String ?? ""
            let state = step["state"] as? String ?? ""
            if stepType == "agent_response", let delta = step["text_delta"] as? String, !delta.isEmpty {
                events.append(.textDelta(delta))
            } else if !stepType.isEmpty && stepType != "user_input" && stepType != "agent_response" && stepType != "thinking" {
                let idx = step["step_index"] as? Int ?? 0
                let status = state == "DONE" ? "done" : "running"
                let detail = (step["summary"] as? String) ?? (step["title"] as? String) ?? stepType
                events.append(.tool(AgentChatToolEvent(id: "agy-\(idx)", name: stepType.replacingOccurrences(of: "_", with: " ").capitalized, detail: detail, status: status)))
            }
        } else if event == "result", let result = json["result"] as? [String: Any] {
            if let cid = result["conversation_id"] as? String, !cid.isEmpty {
                events.append(.sessionId(cid))
            }
            let status = (result["status"] as? String ?? "").uppercased()
            if status == "SUCCESS" || status.isEmpty {
                if let text = result["response"] as? String, !text.isEmpty {
                    events.append(.textReplace(text))
                }
                events.append(.completed)
            } else {
                let msg = (result["error"] as? String) ?? (result["response"] as? String) ?? "Gemini run failed."
                events.append(.failed(msg))
            }
        }
        return events
    }

    private static func summarizeToolInput(name: String, input: [String: Any]?) -> String {
        guard let input else { return "" }
        for key in ["command", "file_path", "path", "pattern", "query", "url", "description"] {
            if let val = input[key] as? String, !val.isEmpty {
                return String(val.prefix(120))
            }
        }
        return ""
    }
}

public enum AgentChatPersistence {
    public static var defaultStorageURL: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".config/toolroll/chat-threads.json")
    }

    public static func load(from url: URL = defaultStorageURL) -> [AgentChatThread] {
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url)
        else {
            return []
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard var decoded = try? decoder.decode([AgentChatThread].self, from: data) else {
            return []
        }
        for i in decoded.indices {
            for j in decoded[i].messages.indices {
                decoded[i].messages[j].isStreaming = false
            }
        }
        return decoded.sorted { $0.updatedAt > $1.updatedAt }
    }

    public static func save(_ threads: [AgentChatThread], to url: URL = defaultStorageURL) {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let trimmed = Array(threads.prefix(80))
        guard var data = try? encoder.encode(trimmed) else { return }
        data.append(0x0A)
        let tmp = url.appendingPathExtension("tmp.\(UUID().uuidString.prefix(8))")
        FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600])
        _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }
}

public final class AgentChatProcessHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?

    public init() {}

    func attach(_ proc: Process) {
        lock.lock()
        process = proc
        lock.unlock()
    }

    public func stop() {
        lock.lock()
        let proc = process
        lock.unlock()
        guard let proc, proc.isRunning else { return }
        proc.terminate()
    }
}

public enum AgentChatRunner {
    public static func locateBinary(for provider: AgentChatProvider) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates: [String]
        switch provider {
        case .claude:
            candidates = ["\(home)/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
        case .codex:
            candidates = ["\(home)/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
        case .gemini:
            candidates = ["\(home)/.local/bin/agy", "\(home)/.gemini/bin/agy", "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    public static func buildCommand(
        provider: AgentChatProvider,
        modelId: String,
        prompt: String,
        sessionId: String?
    ) -> [String] {
        switch provider {
        case .claude:
            var args = [
                "-p", prompt,
                "--output-format", "stream-json",
                "--verbose",
                "--permission-mode", "acceptEdits",
            ]
            if !modelId.isEmpty {
                args.append(contentsOf: ["--model", modelId])
            }
            if let sessionId, !sessionId.isEmpty {
                args.append(contentsOf: ["--resume", sessionId])
            }
            return args

        case .codex:
            if let sessionId, !sessionId.isEmpty {
                var args = ["exec", "resume", "--json", "--skip-git-repo-check"]
                if !modelId.isEmpty {
                    args.append(contentsOf: ["-m", modelId])
                }
                args.append(contentsOf: [sessionId, prompt])
                return args
            } else {
                var args = ["exec", "--json", "--approve-for-me", "--skip-git-repo-check"]
                if !modelId.isEmpty {
                    args.append(contentsOf: ["-m", modelId])
                }
                args.append(prompt)
                return args
            }

        case .gemini:
            var args = [
                "-p", prompt,
                "--output-format", "stream-json",
                "--mode", "accept-edits",
            ]
            if !modelId.isEmpty {
                args.append(contentsOf: ["--model", modelId])
            }
            if let sessionId, !sessionId.isEmpty {
                args.append(contentsOf: ["--conversation", sessionId])
            }
            return args
        }
    }

    public static func streamTurn(
        provider: AgentChatProvider,
        modelId: String,
        projectPath: String,
        prompt: String,
        sessionId: String?,
        handle: AgentChatProcessHandle
    ) -> AsyncStream<AgentChatStreamEvent> {
        AsyncStream { continuation in
            guard let binary = locateBinary(for: provider) else {
                continuation.yield(.failed("\(provider.displayName) CLI not found on this Mac."))
                continuation.finish()
                return
            }

            let args = buildCommand(provider: provider, modelId: modelId, prompt: prompt, sessionId: sessionId)

            DispatchQueue.global(qos: .userInitiated).async {
                let maxAttempts = (provider == .gemini) ? 2 : 1
                for attempt in 1...maxAttempts {
                    let outcome = runSingleTurn(
                        binary: binary,
                        args: args,
                        provider: provider,
                        projectPath: projectPath,
                        handle: handle,
                        continuation: continuation,
                        deferRetryableFailure: attempt < maxAttempts
                    )
                    if !outcome.shouldRetry {
                        break
                    }
                    Thread.sleep(forTimeInterval: 0.6)
                }
                continuation.finish()
            }
        }
    }

    private struct SingleTurnOutcome {
        let shouldRetry: Bool
    }

    private static func runSingleTurn(
        binary: String,
        args: [String],
        provider: AgentChatProvider,
        projectPath: String,
        handle: AgentChatProcessHandle,
        continuation: AsyncStream<AgentChatStreamEvent>.Continuation,
        deferRetryableFailure: Bool
    ) -> SingleTurnOutcome {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.arguments = args
        if FileManager.default.fileExists(atPath: projectPath) {
            proc.currentDirectoryURL = URL(fileURLWithPath: projectPath)
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var env = ProcessInfo.processInfo.environment
        let extraPath = "\(home)/.local/bin:\(home)/.gemini/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        env["PATH"] = [extraPath, env["PATH"]].compactMap { $0 }.joined(separator: ":")
        proc.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        proc.standardInput = FileHandle.nullDevice

        handle.attach(proc)

        let bufferBox = StreamBufferBox()

        outPipe.fileHandleForReading.readabilityHandler = { fh in
            let chunk = fh.availableData
            if chunk.isEmpty { return }
            let lines = bufferBox.appendStdout(chunk)
            for line in lines {
                let events = AgentChatStreamParser.parse(line: line, provider: provider)
                for ev in events {
                    if case .textDelta = ev { bufferBox.markOutput() }
                    if case .textReplace = ev { bufferBox.markOutput() }
                    if case .completed = ev { bufferBox.markTerminal() }
                    if case .failed(let msg) = ev {
                        bufferBox.markTerminal()
                        if deferRetryableFailure && !bufferBox.sawOutput() && msg.localizedCaseInsensitiveContains("authentication failed or timed out") {
                            bufferBox.markRetryableAuthFailure()
                            continue
                        }
                    }
                    continuation.yield(ev)
                }
            }
        }

        errPipe.fileHandleForReading.readabilityHandler = { fh in
            let chunk = fh.availableData
            if chunk.isEmpty { return }
            bufferBox.appendStderr(chunk)
        }

        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            continuation.yield(.failed(error.localizedDescription))
            return SingleTurnOutcome(shouldRetry: false)
        }

        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil

        let tailOut = outPipe.fileHandleForReading.readDataToEndOfFile()
        let tailErr = errPipe.fileHandleForReading.readDataToEndOfFile()
        let drained = bufferBox.drain(tailOut: tailOut, tailErr: tailErr)
        for line in drained.lines {
            let events = AgentChatStreamParser.parse(line: line, provider: provider)
            for ev in events {
                if case .textDelta = ev { bufferBox.markOutput() }
                if case .textReplace = ev { bufferBox.markOutput() }
                if case .completed = ev { bufferBox.markTerminal() }
                if case .failed(let msg) = ev {
                    bufferBox.markTerminal()
                    if deferRetryableFailure && !bufferBox.sawOutput() && msg.localizedCaseInsensitiveContains("authentication failed or timed out") {
                        bufferBox.markRetryableAuthFailure()
                        continue
                    }
                }
                continuation.yield(ev)
            }
        }

        if bufferBox.shouldRetryAuth() {
            return SingleTurnOutcome(shouldRetry: true)
        }

        let stderrText = drained.stderr
        let finishedNormally = bufferBox.sawTerminal()

        if !finishedNormally {
            if proc.terminationStatus == 0 {
                continuation.yield(.completed)
            } else if proc.terminationReason == .uncaughtSignal {
                continuation.yield(.failed("Stopped."))
            } else {
                let lastErr = stderrText.components(separatedBy: .newlines).last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
                let msg = lastErr ?? "\(provider.displayName) exited with code \(proc.terminationStatus)."
                if deferRetryableFailure && !bufferBox.sawOutput() && msg.localizedCaseInsensitiveContains("authentication failed or timed out") {
                    return SingleTurnOutcome(shouldRetry: true)
                }
                continuation.yield(.failed(msg))
            }
        }
        return SingleTurnOutcome(shouldRetry: false)
    }

    private final class StreamBufferBox: @unchecked Sendable {
        private let lock = NSLock()
        private var outBuffer = Data()
        private var errBuffer = Data()
        private var terminal = false
        private var emittedOutput = false
        private var retryableAuthFailure = false

        func appendStdout(_ chunk: Data) -> [String] {
            lock.lock()
            defer { lock.unlock() }
            outBuffer.append(chunk)
            var lines: [String] = []
            while let nl = outBuffer.firstIndex(of: 0x0A) {
                let lineData = outBuffer.subdata(in: outBuffer.startIndex..<nl)
                outBuffer.removeSubrange(outBuffer.startIndex...nl)
                if let line = String(data: lineData, encoding: .utf8) {
                    lines.append(line)
                }
            }
            return lines
        }

        func appendStderr(_ chunk: Data) {
            lock.lock()
            defer { lock.unlock() }
            errBuffer.append(chunk)
            if errBuffer.count > 16_384 {
                errBuffer = errBuffer.suffix(16_384)
            }
        }

        func markOutput() {
            lock.lock()
            emittedOutput = true
            lock.unlock()
        }

        func sawOutput() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return emittedOutput
        }

        func markRetryableAuthFailure() {
            lock.lock()
            retryableAuthFailure = true
            lock.unlock()
        }

        func shouldRetryAuth() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return retryableAuthFailure
        }

        func markTerminal() {
            lock.lock()
            terminal = true
            lock.unlock()
        }

        func sawTerminal() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return terminal
        }

        func drain(tailOut: Data, tailErr: Data) -> (lines: [String], stderr: String) {
            lock.lock()
            defer { lock.unlock() }
            outBuffer.append(tailOut)
            errBuffer.append(tailErr)
            var lines: [String] = []
            if !outBuffer.isEmpty, let rest = String(data: outBuffer, encoding: .utf8) {
                lines = rest.components(separatedBy: .newlines)
                outBuffer.removeAll()
            }
            let stderr = (String(data: errBuffer, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return (lines, stderr)
        }
    }

    public static func fetchGitDiff(projectPath: String) async -> AgentChatGitDiff {
        guard FileManager.default.fileExists(atPath: projectPath) else {
            return AgentChatGitDiff()
        }
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let status = runGit(["status", "--short"], cwd: projectPath)
                let files = status
                    .components(separatedBy: .newlines)
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                let diff = files.isEmpty ? "" : runGit(["diff", "--no-color"], cwd: projectPath)
                let truncated = diff.count > 40_000 ? String(diff.prefix(40_000)) + "\n… (diff truncated)" : diff
                continuation.resume(returning: AgentChatGitDiff(changedFiles: files, diffText: truncated))
            }
        }
    }

    private static func runGit(_ args: [String], cwd: String) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }
}
