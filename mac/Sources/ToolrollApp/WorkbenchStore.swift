import AppKit
import Foundation
import Observation
import ToolrollCore
import UniformTypeIdentifiers

public enum SidebarGrouping: String, CaseIterable, Identifiable, Sendable {
    case status = "Status"
    case project = "Project"
    public var id: String { rawValue }
}

public enum TeamFilter: String, CaseIterable, Identifiable, Sendable {
    case everyone = "Everyone"
    case mine = "Mine"
    case team = "Team"
    case unassigned = "Unassigned"
    public var id: String { rawValue }
}

public enum InspectorTab: String, CaseIterable, Identifiable, Sendable {
    case artifact = "Artifact"
    case diff = "Diff"
    case terminal = "Terminal"
    case lead = "Lead"
    public var id: String { rawValue }
}

public enum WorkspaceMode: String, CaseIterable, Identifiable, Sendable {
    case workbench = "Workbench"
    case canvas = "Canvas"
    public var id: String { rawValue }
}

public enum TaskViewMode: String, CaseIterable, Identifiable, Sendable {
    case activity = "Activity"
    case terminal = "Terminal"
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

    // Filters & Layout (persisted cleanly across launches)
    public var workspaceMode: WorkspaceMode = .workbench {
        didSet { UserDefaults.standard.set(workspaceMode.rawValue, forKey: "toolroll.workspaceMode") }
    }
    public var selectedProject: String? = nil
    /// Active workspace project context for Launchpad, Canvas, and quick Terminal without filtering out other repos in the sidebar.
    public var activeProject: String? = nil
    public var sidebarGrouping: SidebarGrouping = SidebarGrouping(
        rawValue: UserDefaults.standard.string(forKey: "toolroll.sidebarGrouping") ?? ""
    ) ?? .status {
        didSet { UserDefaults.standard.set(sidebarGrouping.rawValue, forKey: "toolroll.sidebarGrouping") }
    }
    public var teamFilter: TeamFilter = .everyone
    public var sidebarSearch: String = ""
    public var isSidebarVisible: Bool = true {
        didSet { UserDefaults.standard.set(isSidebarVisible, forKey: "toolroll.sidebarVisible") }
    }
    public var isInspectorVisible: Bool = false {
        didSet { UserDefaults.standard.set(isInspectorVisible, forKey: "toolroll.inspectorVisible") }
    }
    public var inspectorTab: InspectorTab = .diff
    public var isCommandPaletteOpen: Bool = false
    public var isPairSheetOpen: Bool = false
    public var isNewTaskSheetOpen: Bool = false
    public var isAddProjectSheetOpen: Bool = false
    public var isForkSheetOpen: Bool = false
    public var isPhonePairSheetOpen: Bool = false
    public var isAppearanceSheetOpen: Bool = false
    public var taskViewMode: TaskViewMode = .activity
    private var lastKnownTaskStatuses: [String: TaskStatusTone] = [:]
    public var isComposingNewWork: Bool = false
    public var isSetupOpen: Bool = false
    public var isSettledExpanded: Bool = false
    public var settledDisplayLimit: Int = 10
    private var preZenSidebar: Bool = true
    private var preZenInspector: Bool = false

    // Native Toolroll Canvas (youiyoux port — disk tile cache + 1 managed preview server + 2-slot WebView pool)
    public let previewServer = PreviewServerManager()
    public private(set) var canvasArtboards: [CanvasArtboard] = []
    public private(set) var discoveredCanvasRoutes: [YouiScreenEntry] = []
    public private(set) var canvasPins: [CanvasPin] = []
    public private(set) var canvasProjectName: String = ""
    public private(set) var canvasProjectRoot: String? = nil
    public private(set) var canvasStateKey: String = "latest"
    public private(set) var canvasBaselineKey: String = "baseline"
    public private(set) var canvasViewport: CanvasViewportPreset = .desktop
    public private(set) var canvasBaseURL: String = ""
    public private(set) var hydratingBoardIds: Set<String> = []
    public private(set) var activeAgentSetupTitle: String? = nil
    public private(set) var localSessionCookie: (name: String, value: String, origin: String)? = nil

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
    public var modelChangeError: String?
    private var pendingModelFields: [String: String]?
    public private(set) var candidatesResponse: CandidatesListResponse?
    public private(set) var diffResponse: ResultDiffResponse?
    public private(set) var selectedDiffPath: String?
    public private(set) var selectedDiffFile: ResultDiffFileResponse?
    public private(set) var inlineDiffComments: [InlineDiffComment] = []
    public private(set) var terminalsResponse: TermStateResponse?
    public private(set) var leadChat: LeadChatResponse = LeadChatResponse()

    // Right-hand Tabbed Artifact Window
    public private(set) var openArtifacts: [WorkbenchArtifact] = []
    public var activeArtifactId: String? = nil

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
        if UserDefaults.standard.object(forKey: "toolroll.sidebarVisible") != nil {
            self.isSidebarVisible = UserDefaults.standard.bool(forKey: "toolroll.sidebarVisible")
        }
        if UserDefaults.standard.object(forKey: "toolroll.inspectorVisible") != nil {
            self.isInspectorVisible = UserDefaults.standard.bool(forKey: "toolroll.inspectorVisible")
        }
        if let savedMode = UserDefaults.standard.string(forKey: "toolroll.workspaceMode"),
           let parsed = WorkspaceMode(rawValue: savedMode) {
            self.workspaceMode = parsed
        }
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

