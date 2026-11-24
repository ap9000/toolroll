import Foundation

public struct DiscoveredGitRepo: Identifiable, Sendable, Equatable, Hashable {
    public var id: String { path }
    public let name: String
    public let path: String
    public let branch: String?
    public let suggestedSetupCommand: String?
    public let lastModified: Date

    public init(
        name: String,
        path: String,
        branch: String?,
        suggestedSetupCommand: String?,
        lastModified: Date
    ) {
        self.name = name
        self.path = path
        self.branch = branch
        self.suggestedSetupCommand = suggestedSetupCommand
        self.lastModified = lastModified
    }
}

public enum LocalCliProvider: String, Codable, Sendable, CaseIterable, Identifiable {
    case claude = "claude"
    case codex = "codex"
    case gemini = "gemini"

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .gemini: return "Gemini CLI"
        }
    }

    public var shortBadge: String {
        switch self {
        case .claude: return "CL"
        case .codex: return "CX"
        case .gemini: return "GM"
        }
    }
}

public struct LocalCliMessage: Identifiable, Sendable, Equatable {
    public let id: String
    public let role: String
    public let text: String
    public let timestamp: String?

    public init(id: String, role: String, text: String, timestamp: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
    }
}

public struct LocalCliThread: Identifiable, Sendable, Equatable, Hashable {
    public var id: String { "\(provider.rawValue):\(sessionId)" }
    public let provider: LocalCliProvider
    public let sessionId: String
    public let title: String
    public let projectPath: String?
    public let projectName: String
    public let branch: String?
    public let filePath: String
    public let updatedAt: Date

    public init(
        provider: LocalCliProvider,
        sessionId: String,
        title: String,
        projectPath: String?,
        projectName: String,
        branch: String?,
        filePath: String,
        updatedAt: Date
    ) {
        self.provider = provider
        self.sessionId = sessionId
        self.title = title
        self.projectPath = projectPath
        self.projectName = projectName
        self.branch = branch
        self.filePath = filePath
        self.updatedAt = updatedAt
    }

    public var resumeCommand: String {
        switch provider {
        case .claude:
            return "claude --resume \(sessionId)"
        case .codex:
            return "codex resume \(sessionId)"
        case .gemini:
            return "gemini --resume \(sessionId)"
        }
    }

    public var relativeAge: String {
        let sec = max(0, Int(Date().timeIntervalSince(updatedAt)))
        if sec < 60 { return "now" }
        if sec < 3600 { return "\(sec / 60)m" }
        if sec < 86_400 { return "\(sec / 3600)h" }
        let days = sec / 86_400
        if days < 30 { return "\(days)d" }
        return "\(days / 30)mo"
    }
}

public enum LocalWorkspaceDiscovery {
    private static let skipDirectoryNames: Set<String> = [
        ".git", "node_modules", ".build", ".next", ".turbo", "dist", "build",
        "DerivedData", "Pods", ".venv", "venv", "__pycache__", "target",
        "worktrees", "live-worktrees", ".cache", "Library", ".Trash"
    ]

    public static func defaultSearchRoots(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [URL] {
        [
            home.appendingPathComponent("Documents", isDirectory: true),
            home.appendingPathComponent("Documents/firstmate/projects", isDirectory: true),
            home.appendingPathComponent("Code", isDirectory: true),
            home.appendingPathComponent("Projects", isDirectory: true),
            home.appendingPathComponent("Developer", isDirectory: true),
            home.appendingPathComponent("src", isDirectory: true),
            home.appendingPathComponent("workspace", isDirectory: true),
        ]
    }

    public static func suggestSetupCommand(forRepoPath repoPath: String) -> String? {
        let fm = FileManager.default
        if fm.fileExists(atPath: "\(repoPath)/pnpm-lock.yaml") {
            return "pnpm install --frozen-lockfile"
        }
        if fm.fileExists(atPath: "\(repoPath)/package-lock.json") {
            return "npm ci"
        }
        if fm.fileExists(atPath: "\(repoPath)/yarn.lock") {
            return "yarn install --frozen-lockfile"
        }
        if fm.fileExists(atPath: "\(repoPath)/bun.lockb") || fm.fileExists(atPath: "\(repoPath)/bun.lock") {
            return "bun install --frozen-lockfile"
        }
        if fm.fileExists(atPath: "\(repoPath)/package.json") {
            return "npm install"
        }
        return nil
    }

    public static func readGitBranch(forRepoPath repoPath: String) -> String? {
        let gitPath = "\(repoPath)/.git"
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: gitPath, isDirectory: &isDir) else { return nil }
        let headPath: String
        if isDir.boolValue {
            headPath = "\(gitPath)/HEAD"
        } else if let pointer = try? String(contentsOfFile: gitPath, encoding: .utf8),
                  pointer.hasPrefix("gitdir:") {
            let rel = pointer.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespacesAndNewlines)
            let resolved = rel.hasPrefix("/") ? rel : "\(repoPath)/\(rel)"
            headPath = "\(resolved)/HEAD"
        } else {
            return nil
        }

