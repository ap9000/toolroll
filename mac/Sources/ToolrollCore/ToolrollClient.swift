import Foundation

public enum ToolrollClientError: Error, LocalizedError, Sendable, Equatable {
    case invalidOrigin(String)
    case unauthenticated
    case refused(String)
    case passwordRequired(String)
    case httpStatus(Int, String)
    case unreachable(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .invalidOrigin(let o): return "Invalid workspace origin: \(o)"
        case .unauthenticated: return "Session ended or access changed — reconnect in Workspace Settings."
        case .refused(let m): return m
        case .passwordRequired(let m): return m
        case .httpStatus(let code, let m): return m.isEmpty ? "Server answered HTTP \(code)." : m
        case .unreachable(let m): return "Could not reach Toolroll: \(m)"
        case .decoding(let m): return "Unexpected response shape: \(m)"
        }
    }
}

public enum ClientTransport: Sendable, Equatable {
    case localSession(LocalSessionCredentials)
    case remoteBearer(ConnectionProfile)

    public var origin: String {
        switch self {
        case .localSession(let s): return s.origin
        case .remoteBearer(let p): return p.origin
        }
    }

    public var account: String {
        switch self {
        case .localSession(let s): return s.account
        case .remoteBearer(let p): return p.account
        }
    }

    public var isLocalSession: Bool {
        if case .localSession = self { return true }
        return false
    }

    public var localSessionCookie: (name: String, value: String, origin: String)? {
        guard case .localSession(let s) = self,
              let eq = s.cookieHeader.firstIndex(of: "=")
        else { return nil }
        let name = String(s.cookieHeader[..<eq])
        let value = String(s.cookieHeader[s.cookieHeader.index(after: eq)...])
        return (name, value, s.origin)
    }
}