    public func toggleZenFocus() {
        if isSidebarVisible || isInspectorVisible {
            preZenSidebar = isSidebarVisible
            preZenInspector = isInspectorVisible
            isSidebarVisible = false
            isInspectorVisible = false
        } else {
            isSidebarVisible = preZenSidebar
            isInspectorVisible = preZenInspector
        }
    }

    public func setLayoutPreset(sidebar: Bool, inspector: Bool) {
        isSidebarVisible = sidebar
        isInspectorVisible = inspector
    }

    // MARK: - Native Local Engine & 1-Click Agent Setup (Zero CLI Copy-Paste)

    public func startLocalEngine() async {
        busyLabel = "Starting Local Toolroll Engine…"
        defer { busyLabel = nil }

        let candidates = ["/opt/homebrew/bin/toolroll", "/usr/local/bin/toolroll"]
        guard let binPath = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            notice = WorkbenchNotice(kind: .refusal, message: "Could not locate local `toolroll` binary to start.")
            return
        }
        do {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: binPath)
            let dbPath = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".config/nightorders/orders.db").path
            if FileManager.default.fileExists(atPath: dbPath) {
                proc.arguments = ["up", "--laptop", "--no-open", "--db", dbPath, "--port", "4180"]
            } else {
                proc.arguments = ["up", "--laptop", "--no-open"]
            }
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            try proc.run()
            // Wait up to 6s for console socket to come online
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if await connectToLocalConsoleIfAvailable(silent: true) {
                    await refreshSetupState()
                    return
                }
            }
            notice = WorkbenchNotice(kind: .info, message: "Engine starting… click Rescan in a moment.")
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: "Could not start local engine: \(error.localizedDescription)")
        }
    }

    public func runAgentSetup(kind: String, agent: AgentRow) async {
        guard let client, isLocalSession else {
            notice = WorkbenchNotice(kind: .refusal, message: "Connect to your local Toolroll engine to \(kind) \(agent.name).")
            return
        }
        busyLabel = kind == "install" ? "Installing \(agent.name)…" : "Signing in to \(agent.name)…"
        defer { busyLabel = nil }

        do {
            let confirm = (kind == "install") ? agent.setup.install : nil
            let termId = try await client.startAgentTerminal(kind: kind, agentId: agent.id, confirmCommand: confirm)
            activeAgentSetupTitle = "\(kind == "install" ? "Installing" : "Signing in to") \(agent.name)"
            await terminalSession.attach(
                client: client,
                terminalId: termId,
                taskId: nil,
                program: agent.id,
                branch: "setup"
            )
            // Automatically take control so the user can interact directly if OAuth/prompts ask
            _ = terminalSession.requestTakeControl()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func finishAgentSetupAndRecheck() async {
        activeAgentSetupTitle = nil
        terminalSession.disconnect(clearOutput: true)
        guard let client else { return }
        busyLabel = "Rechecking agents…"
        defer { busyLabel = nil }
        if let updated = try? await client.checkAgents() {
            agentsRead = updated
        } else if let updated = try? await client.fetchAgents() {
            agentsRead = updated
        }
        if let mods = try? await client.fetchModels() {
            modelsRead = mods
        }
    }

    // MARK: - Native Toolroll Canvas (youiyoux port — disk-cached, lazy-wake, 2-slot hydration pool)

    public var draftCanvasPins: [CanvasPin] {
        canvasPins.filter(\.isDraft)
    }

    public var remainingDiscoveredRoutes: [YouiScreenEntry] {
        let activePaths = Set(canvasArtboards.map(\.path))
        return discoveredCanvasRoutes.filter { !activePaths.contains($0.path) }
    }

    public func loadCanvasForCurrentProject(forceRefresh: Bool = false) async {
        let targetProject = selectedProject ?? activeProject ?? selectedRow?.project ?? allProjects.first ?? "toolroll"
        let root = resolveLocalProjectRoot(for: targetProject)

        let projectChanged = (canvasProjectRoot != root) || (canvasProjectName != targetProject)
        canvasProjectName = targetProject
        canvasProjectRoot = root

        let stateKey = root.map { YouiCanvasStorage.gitStateKey(projectRoot: $0) } ?? "latest"
        let baselineKey = root.map { YouiCanvasStorage.mainBranchKey(projectRoot: $0) } ?? "baseline"
        canvasStateKey = stateKey
        canvasBaselineKey = baselineKey

        if projectChanged || canvasArtboards.isEmpty || forceRefresh {
            hydratingBoardIds.removeAll()
            let rawDiscovered = root.map { YouiCanvasStorage.discoverRoutes(projectRoot: $0) }
                ?? [YouiScreenEntry(route: "/", path: "/")]
            let discovered = resolveDynamicTaskRoutes(rawDiscovered)
            discoveredCanvasRoutes = discovered
            // Cap initial canvas to 8 clean artboards (remaining routes live in `+ Screen`)
            let initial = Array(discovered.prefix(8))
            canvasArtboards = YouiCanvasStorage.layoutArtboards(
                from: initial,
                projectRoot: root,
                stateKey: stateKey,
                baselineKey: baselineKey,
                columns: initial.count <= 2 ? max(1, initial.count) : 3,
                viewport: canvasViewport
            )
            canvasPins = root.map { YouiCanvasStorage.loadPins(projectRoot: $0) } ?? []
        }

        // Lazy-wake preview server ONLY if any tile is missing/stale for the current git state!
        let needsHydration = forceRefresh || canvasArtboards.contains(where: { $0.latestImagePath == nil || $0.cachedStateKey != stateKey })
        if needsHydration {
            await wakePreviewServerAndHydrate(forceAll: forceRefresh)
        }
    }

    public func wakePreviewServerAndHydrate(forceAll: Bool = false) async {
        guard let root = canvasProjectRoot else { return }
        let isToolrollRepo = (root as NSString).lastPathComponent.lowercased() == "toolroll"
        let preferredOrigin: String? = (isToolrollRepo && isLocalSession) ? activeProfile.origin : nil

        if let url = await previewServer.ensureRunning(projectRoot: root, preferredOrigin: preferredOrigin) {
            canvasBaseURL = url
            if forceAll {
                for idx in canvasArtboards.indices {
                    canvasArtboards[idx].cachedStateKey = nil
                }
            }
            pumpHydrationPool()
        } else {
            canvasBaseURL = ""
        }
    }

    public func installPreviewDependenciesAndHydrate() async {
        guard let root = canvasProjectRoot else { return }
        let isToolrollRepo = (root as NSString).lastPathComponent.lowercased() == "toolroll"
        let preferredOrigin: String? = (isToolrollRepo && isLocalSession) ? activeProfile.origin : nil

        if let url = await previewServer.installDependenciesAndRun(projectRoot: root, preferredOrigin: preferredOrigin) {
            canvasBaseURL = url
            for idx in canvasArtboards.indices {
                canvasArtboards[idx].cachedStateKey = nil
            }
            pumpHydrationPool()
        }
    }

    public func sleepPreviewServer() {
        hydratingBoardIds.removeAll()
        for idx in canvasArtboards.indices {
            canvasArtboards[idx].isHydrating = false
            canvasArtboards[idx].isLiveInteractive = false
        }
        previewServer.stopManagedServer()
    }

    /// Maintains at most 2 concurrent WebView hydrations so 8–20 screens never spike memory.
    public func pumpHydrationPool() {
        guard !canvasBaseURL.isEmpty else { return }
        let maxPool = 2
        while hydratingBoardIds.count < maxPool {
            guard let nextIdx = canvasArtboards.firstIndex(where: {
                !hydratingBoardIds.contains($0.id)
                    && ($0.latestImagePath == nil || $0.cachedStateKey != canvasStateKey)
            }) else { break }
            let id = canvasArtboards[nextIdx].id
            hydratingBoardIds.insert(id)
            canvasArtboards[nextIdx].isHydrating = true
        }
    }

    public func arrangeCanvasArtboards(viewport: CanvasViewportPreset) {
        let viewportChanged = canvasViewport != viewport
        canvasViewport = viewport
        let screens = canvasArtboards.map { YouiScreenEntry(route: $0.route, path: $0.path, sourceFile: $0.sourceFile) }
        let updated = YouiCanvasStorage.layoutArtboards(
            from: screens,
            projectRoot: canvasProjectRoot,
            stateKey: canvasStateKey,
            baselineKey: canvasBaselineKey,
            columns: screens.count <= 2 ? max(1, screens.count) : 3,
            viewport: viewport
        )
        canvasArtboards = zip(canvasArtboards, updated).map { old, next in
            var merged = next
            if !viewportChanged {
                merged.baselineImagePath = old.baselineImagePath ?? next.baselineImagePath
                merged.latestImagePath = old.latestImagePath ?? next.latestImagePath
                merged.cachedStateKey = old.cachedStateKey ?? next.cachedStateKey
            }
            merged.isLiveInteractive = old.isLiveInteractive
            merged.compareSplit = old.compareSplit
            return merged
        }
        if viewportChanged {
            Task { await wakePreviewServerAndHydrate(forceAll: false) }
        }
    }

    public func addCanvasArtboard(route: String, path: String, sourceFile: String? = nil, viewport: CanvasViewportPreset) {
        let count = canvasArtboards.count
        let col = count % 3
        let row = count / 3
        var board = CanvasArtboard(
            route: route,
            path: path,
            sourceFile: sourceFile,
            x: 60 + Double(col) * (viewport.width + 44),
            y: 56 + Double(row) * (viewport.height + 60),
            width: viewport.width,
            height: viewport.height
        )
        if let root = canvasProjectRoot {
            let cached = YouiCanvasStorage.cachedTilePath(projectRoot: root, stateKey: canvasStateKey, slug: board.slug, viewport: viewport).path
            if FileManager.default.fileExists(atPath: cached) {
                board.latestImagePath = cached
                board.baselineImagePath = cached
                board.cachedStateKey = canvasStateKey
            }
        }
        canvasArtboards.append(board)
        if board.latestImagePath == nil {
            Task { await wakePreviewServerAndHydrate(forceAll: false) }
        }
    }

    public func moveCanvasArtboard(id: String, dx: Double, dy: Double) {
        guard let idx = canvasArtboards.firstIndex(where: { $0.id == id }) else { return }
        canvasArtboards[idx].x += dx
        canvasArtboards[idx].y += dy
    }

    public func removeCanvasArtboard(id: String) {
        hydratingBoardIds.remove(id)
        canvasArtboards.removeAll { $0.id == id }
    }

    public func updateCanvasArtboardPath(id: String, newPath: String) {
        guard let idx = canvasArtboards.firstIndex(where: { $0.id == id }) else { return }
        let clean = newPath.hasPrefix("/") ? newPath : "/\(newPath)"
        canvasArtboards[idx].path = clean
        canvasArtboards[idx].route = clean
        canvasArtboards[idx].cachedStateKey = nil
        canvasArtboards[idx].latestImagePath = nil
        Task { await wakePreviewServerAndHydrate(forceAll: false) }
    }

    public func toggleArtboardLive(id: String) {
        guard let idx = canvasArtboards.firstIndex(where: { $0.id == id }) else { return }
        let turningOn = !canvasArtboards[idx].isLiveInteractive
        // Keep only 1 artboard live interactive at a time for razor-low memory
        for i in canvasArtboards.indices {
            canvasArtboards[i].isLiveInteractive = false
        }
        canvasArtboards[idx].isLiveInteractive = turningOn
        if turningOn {
            previewServer.touchActivity()
            if canvasBaseURL.isEmpty {
                Task { await wakePreviewServerAndHydrate(forceAll: false) }
            }
        }
    }

    public func setArtboardCompareSplit(id: String, split: Double) {
        guard let idx = canvasArtboards.firstIndex(where: { $0.id == id }) else { return }
        canvasArtboards[idx].compareSplit = split
    }

    public func saveArtboardSnapshot(boardId: String, pngData: Data) {
        guard let idx = canvasArtboards.firstIndex(where: { $0.id == boardId }) else { return }
        let root = canvasProjectRoot ?? NSTemporaryDirectory()
        let slug = canvasArtboards[idx].slug
        if let saved = YouiCanvasStorage.saveTilePNG(
            pngData,
            projectRoot: root,
            stateKey: canvasStateKey,
            baselineKey: canvasBaselineKey,
            slug: slug,
            viewport: canvasViewport
        ) {
            canvasArtboards[idx].baselineImagePath = saved.baseline
            canvasArtboards[idx].latestImagePath = saved.latest
            canvasArtboards[idx].cachedStateKey = canvasStateKey
        }
        canvasArtboards[idx].isHydrating = false
        hydratingBoardIds.remove(boardId)
        previewServer.touchActivity()
        pumpHydrationPool()
    }

    /// Locks the artboard's current snapshot as its persistent `Before` baseline checkpoint for visual Compare.
    @discardableResult
    public func setArtboardBaselineCheckpoint(boardId: String) -> Bool {
        guard let idx = canvasArtboards.firstIndex(where: { $0.id == boardId }),
              let latest = canvasArtboards[idx].latestImagePath,
              let root = canvasProjectRoot
        else { return false }
        if let savedPath = YouiCanvasStorage.saveBaselineCheckpoint(
            fromImagePath: latest,
            projectRoot: root,
            slug: canvasArtboards[idx].slug,
            viewport: canvasViewport
        ) {
            canvasArtboards[idx].baselineImagePath = savedPath
            return true
        }
        return false
    }

    private func resolveDynamicTaskRoutes(_ entries: [YouiScreenEntry]) -> [YouiScreenEntry] {
        let rows = workRowsResponse.rows
        guard !rows.isEmpty else { return entries }
        let knownIds = Set(rows.map(\.id))
        return entries.map { entry in
            guard entry.path.hasPrefix("/t/") else { return entry }
            let slugPart = String(entry.path.dropFirst(3)).split(separator: "/").first.map(String.init) ?? ""
            if knownIds.contains(slugPart) { return entry }
            let lower = entry.route.lowercased()
            let matched: WorkRow?
            if lower.contains("decision") || lower.contains("needs") {
                matched = rows.first(where: { $0.status == .needs }) ?? rows.first
            } else if lower.contains("running") {
                matched = rows.first(where: { $0.status == .running }) ?? rows.first
            } else if lower.contains("done") || lower.contains("finished") {
                matched = rows.first(where: { $0.status == .finished }) ?? rows.first
            } else if lower.contains("failed") {
                matched = rows.first(where: { $0.status == .failed }) ?? rows.first
            } else {
                matched = rows.first
            }
            guard let task = matched else { return entry }
            return YouiScreenEntry(route: entry.route, path: "/t/\(task.id)", sourceFile: entry.sourceFile)
        }
    }

    public func createCanvasPin(
        route: String,
        path: String,
        xFrac: Double,
        yFrac: Double,
        kind: CanvasPinKind,
        body: String,
        elementName: String? = nil,
        elementSelector: String? = nil,
        elementFile: String? = nil,
        elementLine: Int? = nil,
        screenshotPNG: Data? = nil,
        fileImmediately: Bool,
        planFirst: Bool = true
    ) async {
        let fallbackFile = elementFile ?? canvasArtboards.first(where: { $0.path == path })?.sourceFile
        let pinId = CanvasPin.newRequestId()
        var savedShot: String? = nil
        if let png = screenshotPNG, let root = canvasProjectRoot {
            savedShot = YouiCanvasStorage.savePinScreenshot(png, projectRoot: root, pinId: pinId)
        }
        let pin = CanvasPin(
            id: pinId,
            artboardRoute: route,
            artboardPath: path,
            xFrac: xFrac,
            yFrac: yFrac,
            kind: kind,
            body: body,
            author: activeProfile.account.isEmpty ? "alex" : activeProfile.account,
            elementName: elementName,
            elementSelector: elementSelector,
            elementFile: fallbackFile,
            elementLine: elementLine,
            screenshotPath: savedShot,
            isDraft: !fileImmediately
        )
        canvasPins.append(pin)

        if let root = canvasProjectRoot {
            _ = YouiCanvasStorage.writeYouiRequest(
                projectRoot: root,
                projectName: canvasProjectName.isEmpty ? "toolroll" : canvasProjectName,
                pin: pin
            )
        }

        if fileImmediately {
            await submitPins([pin], grouping: .perPin, planFirst: planFirst)
        } else {
            notice = WorkbenchNotice(kind: .info, message: "Saved draft pin on \(route) — click Create Tasks when ready.")
        }
    }

    public func deleteCanvasPin(id: String) {
        canvasPins.removeAll { $0.id == id }
    }

    public func submitDraftPins(grouping: PinBatchGrouping) async {
        let drafts = draftCanvasPins
        guard !drafts.isEmpty else { return }
        await submitPins(drafts, grouping: grouping)
    }

    public func submitPins(_ pins: [CanvasPin], grouping: PinBatchGrouping, planFirst: Bool = true) async {
        let groups: [(String, [CanvasPin])]
        switch grouping {
        case .perScreen:
            let byRoute = Dictionary(grouping: pins, by: \.artboardRoute)
            groups = byRoute.keys.sorted().map { ($0, byRoute[$0] ?? []) }
        case .singleTask:
            groups = [("UI Review (\(pins.count) pins)", pins)]
        case .perPin:
            groups = pins.map { ($0.artboardRoute, [$0]) }
        }

        let targetProj = canvasProjectName.isEmpty ? selectedProject : canvasProjectName
        for (label, batch) in groups where !batch.isEmpty {
            let title: String
            if batch.count == 1, let only = batch.first {
                let prefix = only.kind == .options ? "[UI Options A/B/C/D] " : "[UI] "
                title = String("\(prefix)\(only.artboardRoute): \(only.body)".prefix(118))
            } else {
                title = String("[UI] \(label) (\(batch.count) changes)".prefix(118))
            }

            // Automatically lock a pre-run `Before` baseline checkpoint for each screen in this batch
            let touchedPaths = Set(batch.map(\.artboardPath))
            for board in canvasArtboards where touchedPaths.contains(board.path) {
                setArtboardBaselineCheckpoint(boardId: board.id)
            }

            let details = batch.enumerated().map { idx, p -> String in
                var meta = "route `\(p.artboardPath)` at (\(Int(p.xFrac * 100))%, \(Int(p.yFrac * 100))%)"
                if let el = p.elementName { meta += " · element `\(el)`" }
                if let f = p.elementFile {
                    meta += p.elementLine.map { " · `\(f):\($0)`" } ?? " · `\(f)`"
                }
                if let shot = p.screenshotPath {
                    meta += " · element screenshot `\(shot)`"
                }
                let kindTag = p.kind == .options ? "[Options A/B/C/D] " : ""
                return "\(idx + 1). \(kindTag)\(p.body) (\(meta))"
            }.joined(separator: "\n")

            await createTask(title: title, project: targetProj, body: details, planFirst: planFirst)
            let createdTaskId = workRowsResponse.rows.first?.id
            for p in batch {
                if let i = canvasPins.firstIndex(where: { $0.id == p.id }) {
                    canvasPins[i].isDraft = false
                    canvasPins[i].linkedTaskId = createdTaskId
                    if let root = canvasProjectRoot {
                        _ = YouiCanvasStorage.writeYouiRequest(projectRoot: root, projectName: targetProj ?? "toolroll", pin: canvasPins[i])
                    }
                }
            }
        }
    }

    public func statusTone(forPin pin: CanvasPin) -> TaskStatusTone {
        if pin.isDraft { return .queued }
        if let taskId = pin.linkedTaskId,
           let row = workRowsResponse.rows.first(where: { $0.id == taskId }) {
            return row.status
        }
        return .queued
    }

    private func resolveLocalProjectRoot(for projectName: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let directCandidates = [
            "\(home)/Documents/\(projectName)",
            "\(home)/Documents/firstmate/projects/\(projectName)",
            "\(home)/code/\(projectName)",
            "\(home)/Projects/\(projectName)",
        ]
        for path in directCandidates where FileManager.default.fileExists(atPath: path) {
            return path
        }
        // Fallback: scan ~/Documents for a folder matching projectName case-insensitively
        let docsURL = URL(fileURLWithPath: "\(home)/Documents")
        if let entries = try? FileManager.default.contentsOfDirectory(at: docsURL, includingPropertiesForKeys: [.isDirectoryKey]) {
            if let match = entries.first(where: { $0.lastPathComponent.lowercased() == projectName.lowercased() }) {
                return match.path
            }
        }
        return nil
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
            if tab == .artifact {
                syncTaskArtifacts()
            }
        }
    }

    // MARK: - Right-Hand Tabbed Artifact Window

    public func syncTaskArtifacts() {
        var virtuals: [WorkbenchArtifact] = []

        if let cards = stepCards {
            var md: [String] = []
            md.append("# \(cards.task.title)")
            var metaParts: [String] = ["Task `\(cards.task.id)`"]
            if let proj = cards.task.project, !proj.isEmpty { metaParts.append("Project `\(proj)`") }
            if let st = cards.task.state, !st.isEmpty { metaParts.append("State **\(st)**") }
            md.append("> " + metaParts.joined(separator: " · "))

            if let headline = cards.headline, !headline.isEmpty {
                md.append(headline)
            }

            if !cards.cards.isEmpty {
                md.append("## Execution Steps")
                md.append("| Step | State | Agent | Notes |")
                md.append("| :--- | :--- | :--- | :--- |")
                for c in cards.cards {
                    let agentStr = c.agent.map { a in [a.provider, a.model].compactMap { $0 }.joined(separator: " / ") } ?? "—"
                    let note = c.sentence.replacingOccurrences(of: "|", with: "\\|")
                    md.append("| **\(c.label)** | `\(c.state)` | \(agentStr) | \(note) |")
                }
            }

            // Plan terms & scope details
            let termsCards = cards.cards.compactMap { c -> (String, StepTerms)? in
                guard let t = c.terms, (!t.rows.isEmpty || !t.warnings.isEmpty || t.summary != nil) else { return nil }
                return (c.label, t)
            }
            if !termsCards.isEmpty {
                md.append("## Plan & Scope")
                for (label, terms) in termsCards {
                    md.append("### \(label)\(terms.revision.map { " (\($0))" } ?? "")")
                    if let summary = terms.summary, !summary.isEmpty {
                        md.append("> \(summary)")
                    }
                    for row in terms.rows {
                        md.append("- **\(row.label):** \(row.words)")
                        for line in row.lines where !line.isEmpty {
                            md.append("  - \(line)")
                        }
                    }
                    if !terms.warnings.isEmpty {
                        md.append("### Warnings")
                        for w in terms.warnings {
                            md.append("- \(w)")
                        }
                    }
                }
            }

            if let diff = diffResponse, !diff.files.isEmpty {
                md.append("## Changed Files (\(diff.files.count))")
                md.append("| File | Additions | Deletions |")
                md.append("| :--- | :--- | :--- |")
                for f in diff.files {
                    md.append("| `\(f.path)` | `+\(f.added ?? 0)` | `-\(f.removed ?? 0)` |")
                }
            }

            if let fail = cards.failure {
                md.append("## Failure Report")
                md.append("> \(fail.line)")
            }

            if let stopped = cards.planStopped {
                md.append("## Plan Stopped")
                md.append("> \(stopped.line)")
                if let probs = stopped.problems {
                    for p in probs { md.append("- \(p)") }
                }
            }

            let doc = WorkbenchArtifact(
                id: "task-brief::\(cards.task.id)",
                title: "Task Plan",
                subtitle: "Artifact · \(cards.task.id)",
                markdown: md.joined(separator: "\n\n"),
                filePath: nil,
                isPinnedVirtual: true
            )
            virtuals.append(doc)
        }

        // Preserve user-opened local file tabs alongside live virtual task artifact
        let fileTabs = openArtifacts.filter { !$0.isPinnedVirtual }
        openArtifacts = virtuals + fileTabs
        if activeArtifactId == nil || !openArtifacts.contains(where: { $0.id == activeArtifactId }) {
            activeArtifactId = openArtifacts.first?.id
        }
    }

    public func openTaskArtifact() {
        syncTaskArtifacts()
        if let first = openArtifacts.first(where: { $0.isPinnedVirtual }) {
            activeArtifactId = first.id
        }
        inspectorTab = .artifact
        isInspectorVisible = true
    }

    public func openMarkdownArtifact(path: String) {
        let url = URL(fileURLWithPath: path)
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            notice = WorkbenchNotice(kind: .refusal, message: "Could not read \(url.lastPathComponent).")
            return
        }
        let id = "file::\(url.path)"
        let title = url.deletingPathExtension().lastPathComponent
        let subtitle = "Artifact · \(url.path)"
        let doc = WorkbenchArtifact(
            id: id,
            title: title,
            subtitle: subtitle,
            markdown: content,
            filePath: url.path,
            isPinnedVirtual: false
        )
        if let idx = openArtifacts.firstIndex(where: { $0.id == id }) {
            openArtifacts[idx] = doc
        } else {
            openArtifacts.append(doc)
        }
        activeArtifactId = id
        inspectorTab = .artifact
        isInspectorVisible = true
    }

    public func reloadArtifactFile(id: String) {
        guard let idx = openArtifacts.firstIndex(where: { $0.id == id }),
              let path = openArtifacts[idx].filePath,
              let content = try? String(contentsOfFile: path, encoding: .utf8)
        else { return }
        let old = openArtifacts[idx]
        openArtifacts[idx] = WorkbenchArtifact(
            id: old.id,
            title: old.title,
            subtitle: old.subtitle,
            markdown: content,
            filePath: path,
            isPinnedVirtual: false
        )
    }

    public func closeArtifact(id: String) {
        openArtifacts.removeAll { $0.id == id }
        if activeArtifactId == id {
            activeArtifactId = openArtifacts.first?.id
        }
    }

    public func pickAndOpenMarkdownArtifact() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.plainText]
        panel.prompt = "Open Artifact"
        panel.message = "Choose a Markdown or text artifact to open in the right pane"
        if let root = canvasProjectRoot ?? (selectedProject.flatMap { resolveLocalProjectRoot(for: $0) }) {
            panel.directoryURL = URL(fileURLWithPath: root)
        }
        if panel.runModal() == .OK, let url = panel.url {
            openMarkdownArtifact(path: url.path)
        }
    }

    public func discoverProjectMarkdownFiles() -> [URL] {
        let targetProj = selectedProject ?? selectedRow?.project ?? canvasProjectName
        guard !targetProj.isEmpty,
              let root = resolveLocalProjectRoot(for: targetProj)
        else { return [] }
        let fm = FileManager.default
        var results: [URL] = []
        let candidates = [root, "\(root)/docs", "\(root)/docs/adr"]
        for dir in candidates {
            guard let items = try? fm.contentsOfDirectory(at: URL(fileURLWithPath: dir), includingPropertiesForKeys: nil) else { continue }
            for u in items where u.pathExtension.lowercased() == "md" {
                results.append(u)
            }
        }
        return Array(results.sorted { $0.lastPathComponent < $1.lastPathComponent }.prefix(14))
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

    public func localFolderPath(for projectName: String) -> String? {
        resolveLocalProjectRoot(for: projectName)
    }

    public func addLocalProject(path folderPath: String) async {
        busyLabel = "Adding project…"
        defer { busyLabel = nil }
        let folderName = (folderPath as NSString).lastPathComponent
        if activeProfile.isDemo {
            activeProject = folderName
            notice = WorkbenchNotice(kind: .info, message: "Added \(folderName) (demo).")
            return
        }
        guard let client else { return }
        do {
            let reply = try await client.openLocalProject(path: folderPath)
            activeProject = folderName
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    // MARK: - Live Model Selection (POST /settings/models/agent)

    public func selectModel(value: String, label: String, forRoleKey roleKey: String) async {
        var fields: [String: String] = [:]
        if roleKey == "all" {
            for role in modelsRead.roles {
                fields[role.key] = value
            }
        } else {
            // Only send the role being changed (omitted slots remain untouched in Toolroll's modelsSave handler,
            // avoiding sending "" for any unset role which would fail validation!).
            fields[roleKey] = value
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
        modelChangeError = nil
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
            modelChangeError = nil
            pendingModelFields = nil
            notice = WorkbenchNotice(kind: .info, message: "Switched to \(friendlyLabel).")
            return
        }

        guard let client else { return }
        do {
            // Always fetch a fresh digest right before posting so stale-digest refusals never happen!
            let latest = (try? await client.fetchModels()) ?? modelsRead
            modelsRead = latest
            let reply = try await client.updateModels(digest: latest.digest, fields: fields, password: password)
            modelPasswordPrompt = nil
            modelChangeError = nil
            pendingModelFields = nil
            notice = WorkbenchNotice(kind: .info, message: reply)
            if let refreshed = try? await client.fetchModels() {
                modelsRead = refreshed
            }
        } catch ToolrollClientError.passwordRequired(let msg) {
            pendingModelFields = fields
            modelPasswordPrompt = msg
            modelChangeError = nil
        } catch {
            let msg = error.localizedDescription
            modelChangeError = msg
            notice = WorkbenchNotice(kind: .refusal, message: msg)
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
        DesktopNotifier.shared.configure()
        DesktopNotifier.shared.onSelectTask = { [weak self] taskId in
            guard let self else { return }
            self.workspaceMode = .workbench
            Task { await self.selectTask(taskId) }
        }
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
            if let eq = creds.cookieHeader.firstIndex(of: "=") {
                let cname = String(creds.cookieHeader[..<eq])
                let cval = String(creds.cookieHeader[creds.cookieHeader.index(after: eq)...])
                self.localSessionCookie = (cname, cval, creds.origin)
            }
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
            processTaskNotifications(workRowsResponse.rows)
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
            syncTaskArtifacts()
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
        syncTaskArtifacts()
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

    public func attachOrStartTerminal(taskId: String, program: String = "shell", openDrawer: Bool = true) async {
        if openDrawer {
            isInspectorVisible = true
            inspectorTab = .terminal
        }
        busyLabel = "Attaching \(program) Live Terminal…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            terminalSession.attachDemo(taskId: taskId, program: program, branch: "tr/\(taskId)/live", controller: "sam", me: "alex")
            return
        }
        guard let client else { return }
        let targetProject = selectedRow?.project ?? selectedProject ?? allProjects.first
        let targetRun = stepCards?.liveRun ?? stepCards?.review?.run ?? stepCards?.cards.flatMap(\.runs).max()
        do {
            let started = try await client.startOrReuseTerminal(
                taskId: taskId,
                project: targetProject,
                runId: targetRun,
                program: program
            )
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

    /// Starts or attaches a live PTY directly on a project from the Launchpad (no task required).
    public func startProjectTerminal(project: String?, program: String = "shell") async {
        isInspectorVisible = true
        inspectorTab = .terminal
        busyLabel = "Starting \(program) Live Terminal…"
        defer { busyLabel = nil }

        let targetProject = project ?? activeProject ?? selectedProject ?? allProjects.first
        if activeProfile.isDemo {
            terminalSession.attachDemo(taskId: "workspace", program: program, branch: targetProject ?? "workspace", controller: "alex", me: "alex")
            return
        }
        guard let client else { return }
        do {
            let started = try await client.startOrReuseTerminal(
                taskId: "",
                project: targetProject,
                runId: nil,
                program: program
            )
            await terminalSession.attach(
                client: client,
                terminalId: started.id,
                taskId: nil,
                program: started.program,
                branch: started.branch
            )
            notice = WorkbenchNotice(
                kind: .info,
                message: started.reused ? "Attached to \(started.program) in \(targetProject ?? "workspace")." : "Started \(started.program) in \(targetProject ?? "workspace")."
            )
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    // MARK: - Worktree Visibility, Fluid Activity ↔ Terminal, Parallel Forking & MCP Gateway

    public func toggleTaskTerminalMode() {
        if taskViewMode == .terminal {
            taskViewMode = .activity
        } else {
            taskViewMode = .terminal
            if let taskId = selectedTaskId, terminalSession.taskId != taskId || terminalSession.connectionState != .connected {
                Task { await attachOrStartTerminal(taskId: taskId, program: "shell", openDrawer: false) }
            }
        }
    }

    public func setTaskViewMode(_ mode: TaskViewMode) {
        taskViewMode = mode
        if mode == .terminal, let taskId = selectedTaskId,
           terminalSession.taskId != taskId || terminalSession.connectionState != .connected {
            Task { await attachOrStartTerminal(taskId: taskId, program: "shell", openDrawer: false) }
        }
    }

    public func activeWorktreeBranch(for row: WorkRow) -> String {
        if terminalSession.taskId == row.id, !terminalSession.branch.isEmpty {
            return terminalSession.branch
        }
        if let candBranch = candidatesResponse?.candidates.first(where: { $0.branch != nil })?.branch, !candBranch.isEmpty {
            return candBranch
        }
        return "tr/\(row.id)"
    }

    public func siblingActiveTasks(for row: WorkRow) -> [WorkRow] {
        guard let proj = row.project, !proj.isEmpty else { return [] }
        return workRowsResponse.rows.filter { other in
            other.id != row.id
                && other.project == proj
                && (other.status == .running || other.status == .needs || other.status == .queued)
        }
    }

    public func forkSelectedTask(title: String, twist: String, planFirst: Bool, preset: AgentPreset?) async {
        guard let parent = selectedRow else { return }
        if let preset {
            await applyModelPreset(preset)
        }
        var lines: [String] = [
            "Parallel fork of task `\(parent.id)` (\"\(parent.title)\") in an isolated worktree.",
        ]
        if let headline = stepCards?.headline, !headline.isEmpty {
            lines.append("Parent context: \(headline)")
        }
        if !twist.isEmpty {
            lines.append("Approach twist for this fork:\n\(twist)")
        }
        await createTask(
            title: title,
            project: parent.project,
            body: lines.joined(separator: "\n\n"),
            planFirst: planFirst
        )
        notice = WorkbenchNotice(kind: .info, message: "Launched parallel fork \"\(title)\" in its own isolated worktree.")
    }

    public func selectAdjacentTask(delta: Int) async {
        let ordered = needsRows + runningRows + queuedRows + (isSettledExpanded ? settledRows : [])
        guard !ordered.isEmpty else { return }
        if let currentId = selectedTaskId,
           let idx = ordered.firstIndex(where: { $0.id == currentId }) {
            let nextIdx = max(0, min(ordered.count - 1, idx + delta))
            await selectTask(ordered[nextIdx].id)
        } else if let first = ordered.first {
            await selectTask(first.id)
        }
    }

    private func processTaskNotifications(_ rows: [WorkRow]) {
        let needsTotal = rows.filter { $0.status == .needs }.count
        DesktopNotifier.shared.updateDockBadge(needsCount: needsTotal)

        let hadBaseline = !lastKnownTaskStatuses.isEmpty
        for row in rows {
            let prev = lastKnownTaskStatuses[row.id]
            lastKnownTaskStatuses[row.id] = row.status
            guard hadBaseline, prev != row.status else { continue }
            if row.status == .needs {
                let subtitle = row.need?.question != nil ? "Question waiting" : "Needs your approval"
                DesktopNotifier.shared.notify(
                    taskId: row.id,
                    title: row.project ?? "Toolroll",
                    subtitle: subtitle,
                    body: row.title
                )
            } else if row.status == .finished && prev == .running {
                DesktopNotifier.shared.notify(
                    taskId: row.id,
                    title: row.project ?? "Toolroll",
                    subtitle: "Task finished",
                    body: row.title
                )
            }
        }
    }

    public var mcpGatewayEndpoint: String {
        let base = activeProfile.origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(base)/mcp"
    }

    public var mcpConfigSnippet: String {
        """
        {
          "mcpServers": {
            "toolroll": {
              "url": "\(mcpGatewayEndpoint)"
            }
          }
        }
        """
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
                processTaskNotifications(rows.rows)
                // If a Canvas-linked task reached review/finished, invalidate its screen so fresh `After` captures cleanly
                if let row = rows.rows.first(where: { $0.id == taskId }),
                   (row.status == .finished || row.status == .needs) {
                    let linkedPaths = Set(canvasPins.filter { $0.linkedTaskId == taskId }.map(\.artboardPath))
                    var invalidated = false
                    for i in canvasArtboards.indices where linkedPaths.contains(canvasArtboards[i].path) {
                        canvasArtboards[i].cachedStateKey = nil
                        invalidated = true
                    }
                    if invalidated && !canvasBaseURL.isEmpty {
                        pumpHydrationPool()
                    }
                }
            }
            if let client, let pres = try? await client.fetchPresence() {
                presence = pres
            }
        }
    }
}