        guard let head = try? String(contentsOfFile: headPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        if head.hasPrefix("ref: refs/heads/") {
            return String(head.dropFirst("ref: refs/heads/".count))
        }
        if head.count >= 7 {
            return String(head.prefix(7))
        }
        return nil
    }

    public static func scanGitRepositories(
        roots: [URL]? = nil,
        extraRoots: [URL] = [],
        maxDepth: Int = 3,
        limit: Int = 50
    ) -> [DiscoveredGitRepo] {
        let fm = FileManager.default
        let searchRoots = (roots ?? defaultSearchRoots()) + extraRoots
        var seenPaths: Set<String> = []
        var found: [DiscoveredGitRepo] = []

        func walk(_ dir: URL, depth: Int) {
            let stdPath = dir.standardizedFileURL.path
            guard !seenPaths.contains(stdPath) else { return }

            let gitPath = dir.appendingPathComponent(".git").path
            if fm.fileExists(atPath: gitPath) {
                seenPaths.insert(stdPath)
                let modDate = (try? fm.attributesOfItem(atPath: gitPath)[.modificationDate] as? Date)
                    ?? (try? fm.attributesOfItem(atPath: stdPath)[.modificationDate] as? Date)
                    ?? Date.distantPast
                found.append(DiscoveredGitRepo(
                    name: dir.lastPathComponent,
                    path: stdPath,
                    branch: readGitBranch(forRepoPath: stdPath),
                    suggestedSetupCommand: suggestSetupCommand(forRepoPath: stdPath),
                    lastModified: modDate
                ))
                if depth >= 1 { return }
            }

            guard depth < maxDepth else { return }
            guard let children = try? fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            ) else { return }

            for child in children {
                let name = child.lastPathComponent
                if skipDirectoryNames.contains(name) { continue }
                let rv = try? child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard rv?.isDirectory == true, rv?.isSymbolicLink != true else { continue }
                walk(child, depth: depth + 1)
            }
        }

        for root in searchRoots {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else { continue }
            walk(root, depth: 0)
        }

