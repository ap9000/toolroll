import AppKit
import Foundation
import Observation
import ToolrollCore

public enum TeamFilter: String, CaseIterable, Identifiable, Sendable {
    case everyone = "Everyone"
    case mine = "Mine"
    case team = "Team"
    case unassigned = "Unassigned"
    public var id: String { rawValue }
}

public enum InspectorTab: String, CaseIterable, Identifiable, Sendable {
    case terminal = "Terminal"
    case diff = "Diff"
    case lead = "Lead"
    public var id: String { rawValue }
}

public struct WorkbenchNotice: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case info
        case refusal
    }
    public let kind: Kind
    public let message: String
}

/// Central @Observable state coordinator for the native Toolroll Mac workbench.
@MainActor
@Observable
public final class WorkbenchStore {
    // Profiles & Connection
    public private(set) var profiles: [ConnectionProfile] = []
    public private(set) var activeProfile: ConnectionProfile
    public private(set) var isLocalSession: Bool = false
    public private(set) var sseConnected: Bool = false
    public private(set) var isLoading: Bool = false
    public private(set) var busyLabel: String?
    public var notice: WorkbenchNotice?

    // Filters & Layout
    public var selectedProject: String? = nil
    public var teamFilter: TeamFilter = .everyone
    public var sidebarSearch: String = ""
    public var isSidebarVisible: Bool = true
    public var isInspectorVisible: Bool = false
    public var inspectorTab: InspectorTab = .diff
    public var isCommandPaletteOpen: Bool = false
    public var isPairSheetOpen: Bool = false
    public var isNewTaskSheetOpen: Bool = false
    public var isComposingNewWork: Bool = false
    public var isSetupOpen: Bool = false
    public var isSettledExpanded: Bool = false
    public var settledDisplayLimit: Int = 10

    // Navigation History (← / →)
    private var backStack: [String?] = []
    private var forwardStack: [String?] = []
    public var canGoBack: Bool { !backStack.isEmpty }
    public var canGoForward: Bool { !forwardStack.isEmpty }

    // Engine State
    public private(set) var workRowsResponse: WorkRowsResponse = WorkRowsResponse()
    public private(set) var presence: PresenceSnapshot = PresenceSnapshot()
    public private(set) var agentsRead: AgentsReadResponse = AgentsReadResponse()
    public private(set) var modelsRead: ModelsReadResponse = ModelsReadResponse()
    public private(set) var selectedTaskId: String?
    public private(set) var stepCards: StepCardsResponse?
    public private(set) var liveRunRecords: [LiveAgentRecord] = []
    public private(set) var approvalCard: ApprovalCard?
    public var approvalPasswordPrompt: String?
    public var modelPasswordPrompt: String?
    private var pendingModelFields: [String: String]?
    public private(set) var candidatesResponse: CandidatesListResponse?
    public private(set) var diffResponse: ResultDiffResponse?
    public private(set) var selectedDiffPath: String?
    public private(set) var selectedDiffFile: ResultDiffFileResponse?
    public private(set) var inlineDiffComments: [InlineDiffComment] = []
    public private(set) var terminalsResponse: TermStateResponse?
    public private(set) var leadChat: LeadChatResponse = LeadChatResponse()

    // Live Terminal
    public let terminalSession = LiveTerminalSession()

    private let profileStore: ProfileStore
    private var client: ToolrollClient?
    private var sseTask: Task<Void, Never>?
    private var sseRooms: [String] = []
    private var demoApprovedTasks: Set<String> = []

    public init(profileStore: ProfileStore = ProfileStore()) {
        self.profileStore = profileStore
        self.isSetupOpen = !UserDefaults.standard.bool(forKey: "toolroll.setupCompletedV1")
        let loaded = profileStore.load()
        if let active = loaded.active {
            self.profiles = loaded.profiles
            self.activeProfile = active
            self.client = ToolrollClient(profile: active)
        } else {
            let demo = ProfileStore.demoProfile()
            self.profiles = [demo]
            self.activeProfile = demo
            self.client = nil
        }
    }

    public func completeSetup() {
        UserDefaults.standard.set(true, forKey: "toolroll.setupCompletedV1")
        isSetupOpen = false
    }