/// Async HTTP + SSE + WebSocket client over Toolroll's central Engine API.
/// Supports both:
/// - **Local Owner Session** (`POST /login/once` cookie + CSRF + mutation key): full native in-app approvals,
///   reviews, answers, retries, plans, and task creation with zero browser handoff.
/// - **Remote Bearer Profile** (`x-toolroll-client: terminal-remote` + workspace/recovery pinning).
public actor ToolrollClient {
    public let transport: ClientTransport
    public var profile: ConnectionProfile {
        switch transport {
        case .remoteBearer(let p): return p
        case .localSession(let s):
            return ConnectionProfile(name: "local", origin: s.origin, account: s.account, token: "", label: "Local Toolroll")
        }
    }

    private let session: URLSession
    private let decoder: JSONDecoder

    public init(profile: ConnectionProfile, session: URLSession = .shared) {
        self.transport = .remoteBearer(profile)
        self.session = session
        self.decoder = JSONDecoder()
    }

    public init(localSession: LocalSessionCredentials, session: URLSession = .shared) {
        self.transport = .localSession(localSession)
        self.session = session
        self.decoder = JSONDecoder()
    }

    public static func normalizedOrigin(_ raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased()
        else {
            throw ToolrollClientError.invalidOrigin(raw)
        }
        let loopback = host == "127.0.0.1" || host == "localhost" || host == "::1"
        guard scheme == "https" || (scheme == "http" && loopback) else {
            throw ToolrollClientError.invalidOrigin("Origin must use HTTPS (or loopback HTTP).")
        }
        return url
    }

    private func makeRequest(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String = "application/json",
        accept: String = "application/json",
        includeMutationKey: Bool = false
    ) throws -> URLRequest {
        let base = try Self.normalizedOrigin(transport.origin)
        guard let url = URL(string: path, relativeTo: base) else {
            throw ToolrollClientError.invalidOrigin(path)
        }
        var req = URLRequest(url: url, timeoutInterval: 25)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.setValue(accept, forHTTPHeaderField: "Accept")

        switch transport {
        case .localSession(let s):
            req.setValue("terminal", forHTTPHeaderField: "x-toolroll-client")
            req.setValue(s.cookieHeader, forHTTPHeaderField: "Cookie")
            req.setValue(s.origin, forHTTPHeaderField: "Origin")
            req.setValue(s.csrf, forHTTPHeaderField: "x-csrf-token")
            if includeMutationKey || method == "POST" {
                req.setValue(s.key, forHTTPHeaderField: "x-toolroll-key")
                req.setValue("in-place", forHTTPHeaderField: "x-toolroll-act")
            }

        case .remoteBearer(let p):
            req.setValue("terminal-remote", forHTTPHeaderField: "x-toolroll-client")
            if !p.token.isEmpty {
                req.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
            }
            if let ws = p.workspaceId, !ws.isEmpty {
                req.setValue(ws, forHTTPHeaderField: "x-toolroll-workspace")
            }
            if let rec = p.recoveryGeneration, !rec.isEmpty {
                req.setValue(rec, forHTTPHeaderField: "x-toolroll-recovery")
            }
        }

        if let body {
            req.httpBody = body
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ToolrollClientError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ToolrollClientError.unreachable("No HTTP response")
        }
        if http.statusCode == 401 {
            throw ToolrollClientError.unauthenticated
        }
        if !(200...299).contains(http.statusCode) {
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let msg = (obj?["words"] as? String)
                ?? (obj?["message"] as? String)
                ?? (obj?["error"] as? String)
                ?? (obj?["said"] as? String)
                ?? ""
            if http.statusCode == 403 || http.statusCode == 409 {
                throw ToolrollClientError.refused(msg.isEmpty ? "Action refused (\(http.statusCode))." : msg)
            }
            throw ToolrollClientError.httpStatus(http.statusCode, msg)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            let preview = String(data: data.prefix(240), encoding: .utf8) ?? "<binary>"
            throw ToolrollClientError.decoding("\(String(describing: error)) | body: \(preview)")
        }
    }

    /// Sends a form POST action (`application/x-www-form-urlencoded`) in local-session mode and parses
    /// Toolroll's standard JSON (`{ outcome, words }`) or redirect (`?said=` / `?problem=`) response.
    private func sendFormAct(path: String, fields: [(String, String)], defaultDone: String) async throws -> String {
        guard case .localSession(let s) = transport else {
            throw ToolrollClientError.refused("This action requires a local or signed-in session.")
        }
        var items = [URLQueryItem(name: "csrf", value: s.csrf)]
        for (k, v) in fields {
            items.append(URLQueryItem(name: k, value: v))
        }
        var comps = URLComponents()
        comps.queryItems = items
        let formBody = comps.percentEncodedQuery ?? ""
        let req = try makeRequest(
            path: path,
            method: "POST",
            body: Data(formBody.utf8),
            contentType: "application/x-www-form-urlencoded",
            accept: "application/json",
            includeMutationKey: true
        )

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw ToolrollClientError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ToolrollClientError.unreachable("No HTTP response")
        }
        if http.statusCode == 401 {
            throw ToolrollClientError.unauthenticated
        }

        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let words = (obj["words"] as? String)
                ?? (obj["error"] as? String)
                ?? (obj["said"] as? String)
                ?? (obj["message"] as? String)
                ?? ""
            let outcome = obj["outcome"] as? String
            if outcome == "refused" || http.statusCode >= 400 {
                let lower = words.lowercased()
                if lower.contains("password") || lower.contains("step-up") || lower.contains("confirm your password") {
                    throw ToolrollClientError.passwordRequired(words.isEmpty ? "Enter your password to confirm this action." : words)
                }
                throw ToolrollClientError.refused(words.isEmpty ? "Action refused (\(http.statusCode))." : words)
            }
            return words.isEmpty ? defaultDone : words
        }

        // Parse Toolroll's 303 redirect query feedback (`?problem=...` or `?said=...`)
        // from either the followed final URL (`http.url`) or an unfollowed `Location` header!
        let redirectOutcome = Self.parseRedirectFeedback(
            finalURL: http.url,
            locationHeader: http.value(forHTTPHeaderField: "Location")
        )
        if let problem = redirectOutcome.problem {
            let lower = problem.lowercased()
            if lower.contains("password") || lower.contains("step-up") || lower.contains("confirm your password") {
                throw ToolrollClientError.passwordRequired(problem)
            }
            throw ToolrollClientError.refused(problem)
        }
        if let said = redirectOutcome.said {
            return said
        }

        if (200...399).contains(http.statusCode) {
            return defaultDone
        }
        throw ToolrollClientError.httpStatus(http.statusCode, "Action failed (HTTP \(http.statusCode)).")
    }

    public static func parseRedirectFeedback(finalURL: URL?, locationHeader: String?) -> (said: String?, problem: String?) {
        let candidates: [URL] = [
            locationHeader.flatMap { URL(string: $0, relativeTo: finalURL) },
            finalURL,
        ].compactMap { $0 }

        for url in candidates {
            guard let items = URLComponents(url: url, resolvingAgainstBaseURL: true)?.queryItems else { continue }
            if let problem = items.first(where: { $0.name == "problem" })?.value, !problem.isEmpty {
                return (nil, problem)
            }
            if let said = items.first(where: { $0.name == "said" })?.value, !said.isEmpty {
                return (said, nil)
            }
        }
        return (nil, nil)
    }

    // MARK: - Core Engine Reads

    public func fetchWorkRows() async throws -> WorkRowsResponse {
        try await send(try makeRequest(path: "/work/rows"), as: WorkRowsResponse.self)
    }

    public func fetchSteps(taskId: String) async throws -> StepCardsResponse {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        return try await send(try makeRequest(path: "/t/\(enc)/steps"), as: StepCardsResponse.self)
    }

    public func fetchApprovalCard(taskId: String) async throws -> ApprovalCard {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        return try await send(
            try makeRequest(path: "/t/\(enc)/approval", includeMutationKey: true),
            as: ApprovalCard.self
        )
    }

    public func fetchDiff(taskId: String, runId: Int? = nil) async throws -> ResultDiffResponse {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        let q = runId.map { "?run=\($0)" } ?? ""
        return try await send(try makeRequest(path: "/t/\(enc)/diff\(q)"), as: ResultDiffResponse.self)
    }

    public func fetchDiffFile(taskId: String, fileIndex: Int, runId: Int? = nil) async throws -> ResultDiffFileResponse {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        var comps = URLComponents()
        comps.queryItems = [URLQueryItem(name: "file", value: String(fileIndex))]
        if let runId { comps.queryItems?.append(URLQueryItem(name: "run", value: String(runId))) }
        let query = comps.percentEncodedQuery.map { "?\($0)" } ?? ""
        return try await send(try makeRequest(path: "/t/\(enc)/diff\(query)"), as: ResultDiffFileResponse.self)
    }

    public func fetchPresence() async throws -> PresenceSnapshot {
        try await send(try makeRequest(path: "/api/presence"), as: PresenceSnapshot.self)
    }

    public func fetchCandidates(taskId: String) async throws -> CandidatesListResponse {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        return try await send(try makeRequest(path: "/api/handoff/task/\(enc)/candidates"), as: CandidatesListResponse.self)
    }

    public func fetchTerminals() async throws -> TermStateResponse {
        if transport.isLocalSession {
            if let local = try? await send(try makeRequest(path: "/term/state"), as: TermStateResponse.self) {
                return local
            }
            return TermStateResponse(available: true, problem: nil, programs: ["shell", "claude", "codex", "antigravity"], sessions: [])
        }
        return try await send(try makeRequest(path: "/api/handoff/terminals"), as: TermStateResponse.self)
    }

    public func fetchLeadChat(project: String? = nil) async throws -> LeadChatResponse {
        let path: String
        if let project, !project.isEmpty,
           let enc = project.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path = "/engine/chat?project=\(enc)"
        } else {
            path = "/engine/chat"
        }
        return try await send(try makeRequest(path: path), as: LeadChatResponse.self)
    }

    public func fetchAgents() async throws -> AgentsReadResponse {
        try await send(try makeRequest(path: "/engine/agents"), as: AgentsReadResponse.self)
    }

    public func checkAgents() async throws -> AgentsReadResponse {
        guard case .localSession(let s) = transport else {
            return try await fetchAgents()
        }
        let body = "csrf=\(s.csrf.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s.csrf)"
        let req = try makeRequest(
            path: "/engine/agents/check",
            method: "POST",
            body: Data(body.utf8),
            contentType: "application/x-www-form-urlencoded",
            accept: "application/json",
            includeMutationKey: true
        )
        return try await send(req, as: AgentsReadResponse.self)
    }

    /// Starts Toolroll's built-in trusted agent sign-in or install terminal (`POST /term/agent/sign-in` or `/install`).
    public func startAgentTerminal(kind: String, agentId: String, confirmCommand: String? = nil) async throws -> String {
        struct TermStartReply: Decodable {
            let ok: Bool?
            let id: String?
            let error: String?
        }
        guard case .localSession(let s) = transport else {
            throw ToolrollClientError.refused("Agent setup requires a local Toolroll session on this Mac.")
        }
        var items = [
            URLQueryItem(name: "csrf", value: s.csrf),
            URLQueryItem(name: "agent", value: agentId),
        ]
        if let confirmCommand {
            items.append(URLQueryItem(name: "confirm", value: confirmCommand))
        }
        var comps = URLComponents()
        comps.queryItems = items
        let form = comps.percentEncodedQuery ?? ""
        let req = try makeRequest(
            path: "/term/agent/\(kind)",
            method: "POST",
            body: Data(form.utf8),
            contentType: "application/x-www-form-urlencoded",
            accept: "application/json",
            includeMutationKey: true
        )
        let reply = try await send(req, as: TermStartReply.self)
        if let id = reply.id, !id.isEmpty {
            return id
        }
        throw ToolrollClientError.refused(reply.error ?? "Could not start agent \(kind).")
    }

    public func fetchModels() async throws -> ModelsReadResponse {
        try await send(try makeRequest(path: "/engine/models"), as: ModelsReadResponse.self)
    }

    public func updateModels(digest: String, fields: [String: String], password: String = "") async throws -> String {
        var formFields: [(String, String)] = [
            ("digest", digest),
            ("scope", "installation"),
            ("password", password),
        ]
        for (k, v) in fields.sorted(by: { $0.key < $1.key }) {
            formFields.append((k, v))
        }
        return try await sendFormAct(
            path: "/settings/models/agent",
            fields: formFields,
            defaultDone: "Updated model selection."
        )
    }

    /// Probes installed local CLIs (claude, codex, gemini) and refreshes the live model catalog from OpenRouter/providers.
    public func checkModelCatalog() async throws -> String {
        return try await sendFormAct(
            path: "/settings/models/check",
            fields: [],
            defaultDone: "Checked for installed agents & new models."
        )
    }

    public func fetchLiveRunWindow(runId: Int, cursor: String? = nil) async throws -> LiveRunWindowResponse {
        var path = "/agents/live/run/\(runId)?file=main"
        if let cursor, !cursor.isEmpty,
           let enc = cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "&cursor=\(enc)"
        }
        return try await send(try makeRequest(path: path), as: LiveRunWindowResponse.self)
    }

    public func saveRunComment(runId: Int, note: String, path filePath: String = "", line: Int? = nil) async throws -> String {
        return try await sendFormAct(
            path: "/r/\(runId)/comment",
            fields: [
                ("note", note),
                ("request", UUID().uuidString.lowercased()),
                ("path", filePath),
                ("line", line.map(String.init) ?? ""),
            ],
            defaultDone: "Review note saved."
        )
    }

    public func openLocalProject(path folderPath: String) async throws -> String {
        return try await sendFormAct(
            path: "/projects/open",
            fields: [
                ("path", folderPath),
                ("via", "path"),
                ("return", "/work"),
            ],
            defaultDone: "Added project \((folderPath as NSString).lastPathComponent)."
        )
    }

    /// Official 2-step worktree setup approval (`POST /control/setup-preview` -> `POST /control/setup-approve`)
    /// so users can approve a per-repo setup command (e.g. `pnpm install --frozen-lockfile`) directly inside Toolroll.app.
    public func approveProjectWorktreeSetup(
        repo: String,
        provider: String,
        model: String,
        command: String,
        timeoutSeconds: Int = 300,
        password: String
    ) async throws -> String {
        guard case .localSession(let creds) = transport else {
            throw ToolrollClientError.refused("Project worktree setup requires a local Toolroll session.")
        }
        let previewFields: [(String, String)] = [
            ("csrf", creds.csrf),
            ("repo", repo),
            ("provider", provider),
            ("model", model),
            ("command", command),
            ("seconds", String(timeoutSeconds)),
        ]
        var comps = URLComponents()
        comps.queryItems = previewFields.map { URLQueryItem(name: $0.0, value: $0.1) }
        let formBody = comps.percentEncodedQuery ?? ""
        let previewReq = try makeRequest(
            path: "/control/setup-preview",
            method: "POST",
            body: Data(formBody.utf8),
            contentType: "application/x-www-form-urlencoded",
            accept: "text/html",
            includeMutationKey: true
        )
        let (previewData, previewResp) = try await session.data(for: previewReq)
        let previewHTML = String(data: previewData, encoding: .utf8) ?? ""
        let status = (previewResp as? HTTPURLResponse)?.statusCode ?? 0
        guard status >= 200 && status < 300 else {
            throw ToolrollClientError.refused("Could not preview worktree setup (HTTP \(status)).")
        }

        func extractHidden(_ name: String) -> String? {
            let pattern1 = #"name=""# + name + #""[^>]*value="([^"]+)""#
            let pattern2 = #"value="([^"]+)"[^>]*name=""# + name + #"""#
            for pat in [pattern1, pattern2] {
                if let re = try? NSRegularExpression(pattern: pat),
                   let m = re.firstMatch(in: previewHTML, range: NSRange(previewHTML.startIndex..., in: previewHTML)),
                   m.numberOfRanges > 1,
                   let r = Range(m.range(at: 1), in: previewHTML) {
                    return String(previewHTML[r])
                }
            }
            return nil
        }

        guard let nonce = extractHidden("nonce"), let fingerprint = extractHidden("fingerprint") else {
            throw ToolrollClientError.refused("Setup preview did not return an approval nonce — check your model selection and try again.")
        }

        return try await sendFormAct(
            path: "/control/setup-approve",
            fields: [
                ("repo", repo),
                ("nonce", nonce),
                ("fingerprint", fingerprint),
                ("provider", provider),
                ("model", model),
                ("command", command),
                ("seconds", String(timeoutSeconds)),
                ("token", password),
            ],
            defaultDone: "Approved worktree setup (`\(command)`) for \((repo as NSString).lastPathComponent)."
        )
    }

    public func sendLeadMessage(message: String, project: String? = nil) async throws -> String {
        if case .localSession(let s) = transport {
            var fields = [
                ("message", message),
                ("request", UUID().uuidString.lowercased()),
            ]
            if let project, !project.isEmpty { fields.append(("project", project)) }
            _ = s
            return try await sendFormAct(path: "/chat", fields: fields, defaultDone: "Sent to Lead.")
        }
        struct ChatReply: Codable { let ok: Bool?; let message: String?; let problem: String?; let error: String? }
        var items = [
            URLQueryItem(name: "message", value: message),
            URLQueryItem(name: "request", value: UUID().uuidString.lowercased()),
        ]
        if let project, !project.isEmpty {
            items.append(URLQueryItem(name: "project", value: project))
        }
        var comps = URLComponents()
        comps.queryItems = items
        let form = comps.percentEncodedQuery ?? ""
        let req = try makeRequest(path: "/chat", method: "POST", body: Data(form.utf8), contentType: "application/x-www-form-urlencoded")
        let reply = try await send(req, as: ChatReply.self)
        if let problem = reply.problem ?? reply.error, !problem.isEmpty {
            throw ToolrollClientError.refused(problem)
        }
        return reply.message ?? "Sent to Lead."
    }

    // MARK: - Native In-App Approvals, Reviews, Questions & Task Lifecycle

    public func approveTask(taskId: String, digest: String, nonce: String, password: String = "") async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        return try await sendFormAct(
            path: "/t/\(enc)/approve",
            fields: [
                ("digest", digest),
                ("nonce", nonce),
                ("token", password),
            ],
            defaultDone: "Approved. Build queued next."
        )
    }

    public func acceptResult(taskId: String, runId: Int, receipt: String) async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        if !transport.isLocalSession {
            return try await runRemoteCli(argv: ["task", "complete", taskId], defaultDone: "Accepted. Task complete.")
        }
        return try await sendFormAct(
            path: "/t/\(enc)/complete",
            fields: [
                ("receipt", receipt),
                ("run", String(runId)),
            ],
            defaultDone: "Accepted. Task complete."
        )
    }

    public func sendBackResult(taskId: String, runId: Int, source: String, note: String) async throws -> String {
        if !transport.isLocalSession {
            return try await runRemoteCli(argv: ["task", "revise", taskId, note], defaultDone: "Sent back for revision.")
        }
        return try await sendFormAct(
            path: "/r/\(runId)/comment",
            fields: [
                ("intent", "revise"),
                ("note", note),
                ("request", UUID().uuidString.lowercased()),
                ("batch", ""),
                ("source", source),
            ],
            defaultDone: "Sent back. Revision filed."
        )
    }

    public func answerQuestion(questionId: Int, optionId: String) async throws -> String {
        return try await sendFormAct(
            path: "/d/\(questionId)/answer",
            fields: [
                ("choice", optionId),
                ("confirm", "yes"),
                ("return", "next"),
            ],
            defaultDone: "Answer recorded."
        )
    }

    public func planTask(taskId: String, source: String, incident: Int? = nil) async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        var fields = [("source", source)]
        if let incident {
            fields.append(("incident", String(incident)))
        }
        return try await sendFormAct(
            path: "/t/\(enc)/plan",
            fields: fields,
            defaultDone: "Planning started. You'll approve the plan in-app before it builds."
        )
    }

    public func retryTask(taskId: String, runId: Int, digest: String) async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        if !transport.isLocalSession {
            return try await runRemoteCli(argv: ["task", "requeue", taskId], defaultDone: "Queued retry.")
        }
        return try await sendFormAct(
            path: "/t/\(enc)/requeue",
            fields: [
                ("run", String(runId)),
                ("digest", digest),
                ("return", "task"),
            ],
            defaultDone: "Retrying — new attempt queued."
        )
    }

    public func holdTask(taskId: String) async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        if !transport.isLocalSession {
            return try await runRemoteCli(argv: ["task", "hold", taskId], defaultDone: "Task paused.")
        }
        return try await sendFormAct(
            path: "/t/\(enc)/hold",
            fields: [("reason", "Paused from Toolroll Mac")],
            defaultDone: "Paused until you resume it."
        )
    }

    public func resumeHold(taskId: String, holdId: Int) async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        if !transport.isLocalSession {
            return try await runRemoteCli(argv: ["task", "unhold", taskId], defaultDone: "Task resumed.")
        }
        return try await sendFormAct(
            path: "/t/\(enc)/unhold",
            fields: [("hold", String(holdId))],
            defaultDone: "Resumed."
        )
    }

    public func stopTask(taskId: String, runId: Int) async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        if !transport.isLocalSession {
            return try await runRemoteCli(argv: ["task", "stop", taskId], defaultDone: "Stop requested.")
        }
        return try await sendFormAct(
            path: "/t/\(enc)/stop",
            fields: [("run", String(runId)), ("return", "task")],
            defaultDone: "Stopping active run."
        )
    }

    public func cancelTask(taskId: String, state: String, runId: Int?) async throws -> String {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        if !transport.isLocalSession {
            return try await runRemoteCli(argv: ["task", "stop", taskId], defaultDone: "Cancelled.")
        }
        return try await sendFormAct(
            path: "/t/\(enc)/cancel",
            fields: [
                ("state", state),
                ("run", runId.map(String.init) ?? "none"),
            ],
            defaultDone: "Task cancelled."
        )
    }

    public func createTask(title: String, project: String?, body: String, planFirst: Bool) async throws -> String {
        if !transport.isLocalSession {
            var argv = ["task", "add", title]
            if let project, !project.isEmpty { argv += ["--repo", project] }
            if !body.isEmpty { argv += ["--body", body] }
            return try await runRemoteCli(argv: argv, defaultDone: "Task filed.")
        }
        var fields = [
            ("title", title),
            ("planning-policy", "choice"),
        ]
        if planFirst {
            fields.append(("plain", "1"))
            fields.append(("plan-first", "1"))
        }
        if let project, !project.isEmpty {
            fields.append(("repo", project))
        }
        if !body.isEmpty {
            fields.append(("goal", body))
        }
        return try await sendFormAct(
            path: "/tasks/add",
            fields: fields,
            defaultDone: planFirst ? "Filed. A plan comes first." : "Filed."
        )
    }

    public func steerTask(taskId: String, note: String, liveRun: Int? = nil) async throws -> String {
        if transport.isLocalSession, let runId = liveRun {
            let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
            return try await sendFormAct(
                path: "/t/\(enc)/steer",
                fields: [
                    ("note", note),
                    ("return", "task"),
                    ("run", String(runId)),
                    ("key", UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(24).description),
                ],
                defaultDone: "Steering note delivered."
            )
        }
        return try await runRemoteCli(argv: ["task", "steer", taskId, note], defaultDone: "Steering note delivered.")
    }

    private func runRemoteCli(argv: [String], defaultDone: String) async throws -> String {
        struct CliReply: Codable { let ok: Bool?; let message: String?; let stdout: String?; let stderr: String?; let error: String?; let exit: Int? }
        let payload = try JSONSerialization.data(withJSONObject: ["argv": argv, "files": []])
        let res = try await send(try makeRequest(path: "/api/cli", method: "POST", body: payload), as: CliReply.self)
        if let code = res.exit, code != 0 {
            throw ToolrollClientError.refused(res.stderr ?? res.error ?? res.message ?? "Command failed.")
        }
        return res.message ?? res.stdout?.trimmingCharacters(in: .whitespacesAndNewlines) ?? defaultDone
    }

    // MARK: - Multiplayer & Candidate Mutations

    public func assignTaskPerson(taskId: String, person: String, why: String = "") async throws -> AssignPersonResponse {
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        let payload = try JSONSerialization.data(withJSONObject: ["person": person, "why": why])
        return try await send(
            try makeRequest(path: "/api/handoff/task/\(enc)/assign-person", method: "POST", body: payload),
            as: AssignPersonResponse.self
        )
    }

    public func promoteCandidate(taskId: String, candidateId: String) async throws -> PromoteCandidateResponse {
        let encT = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        let encC = candidateId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? candidateId
        return try await send(
            try makeRequest(path: "/api/handoff/task/\(encT)/candidate/\(encC)/promote", method: "POST", body: Data("{}".utf8)),
            as: PromoteCandidateResponse.self
        )
    }

    public func openCandidatePr(taskId: String, candidateId: String) async throws -> OpenCandidatePrResponse {
        let encT = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        let encC = candidateId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? candidateId
        return try await send(
            try makeRequest(path: "/api/handoff/task/\(encT)/candidate/\(encC)/open-pr", method: "POST", body: Data("{}".utf8)),
            as: OpenCandidatePrResponse.self
        )
    }

    public func startOrReuseTerminal(
        taskId: String,
        project: String? = nil,
        runId: Int? = nil,
        program: String = "shell"
    ) async throws -> StartRemoteTerminalResponse {
        switch transport {
        case .localSession(let s):
            // 1. Check /term/state for an existing live session bound specifically to THIS task
            let state = try? await fetchTerminals()
            if let existingForTask = state?.sessions.first(where: {
                $0.endedAt == nil && $0.program == program && $0.task == taskId
                    && (runId == nil || $0.run == nil || $0.run == runId)
            }) {
                return StartRemoteTerminalResponse(
                    ok: true,
                    id: existingForTask.id,
                    branch: existingForTask.branch,
                    program: existingForTask.program,
                    reused: true
                )
            }

            let resolvedRepo: String? = {
                guard let projects = state?.projects else { return nil }
                if let p = project, !p.isEmpty,
                   let match = projects.first(where: { $0.name.lowercased() == p.lowercased() || $0.path.hasSuffix("/\(p)") }) {
                    return match.path
                }
                return projects.first?.path
            }()

            // 2. Always try task+run take-over FIRST when a build run exists so Shell opens on the agent's exact build commit!
            if let runId {
                if let started = try? await postLocalTermStart(csrf: s.csrf, program: program, taskId: taskId, runId: runId, repo: nil) {
                    let branch = (try? await fetchTerminals().sessions.first(where: { $0.id == started })?.branch) ?? "tr/\(taskId)"
                    return StartRemoteTerminalResponse(ok: true, id: started, branch: branch, program: program, reused: false)
                }
            }

            // 3. No committed build available to take over yet: reuse or start a repo-level scratch shell
            if let existingForProject = state?.sessions.first(where: {
                $0.endedAt == nil && $0.program == program && $0.task == nil && project != nil && $0.project == project
            }) {
                return StartRemoteTerminalResponse(
                    ok: true,
                    id: existingForProject.id,
                    branch: existingForProject.branch,
                    program: existingForProject.program,
                    reused: true
                )
            }

            guard let repo = resolvedRepo else {
                throw ToolrollClientError.refused("No project repository is registered with the local Toolroll engine yet.")
            }
            let startedId = try await postLocalTermStart(csrf: s.csrf, program: program, taskId: nil, runId: nil, repo: repo)
            let branch = (try? await fetchTerminals().sessions.first(where: { $0.id == startedId })?.branch) ?? "main"
            return StartRemoteTerminalResponse(ok: true, id: startedId, branch: branch, program: program, reused: false)

        case .remoteBearer:
            let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
            let payload = try JSONSerialization.data(withJSONObject: ["program": program])
            return try await send(
                try makeRequest(path: "/api/handoff/task/\(enc)/terminal", method: "POST", body: payload),
                as: StartRemoteTerminalResponse.self
            )
        }
    }

    private func postLocalTermStart(
        csrf: String,
        program: String,
        taskId: String?,
        runId: Int?,
        repo: String?
    ) async throws -> String {
        var items: [URLQueryItem] = [
            URLQueryItem(name: "csrf", value: csrf),
            URLQueryItem(name: "program", value: program),
            URLQueryItem(name: "password", value: ""),
        ]
        if let taskId, let runId {
            items.append(URLQueryItem(name: "task", value: taskId))
            items.append(URLQueryItem(name: "run", value: String(runId)))
        } else if let repo {
            items.append(URLQueryItem(name: "repo", value: repo))
        }
        var comps = URLComponents()
        comps.queryItems = items
        let formBody = comps.percentEncodedQuery ?? ""
        let req = try makeRequest(
            path: "/term/start",
            method: "POST",
            body: Data(formBody.utf8),
            contentType: "application/x-www-form-urlencoded",
            accept: "application/json",
            includeMutationKey: true
        )
        let (data, response) = try await session.data(for: req)
        struct LocalTermReply: Codable {
            let ok: Bool?
            let id: String?
            let error: String?
        }
        let reply = try? JSONDecoder().decode(LocalTermReply.self, from: data)
        if let id = reply?.id, !id.isEmpty {
            return id
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        throw ToolrollClientError.refused(reply?.error ?? "Could not start \(program) terminal (HTTP \(status)).")
    }

    public func pingApproval(taskId: String) async throws -> String {
        struct PingReply: Codable { let ok: Bool; let channels: [String]?; let url: String?; let path: String? }
        let enc = taskId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? taskId
        let res = try await send(
            try makeRequest(path: "/api/handoff/task/\(enc)/approval-ping", method: "POST", body: Data("{}".utf8)),
            as: PingReply.self
        )
        let ch = (res.channels ?? []).joined(separator: ", ")
        return ch.isEmpty ? "Approval link ready (\(res.url ?? res.path ?? "/t/\(taskId)"))." : "Sent approval ping via \(ch)."
    }

    // MARK: - Browser-Assisted Device Pairing (Static, Pre-Auth)

    public static func startDevicePairing(origin rawOrigin: String, label: String = "Toolroll Mac", session: URLSession = .shared) async throws -> DevicePairStartResponse {
        let base = try normalizedOrigin(rawOrigin)
        guard let url = URL(string: "/api/connect/pair/start", relativeTo: base) else {
            throw ToolrollClientError.invalidOrigin(rawOrigin)
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["label": label])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            throw ToolrollClientError.httpStatus(code, "Could not start browser pairing.")
        }
        return try JSONDecoder().decode(DevicePairStartResponse.self, from: data)
    }

    public static func pollDevicePairing(origin rawOrigin: String, pairId: String, pollSecret: String, session: URLSession = .shared) async throws -> DevicePairPollResponse {
        let base = try normalizedOrigin(rawOrigin)
        guard let url = URL(string: "/api/connect/pair/poll", relativeTo: base) else {
            throw ToolrollClientError.invalidOrigin(rawOrigin)
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["pairId": pairId, "pollSecret": pollSecret])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            throw ToolrollClientError.httpStatus(code, "Pairing poll failed.")
        }
        return try JSONDecoder().decode(DevicePairPollResponse.self, from: data)
    }

    // MARK: - Real-Time SSE Stream (GET /live?room=...)

    public func streamLive(rooms: [String]) -> AsyncStream<LiveSignal> {
        let reqResult = Result { () throws -> URLRequest in
            var comps = URLComponents()
            comps.queryItems = rooms.map { URLQueryItem(name: "room", value: $0) }
            let query = comps.percentEncodedQuery.map { "?\($0)" } ?? ""
            var r = try makeRequest(path: "/live\(query)", accept: "text/event-stream")
            r.timeoutInterval = 3600
            return r
        }
        let urlSession = self.session
        return AsyncStream { continuation in
            let task = Task {
                guard case .success(let request) = reqResult else {
                    continuation.yield(.ended)
                    continuation.finish()
                    return
                }
                do {
                    let (bytes, response) = try await urlSession.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        continuation.yield(.ended)
                        continuation.finish()
                        return
                    }
                    var eventName = ""
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line.isEmpty {
                            if let sig = SSEParser.parseFrame(event: eventName, data: dataLines.joined(separator: "\n")) {
                                continuation.yield(sig)
                            }
                            eventName = ""
                            dataLines.removeAll(keepingCapacity: true)
                        } else if line.hasPrefix("event:") {
                            eventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            dataLines.append(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
                        }
                    }
                } catch {
                    // Network drop ends this stream; WorkbenchStore reconnects cleanly.
                }
                continuation.yield(.ended)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func webSocketRequest(terminalId: String) throws -> URLRequest {
        let base = try Self.normalizedOrigin(transport.origin)
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.scheme = (base.scheme == "https") ? "wss" : "ws"
        comps.path = "/term/\(terminalId)/socket"
        guard let url = comps.url else {
            throw ToolrollClientError.invalidOrigin(terminalId)
        }
        var req = URLRequest(url: url, timeoutInterval: 30)
        switch transport {
        case .localSession(let s):
            if s.key.isEmpty {
                req.setValue("toolroll", forHTTPHeaderField: "Sec-WebSocket-Protocol")
            } else {
                req.setValue("toolroll, toolroll.key.\(s.key)", forHTTPHeaderField: "Sec-WebSocket-Protocol")
                req.setValue(s.key, forHTTPHeaderField: "x-toolroll-key")
            }
            req.setValue("terminal", forHTTPHeaderField: "x-toolroll-client")
            req.setValue(s.cookieHeader, forHTTPHeaderField: "Cookie")
            req.setValue(s.origin, forHTTPHeaderField: "Origin")
        case .remoteBearer(let p):
            req.setValue("toolroll", forHTTPHeaderField: "Sec-WebSocket-Protocol")
            req.setValue("terminal-remote", forHTTPHeaderField: "x-toolroll-client")
            if !p.token.isEmpty {
                req.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
            }
            if let ws = p.workspaceId, !ws.isEmpty {
                req.setValue(ws, forHTTPHeaderField: "x-toolroll-workspace")
            }
            if let rec = p.recoveryGeneration, !rec.isEmpty {
                req.setValue(rec, forHTTPHeaderField: "x-toolroll-recovery")
            }
        }
        return req
    }
}

public enum SSEParser {
    public static func parseFrame(event: String, data: String) -> LiveSignal? {
        if event == "reload" { return .reload }
        guard let jsonData = data.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
        else {
            return nil
        }
        let room = obj["room"] as? String ?? "home"
        if event == "change" { return .change(room: room) }
        if event == "turn" { return .turn(room: room) }
        return nil
    }
}