        return Array(found.sorted { $0.lastModified > $1.lastModified }.prefix(limit))
    }

    public static func scanCliThreads(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        limit: Int = 36
    ) -> [LocalCliThread] {
        var threads: [LocalCliThread] = []
        threads.append(contentsOf: scanClaudeThreads(home: home, limit: 16))
        threads.append(contentsOf: scanCodexThreads(home: home, limit: 16))
        threads.append(contentsOf: scanGeminiThreads(home: home, limit: 12))
        return Array(threads.sorted { $0.updatedAt > $1.updatedAt }.prefix(limit))
    }

    public static func loadCliThreadMessages(thread: LocalCliThread, limit: Int = 80) -> [LocalCliMessage] {
        switch thread.provider {
        case .claude:
            return parseClaudeMessages(filePath: thread.filePath, limit: limit)
        case .codex:
            return parseCodexMessages(filePath: thread.filePath, limit: limit)
        case .gemini:
            return parseGeminiMessages(filePath: thread.filePath, limit: limit)
        }
    }

    private static func scanClaudeThreads(home: URL, limit: Int) -> [LocalCliThread] {
        let fm = FileManager.default
        let root = home.appendingPathComponent(".claude/projects", isDirectory: true)
        guard let projectDirs = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var candidates: [(url: URL, dirName: String, mtime: Date)] = []
        for dir in projectDirs {
            let dirName = dir.lastPathComponent
            if dirName.contains("-worktrees-") || dirName.contains("--treehouse-") || dirName.contains("--no-mistakes-") {
                continue
            }
            guard let files = try? fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for file in files where file.pathExtension == "jsonl" {
                let rv = try? file.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
                guard (rv?.fileSize ?? 0) > 120 else { continue }
                candidates.append((file, dirName, rv?.contentModificationDate ?? .distantPast))
            }
        }

        candidates.sort { $0.mtime > $1.mtime }
        var out: [LocalCliThread] = []
        for cand in candidates.prefix(limit * 2) {
            if out.count >= limit { break }
            if let parsed = summarizeClaudeFile(url: cand.url, dirName: cand.dirName, mtime: cand.mtime) {
                out.append(parsed)
            }
        }
        return out
    }

    private static func summarizeClaudeFile(url: URL, dirName: String, mtime: Date) -> LocalCliThread? {
        let lines = readHeadLines(atPath: url.path, maxBytes: 128_000, maxLines: 60)
        var sessionId = url.deletingPathExtension().lastPathComponent
        var cwd: String?
        var branch: String?
        var title: String?

        for line in lines {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let sid = obj["sessionId"] as? String, !sid.isEmpty { sessionId = sid }
            if cwd == nil, let c = obj["cwd"] as? String, !c.isEmpty { cwd = c }
            if branch == nil, let b = obj["gitBranch"] as? String, !b.isEmpty { branch = b }
            if title == nil, (obj["type"] as? String) == "user",
               let msg = obj["message"] as? [String: Any],
               let rawText = extractClaudeContentText(msg["content"]),
               let clean = cleanThreadTitle(rawText) {
                title = clean
            }
            if title != nil && cwd != nil { break }
        }

        guard let finalTitle = title else { return nil }
        let resolvedPath = cwd ?? decodeClaudeProjectDirName(dirName)
        let projName = resolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? dirName
        return LocalCliThread(
            provider: .claude,
            sessionId: sessionId,
            title: finalTitle,
            projectPath: resolvedPath,
            projectName: projName,
            branch: branch,
            filePath: url.path,
            updatedAt: mtime
        )
    }

    private static func parseClaudeMessages(filePath: String, limit: Int) -> [LocalCliMessage] {
        let lines = readHeadLines(atPath: filePath, maxBytes: 750_000, maxLines: 400)
        var msgs: [LocalCliMessage] = []
        for (idx, line) in lines.enumerated() {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String,
                  type == "user" || type == "assistant",
                  let msg = obj["message"] as? [String: Any],
                  let text = extractClaudeContentText(msg["content"]),
                  !isSystemNoise(text) else { continue }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            msgs.append(LocalCliMessage(
                id: "cl-\(idx)",
                role: type,
                text: String(trimmed.prefix(4000)),
                timestamp: obj["timestamp"] as? String
            ))
            if msgs.count >= limit { break }
        }
        return msgs
    }

    private static func extractClaudeContentText(_ content: Any?) -> String? {
        if let str = content as? String { return str }
        if let arr = content as? [[String: Any]] {
            let parts = arr.compactMap { item -> String? in
                guard (item["type"] as? String) == "text" else { return nil }
                return item["text"] as? String
            }
            return parts.isEmpty ? nil : parts.joined(separator: "\n")
        }
        return nil
    }

    private static func decodeClaudeProjectDirName(_ dirName: String) -> String? {
        guard dirName.hasPrefix("-") else { return nil }
        let guess = "/" + dirName.dropFirst().replacingOccurrences(of: "-", with: "/")
        if FileManager.default.fileExists(atPath: guess) { return guess }
        return nil
    }

    private static func scanCodexThreads(home: URL, limit: Int) -> [LocalCliThread] {
        let fm = FileManager.default
        let root = home.appendingPathComponent(".codex/sessions", isDirectory: true)
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var candidates: [(url: URL, mtime: Date)] = []
        for case let fileURL as URL in enumerator {
            guard fileURL.pathExtension == "jsonl" else { continue }
            let rv = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey])
            guard rv?.isRegularFile == true, (rv?.fileSize ?? 0) > 200 else { continue }
            candidates.append((fileURL, rv?.contentModificationDate ?? .distantPast))
        }

        candidates.sort { $0.mtime > $1.mtime }
        var out: [LocalCliThread] = []
        for cand in candidates.prefix(limit * 2) {
            if out.count >= limit { break }
            if let parsed = summarizeCodexFile(url: cand.url, mtime: cand.mtime) {
                out.append(parsed)
            }
        }
        return out
    }

    private static func summarizeCodexFile(url: URL, mtime: Date) -> LocalCliThread? {
        let lines = readHeadLines(atPath: url.path, maxBytes: 180_000, maxLines: 80)
        var sessionId = url.deletingPathExtension().lastPathComponent
        var cwd: String?
        var branch: String?
        var title: String?

        for line in lines {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String else { continue }

            if type == "session_meta", let payload = obj["payload"] as? [String: Any] {
                if let id = payload["id"] as? String, !id.isEmpty { sessionId = id }
                if let c = payload["cwd"] as? String, !c.isEmpty { cwd = c }
                if let git = payload["git"] as? [String: Any], let b = git["branch"] as? String, !b.isEmpty {
                    branch = b
                }
            } else if title == nil, type == "event_msg", let payload = obj["payload"] as? [String: Any],
                      (payload["type"] as? String) == "user_message",
                      let msg = payload["message"] as? String,
                      let clean = cleanThreadTitle(msg) {
                title = clean
            } else if title == nil, type == "response_item", let payload = obj["payload"] as? [String: Any],
                      (payload["role"] as? String) == "user",
                      let text = extractCodexContentText(payload["content"]),
                      let clean = cleanThreadTitle(text) {
                title = clean
            }
            if title != nil && cwd != nil { break }
        }

        if let cwd, cwd.contains("/.config/nightorders/worktrees/"), title == nil {
            return nil
        }

        let resolvedTitle = title ?? branch.map { "Codex session on \($0)" } ?? "Codex session"
        let projName = cwd.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Codex"
        return LocalCliThread(
            provider: .codex,
            sessionId: sessionId,
            title: resolvedTitle,
            projectPath: cwd,
            projectName: projName,
            branch: branch,
            filePath: url.path,
            updatedAt: mtime
        )
    }

    private static func parseCodexMessages(filePath: String, limit: Int) -> [LocalCliMessage] {
        let lines = readHeadLines(atPath: filePath, maxBytes: 850_000, maxLines: 500)
        var msgs: [LocalCliMessage] = []
        for (idx, line) in lines.enumerated() {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String,
                  let payload = obj["payload"] as? [String: Any] else { continue }
            let ts = obj["timestamp"] as? String

            if type == "event_msg", let evType = payload["type"] as? String {
                if evType == "user_message", let text = payload["message"] as? String, !isSystemNoise(text) {
                    msgs.append(LocalCliMessage(id: "cx-\(idx)", role: "user", text: String(text.prefix(4000)), timestamp: ts))
                } else if evType == "agent_message", let text = payload["message"] as? String, !text.isEmpty {
                    msgs.append(LocalCliMessage(id: "cx-\(idx)", role: "assistant", text: String(text.prefix(4000)), timestamp: ts))
                }
            } else if type == "response_item",
                      let role = payload["role"] as? String,
                      (role == "user" || role == "assistant"),
                      let text = extractCodexContentText(payload["content"]),
                      !isSystemNoise(text) {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty, msgs.last?.text != trimmed {
                    msgs.append(LocalCliMessage(id: "cx-r-\(idx)", role: role, text: String(trimmed.prefix(4000)), timestamp: ts))
                }
            }
            if msgs.count >= limit { break }
        }
        return msgs
    }

    private static func extractCodexContentText(_ content: Any?) -> String? {
        if let str = content as? String { return str }
        if let arr = content as? [[String: Any]] {
            let parts = arr.compactMap { item -> String? in
                guard let t = item["type"] as? String,
                      (t == "input_text" || t == "output_text" || t == "text") else { return nil }
                return item["text"] as? String
            }
            return parts.isEmpty ? nil : parts.joined(separator: "\n")
        }
        return nil
    }

    private static func scanGeminiThreads(home: URL, limit: Int) -> [LocalCliThread] {
        let fm = FileManager.default
        let root = home.appendingPathComponent(".gemini/tmp", isDirectory: true)
        guard let projectDirs = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var candidates: [(url: URL, projectRoot: String?, fallbackName: String, mtime: Date)] = []
        for dir in projectDirs {
            let chatsDir = dir.appendingPathComponent("chats", isDirectory: true)
            guard let files = try? fm.contentsOfDirectory(
                at: chatsDir,
                includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            let rootFile = dir.appendingPathComponent(".project_root")
            let projRoot = (try? String(contentsOf: rootFile, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanRoot = (projRoot?.isEmpty == false && projRoot != "/") ? projRoot : nil

            for file in files where file.pathExtension == "jsonl" || file.pathExtension == "json" {
                let rv = try? file.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
                guard (rv?.fileSize ?? 0) > 40 else { continue }
                candidates.append((file, cleanRoot, dir.lastPathComponent, rv?.contentModificationDate ?? .distantPast))
            }
        }

        candidates.sort { $0.mtime > $1.mtime }
        var out: [LocalCliThread] = []
        for cand in candidates.prefix(limit * 2) {
            if out.count >= limit { break }
            if let parsed = summarizeGeminiFile(
                url: cand.url,
                projectRoot: cand.projectRoot,
                fallbackName: cand.fallbackName,
                mtime: cand.mtime
            ) {
                out.append(parsed)
            }
        }
        return out
    }

    private static func summarizeGeminiFile(
        url: URL,
        projectRoot: String?,
        fallbackName: String,
        mtime: Date
    ) -> LocalCliThread? {
        let lines = readHeadLines(atPath: url.path, maxBytes: 180_000, maxLines: 60)
        var sessionId = url.deletingPathExtension().lastPathComponent
        var title: String?

        for line in lines {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let sid = obj["sessionId"] as? String, !sid.isEmpty { sessionId = sid }
            if title == nil, (obj["type"] as? String) == "user",
               let text = extractGeminiContentText(obj["content"]),
               let clean = cleanThreadTitle(text) {
                title = clean
            }
            if title != nil { break }
        }

        let projName = projectRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? fallbackName
        return LocalCliThread(
            provider: .gemini,
            sessionId: sessionId,
            title: title ?? "Gemini CLI session (\(projName))",
            projectPath: projectRoot,
            projectName: projName,
            branch: projectRoot.flatMap { readGitBranch(forRepoPath: $0) },
            filePath: url.path,
            updatedAt: mtime
        )
    }

    private static func parseGeminiMessages(filePath: String, limit: Int) -> [LocalCliMessage] {
        let lines = readHeadLines(atPath: filePath, maxBytes: 600_000, maxLines: 300)
        var msgs: [LocalCliMessage] = []
        for (idx, line) in lines.enumerated() {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String,
                  (type == "user" || type == "gemini" || type == "model" || type == "assistant"),
                  let text = extractGeminiContentText(obj["content"]),
                  !isSystemNoise(text) else { continue }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            msgs.append(LocalCliMessage(
                id: "gm-\(idx)",
                role: type == "user" ? "user" : "assistant",
                text: String(trimmed.prefix(4000)),
                timestamp: obj["timestamp"] as? String
            ))
            if msgs.count >= limit { break }
        }
        return msgs
    }

    private static func extractGeminiContentText(_ content: Any?) -> String? {
        if let str = content as? String { return str }
        if let arr = content as? [[String: Any]] {
            let parts = arr.compactMap { $0["text"] as? String }
            return parts.isEmpty ? nil : parts.joined(separator: "\n")
        }
        return nil
    }

    private static func readHeadLines(atPath path: String, maxBytes: Int, maxLines: Int) -> [String] {
        guard let handle = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: maxBytes)) ?? Data()
        guard let text = String(data: data, encoding: .utf8) else { return [] }
        return Array(text.components(separatedBy: .newlines).prefix(maxLines))
    }

    private static func isSystemNoise(_ raw: String) -> Bool {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return true }
        let noisePrefixes = [
            "<session_context>",
            "<environment_context>",
            "<command-",
            "<local-command-",
            "# AGENTS.md",
            "MAIN DIALOG MIRROR",
            "<turn_aborted>"
        ]
        return noisePrefixes.contains { t.hasPrefix($0) }
    }

    private static func cleanThreadTitle(_ raw: String) -> String? {
        guard !isSystemNoise(raw) else { return nil }
        let singleLine = raw
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard singleLine.count >= 2 else { return nil }
        if singleLine.count <= 96 { return singleLine }
        return String(singleLine.prefix(95)) + "…"
    }
}