    public func refreshSetupState() async {
        if activeProfile.isDemo {
            // Try connecting to a newly started local Toolroll engine too!
            if await connectToLocalConsoleIfAvailable(silent: true) {
                return
            }
            agentsRead = DemoFixtures.agents
            modelsRead = DemoFixtures.models
            return
        }
        guard let client else { return }
        async let aReq = client.fetchAgents()
        async let mReq = client.fetchModels()
        if let a = try? await aReq { agentsRead = a }
        if let m = try? await mReq { modelsRead = m }
    }

    public var isTeamWorkspace: Bool {
        presence.accounts.count > 1
    }

    // MARK: - Computed Views

    public var canApproveInApp: Bool {
        isLocalSession || activeProfile.isDemo
    }

    public var allProjects: [String] {
        let names = Set(workRowsResponse.rows.compactMap(\.project).filter { !$0.isEmpty })
        return names.sorted()
    }

    public var filteredRows: [WorkRow] {
        workRowsResponse.rows.filter { row in
            if let proj = selectedProject, row.project != proj {
                return false
            }
            let owner = presence.owners[row.id] ?? nil
            switch teamFilter {
            case .everyone:
                break
            case .mine:
                if owner != presence.me { return false }
            case .team:
                if owner == nil || owner == presence.me { return false }
            case .unassigned:
                if owner != nil { return false }
            }
            let q = sidebarSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !q.isEmpty {
                let hay = "\(row.title) \(row.id) \(row.project ?? "") \(owner ?? "")".lowercased()
                if !hay.contains(q) { return false }
            }
            return true
        }
    }

    public var needsRows: [WorkRow] { filteredRows.filter { $0.status == .needs } }
    public var runningRows: [WorkRow] { filteredRows.filter { $0.status == .running } }
    public var queuedRows: [WorkRow] { filteredRows.filter { $0.status == .queued } }
    public var failedRows: [WorkRow] { filteredRows.filter { $0.status == .failed } }
    public var finishedRows: [WorkRow] { filteredRows.filter { $0.status == .finished || $0.status == .unknown } }

    /// Settled work (Finished + Failed) pinned cleanly to the bottom expandable section of the sidebar.
    public var settledRows: [WorkRow] {
        filteredRows.filter { $0.status == .finished || $0.status == .failed || $0.status == .unknown }
    }

    public func openNewWorkCanvas() {
        if !isComposingNewWork, let current = selectedTaskId {
            backStack.append(current)
            forwardStack.removeAll()
        }
        isComposingNewWork = true
    }

    public func toggleInspector(tab: InspectorTab) {
        if isInspectorVisible && inspectorTab == tab {
            isInspectorVisible = false
        } else {
            inspectorTab = tab
            isInspectorVisible = true
        }
    }

    public func goBack() async {
        guard let prev = backStack.popLast() else { return }
        forwardStack.append(isComposingNewWork ? nil : selectedTaskId)
        if let taskId = prev {
            isComposingNewWork = false
            await selectTask(taskId, recordHistory: false)
        } else {
            isComposingNewWork = true
        }
    }

    public func goForward() async {
        guard let next = forwardStack.popLast() else { return }
        backStack.append(isComposingNewWork ? nil : selectedTaskId)
        if let taskId = next {
            isComposingNewWork = false
            await selectTask(taskId, recordHistory: false)
        } else {
            isComposingNewWork = true
        }
    }

