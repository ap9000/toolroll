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
    public private(set) var sseConnected: Bool = false
    public private(set) var isLoading: Bool = false
    public private(set) var busyLabel: String?
    public var notice: WorkbenchNotice?

    // Filters & Layout
    public var selectedProject: String? = nil
    public var teamFilter: TeamFilter = .everyone
    public var sidebarSearch: String = ""
    public var isInspectorVisible: Bool = true
    public var inspectorTab: InspectorTab = .terminal
    public var isCommandPaletteOpen: Bool = false
    public var isPairSheetOpen: Bool = false
    public var isFinishedDrawerOpen: Bool = false

    // Engine State
    public private(set) var workRowsResponse: WorkRowsResponse = WorkRowsResponse()
    public private(set) var presence: PresenceSnapshot = PresenceSnapshot()
    public private(set) var selectedTaskId: String?
    public private(set) var stepCards: StepCardsResponse?
    public private(set) var candidatesResponse: CandidatesListResponse?
    public private(set) var diffResponse: ResultDiffResponse?
    public private(set) var selectedDiffPath: String?
    public private(set) var selectedDiffFile: ResultDiffFileResponse?
    public private(set) var terminalsResponse: TermStateResponse?
    public private(set) var leadChat: LeadChatResponse = LeadChatResponse()

    // Live Terminal
    public let terminalSession = LiveTerminalSession()

    private let profileStore: ProfileStore
    private var client: ToolrollClient?
    private var sseTask: Task<Void, Never>?
    private var sseRooms: [String] = []

    public init(profileStore: ProfileStore = ProfileStore()) {
        self.profileStore = profileStore
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

    // MARK: - Computed Views

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
        await refreshAll()
        if selectedTaskId == nil, let first = needsRows.first ?? runningRows.first ?? workRowsResponse.rows.first {
            await selectTask(first.id)
        }
        restartSSE()
    }

    public func switchProfile(name: String) async {
        let loaded = profileStore.load()
        if let target = loaded.profiles.first(where: { $0.name == name }) {
            try? profileStore.setActive(name: name)
            profiles = loaded.profiles
            activeProfile = target
            client = ToolrollClient(profile: target)
        } else if name == "demo" {
            let demo = ProfileStore.demoProfile()
            activeProfile = demo
            client = nil
        }
        terminalSession.disconnect(clearOutput: true)
        selectedTaskId = nil
        notice = nil
        await start()
    }

    public func savePairedProfile(_ profile: ConnectionProfile) async {
        do {
            try profileStore.save(profile: profile, makeActive: true)
            let loaded = profileStore.load()
            profiles = loaded.profiles
            activeProfile = profile
            client = ToolrollClient(profile: profile)
            isPairSheetOpen = false
            terminalSession.disconnect(clearOutput: true)
            selectedTaskId = nil
            notice = WorkbenchNotice(kind: .info, message: "Connected to \(profile.displayTitle) as \(profile.account).")
            await start()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: "Could not save profile: \(error.localizedDescription)")
        }
    }

    public func reloadProfilesFromDisk() {
        let loaded = profileStore.load()
        if !loaded.profiles.isEmpty {
            profiles = loaded.profiles
        }
    }

    // MARK: - Data Fetching

    public func refreshAll() async {
        isLoading = true
        defer { isLoading = false }

        if activeProfile.isDemo {
            workRowsResponse = DemoFixtures.workRows
            presence = DemoFixtures.presence
            leadChat = DemoFixtures.leadChat
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

            workRowsResponse = try await rowsReq
            if let pres = try? await presReq { presence = pres }
            if let terms = try? await termsReq { terminalsResponse = terms }
            if let chat = try? await leadReq { leadChat = chat }

            if let id = selectedTaskId {
                await loadSelectedTaskDetails(taskId: id)
            }
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func selectTask(_ taskId: String) async {
        guard selectedTaskId != taskId || stepCards?.task.id != taskId else { return }
        selectedTaskId = taskId
        selectedDiffPath = nil
        selectedDiffFile = nil
        await loadSelectedTaskDetails(taskId: taskId)
        restartSSE()
    }

    public func loadSelectedTaskDetails(taskId: String) async {
        if activeProfile.isDemo {
            stepCards = DemoFixtures.steps(for: taskId)
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

        if let steps = try? await stepsReq { stepCards = steps }
        if let cands = try? await candsReq { candidatesResponse = cands }
        if let diff = try? await diffReq {
            diffResponse = diff
            if let first = diff.files.first?.path, selectedDiffPath == nil || !diff.files.contains(where: { $0.path == selectedDiffPath }) {
                await selectDiffFile(path: first)
            }
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

    // MARK: - Multiplayer & Task Actions

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
                        id: c.id,
                        author: c.author,
                        createdAt: c.createdAt,
                        files: c.files,
                        note: c.note,
                        stale: false,
                        promotedAt: "just now",
                        promotedBy: "alex",
                        runId: 15,
                        branch: "tr/\(taskId)/c-\(c.id.prefix(6))",
                        headCommit: "9ab4c102",
                        checkStatus: "passed",
                        liveCheckState: "passed",
                        publication: nil,
                        canOpenPr: true
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
                        id: c.id,
                        author: c.author,
                        createdAt: c.createdAt,
                        files: c.files,
                        note: c.note,
                        stale: c.stale,
                        promotedAt: c.promotedAt,
                        promotedBy: c.promotedBy,
                        runId: c.runId,
                        branch: c.branch,
                        headCommit: c.headCommit,
                        checkStatus: c.checkStatus,
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
            let reply = try await client.steerTask(taskId: taskId, note: trimmed)
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
            notice = WorkbenchNotice(kind: .info, message: "Sent approval ping to browser & phone for \(taskId).")
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
            msgs.append(LeadMessage(id: nextId + 1, role: "assistant", text: "Demo mode: connect a live Toolroll workspace (⌘⇧P) to chat with your real central Lead.", at: "now"))
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
            notice = WorkbenchNotice(kind: .info, message: "Demo mode — pair a live workspace to open \(taskId) in your browser.")
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