    public func pickAndAddLocalFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add Project"
        panel.message = "Choose a local Git repository folder to add to Toolroll"
        if panel.runModal() == .OK, let url = panel.url {
            Task { await addLocalProject(path: url.path) }
        }
    }

    public func addLocalProject(path folderPath: String) async {
        busyLabel = "Adding project…"
        defer { busyLabel = nil }
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Added \((folderPath as NSString).lastPathComponent) (demo).")
            return
        }
        guard let client else { return }
        do {
            let reply = try await client.openLocalProject(path: folderPath)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    // MARK: - Live Model Selection (POST /settings/models/agent)

    public func selectModel(value: String, label: String, forRoleKey roleKey: String) async {
        var fields: [String: String] = [:]
        for role in modelsRead.roles {
            if roleKey == "all" || role.key == roleKey {
                fields[role.key] = value
            } else {
                fields[role.key] = role.current
            }
        }
        await submitModelFields(fields, friendlyLabel: label)
    }

    public func applyModelPreset(_ preset: AgentPreset) async {
        await submitModelFields(preset.fields, friendlyLabel: preset.name)
    }

    public func retryPendingModelChange(password: String) async {
        guard let fields = pendingModelFields else { return }
        await submitModelFields(fields, friendlyLabel: "model selection", password: password)
    }

    private func submitModelFields(_ fields: [String: String], friendlyLabel: String, password: String = "") async {
        busyLabel = "Switching to \(friendlyLabel)…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            let updatedRoles = modelsRead.roles.map { role -> ModelRoleSummary in
                guard let nextVal = fields[role.key] else { return role }
                let nextLabel = role.choices.flatMap(\.models).first(where: { $0.value == nextVal })?.label ?? friendlyLabel
                return ModelRoleSummary(key: role.key, label: role.label, current: nextVal, words: nextLabel, choices: role.choices)
            }
            modelsRead = ModelsReadResponse(
                version: modelsRead.version, canChange: modelsRead.canChange, digest: modelsRead.digest,
                problem: nil, defaultAgent: modelsRead.defaultAgent, roles: updatedRoles, presets: modelsRead.presets
            )
            modelPasswordPrompt = nil
            pendingModelFields = nil
            notice = WorkbenchNotice(kind: .info, message: "Switched to \(friendlyLabel).")
            return
        }

        guard let client else { return }
        do {
            let reply = try await client.updateModels(digest: modelsRead.digest, fields: fields, password: password)
            modelPasswordPrompt = nil
            pendingModelFields = nil
            notice = WorkbenchNotice(kind: .info, message: reply)
            if let refreshed = try? await client.fetchModels() {
                modelsRead = refreshed
            }
        } catch ToolrollClientError.passwordRequired(let msg) {
            pendingModelFields = fields
            modelPasswordPrompt = msg
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public var needsCount: Int {
        max(workRowsResponse.needsCount, workRowsResponse.rows.filter { $0.status == .needs }.count)
    }

    public var selectedRow: WorkRow? {
        guard let id = selectedTaskId else { return nil }
        return workRowsResponse.rows.first(where: { $0.id == id })
    }

    public var selectedTaskOwner: String? {
        guard let id = selectedTaskId else { return nil }
        return presence.owners[id] ?? nil
    }

    public var selectedTaskPresence: TaskPresence? {
        guard let id = selectedTaskId else { return nil }
        return presence.tasks[id]
    }

    public var activeTerminalCount: Int {
        if activeProfile.isDemo { return 1 }
        return terminalsResponse?.sessions.filter { $0.endedAt == nil }.count ?? 0
    }

    public func paletteItems() -> [PaletteItem] {
        CommandPaletteEngine.buildItems(
            rows: workRowsResponse.rows,
            selectedTaskId: selectedTaskId,
            presence: presence,
            candidates: candidatesResponse?.candidates ?? [],
            profiles: profiles,
            activeProfileName: activeProfile.name,
            terminalControlling: terminalSession.isControlling
        )
    }

    // MARK: - Lifecycle

    public func start() async {
        // Prefer auto-connecting to a live local Toolroll console on this Mac if no explicit remote profile is active.
        if activeProfile.isDemo {
            if await connectToLocalConsoleIfAvailable(silent: true) {
                return
            }
        }
        await refreshAll()
        if selectedTaskId == nil, let first = needsRows.first ?? runningRows.first ?? failedRows.first ?? workRowsResponse.rows.first {
            await selectTask(first.id)
        }
        restartSSE()
    }

    @discardableResult
    public func connectToLocalConsoleIfAvailable(silent: Bool = false) async -> Bool {
        if let creds = await LocalConsoleConnector.discoverAndConnect() {
            let localProf = ConnectionProfile(
                name: "local",
                origin: creds.origin,
                account: creds.account,
                token: "",
                label: "Local Toolroll (\(creds.origin.replacingOccurrences(of: "http://", with: "")))",
                isDemo: false
            )
            let loaded = profileStore.load()
            self.profiles = [localProf] + loaded.profiles.filter { $0.name != "local" }
            self.activeProfile = localProf
            self.isLocalSession = true
            self.client = ToolrollClient(localSession: creds)
            self.terminalSession.disconnect(clearOutput: true)
            self.selectedTaskId = nil
            self.notice = silent ? nil : WorkbenchNotice(kind: .info, message: "Connected to Local Toolroll at \(creds.origin) as \(creds.account).")
            await refreshAll()
            if let first = needsRows.first ?? runningRows.first ?? failedRows.first ?? workRowsResponse.rows.first {
                await selectTask(first.id)
            }
            restartSSE()
            return true
        }
        if !silent {
            notice = WorkbenchNotice(kind: .refusal, message: "No running local Toolroll console found. Run `toolroll up` or pair a remote workspace.")
        }
        return false
    }

    public func switchProfile(name: String) async {
        if name == "local" {
            _ = await connectToLocalConsoleIfAvailable(silent: false)
            return
        }
        let loaded = profileStore.load()
        if let target = loaded.profiles.first(where: { $0.name == name }) {
            try? profileStore.setActive(name: name)
            profiles = loaded.profiles
            activeProfile = target
            isLocalSession = false
            client = ToolrollClient(profile: target)
        } else if name == "demo" {
            let demo = ProfileStore.demoProfile()
            activeProfile = demo
            isLocalSession = false
            client = nil
        }
        terminalSession.disconnect(clearOutput: true)
        selectedTaskId = nil
        approvalCard = nil
        approvalPasswordPrompt = nil
        notice = nil
        await start()
    }

    public func savePairedProfile(_ profile: ConnectionProfile) async {
        do {
            try profileStore.save(profile: profile, makeActive: true)
            let loaded = profileStore.load()
            profiles = loaded.profiles
            activeProfile = profile
            isLocalSession = false
            client = ToolrollClient(profile: profile)
            isPairSheetOpen = false
            terminalSession.disconnect(clearOutput: true)
            selectedTaskId = nil
            approvalCard = nil
            approvalPasswordPrompt = nil
            notice = WorkbenchNotice(kind: .info, message: "Connected to \(profile.displayTitle) as \(profile.account).")
            await start()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: "Could not save profile: \(error.localizedDescription)")
        }
    }

    // MARK: - Data Fetching

    public func refreshAll() async {
        isLoading = true
        defer { isLoading = false }

        if activeProfile.isDemo {
            let base = DemoFixtures.workRows
            let rows = base.rows.map { row -> WorkRow in
                if demoApprovedTasks.contains(row.id) {
                    return WorkRow(
                        id: row.id, title: row.title, href: row.href, project: row.project,
                        age: row.age, status: .running, word: "Running", ask: nil,
                        chip: "Approved", group: "running", rank: row.rank, detail: "Approved in-app — build running"
                    )
                }
                return row
            }
            let needs = rows.filter { $0.status == .needs }.count
            workRowsResponse = WorkRowsResponse(
                version: base.version, project: base.project, projectName: base.projectName,
                needsCount: needs, rows: rows, room: base.room, spend: base.spend
            )
            presence = DemoFixtures.presence
            if leadChat.messages.isEmpty { leadChat = DemoFixtures.leadChat }
            sseConnected = true
            if let id = selectedTaskId {
                await loadSelectedTaskDetails(taskId: id)
            }
            return
        }

        guard let client else { return }
        do {
            async let rowsReq = client.fetchWorkRows()
            async let presReq = client.fetchPresence()
            async let termsReq = client.fetchTerminals()
            async let leadReq = client.fetchLeadChat(project: selectedProject)
            async let agentsReq = client.fetchAgents()
            async let modelsReq = client.fetchModels()

            workRowsResponse = try await rowsReq
            if let pres = try? await presReq { presence = pres }
            if let terms = try? await termsReq { terminalsResponse = terms }
            if let chat = try? await leadReq { leadChat = chat }
            if let ag = try? await agentsReq { agentsRead = ag }
            if let mod = try? await modelsReq { modelsRead = mod }

            if let id = selectedTaskId {
                await loadSelectedTaskDetails(taskId: id)
            }
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func selectTask(_ taskId: String, recordHistory: Bool = true) async {
        if recordHistory && (selectedTaskId != taskId || isComposingNewWork) {
            backStack.append(isComposingNewWork ? nil : selectedTaskId)
            forwardStack.removeAll()
        }
        isComposingNewWork = false
        guard selectedTaskId != taskId || stepCards?.task.id != taskId else { return }
        selectedTaskId = taskId
        selectedDiffPath = nil
        selectedDiffFile = nil
        approvalCard = nil
        approvalPasswordPrompt = nil
        await loadSelectedTaskDetails(taskId: taskId)
        restartSSE()
    }

    public func loadSelectedTaskDetails(taskId: String) async {
        if activeProfile.isDemo {
            stepCards = DemoFixtures.steps(for: taskId)
            liveRunRecords = (taskId == "t-handoff-rebase") ? DemoFixtures.liveRunRecords : []
            approvalCard = demoApprovedTasks.contains(taskId) ? nil : DemoFixtures.approvalCard(for: taskId)
            candidatesResponse = DemoFixtures.candidates(for: taskId)
            diffResponse = DemoFixtures.diff(for: taskId)
            if let firstPath = diffResponse?.files.first?.path {
                selectedDiffPath = firstPath
                selectedDiffFile = DemoFixtures.diffFile(path: firstPath)
            }
            if taskId == "t-handoff-rebase" && terminalSession.taskId != taskId {
                terminalSession.attachDemo(taskId: taskId, program: "shell", branch: "tr/t-handoff-rebase/c-8a2f", controller: "sam", me: "alex")
            }
            return
        }

        guard let client else { return }
        async let stepsReq = client.fetchSteps(taskId: taskId)
        async let candsReq = client.fetchCandidates(taskId: taskId)
        async let diffReq = client.fetchDiff(taskId: taskId)

        if let steps = try? await stepsReq {
            stepCards = steps
            // Load live streaming agent records for the active or latest run
            let targetRun = steps.liveRun ?? steps.review?.run ?? steps.cards.flatMap(\.runs).max()
            if let runId = targetRun, let live = try? await client.fetchLiveRunWindow(runId: runId) {
                liveRunRecords = live.records
            } else {
                liveRunRecords = []
            }

            // Fetch full digest-bound approval card natively in-app whenever approval is waiting
            let needsApproval = steps.cards.contains(where: { $0.needsYou && $0.terms != nil })
                || (selectedRow?.status == .needs && steps.review == nil && selectedRow?.need?.question == nil)
            if needsApproval && isLocalSession {
                if let card = try? await client.fetchApprovalCard(taskId: taskId), card.digest != nil {
                    approvalCard = card
                } else {
                    approvalCard = nil
                }
            } else {
                approvalCard = nil
            }
        }
        if let cands = try? await candsReq { candidatesResponse = cands }
        if let diff = try? await diffReq {
            diffResponse = diff
            if let first = diff.files.first?.path, selectedDiffPath == nil || !diff.files.contains(where: { $0.path == selectedDiffPath }) {
                await selectDiffFile(path: first)
            }
        }
    }

    public func addInlineDiffComment(path: String, line: Int, text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        inlineDiffComments.append(InlineDiffComment(path: path, line: line, text: trimmed))
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Saved review note on \(path):\(line).")
            return
        }
        guard let client, let runId = diffResponse?.run ?? stepCards?.review?.run else { return }
        do {
            let reply = try await client.saveRunComment(runId: runId, note: trimmed, path: path, line: line)
            notice = WorkbenchNotice(kind: .info, message: "\(reply) (\(path):\(line))")
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func selectDiffFile(path: String) async {
        selectedDiffPath = path
        if activeProfile.isDemo {
            selectedDiffFile = DemoFixtures.diffFile(path: path)
            return
        }
        guard let client, let taskId = selectedTaskId else { return }
        let fileIndex = diffResponse?.files.first(where: { $0.path == path })?.fileIndex ?? 0
        do {
            selectedDiffFile = try await client.fetchDiffFile(taskId: taskId, fileIndex: fileIndex, runId: diffResponse?.run)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    // MARK: - Native In-App Approvals, Reviews, Questions & Lifecycle

    public func approveSelectedTask(password: String = "") async {
        guard let taskId = selectedTaskId else { return }
        busyLabel = "Approving plan…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            demoApprovedTasks.insert(taskId)
            approvalCard = nil
            approvalPasswordPrompt = nil
            notice = WorkbenchNotice(kind: .info, message: "Approved plan for \(taskId). Build started.")
            await refreshAll()
            return
        }

        guard let client else { return }
        do {
            // Re-fetch fresh approval card if needed so nonce is live
            let card: ApprovalCard
            if let existing = approvalCard, existing.task == taskId, existing.digest != nil, existing.nonce != nil {
                card = existing
            } else {
                card = try await client.fetchApprovalCard(taskId: taskId)
                approvalCard = card
            }
            guard let digest = card.digest, let nonce = card.nonce else {
                notice = WorkbenchNotice(kind: .refusal, message: card.problem ?? "No pending approval on this task.")
                return
            }
            let reply = try await client.approveTask(taskId: taskId, digest: digest, nonce: nonce, password: password)
            approvalPasswordPrompt = nil
            approvalCard = nil
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch ToolrollClientError.passwordRequired(let msg) {
            approvalPasswordPrompt = msg
            // Mint a fresh nonce for the password submission
            if let fresh = try? await client.fetchApprovalCard(taskId: taskId) {
                approvalCard = fresh
            }
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func acceptSelectedResult() async {
        guard let taskId = stepCards?.task.id ?? selectedTaskId,
              let review = stepCards?.review
        else { return }
        busyLabel = "Accepting result…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply = try await client.acceptResult(taskId: taskId, runId: review.run, receipt: review.receipt)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func sendBackSelectedResult(note: String) async {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let taskId = stepCards?.task.id ?? selectedTaskId,
              let review = stepCards?.review
        else { return }
        busyLabel = "Sending back…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply = try await client.sendBackResult(taskId: taskId, runId: review.run, source: review.source, note: trimmed)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func answerQuestion(questionId: Int, optionId: String) async {
        busyLabel = "Sending answer…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply = try await client.answerQuestion(questionId: questionId, optionId: optionId)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func planAgainSelectedTask() async {
        guard let taskId = stepCards?.task.id ?? selectedTaskId else { return }
        busyLabel = "Starting plan…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply: String
            if let stopped = stepCards?.planStopped, let again = stopped.again {
                reply = try await client.planTask(taskId: taskId, source: again.source, incident: stopped.incident)
            } else if let ask = stepCards?.plan {
                reply = try await client.planTask(taskId: taskId, source: ask.source)
            } else {
                notice = WorkbenchNotice(kind: .refusal, message: "This task cannot be planned again right now.")
                return
            }
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func retrySelectedTask() async {
        guard let taskId = stepCards?.task.id ?? selectedTaskId,
              let retry = stepCards?.retry
        else { return }
        busyLabel = "Retrying build…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply = try await client.retryTask(taskId: taskId, runId: retry.run, digest: retry.digest)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func holdOrResumeSelectedTask() async {
        guard let taskId = stepCards?.task.id ?? selectedTaskId else { return }
        busyLabel = stepCards?.held != nil ? "Resuming…" : "Pausing…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply: String
            if let hold = stepCards?.held {
                reply = try await client.resumeHold(taskId: taskId, holdId: hold.id)
            } else {
                reply = try await client.holdTask(taskId: taskId)
            }
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func stopSelectedTask() async {
        guard let taskId = stepCards?.task.id ?? selectedTaskId,
              let runId = stepCards?.liveRun
        else { return }
        busyLabel = "Stopping run…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply = try await client.stopTask(taskId: taskId, runId: runId)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func cancelSelectedTask() async {
        guard let taskId = stepCards?.task.id ?? selectedTaskId,
              let state = stepCards?.task.state
        else { return }
        busyLabel = "Cancelling task…"
        defer { busyLabel = nil }

        guard let client else { return }
        do {
            let reply = try await client.cancelTask(taskId: taskId, state: state, runId: stepCards?.liveRun)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func createTask(title: String, project: String?, body: String, planFirst: Bool) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        busyLabel = "Filing task…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            isNewTaskSheetOpen = false
            notice = WorkbenchNotice(kind: .info, message: "Filed demo task \"\(trimmed)\".")
            return
        }
        guard let client else { return }
        do {
            let reply = try await client.createTask(title: trimmed, project: project, body: body, planFirst: planFirst)
            isNewTaskSheetOpen = false
            isComposingNewWork = false
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    // MARK: - Multiplayer & Candidate Actions

    public func handOffTask(taskId: String, to person: String) async {
        busyLabel = "Handing off to \(person)…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            var owners = presence.owners
            owners[taskId] = person
            presence = PresenceSnapshot(me: presence.me, tasks: presence.tasks, owners: owners, accounts: presence.accounts)
            notice = WorkbenchNotice(kind: .info, message: "Handed off \(taskId) to \(person).")
            return
        }
        guard let client else { return }
        do {
            let res = try await client.assignTaskPerson(taskId: taskId, person: person)
            notice = WorkbenchNotice(kind: .info, message: res.warning ?? "Assigned \(taskId) to \(res.person).")
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func promoteCandidate(taskId: String, candidateId: String) async {
        busyLabel = "Promoting Candidate…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            if let existing = candidatesResponse {
                let updated = existing.candidates.map { c -> HandoffCandidate in
                    guard c.id == candidateId else { return c }
                    return HandoffCandidate(
                        id: c.id, author: c.author, createdAt: c.createdAt, files: c.files, note: c.note,
                        stale: false, promotedAt: "just now", promotedBy: "alex", runId: 15,
                        branch: "tr/\(taskId)/c-\(c.id.prefix(6))", headCommit: "9ab4c102",
                        checkStatus: "passed", liveCheckState: "passed", publication: nil, canOpenPr: true
                    )
                }
                candidatesResponse = CandidatesListResponse(ok: true, taskId: taskId, currentBaseCommit: existing.currentBaseCommit, candidates: updated)
            }
            notice = WorkbenchNotice(kind: .info, message: "Promoted Candidate \(candidateId.prefix(8)) to Run #15 — checks passed.")
            return
        }
        guard let client else { return }
        do {
            let res = try await client.promoteCandidate(taskId: taskId, candidateId: candidateId)
            let runStr = res.runId.map { "Run #\($0)" } ?? "central Run"
            notice = WorkbenchNotice(kind: .info, message: "Promoted Candidate \(candidateId.prefix(8)) → \(runStr). Checks queued.")
            await loadSelectedTaskDetails(taskId: taskId)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func openCandidatePr(taskId: String, candidateId: String) async {
        busyLabel = "Opening Pull Request…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            if let existing = candidatesResponse {
                let updated = existing.candidates.map { c -> HandoffCandidate in
                    guard c.id == candidateId else { return c }
                    return HandoffCandidate(
                        id: c.id, author: c.author, createdAt: c.createdAt, files: c.files, note: c.note,
                        stale: c.stale, promotedAt: c.promotedAt, promotedBy: c.promotedBy, runId: c.runId,
                        branch: c.branch, headCommit: c.headCommit, checkStatus: c.checkStatus,
                        liveCheckState: c.liveCheckState,
                        publication: CandidatePublication(id: 1, state: "opened", prNumber: 488, prUrl: "https://github.com/ap9000/toolroll/pull/488"),
                        canOpenPr: false
                    )
                }
                candidatesResponse = CandidatesListResponse(ok: true, taskId: taskId, currentBaseCommit: existing.currentBaseCommit, candidates: updated)
            }
            notice = WorkbenchNotice(kind: .info, message: "Opened PR #488 for Candidate \(candidateId.prefix(8)).")
            return
        }
        guard let client else { return }
        do {
            let res = try await client.openCandidatePr(taskId: taskId, candidateId: candidateId)
            if let prNum = res.publication.prNumber {
                notice = WorkbenchNotice(kind: .info, message: "Opened PR #\(prNum) for Run #\(res.runId).")
            } else {
                notice = WorkbenchNotice(kind: .info, message: "Queued Git Push & PR publication (\(res.publication.state)) for Run #\(res.runId).")
            }
            await loadSelectedTaskDetails(taskId: taskId)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func attachOrStartTerminal(taskId: String, program: String = "shell") async {
        isInspectorVisible = true
        inspectorTab = .terminal
        busyLabel = "Attaching \(program) Live Terminal…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            terminalSession.attachDemo(taskId: taskId, program: program, branch: "tr/\(taskId)/live", controller: "sam", me: "alex")
            return
        }
        guard let client else { return }
        do {
            let started = try await client.startOrReuseTerminal(taskId: taskId, program: program)
            await terminalSession.attach(
                client: client,
                terminalId: started.id,
                taskId: taskId,
                program: started.program,
                branch: started.branch
            )
            notice = WorkbenchNotice(
                kind: .info,
                message: started.reused ? "Attached to existing \(started.program) Live Terminal." : "Started \(started.program) Live Terminal on \(started.branch)."
            )
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func steerTask(taskId: String, note: String) async {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        busyLabel = "Delivering note…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Delivered steering note to \(taskId).")
            return
        }
        guard let client else { return }
        do {
            let reply = try await client.steerTask(taskId: taskId, note: trimmed, liveRun: stepCards?.liveRun)
            notice = WorkbenchNotice(kind: .info, message: reply)
            await loadSelectedTaskDetails(taskId: taskId)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func pingApproval(taskId: String) async {
        busyLabel = "Sending approval ping…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Sent approval ping for \(taskId).")
            return
        }
        guard let client else { return }
        do {
            let reply = try await client.pingApproval(taskId: taskId)
            notice = WorkbenchNotice(kind: .info, message: reply)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func sendLeadMessage(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        busyLabel = "Sending to Lead…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            var msgs = leadChat.messages
            let nextId = (msgs.last?.id ?? 0) + 1
            msgs.append(LeadMessage(id: nextId, role: "user", text: trimmed, at: "now"))
            msgs.append(LeadMessage(id: nextId + 1, role: "assistant", text: "Demo mode: start local Toolroll (`toolroll up`) or connect a remote workspace (`⌘⇧P`) to chat with your real central Lead.", at: "now"))
            leadChat = LeadChatResponse(leadName: leadChat.leadName, canSend: true, busy: false, messages: msgs)
            return
        }
        guard let client else { return }
        do {
            _ = try await client.sendLeadMessage(message: trimmed, project: selectedProject)
            if let refreshed = try? await client.fetchLeadChat(project: selectedProject) {
                leadChat = refreshed
            }
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func openTaskInBrowser(taskId: String) {
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Demo mode — connect a workspace to open \(taskId).")
            return
        }
        let base = activeProfile.origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if let url = URL(string: "\(base)/t/\(taskId)") {
            NSWorkspace.shared.open(url)
        }
    }

    public func openExternalURL(_ raw: String) {
        if let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
        }
    }

    public func executePaletteAction(_ action: PaletteAction) async {
        isCommandPaletteOpen = false
        switch action {
        case .selectTask(let taskId):
            await selectTask(taskId)
        case .handOff(let taskId, let person):
            await handOffTask(taskId: taskId, to: person)
        case .promoteCandidate(let taskId, let candidateId):
            await promoteCandidate(taskId: taskId, candidateId: candidateId)
        case .openCandidatePr(let taskId, let candidateId):
            await openCandidatePr(taskId: taskId, candidateId: candidateId)
        case .openTerminal(let taskId, let program):
            await attachOrStartTerminal(taskId: taskId, program: program)
        case .releaseTerminalControl:
            terminalSession.releaseControl()
        case .openInBrowser(let taskId):
            openTaskInBrowser(taskId: taskId)
        case .pingApproval(let taskId):
            await pingApproval(taskId: taskId)
        case .switchInspectorTab(let tab):
            isInspectorVisible = true
            if tab == "terminal" { inspectorTab = .terminal }
            else if tab == "diff" { inspectorTab = .diff }
            else if tab == "lead" { inspectorTab = .lead }
        case .toggleInspector:
            isInspectorVisible.toggle()
        case .switchProfile(let name):
            await switchProfile(name: name)
        case .openPairWorkspace:
            isPairSheetOpen = true
        case .refreshAll:
            await refreshAll()
        }
    }

    // MARK: - Live SSE Loop

    private func restartSSE() {
        var rooms = ["home", "chat"]
        if let taskId = selectedTaskId {
            rooms.append("task:\(taskId)")
        }
        if activeProfile.isDemo {
            sseTask?.cancel()
            sseTask = nil
            sseRooms = rooms
            sseConnected = true
            return
        }
        if rooms == sseRooms && sseTask != nil { return }
        sseRooms = rooms
        sseTask?.cancel()
        guard let client else { return }

        sseTask = Task { [weak self] in
            var backoffSeconds: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                let stream = await client.streamLive(rooms: rooms)
                self.sseConnected = true
                backoffSeconds = 1
                for await signal in stream {
                    if Task.isCancelled { return }
                    switch signal {
                    case .change(let room), .turn(let room):
                        await self.handleLiveSignal(room: room)
                    case .reload:
                        await self.refreshAll()
                    case .ended:
                        self.sseConnected = false
                    }
                }
                self.sseConnected = false
                try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
                backoffSeconds = min(backoffSeconds * 2, 16)
            }
        }
    }

    private func handleLiveSignal(room: String) async {
        if room == "home" {
            await refreshAll()
        } else if room == "chat", let client {
            if let chat = try? await client.fetchLeadChat(project: selectedProject) {
                leadChat = chat
            }
        } else if room.hasPrefix("task:") {
            let taskId = String(room.dropFirst(5))
            if taskId == selectedTaskId {
                await loadSelectedTaskDetails(taskId: taskId)
            }
            if let client, let rows = try? await client.fetchWorkRows() {
                workRowsResponse = rows
            }
            if let client, let pres = try? await client.fetchPresence() {
                presence = pres
            }
        }
    }
}
