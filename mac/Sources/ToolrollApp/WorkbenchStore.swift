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
    case automations = "Automations"
    public var id: String { rawValue }
}

public enum TaskViewMode: String, CaseIterable, Identifiable, Sendable {
    case activity = "Activity"
    case terminal = "Shell"
    public var id: String { rawValue }
}

public struct WorkbenchNotice: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case info
        case refusal
    }
    public let kind: Kind
    public let message: String
    public var action: NoticeAction? = nil
}

public struct ModelPick: Equatable, Sendable, Identifiable {
    public var id: String { taskId }
    public let taskId: String
    public let phase: String
    public let value: String
    public let label: String
    public let sawDigest: String
}

public enum NoticeAction: Equatable, Sendable {
    case restore(taskId: String)
    case restoreAll(taskIds: [String])
}

public struct PendingCancel: Equatable, Sendable, Identifiable {
    public var id: String { taskId }
    public let taskId: String
    public let title: String
    public let state: String
    public let shownRun: Int?
    public let alsoArchive: Bool
}

@MainActor
@Observable
public final class WorkbenchStore {
    public private(set) var profiles: [ConnectionProfile] = []
    public private(set) var activeProfile: ConnectionProfile {
        didSet {
            guard oldValue.origin != activeProfile.origin || oldValue.account != activeProfile.account else { return }
            projectsRead = nil
        }
    }
    public private(set) var isLocalSession: Bool = false
    public private(set) var sseConnected: Bool = false
    public private(set) var isLoading: Bool = false
    public internal(set) var busyLabel: String?
    public var notice: WorkbenchNotice?
    public var pendingCancel: PendingCancel?
    public var modelPickerTaskId: String?
    public var modelPickerSteps: StepCardsResponse?
    public var pendingModelPick: ModelPick?

    public var workspaceMode: WorkspaceMode = .workbench {
        didSet { UserDefaults.standard.set(workspaceMode.rawValue, forKey: "toolroll.workspaceMode") }
    }
    public var selectedProject: String? = nil
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
    public var isProjectSettingsOpen: Bool = false
    public var projectSettingsTargetName: String? = nil
    public private(set) var projectSettingsSnapshot: ToolrollClient.ProjectSettingsSnapshot? = nil
    public var taskViewMode: TaskViewMode = .activity
    public var terminalIsScratch: Bool = false
    private var lastKnownTaskStatuses: [String: TaskStatusTone] = [:]
    private var deletingChatThreadIds: Set<String> = []
    public var isComposingNewWork: Bool = false
    public var isSetupOpen: Bool = false
    public var isSettledExpanded: Bool = false
    public private(set) var archivedRows: [WorkRow] = []
    public var isArchivedExpanded: Bool = false
    public var bulkSelection: Set<String> = []
    var bulkAnchorId: String?
    public var settledDisplayLimit: Int = 10
    public var isCliThreadsExpanded: Bool = true
    public var cliThreadsDisplayLimit: Int = 10
    public private(set) var discoveredGitRepos: [DiscoveredGitRepo] = []
    public internal(set) var projectsRead: ProjectsResponse?
    public private(set) var localCliThreads: [LocalCliThread] = []
    public var selectedCliThreadId: String? = nil
    public private(set) var selectedCliThreadMessages: [LocalCliMessage] = []
    public var pendingComposerDraft: String? = nil
    public var workDraftText: String = ""
    public var workDraftPlanFirst: Bool = true
    public var workDraftAttachments: [ComposerAttachment] = []
    public var chatReplyDrafts: [String: String] = [:]
    public var chatReplyAttachments: [String: [ComposerAttachment]] = [:]
    public var taskSteerDrafts: [String: String] = [:]
    public var taskSteerAttachments: [String: [ComposerAttachment]] = [:]
    private var preZenSidebar: Bool = true
    private var preZenInspector: Bool = false

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

    private var backStack: [String?] = []
    private var forwardStack: [String?] = []
    public var canGoBack: Bool { !backStack.isEmpty }
    public var canGoForward: Bool { !forwardStack.isEmpty }

    public private(set) var workRowsResponse: WorkRowsResponse = WorkRowsResponse()
    public private(set) var presence: PresenceSnapshot = PresenceSnapshot()
    public private(set) var agentsRead: AgentsReadResponse = AgentsReadResponse()
    public private(set) var modelsRead: ModelsReadResponse = ModelsReadResponse()
    public private(set) var selectedTaskId: String?
    public private(set) var stepCards: StepCardsResponse?
    public private(set) var taskResult: TaskResultResponse? = nil
    public private(set) var taskEvidenceImages: [String: Data] = [:]
    public private(set) var selectedLiveRunId: Int? = nil
    public private(set) var liveRunRecords: [LiveAgentRecord] = []
    public private(set) var liveRunRecordsById: [Int: [LiveAgentRecord]] = [:]
    public private(set) var isLoadingLiveRun: Bool = false
    public private(set) var approvalCard: ApprovalCard?
    public var approvalPasswordPrompt: String?
    public private(set) var passwordSet: Bool? = nil
    public var isSetPasswordOpen: Bool = false
    public private(set) var setPasswordBusy: Bool = false
    public var setPasswordProblem: String? = nil
    public private(set) var localDatabasePath: String? = nil
    public private(set) var pendingAgentRequests: [AgentRequest] = []
    public private(set) var resolvingAgentRequestId: String? = nil
    public private(set) var isTouchIDAvailable: Bool = TouchIDVault.isAuthenticationAvailable()
    public private(set) var touchIDLabel: String = TouchIDVault.biometryLabel()
    public private(set) var touchIDSystemImage: String = TouchIDVault.biometrySystemImage()
    public private(set) var isTouchIDEnabled: Bool = false
    public private(set) var backgroundServiceStatus: BackgroundServiceStatus? = nil
    public private(set) var isUpdatingBackgroundService: Bool = false
    public private(set) var geminiSubscription: GeminiSubscriptionStatus? = nil
    public private(set) var isRefreshingUsage: Bool = false
    public private(set) var lastUsageRefreshAt: Date? = nil
    private var didAutoRefreshUsage: Bool = false
    public private(set) var chatThreads: [AgentChatThread] = []
    public var selectedChatThreadId: String? = nil
    public private(set) var runningChatThreadIds: Set<String> = []
    public private(set) var chatThreadDiffs: [String: AgentChatGitDiff] = [:]
    public private(set) var chatArtifactImages: [String: Data] = [:]
    public private(set) var chatGitBindingErrors: [String: String] = [:]
    public private(set) var directChatAvailable: Bool = true
    public private(set) var directChatProblem: String? = nil
    public private(set) var directChatBackgroundOn: Bool = false
    public var isChatDiffDrawerOpen: Bool = false
    public var isChatThreadsExpanded: Bool = true
    public var chatDeleteConfirmationThread: AgentChatThread? = nil
    public var isChatShipSheetOpen: Bool = false
    public private(set) var chatShipThreadId: String? = nil
    public private(set) var chatShipPreview: DirectChatShipPreview? = nil
    public private(set) var isLoadingChatShipPreview: Bool = false
    public private(set) var isExecutingChatShip: Bool = false
    public var chatShipError: String? = nil
    public var showBackgroundServiceBanner: Bool = false
    public var composerFocusTick: Int = 0
    public var preferredOrchestrationMode: String = UserDefaults.standard.string(forKey: "toolroll.orchestrationMode") ?? "lead" {
        didSet { UserDefaults.standard.set(preferredOrchestrationMode, forKey: "toolroll.orchestrationMode") }
    }
    public var defaultChatProvider: AgentChatProvider = AgentChatProvider(rawValue: UserDefaults.standard.string(forKey: "toolroll.chatProvider") ?? "claude") ?? .claude {
        didSet { UserDefaults.standard.set(defaultChatProvider.rawValue, forKey: "toolroll.chatProvider") }
    }
    public var defaultChatModelId: String = UserDefaults.standard.string(forKey: "toolroll.chatModelId") ?? AgentChatProvider.claude.defaultModelId {
        didSet { UserDefaults.standard.set(defaultChatModelId, forKey: "toolroll.chatModelId") }
    }
    public var defaultChatEffort: String = UserDefaults.standard.string(forKey: "toolroll.chatEffort") ?? "high" {
        didSet { UserDefaults.standard.set(defaultChatEffort, forKey: "toolroll.chatEffort") }
    }
    public private(set) var directChatModels: [DirectChatModelOption] = AgentChatProvider.fallbackCatalogModels
    public var useLeadForNextChat: Bool = false
    private var managedLocalEngineProcess: Process? = nil
    private var directChatPollTask: Task<Void, Never>? = nil
    private var knownAgentRequestIds: Set<String> = []
    private var agentRequestPollTask: Task<Void, Never>?
    private static let passwordNudgeKey = "toolroll.passwordNudgeSnoozedUntil"
    private static let passwordNudgeSnooze: TimeInterval = 7 * 24 * 60 * 60
    public private(set) var passwordNudgeSnoozedUntil: Date? = UserDefaults.standard.object(forKey: WorkbenchStore.passwordNudgeKey) as? Date
    public var modelPasswordPrompt: String?
    public var modelChangeError: String?
    public var isCheckingModelCatalog: Bool = false
    private var pendingModelFields: [String: String]?
    public private(set) var candidatesResponse: CandidatesListResponse?
    public private(set) var diffResponse: ResultDiffResponse?
    public private(set) var selectedDiffPath: String?
    public private(set) var selectedDiffFile: ResultDiffFileResponse?
    public private(set) var inlineDiffComments: [InlineDiffComment] = []
    public private(set) var terminalsResponse: TermStateResponse?
    public private(set) var leadChat: LeadChatResponse = LeadChatResponse()

    public private(set) var openArtifacts: [WorkbenchArtifact] = []
    public var activeArtifactId: String? = nil

    public let terminalSession = LiveTerminalSession()

    private let profileStore: ProfileStore
    private(set) var client: ToolrollClient?
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
            managedLocalEngineProcess = proc
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
        if projectChanged { canvasBaseURL = "" }

        let facts = await Task.detached(priority: .userInitiated) { () -> (git: String, baseline: String, routes: [YouiScreenEntry]?, pins: [CanvasPin]) in
            guard let root else { return ("latest", "baseline", nil, []) }
            return (YouiCanvasStorage.gitStateKey(projectRoot: root), YouiCanvasStorage.mainBranchKey(projectRoot: root),
                    YouiCanvasStorage.discoverRoutes(projectRoot: root), YouiCanvasStorage.loadPins(projectRoot: root))
        }.value
        guard canvasProjectRoot == root else { return }
        canvasGitKey = facts.git
        let stateKey = facts.git + canvasOriginTag(for: root)
        let baselineKey = facts.baseline
        canvasStateKey = stateKey
        canvasBaselineKey = baselineKey

        if projectChanged || canvasArtboards.isEmpty || forceRefresh {
            hydratingBoardIds.removeAll()
            let rawDiscovered = facts.routes ?? [YouiScreenEntry(route: "/", path: "/")]
            let discovered = resolveDynamicTaskRoutes(rawDiscovered)
            discoveredCanvasRoutes = discovered
            let initial = Array(discovered.prefix(8))
            canvasArtboards = YouiCanvasStorage.layoutArtboards(
                from: initial,
                projectRoot: root,
                stateKey: stateKey,
                baselineKey: baselineKey,
                columns: initial.count <= 2 ? max(1, initial.count) : 3,
                viewport: canvasViewport
            )
            canvasPins = facts.pins
        }

        let needsHydration = forceRefresh || canvasArtboards.contains(where: { $0.latestImagePath == nil || $0.cachedStateKey != stateKey })
        if needsHydration {
            await wakePreviewServerAndHydrate(forceAll: forceRefresh)
        }
    }

    private static let canvasOriginKeyPrefix = "toolroll.canvasOrigin|"
    var canvasGitKey: String = "latest"

    func canvasOriginTag(for root: String?) -> String {
        guard let root, let origin = UserDefaults.standard.string(forKey: Self.canvasOriginKeyPrefix + root) else { return "-o0" }
        var hash: UInt32 = 2_166_136_261
        for byte in origin.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        return "-o" + String(hash, radix: 16)
    }

    func adoptCanvasOrigin(_ url: String) {
        guard let root = canvasProjectRoot else { return }
        let key = Self.canvasOriginKeyPrefix + root
        guard UserDefaults.standard.string(forKey: key) != url else { return }
        UserDefaults.standard.set(url, forKey: key)
        canvasStateKey = canvasGitKey + canvasOriginTag(for: root)
        for idx in canvasArtboards.indices { canvasArtboards[idx].cachedStateKey = nil }
    }

    public func wakePreviewServerAndHydrate(forceAll: Bool = false) async {
        guard let root = canvasProjectRoot else { return }
        let isToolrollRepo = (root as NSString).lastPathComponent.lowercased() == "toolroll"
        let preferredOrigin: String? = (isToolrollRepo && isLocalSession) ? activeProfile.origin : nil

        if let url = await previewServer.ensureRunning(projectRoot: root, preferredOrigin: preferredOrigin) {
            canvasBaseURL = url
            adoptCanvasOrigin(url)
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
            adoptCanvasOrigin(url)
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

    public var canApproveInApp: Bool {
        isLocalSession || activeProfile.isDemo
    }

    public var allProjects: [String] {
        let fromTasks = workRowsResponse.rows.compactMap(\.project).filter { !$0.isEmpty }
        let fromConsole = projectsRead?.projects.map(\.name) ?? []
        return Set(fromTasks + fromConsole).sorted()
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

    public var settledRows: [WorkRow] {
        filteredRows.filter { $0.status == .finished || $0.status == .failed || $0.status == .unknown }
    }

    public var selectedCliThread: LocalCliThread? {
        guard let id = selectedCliThreadId else { return nil }
        return localCliThreads.first(where: { $0.id == id })
    }

    public var filteredCliThreads: [LocalCliThread] {
        localCliThreads.filter { thread in
            if let proj = selectedProject, !proj.isEmpty {
                let matchName = thread.projectName.caseInsensitiveCompare(proj) == .orderedSame
                let matchPath = thread.projectPath?.localizedCaseInsensitiveContains(proj) == true
                if !matchName && !matchPath { return false }
            }
            let q = sidebarSearch.trimmingCharacters(in: .whitespacesAndNewlines)
            if !q.isEmpty {
                let hay = "\(thread.title) \(thread.projectName) \(thread.provider.displayName) \(thread.branch ?? "")"
                if !hay.localizedCaseInsensitiveContains(q) { return false }
            }
            return true
        }
    }

    public var unconnectedGitRepos: [DiscoveredGitRepo] {
        let connectedNames = Set(allProjects.map { $0.lowercased() })
        let connectedPaths = Set((projectsRead?.projects ?? []).map { URL(fileURLWithPath: $0.path).standardizedFileURL.path.lowercased() })

        var merged: [DiscoveredGitRepo] = []
        var seenPaths: Set<String> = []

        if let read = projectsRead, read.canAdd {
            for item in read.found {
                let normPath = URL(fileURLWithPath: item.path).standardizedFileURL.path.lowercased()
                guard !connectedPaths.contains(normPath),
                      !connectedNames.contains(item.name.lowercased()),
                      !seenPaths.contains(normPath)
                else { continue }
                seenPaths.insert(normPath)
                let localMatch = discoveredGitRepos.first {
                    URL(fileURLWithPath: $0.path).standardizedFileURL.path.lowercased() == normPath
                }
                merged.append(DiscoveredGitRepo(
                    name: item.name,
                    path: item.path,
                    branch: localMatch?.branch,
                    suggestedSetupCommand: localMatch?.suggestedSetupCommand,
                    lastModified: localMatch?.lastModified ?? .distantPast
                ))
            }
        }

        if isLocalSession || projectsRead == nil {
            for repo in discoveredGitRepos {
                let normPath = URL(fileURLWithPath: repo.path).standardizedFileURL.path.lowercased()
                guard !connectedPaths.contains(normPath),
                      !connectedNames.contains(repo.name.lowercased()),
                      !seenPaths.contains(normPath)
                else { continue }
                seenPaths.insert(normPath)
                merged.append(repo)
            }
        }

        return merged
    }

    public var isShowingWorkHome: Bool { !isComposingNewWork && selectedTaskId == nil && selectedCliThreadId == nil && selectedChatThreadId == nil }

    public var selectedChatThread: AgentChatThread? {
        guard let id = selectedChatThreadId else { return nil }
        return chatThreads.first(where: { $0.id == id })
    }

    public var filteredChatThreads: [AgentChatThread] {
        chatThreads.filter { thread in
            if let proj = selectedProject, !proj.isEmpty {
                guard thread.projectName.caseInsensitiveCompare(proj) == .orderedSame else { return false }
            }
            let trimmed = sidebarSearch.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                let q = trimmed.lowercased()
                return thread.title.lowercased().contains(q)
                    || thread.projectName.lowercased().contains(q)
                    || thread.provider.displayName.lowercased().contains(q)
            }
            return true
        }
    }

    public func openWorkHome() {
        if let current = selectedTaskId { backStack.append(current); forwardStack.removeAll() }
        workspaceMode = .workbench
        isComposingNewWork = false
        selectedCliThreadId = nil
        selectedChatThreadId = nil
        selectedTaskId = nil
        stepCards = nil
        isChatDiffDrawerOpen = false
        composerFocusTick &+= 1
    }

    public func openNewWorkCanvas() {
        openWorkHome()
    }

    public func toggleOrchestrationMode() {
        switch preferredOrchestrationMode {
        case "lead": preferredOrchestrationMode = "chat"
        case "chat": preferredOrchestrationMode = "task"
        default: preferredOrchestrationMode = "lead"
        }
    }

    public func selectChatThread(_ id: String) {
        workspaceMode = .workbench
        isComposingNewWork = false
        selectedCliThreadId = nil
        selectedTaskId = nil
        if selectedChatThreadId != id {
            isChatDiffDrawerOpen = false
        }
        selectedChatThreadId = id
        if let thread = chatThreads.first(where: { $0.id == id }) {
            activeProject = thread.projectName
        }
        restartSSE()
        if !id.hasPrefix("pending-") {
            Task { await refreshDirectChatDetail(threadId: id) }
        }
    }

    public func directChatModels(for provider: AgentChatProvider) -> [DirectChatModelOption] {
        let filtered = directChatModels.filter { $0.provider == provider }
        if !filtered.isEmpty { return filtered }
        return AgentChatProvider.fallbackCatalogModels.filter { $0.provider == provider }
    }

    public func directChatModelOption(provider: AgentChatProvider, modelId: String) -> DirectChatModelOption? {
        let options = directChatModels(for: provider)
        if let exact = options.first(where: { $0.modelId == modelId }) { return exact }
        let stripped = modelId
            .replacingOccurrences(of: "-xhigh", with: "")
            .replacingOccurrences(of: "-high", with: "")
            .replacingOccurrences(of: "-medium", with: "")
            .replacingOccurrences(of: "-low", with: "")
            .replacingOccurrences(of: "-max", with: "")
        return options.first(where: { $0.modelId == stripped })
    }

    public func directChatModelLabel(provider: AgentChatProvider, modelId: String) -> String {
        directChatModelOption(provider: provider, modelId: modelId)?.label ?? provider.label(for: modelId)
    }

    public func directChatAvailableEfforts(provider: AgentChatProvider, modelId: String) -> [String] {
        if let option = directChatModelOption(provider: provider, modelId: modelId), !option.efforts.isEmpty {
            return option.efforts
        }
        switch provider {
        case .claude: return ["low", "medium", "high", "xhigh", "max"]
        case .codex: return ["low", "medium", "high", "xhigh", "max", "ultra"]
        case .gemini: return ["low", "medium", "high", "xhigh"]
        }
    }

    public func setDefaultChatModel(provider: AgentChatProvider, modelId: String, effort: String? = nil) {
        useLeadForNextChat = false
        defaultChatProvider = provider
        defaultChatModelId = modelId
        let allowed = directChatAvailableEfforts(provider: provider, modelId: modelId)
        if let effort, allowed.contains(effort) {
            defaultChatEffort = effort
        } else if !allowed.contains(defaultChatEffort) {
            let fallback = directChatModelOption(provider: provider, modelId: modelId)?.defaultEffort
            defaultChatEffort = (fallback.flatMap { allowed.contains($0) ? $0 : nil }) ?? allowed.first ?? "high"
        }
    }

    public func setDefaultChatEffort(_ effort: String) {
        defaultChatEffort = effort
    }

    public func refreshDirectChats() async {
        if activeProfile.isDemo {
            directChatAvailable = true
            directChatProblem = nil
            directChatBackgroundOn = true
            if chatThreads.isEmpty {
                chatThreads = DemoFixtures.directChatThreads
                chatThreadDiffs = DemoFixtures.directChatDiffs
            }
            runningChatThreadIds = Set(chatThreads.filter(\.running).map(\.id))
            return
        }
        guard let client, isLocalSession else {
            directChatAvailable = false
            directChatProblem = "Direct chat is only available when connected to your local Toolroll install."
            return
        }
        do {
            let list = try await client.fetchDirectChats()
            directChatAvailable = list.available
            directChatProblem = list.problem
            directChatBackgroundOn = list.backgroundOn
            if !list.models.isEmpty {
                directChatModels = list.models
            }
            let existingById = Dictionary(uniqueKeysWithValues: chatThreads.map { ($0.id, $0) })
            let pendingThreads = chatThreads.filter { $0.id.hasPrefix("pending-") && !deletingChatThreadIds.contains($0.id) }
            let serverThreads = list.threads
                .filter { !deletingChatThreadIds.contains($0.id) }
                .map { AgentChatThread(summary: $0, preserving: existingById[$0.id]) }
            chatThreads = pendingThreads + serverThreads
            runningChatThreadIds = Set(chatThreads.filter(\.running).map(\.id))
            if let sel = selectedChatThreadId, !sel.hasPrefix("pending-") {
                await refreshDirectChatDetail(threadId: sel)
            }
            ensureDirectChatPolling()
        } catch {
        }
    }

    public func refreshDirectChatDetail(threadId: String) async {
        if activeProfile.isDemo {
            if let demoDiff = DemoFixtures.directChatDiffs[threadId], chatThreadDiffs[threadId] == nil {
                chatThreadDiffs[threadId] = demoDiff
            }
            return
        }
        guard let client, isLocalSession else { return }
        do {
            let detail = try await client.fetchDirectChatDetail(threadId: threadId)
            guard !deletingChatThreadIds.contains(threadId) else { return }
            let updated = AgentChatThread(detail: detail)
            if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
                chatThreads[idx] = updated
            } else {
                chatThreads.insert(updated, at: 0)
            }
            chatThreadDiffs[threadId] = AgentChatGitDiff(dto: detail.diff)
            if updated.running {
                runningChatThreadIds.insert(threadId)
            } else {
                runningChatThreadIds.remove(threadId)
            }
            ensureDirectChatPolling()
        } catch {
        }
    }

    private func ensureDirectChatPolling() {
        let shouldPoll = !activeProfile.isDemo && isLocalSession && !runningChatThreadIds.isEmpty
        if !shouldPoll {
            directChatPollTask?.cancel()
            directChatPollTask = nil
            return
        }
        guard directChatPollTask == nil else { return }
        directChatPollTask = Task { [weak self] in
            while !Task.isCancelled {
                let connected = self?.sseConnected ?? false
                try? await Task.sleep(for: .milliseconds(connected ? 1500 : 350))
                guard let self, !Task.isCancelled else { break }
                if self.runningChatThreadIds.isEmpty { break }
                if let sel = self.selectedChatThreadId, self.runningChatThreadIds.contains(sel) {
                    await self.refreshDirectChatDetail(threadId: sel)
                } else {
                    await self.refreshDirectChats()
                }
            }
            if let self {
                self.directChatPollTask = nil
            }
        }
    }

    private func maybePromptBackgroundOnFirstChat() {
        guard !activeProfile.isDemo, isLocalSession, !directChatBackgroundOn else { return }
        let key = "toolroll.dismissedBackgroundBannerV1"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        showBackgroundServiceBanner = true
    }

    public func dismissBackgroundServiceBanner() {
        UserDefaults.standard.set(true, forKey: "toolroll.dismissedBackgroundBannerV1")
        showBackgroundServiceBanner = false
    }

    public func startChatThread(
        prompt: String,
        project: String?,
        provider: AgentChatProvider? = nil,
        modelId: String? = nil,
        effort: String? = nil,
        attachments: [ComposerAttachment] = []
    ) async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        let chosenProvider = provider ?? defaultChatProvider
        let chosenModel = modelId ?? (provider == nil ? defaultChatModelId : chosenProvider.defaultModelId)
        let allowedEfforts = directChatAvailableEfforts(provider: chosenProvider, modelId: chosenModel)
        let rawEffort = effort ?? defaultChatEffort
        let chosenEffort = allowedEfforts.contains(rawEffort)
            ? rawEffort
            : (directChatModelOption(provider: chosenProvider, modelId: chosenModel)?.defaultEffort ?? allowedEfforts.first ?? "high")
        let projName = project ?? activeProject ?? selectedProject ?? allProjects.first ?? "Workspace"

        if activeProfile.isDemo {
            let newId = DirectChatDateParser.makeHex32RequestId()
            let composed = ComposerAttachmentStore.composeSubmission(text: trimmed, attachments: attachments)
            let thread = AgentChatThread(
                id: newId,
                title: String(composed.title.prefix(64)),
                projectName: projName,
                branch: "toolroll/chat-\(newId.prefix(8))",
                provider: chosenProvider,
                modelId: chosenModel,
                messages: [
                    AgentChatMessage(role: .user, text: composed.combinedMessage),
                    AgentChatMessage(
                        role: .assistant,
                        text: "Demo mode: in a live local Toolroll install, this starts an isolated local git clone (`toolroll/chat-\(newId.prefix(8))`) and streams \(chosenProvider.displayName) over SSE.",
                        tools: [AgentChatToolEvent(name: "Clone", detail: "isolated local repo", status: "done")]
                    ),
                ]
            )
            chatThreads.insert(thread, at: 0)
            selectChatThread(thread.id)
            return
        }

        guard let client, isLocalSession else {
            notice = WorkbenchNotice(kind: .refusal, message: directChatProblem ?? "Connect to your local Toolroll engine to start a chat.")
            return
        }

        let resolvedProject = localFolderPath(for: projName)
            ?? projectsRead?.projects.first(where: { $0.name.caseInsensitiveCompare(projName) == .orderedSame })?.path
            ?? terminalsResponse?.projects?.first(where: { $0.name.caseInsensitiveCompare(projName) == .orderedSame })?.path
            ?? projName

        let composed = ComposerAttachmentStore.composeSubmission(text: trimmed, attachments: attachments)
        let initialPrompt = composed.combinedMessage.isEmpty ? trimmed : composed.combinedMessage
        let firstLine = initialPrompt.components(separatedBy: .newlines).first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? initialPrompt
        let optimisticTitle = String(firstLine.prefix(64))

        let tempId = "pending-\(DirectChatDateParser.makeHex32RequestId())"
        let optimisticThread = AgentChatThread(
            id: tempId,
            title: optimisticTitle.isEmpty ? "New chat" : optimisticTitle,
            projectName: projName,
            branch: "Preparing clone…",
            provider: chosenProvider,
            modelId: chosenModel,
            posture: DirectChatPosture.defaultFor(chosenProvider),
            running: true,
            lastStatus: "running",
            messages: [
                AgentChatMessage(role: .user, text: initialPrompt),
                AgentChatMessage(
                    id: "\(tempId)-assistant",
                    role: .assistant,
                    text: "",
                    tools: [
                        AgentChatToolEvent(
                            id: "setup-workspace",
                            ordinal: 1,
                            name: "Workspace",
                            detail: "Creating isolated local clone…",
                            status: "running"
                        )
                    ],
                    isStreaming: true,
                    status: "running"
                ),
            ]
        )
        chatThreads.insert(optimisticThread, at: 0)
        runningChatThreadIds.insert(tempId)
        selectChatThread(tempId)
        maybePromptBackgroundOnFirstChat()

        do {
            let started = try await client.startDirectChat(
                project: resolvedProject,
                prompt: initialPrompt,
                provider: chosenProvider,
                modelId: chosenModel,
                effort: chosenEffort
            )
            guard started.ok, let threadId = started.threadId else {
                let err = started.error ?? "Could not start chat."
                if let idx = chatThreads.firstIndex(where: { $0.id == tempId }) {
                    chatThreads[idx].running = false
                    chatThreads[idx].lastStatus = "failed"
                    if let mIdx = chatThreads[idx].messages.lastIndex(where: { $0.role == .assistant }) {
                        chatThreads[idx].messages[mIdx].isStreaming = false
                        chatThreads[idx].messages[mIdx].isError = true
                        chatThreads[idx].messages[mIdx].text = err
                        chatThreads[idx].messages[mIdx].tools = [
                            AgentChatToolEvent(id: "setup-workspace", ordinal: 1, name: "Workspace", detail: "Could not prepare clone", status: "error")
                        ]
                    }
                }
                runningChatThreadIds.remove(tempId)
                notice = WorkbenchNotice(kind: .refusal, message: err)
                return
            }

            if !attachments.isEmpty {
                await uploadImageAttachments(attachments, to: threadId, client: client)
            }

            let wasSelected = selectedChatThreadId == tempId
            chatThreads.removeAll { $0.id == tempId }
            runningChatThreadIds.remove(tempId)
            runningChatThreadIds.insert(threadId)

            if let detail = try? await client.fetchDirectChatDetail(threadId: threadId) {
                let realThread = AgentChatThread(detail: detail)
                chatThreads.removeAll { $0.id == threadId }
                chatThreads.insert(realThread, at: 0)
                chatThreadDiffs[threadId] = AgentChatGitDiff(dto: detail.diff)
                if realThread.running {
                    runningChatThreadIds.insert(threadId)
                } else {
                    runningChatThreadIds.remove(threadId)
                }
            } else {
                await refreshDirectChats()
            }

            if wasSelected {
                selectedChatThreadId = threadId
                restartSSE()
            }
            ensureDirectChatPolling()
        } catch {
            let err = error.localizedDescription
            if let idx = chatThreads.firstIndex(where: { $0.id == tempId }) {
                chatThreads[idx].running = false
                chatThreads[idx].lastStatus = "failed"
                if let mIdx = chatThreads[idx].messages.lastIndex(where: { $0.role == .assistant }) {
                    chatThreads[idx].messages[mIdx].isStreaming = false
                    chatThreads[idx].messages[mIdx].isError = true
                    chatThreads[idx].messages[mIdx].text = err
                }
            }
            runningChatThreadIds.remove(tempId)
            notice = WorkbenchNotice(kind: .refusal, message: err)
        }
    }

    public func sendChatMessage(threadId: String, text: String, attachments: [ComposerAttachment] = []) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty,
              !runningChatThreadIds.contains(threadId)
        else { return }

        if activeProfile.isDemo {
            guard let idx = chatThreads.firstIndex(where: { $0.id == threadId }) else { return }
            let composed = ComposerAttachmentStore.composeSubmission(text: trimmed, attachments: attachments)
            chatThreads[idx].messages.append(AgentChatMessage(role: .user, text: composed.combinedMessage))
            chatThreads[idx].messages.append(AgentChatMessage(
                role: .assistant,
                text: "Demo reply recorded in isolated clone `\(chatThreads[idx].branch)`."
            ))
            chatThreads[idx].updatedAt = Date()
            return
        }

        guard let client, isLocalSession else {
            notice = WorkbenchNotice(kind: .refusal, message: "Connect to your local Toolroll engine to send a message.")
            return
        }

        let uploadedPaths = await uploadImageAttachments(attachments, to: threadId, client: client)
        let nonImageAttachments = attachments.filter { $0.kind != .image }
        var promptParts: [String] = []
        if !trimmed.isEmpty { promptParts.append(trimmed) }
        if !uploadedPaths.isEmpty {
            promptParts.append("Attached images in this workspace:\n" + uploadedPaths.map { "- \($0)" }.joined(separator: "\n"))
        }
        if !nonImageAttachments.isEmpty {
            promptParts.append(ComposerAttachmentStore.formatContextBlock(for: nonImageAttachments))
        }
        let finalPrompt = promptParts.joined(separator: "\n\n")
        guard !finalPrompt.isEmpty else { return }

        let optimisticUserId = "opt-user-\(UUID().uuidString)"
        let optimisticAssistantId = "opt-assistant-\(UUID().uuidString)"
        if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
            chatThreads[idx].messages.append(AgentChatMessage(id: optimisticUserId, role: .user, text: finalPrompt))
            chatThreads[idx].messages.append(AgentChatMessage(id: optimisticAssistantId, role: .assistant, text: "", isStreaming: true, status: "running"))
            chatThreads[idx].running = true
            chatThreads[idx].updatedAt = Date()
        }
        runningChatThreadIds.insert(threadId)

        do {
            let reply = try await client.sendDirectChatMessage(threadId: threadId, prompt: finalPrompt)
            if !reply.ok {
                let err = reply.error ?? "Could not send message."
                if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
                    chatThreads[idx].messages.removeAll { $0.id == optimisticUserId || $0.id == optimisticAssistantId }
                    chatThreads[idx].running = false
                }
                runningChatThreadIds.remove(threadId)
                recordChatGitErrorIfRelevant(threadId: threadId, error: err)
                notice = WorkbenchNotice(kind: .refusal, message: err)
                return
            }
            await refreshDirectChatDetail(threadId: threadId)
            ensureDirectChatPolling()
        } catch {
            if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
                chatThreads[idx].messages.removeAll { $0.id == optimisticUserId || $0.id == optimisticAssistantId }
                chatThreads[idx].running = false
            }
            runningChatThreadIds.remove(threadId)
            recordChatGitErrorIfRelevant(threadId: threadId, error: error.localizedDescription)
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    @discardableResult
    private func uploadImageAttachments(
        _ attachments: [ComposerAttachment],
        to threadId: String,
        client: ToolrollClient
    ) async -> [String] {
        var clonePaths: [String] = []
        for item in attachments where item.kind == .image {
            guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: item.path)), !bytes.isEmpty else { continue }
            let ext = URL(fileURLWithPath: item.path).pathExtension.lowercased()
            let mime: String? = switch ext {
            case "png": "image/png"
            case "jpg", "jpeg": "image/jpeg"
            case "webp": "image/webp"
            case "gif": "image/gif"
            default: nil
            }
            let filename = URL(fileURLWithPath: item.path).lastPathComponent
            if let res = try? await client.attachDirectChatFile(
                threadId: threadId,
                filename: filename,
                mimeType: mime,
                data: bytes
            ), res.ok {
                if let rel = res.cloneRelativePath, !rel.isEmpty {
                    clonePaths.append(rel)
                }
            }
        }
        return clonePaths
    }

    private func recordChatGitErrorIfRelevant(threadId: String, error: String) {
        let lower = error.lowercased()
        if lower.contains("repair") || lower.contains("config changed") || lower.contains("commondir") || lower.contains(".git pointer") {
            chatGitBindingErrors[threadId] = error
        }
    }

    public func stopChatThread(threadId: String) {
        if activeProfile.isDemo {
            runningChatThreadIds.remove(threadId)
            return
        }
        guard let client, isLocalSession else { return }
        Task {
            do {
                let res = try await client.stopDirectChat(threadId: threadId)
                if !res.ok, let err = res.error {
                    notice = WorkbenchNotice(kind: .refusal, message: err)
                } else if let said = res.said {
                    notice = WorkbenchNotice(kind: .info, message: said)
                }
                await refreshDirectChatDetail(threadId: threadId)
            } catch {
                notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            }
        }
    }

    public func stopAllRunningChatsAndWait() async {
        guard let client, isLocalSession else { return }
        let ids = Array(runningChatThreadIds)
        for id in ids {
            _ = try? await client.stopDirectChat(threadId: id)
        }
        for _ in 0..<10 {
            await refreshDirectChats()
            if runningChatThreadIds.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(400))
        }
    }

    public func updateChatThreadModel(threadId: String, provider: AgentChatProvider, modelId: String, effort: String? = nil) {
        setDefaultChatModel(provider: provider, modelId: modelId, effort: effort)
        let effectiveEffort = effort ?? defaultChatEffort
        if activeProfile.isDemo {
            if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
                chatThreads[idx].provider = provider
                chatThreads[idx].modelId = modelId
                chatThreads[idx].effort = effectiveEffort
                chatThreads[idx].posture = DirectChatPosture.defaultFor(provider)
            }
            return
        }
        guard let client, isLocalSession else { return }
        Task {
            do {
                let res = try await client.updateDirectChatModel(
                    threadId: threadId,
                    provider: provider,
                    modelId: modelId,
                    effort: effectiveEffort
                )
                if !res.ok {
                    notice = WorkbenchNotice(kind: .refusal, message: res.error ?? "Could not switch model.")
                    return
                }
                await refreshDirectChatDetail(threadId: threadId)
            } catch {
                notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            }
        }
    }

    public func deleteChatThread(id: String, discardChanges: Bool = false, keepBranch: Bool = false) {
        if activeProfile.isDemo {
            chatThreads.removeAll { $0.id == id }
            chatThreadDiffs.removeValue(forKey: id)
            chatDeleteConfirmationThread = nil
            if selectedChatThreadId == id { selectedChatThreadId = nil }
            return
        }
        guard let client, isLocalSession else { return }
        guard !deletingChatThreadIds.contains(id) else { return }

        let existingIndex = chatThreads.firstIndex(where: { $0.id == id })
        let existingThread = existingIndex.map { chatThreads[$0] }
        let existingDiff = chatThreadDiffs[id]
        let existingGitError = chatGitBindingErrors[id]
        let wasSelected = selectedChatThreadId == id

        if !discardChanges && !keepBranch,
           let thread = existingThread,
           !thread.running,
           thread.changedFilesCount > 0 || (existingDiff?.dirty == true) {
            chatDeleteConfirmationThread = thread
            return
        }

        let shouldOptimisticallyHide = discardChanges || keepBranch || (existingThread?.running != true)
        deletingChatThreadIds.insert(id)
        if chatDeleteConfirmationThread?.id == id {
            chatDeleteConfirmationThread = nil
        }
        if shouldOptimisticallyHide {
            chatThreads.removeAll { $0.id == id }
            chatThreadDiffs.removeValue(forKey: id)
            chatGitBindingErrors.removeValue(forKey: id)
            runningChatThreadIds.remove(id)
            if wasSelected {
                selectedChatThreadId = nil
            }
        }

        Task {
            do {
                let res = try await client.deleteDirectChat(threadId: id, discard: discardChanges, keepBranch: keepBranch)
                deletingChatThreadIds.remove(id)
                if !res.ok {
                    if shouldOptimisticallyHide, let thread = existingThread {
                        if !chatThreads.contains(where: { $0.id == id }) {
                            let targetIndex = min(existingIndex ?? 0, chatThreads.count)
                            chatThreads.insert(thread, at: targetIndex)
                        }
                        if let existingDiff { chatThreadDiffs[id] = existingDiff }
                        if let existingGitError { chatGitBindingErrors[id] = existingGitError }
                        if thread.running { runningChatThreadIds.insert(id) }
                        if wasSelected && selectedChatThreadId == nil {
                            selectedChatThreadId = id
                        }
                    }
                    if res.code == "unmerged_changes", let thread = existingThread ?? chatThreads.first(where: { $0.id == id }) {
                        chatDeleteConfirmationThread = thread
                        return
                    }
                    notice = WorkbenchNotice(kind: .refusal, message: res.error ?? "Could not delete chat.")
                    return
                }
                chatDeleteConfirmationThread = nil
                chatThreads.removeAll { $0.id == id }
                chatThreadDiffs.removeValue(forKey: id)
                chatGitBindingErrors.removeValue(forKey: id)
                runningChatThreadIds.remove(id)
                if wasSelected {
                    if selectedChatThreadId == id {
                        selectedChatThreadId = nil
                    }
                    restartSSE()
                }
            } catch {
                deletingChatThreadIds.remove(id)
                if shouldOptimisticallyHide, let thread = existingThread {
                    if !chatThreads.contains(where: { $0.id == id }) {
                        let targetIndex = min(existingIndex ?? 0, chatThreads.count)
                        chatThreads.insert(thread, at: targetIndex)
                    }
                    if let existingDiff { chatThreadDiffs[id] = existingDiff }
                    if let existingGitError { chatGitBindingErrors[id] = existingGitError }
                    if thread.running { runningChatThreadIds.insert(id) }
                    if wasSelected && selectedChatThreadId == nil {
                        selectedChatThreadId = id
                    }
                }
                notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            }
        }
    }

    public func refreshChatDiff(threadId: String) async {
        await refreshDirectChatDetail(threadId: threadId)
    }

    public func applyMainEditsToChat(threadId: String) async {
        if activeProfile.isDemo {
            if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
                chatThreads[idx].mainDirtyFiles = []
            }
            notice = WorkbenchNotice(kind: .info, message: "Brought uncommitted changes into this chat's clone (demo).")
            return
        }
        guard let client, isLocalSession else { return }
        do {
            let res = try await client.applyMainEditsToDirectChat(threadId: threadId)
            if !res.ok {
                let err = res.error ?? "Could not bring in uncommitted edits."
                recordChatGitErrorIfRelevant(threadId: threadId, error: err)
                notice = WorkbenchNotice(kind: .refusal, message: err)
                return
            }
            chatGitBindingErrors.removeValue(forKey: threadId)
            notice = WorkbenchNotice(kind: .info, message: res.said ?? "Brought uncommitted changes into this chat.")
            await refreshDirectChatDetail(threadId: threadId)
        } catch {
            recordChatGitErrorIfRelevant(threadId: threadId, error: error.localizedDescription)
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func dismissMainDirtyNotice(threadId: String) {
        if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
            chatThreads[idx].mainDirtyFiles = []
        }
    }

    public func repairChatGitBinding(threadId: String) async {
        guard let client, isLocalSession else { return }
        do {
            let res = try await client.repairDirectChatGit(threadId: threadId)
            if !res.ok {
                notice = WorkbenchNotice(kind: .refusal, message: res.error ?? "Could not repair workspace git binding.")
                return
            }
            chatGitBindingErrors.removeValue(forKey: threadId)
            notice = WorkbenchNotice(kind: .info, message: res.said ?? "Workspace git binding repaired.")
            await refreshDirectChatDetail(threadId: threadId)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func openChatShipSheet(threadId: String) async {
        chatShipThreadId = threadId
        chatShipError = nil
        chatShipPreview = nil
        isChatShipSheetOpen = true
        await reloadChatShipPreview(mode: nil, title: nil, goal: nil)
    }

    public func reloadChatShipPreview(mode: String?, title: String?, goal: String?) async {
        guard let threadId = chatShipThreadId else { return }
        isLoadingChatShipPreview = true
        chatShipError = nil
        defer { isLoadingChatShipPreview = false }

        if activeProfile.isDemo {
            let thread = chatThreads.first(where: { $0.id == threadId })
            let files = chatThreadDiffs[threadId]?.changedFiles ?? ["AgentChatView.swift"]
            let chosenMode = mode ?? "ship"
            chatShipPreview = DirectChatShipPreview(
                threadId: threadId,
                mode: chosenMode,
                canAutoMerge: true,
                autoMergeReason: nil,
                termsDigest: DirectChatDateParser.makeHex32RequestId(),
                title: title ?? thread?.title ?? "Changes from Direct Chat",
                goal: goal ?? "Ship verified changes from Direct Chat.",
                baseSha: "19c35fa4",
                branch: chosenMode == "keep-branch" ? "\(thread?.branch ?? "toolroll/chat-demo")-1" : (thread?.branch ?? "toolroll/chat-demo"),
                changedFiles: files,
                checkCommand: "npm test",
                githubRepo: "acme/toolroll",
                githubBase: "main",
                mergeSummary: chosenMode == "ship"
                    ? "Freezes a snapshot commit, runs npm test, opens a PR into acme/toolroll (main), and merges automatically once checks pass on this exact commit."
                    : "Freezes a snapshot commit and saves local branch without pushing."
            )
            return
        }

        guard let client, isLocalSession else {
            chatShipError = "Connect to your local Toolroll engine to ship."
            return
        }
        do {
            let preview = try await client.previewDirectChatShip(
                threadId: threadId,
                mode: mode,
                title: title,
                goal: goal
            )
            chatShipPreview = preview
            chatGitBindingErrors.removeValue(forKey: threadId)
        } catch {
            recordChatGitErrorIfRelevant(threadId: threadId, error: error.localizedDescription)
            chatShipError = error.localizedDescription
        }
    }

    public func executeChatShip(mode: String, title: String, goal: String, password: String) async -> Bool {
        guard let threadId = chatShipThreadId, let preview = chatShipPreview else { return false }
        isExecutingChatShip = true
        chatShipError = nil
        defer { isExecutingChatShip = false }

        if activeProfile.isDemo {
            let ship = DirectChatShipSummary(
                id: preview.termsDigest,
                seq: 1,
                mode: mode,
                branch: preview.branch,
                candidateSha: "f4a8c912deadbeef",
                state: mode == "ship" ? "armed" : "kept",
                taskId: mode == "ship" ? "dc-\(preview.termsDigest.prefix(8))" : nil,
                prUrl: nil,
                detail: nil,
                createdAt: ISO8601DateFormatter().string(from: Date()),
                stateAt: ISO8601DateFormatter().string(from: Date())
            )
            if let idx = chatThreads.firstIndex(where: { $0.id == threadId }) {
                chatThreads[idx].ships.insert(ship, at: 0)
            }
            isChatShipSheetOpen = false
            notice = WorkbenchNotice(kind: .info, message: mode == "ship" ? "Shipped snapshot — verifying checks (demo)." : "Saved branch \(preview.branch) (demo).")
            return true
        }

        guard let client, isLocalSession else {
            chatShipError = "Connect to your local Toolroll engine to ship."
            return false
        }
        let pw = password
        do {
            let res = try await client.executeDirectChatShip(
                threadId: threadId,
                mode: mode,
                termsDigest: preview.termsDigest,
                title: title,
                goal: goal,
                password: pw.isEmpty ? nil : pw
            )
            if !res.ok {
                if res.code == "terms_changed" {
                    await reloadChatShipPreview(mode: mode, title: title, goal: goal)
                    chatShipError = res.error ?? "Changes occurred since this preview. Review the updated terms and press Ship again."
                    return false
                }
                let err = res.error ?? "Could not ship chat."
                recordChatGitErrorIfRelevant(threadId: threadId, error: err)
                chatShipError = err
                return false
            }
            isChatShipSheetOpen = false
            notice = WorkbenchNotice(kind: .info, message: res.said ?? "Shipped.")
            await refreshDirectChatDetail(threadId: threadId)
            if let rows = try? await client.fetchWorkRows() {
                workRowsResponse = rows
            }
            return true
        } catch {
            recordChatGitErrorIfRelevant(threadId: threadId, error: error.localizedDescription)
            chatShipError = error.localizedDescription
            return false
        }
    }

    public func cancelChatShip(threadId: String, shipId: String) async {
        if activeProfile.isDemo {
            if let idx = chatThreads.firstIndex(where: { $0.id == threadId }),
               let sIdx = chatThreads[idx].ships.firstIndex(where: { $0.id == shipId }) {
                let s = chatThreads[idx].ships[sIdx]
                chatThreads[idx].ships[sIdx] = DirectChatShipSummary(
                    id: s.id, seq: s.seq, mode: s.mode, branch: s.branch, candidateSha: s.candidateSha,
                    state: "cancelled", taskId: s.taskId, prUrl: s.prUrl, detail: "Cancelled by owner.",
                    createdAt: s.createdAt, stateAt: ISO8601DateFormatter().string(from: Date())
                )
            }
            return
        }
        guard let client, isLocalSession else { return }
        do {
            let res = try await client.cancelDirectChatShip(threadId: threadId, shipId: shipId)
            if !res.ok {
                notice = WorkbenchNotice(kind: .refusal, message: res.error ?? "Could not cancel Ship.")
                return
            }
            notice = WorkbenchNotice(kind: .info, message: res.said ?? "Auto-merge cancelled.")
            await refreshDirectChatDetail(threadId: threadId)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func loadDirectChatArtifactData(for artifact: DirectChatArtifact) async -> Data? {
        if let cached = chatArtifactImages[artifact.url] {
            return cached
        }
        if activeProfile.isDemo {
            chatArtifactImages[artifact.url] = DemoFixtures.demoArtifactPngData
            return DemoFixtures.demoArtifactPngData
        }
        guard let client, isLocalSession else { return nil }
        if let bytes = try? await client.fetchDirectChatArtifactData(urlPath: artifact.url), !bytes.isEmpty {
            chatArtifactImages[artifact.url] = bytes
            return bytes
        }
        return nil
    }

    public func promoteChatToTask(threadId: String) async {
        await openChatShipSheet(threadId: threadId)
    }

    public func refreshLocalDiscovery() {
        Task.detached(priority: .utility) {
            let repos = LocalWorkspaceDiscovery.scanGitRepositories(limit: 40)
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.discoveredGitRepos = repos
            }
        }
    }

    public func selectCliThread(_ thread: LocalCliThread) {
        isComposingNewWork = false
        workspaceMode = .workbench
        selectedCliThreadId = thread.id
        selectedCliThreadMessages = []
        Task.detached(priority: .userInitiated) {
            let msgs = LocalWorkspaceDiscovery.loadCliThreadMessages(thread: thread, limit: 80)
            await MainActor.run { [weak self] in
                guard let self, self.selectedCliThreadId == thread.id else { return }
                self.selectedCliThreadMessages = msgs
            }
        }
    }

    public func continueCliThreadAsTask(_ thread: LocalCliThread) async {
        if let path = thread.projectPath,
           !allProjects.contains(where: { $0.caseInsensitiveCompare(thread.projectName) == .orderedSame }) {
            await addLocalProject(path: path)
        } else {
            activeProject = thread.projectName
        }
        pendingComposerDraft = "Continue \(thread.provider.displayName) thread (\(thread.sessionId.prefix(8))): \(thread.title)"
        selectedCliThreadId = nil
        isComposingNewWork = true
        workspaceMode = .workbench
    }

    public func approveProjectWorktreeSetup(repoPath: String, command: String, password: String) async -> Bool {
        let cleanCmd = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanCmd.isEmpty else {
            notice = WorkbenchNotice(kind: .refusal, message: "Enter a worktree setup command first.")
            return false
        }
        guard let client, !activeProfile.isDemo else {
            notice = WorkbenchNotice(kind: .info, message: "Saved worktree setup (demo).")
            return true
        }
        let buildCurrent = modelsRead.roles.first(where: { $0.key == "build" })?.current ?? ""
        let parts = buildCurrent.split(separator: "|", maxSplits: 1).map(String.init)
        let provider = parts.count == 2 ? parts[0] : "claude"
        let model = parts.count == 2 ? parts[1] : "claude-opus-5-5"

        busyLabel = "Approving setup…"
        defer { busyLabel = nil }
        do {
            let reply = try await client.approveProjectWorktreeSetup(
                repo: repoPath,
                provider: provider,
                model: model,
                command: cleanCmd,
                password: password
            )
            notice = WorkbenchNotice(kind: .info, message: reply)
            return true
        } catch {
            if !handleSignInRefusal(error) { notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription) }
            return false
        }
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
        if let direct = resolveLocalProjectRoot(for: projectName) {
            return direct
        }
        return discoveredGitRepos.first(where: { $0.name.caseInsensitiveCompare(projectName) == .orderedSame })?.path
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

    public func selectModel(value: String, label: String, forRoleKey roleKey: String) async {
        var fields: [String: String] = [:]
        if roleKey == "all" {
            for role in modelsRead.roles {
                fields[role.key] = value
            }
            fields["plan-strong"] = "clear"
            fields["build-strong"] = "clear"
            fields["build-light"] = "clear"
            fields["review-strong"] = "clear"
        } else {
            fields[roleKey] = value
            switch roleKey {
            case "plan":
                fields["plan-strong"] = "clear"
            case "build":
                fields["build-strong"] = "clear"
                fields["build-light"] = "clear"
            case "review":
                fields["review-strong"] = "clear"
            default:
                break
            }
        }
        await submitModelFields(fields, friendlyLabel: label)
    }

    public func applyModelPreset(_ preset: AgentPreset) async {
        await submitModelFields(preset.fields, friendlyLabel: preset.name)
    }

    public func refreshModelCatalog() async {
        guard let client, !activeProfile.isDemo, !isCheckingModelCatalog else { return }
        isCheckingModelCatalog = true
        modelChangeError = nil
        defer { isCheckingModelCatalog = false }
        do {
            _ = try await client.checkModelCatalog()
            modelsRead = try await client.fetchModels()
        } catch {
            modelChangeError = error.localizedDescription
        }
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
        } catch let error as ToolrollClientError where handleSignInRefusal(error) {
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
        return workRowsResponse.rows.first(where: { $0.id == id }) ?? archivedRows.first(where: { $0.id == id })
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

    public func start() async {
        DesktopNotifier.shared.configure()
        DesktopNotifier.shared.onSelectTask = { [weak self] taskId in
            guard let self else { return }
            self.workspaceMode = .workbench
            Task { await self.selectTask(taskId) }
        }
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

    public var showPasswordNudge: Bool {
        guard isLocalSession, passwordSet == false else { return false }
        if let until = passwordNudgeSnoozedUntil, until > Date() { return false }
        return true
    }

    public func snoozePasswordNudge() {
        let until = Date().addingTimeInterval(Self.passwordNudgeSnooze)
        passwordNudgeSnoozedUntil = until
        UserDefaults.standard.set(until, forKey: Self.passwordNudgeKey)
    }

    public func openSetPassword() {
        setPasswordProblem = nil
        isSetPasswordOpen = true
    }

    @discardableResult
    public func handleSignInRefusal(_ error: Error) -> Bool {
        switch error as? ToolrollClientError {
        case .passwordNotSet?:
            openSetPassword()
            notice = WorkbenchNotice(kind: .info, message: "Set a password first; then do this again.")
            return true
        case .fullSignInNeeded?:
            notice = WorkbenchNotice(kind: .refusal, message: "This needs you signed in with your password: open Toolroll in your browser and sign in there.")
            return true
        default:
            return false
        }
    }

    @discardableResult
    public func setFirstPassword(_ password: String, again: String, saveToTouchID: Bool = false) async -> Bool {
        setPasswordProblem = nil
        guard password.count >= 8 else { setPasswordProblem = "Use at least 8 characters."; return false }
        guard password == again else { setPasswordProblem = "The two passwords don't match. Type them again."; return false }
        guard let client else { setPasswordProblem = "Toolroll isn't connected. Run `toolroll up`, then try again."; return false }
        setPasswordBusy = true
        defer { setPasswordBusy = false }
        sseTask?.cancel()
        sseTask = nil
        do {
            try await client.setFirstPassword(password)
        } catch {
            setPasswordProblem = error.localizedDescription
            return false
        }
        let keep = selectedTaskId
        let connected = await connectToLocalConsoleIfAvailable(silent: true)
        if let keep { await selectTask(keep) }
        guard connected else {
            setPasswordProblem = "Toolroll couldn't reconnect. Run `toolroll` in Terminal, then reopen this window."
            return false
        }
        guard passwordSet == true else {
            setPasswordProblem = "Toolroll didn't take that password. Try again, or set it in Terminal with `toolroll password set`."
            return false
        }
        var touchMsg = ""
        if saveToTouchID && isTouchIDAvailable {
            let saved = enableTouchID(password: password)
            if saved.ok {
                touchMsg = " \(touchIDLabel) approvals enabled."
            }
        }
        isSetPasswordOpen = false
        notice = WorkbenchNotice(kind: .info, message: "Password set.\(touchMsg) Keep it in your password manager.")
        return true
    }

    func adoptRenewedSession(_ creds: LocalSessionCredentials) {
        guard let eq = creds.cookieHeader.firstIndex(of: "=") else { return }
        let name = String(creds.cookieHeader[..<eq])
        let value = String(creds.cookieHeader[creds.cookieHeader.index(after: eq)...])
        localSessionCookie = (name, value, creds.origin)
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
            self.localDatabasePath = creds.databasePath
            let fresh = ToolrollClient(localSession: creds)
            self.client = fresh
            await fresh.onSessionRenewed { [weak self] renewed in
                Task { @MainActor in self?.adoptRenewedSession(renewed) }
            }
            self.passwordSet = creds.passwordSet
            refreshTouchIDState()
            refreshAgentRequests(notifyNew: false)
            startAgentRequestPolling()
            if let eq = creds.cookieHeader.firstIndex(of: "=") {
                let cname = String(creds.cookieHeader[..<eq])
                let cval = String(creds.cookieHeader[creds.cookieHeader.index(after: eq)...])
                self.localSessionCookie = (cname, cval, creds.origin)
            }
            self.terminalSession.disconnect(clearOutput: true)
            self.selectedTaskId = nil
            self.notice = silent ? nil : WorkbenchNotice(kind: .info, message: "Connected to Local Toolroll at \(creds.origin) as \(creds.account).")
            await refreshAll()
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

    public func refreshAll() async {
        isLoading = true
        defer { isLoading = false }
        refreshLocalDiscovery()
        refreshAgentRequests(notifyNew: true)
        refreshTouchIDState()
        loadCachedGeminiSubscription()

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
            await refreshDirectChats()
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
            async let archivedReq = client.fetchWorkRows(view: "archived")

            workRowsResponse = try await rowsReq
            processTaskNotifications(workRowsResponse.rows)
            if let pres = try? await presReq { presence = pres }
            if let terms = try? await termsReq { terminalsResponse = terms }
            if let chat = try? await leadReq { leadChat = chat }
            if let ag = try? await agentsReq { agentsRead = ag }
            if let mod = try? await modelsReq { modelsRead = mod }
            automations = try? await client.fetchAutomations()
            projectsRead = try? await client.fetchProjects()
            if let archived = try? await archivedReq { archivedRows = archived.rows }
            await refreshDirectChats()

            if let id = selectedTaskId {
                await loadSelectedTaskDetails(taskId: id)
            }
            maybeAutoRefreshSubscriptionUsage()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func selectTask(_ taskId: String, recordHistory: Bool = true) async {
        workspaceMode = .workbench
        if recordHistory && (selectedTaskId != taskId || isComposingNewWork) {
            backStack.append(isComposingNewWork ? nil : selectedTaskId)
            forwardStack.removeAll()
        }
        isComposingNewWork = false
        selectedCliThreadId = nil
        selectedChatThreadId = nil
        guard selectedTaskId != taskId || stepCards?.task.id != taskId else { return }
        selectedTaskId = taskId
        taskViewMode = .activity
        taskResult = nil
        selectedLiveRunId = nil
        liveRunRecords = []
        liveRunRecordsById = [:]
        selectedDiffPath = nil
        selectedDiffFile = nil
        approvalCard = nil
        approvalPasswordPrompt = nil
        await loadSelectedTaskDetails(taskId: taskId)
        restartSSE()
    }

    public func selectLiveRun(_ runId: Int) async {
        selectedLiveRunId = runId
        if let cached = liveRunRecordsById[runId] {
            liveRunRecords = cached
        }
        guard !activeProfile.isDemo, let client else { return }
        isLoadingLiveRun = true
        defer { isLoadingLiveRun = false }
        if let live = try? await client.fetchLiveRunWindow(runId: runId) {
            liveRunRecordsById[runId] = live.records
            if selectedLiveRunId == runId {
                liveRunRecords = live.records
            }
        } else if liveRunRecordsById[runId] == nil, selectedLiveRunId == runId {
            liveRunRecords = []
        }
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
        async let resultReq = client.fetchTaskResult(taskId: taskId)

        if let steps = try? await stepsReq {
            stepCards = steps
            let allRunIds = Set(steps.cards.flatMap(\.runs) + [steps.liveRun, steps.review?.run].compactMap { $0 })
            let targetRun: Int?
            if let pinned = selectedLiveRunId, allRunIds.contains(pinned) {
                targetRun = pinned
            } else {
                targetRun = steps.liveRun ?? steps.review?.run ?? steps.cards.flatMap(\.runs).max()
            }
            selectedLiveRunId = targetRun
            if let runId = targetRun, let live = try? await client.fetchLiveRunWindow(runId: runId) {
                liveRunRecordsById[runId] = live.records
                liveRunRecords = live.records
            } else {
                liveRunRecords = []
            }

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
        if let result = try? await resultReq {
            if selectedTaskId == taskId {
                taskResult = result
            }
        } else if selectedTaskId == taskId {
            taskResult = nil
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

    public func loadTaskEvidenceImage(urlPath: String) async -> Data? {
        if let cached = taskEvidenceImages[urlPath] {
            return cached
        }
        guard !activeProfile.isDemo, let client else { return nil }
        if let bytes = try? await client.fetchAuthenticatedBytes(path: urlPath) {
            taskEvidenceImages[urlPath] = bytes
            return bytes
        }
        return nil
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

    public func approveSelectedTask(password: String = "") async {
        guard let rootTaskId = selectedTaskId else { return }
        let queryTaskId = stepCards?.task.id ?? rootTaskId
        busyLabel = "Approving plan…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            demoApprovedTasks.insert(rootTaskId)
            approvalCard = nil
            approvalPasswordPrompt = nil
            notice = WorkbenchNotice(kind: .info, message: "Approved plan for \(rootTaskId). Build started.")
            await refreshAll()
            return
        }

        guard let client else { return }
        do {
            var card: ApprovalCard
            if let existing = approvalCard,
               (existing.task == queryTaskId || existing.task == rootTaskId),
               existing.digest != nil,
               existing.nonce != nil {
                card = existing
            } else {
                card = try await client.fetchApprovalCard(taskId: queryTaskId)
                approvalCard = card
            }
            guard let shownDigest = card.digest, let nonce = card.nonce else {
                notice = WorkbenchNotice(kind: .refusal, message: card.problem ?? "No pending approval on this task.")
                return
            }

            do {
                let reply = try await client.approveTask(taskId: card.task, digest: shownDigest, nonce: nonce, password: password)
                approvalPasswordPrompt = nil
                approvalCard = nil
                notice = WorkbenchNotice(kind: .info, message: reply)
                await refreshAll()
            } catch let err as ToolrollClientError where err.localizedDescription.localizedCaseInsensitiveContains("stale") {
                let fresh = try await client.fetchApprovalCard(taskId: queryTaskId)
                approvalCard = fresh
                if let freshDigest = fresh.digest, let freshNonce = fresh.nonce, freshDigest == shownDigest {
                    let reply = try await client.approveTask(taskId: fresh.task, digest: freshDigest, nonce: freshNonce, password: password)
                    approvalPasswordPrompt = nil
                    approvalCard = nil
                    notice = WorkbenchNotice(kind: .info, message: reply)
                    await refreshAll()
                } else {
                    notice = WorkbenchNotice(kind: .refusal, message: "Plan terms changed — review the refreshed plan and click Approve & Build again.")
                }
            }
        } catch let error as ToolrollClientError where handleSignInRefusal(error) {
        } catch ToolrollClientError.passwordRequired(let msg) {
            approvalPasswordPrompt = msg
            if let fresh = try? await client.fetchApprovalCard(taskId: queryTaskId) {
                approvalCard = fresh
            }
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            if let fresh = try? await client.fetchApprovalCard(taskId: queryTaskId), fresh.digest != nil {
                approvalCard = fresh
            }
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
        guard let taskId = stepCards?.task.id ?? selectedTaskId else { return }
        await prepareCancel(taskId: taskId, alsoArchive: false)
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
        busyLabel = "Applying result…"
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
            notice = WorkbenchNotice(kind: .info, message: "Applied result \(candidateId.prefix(8)) — checks passed.")
            return
        }
        guard let client else { return }
        do {
            let res = try await client.promoteCandidate(taskId: taskId, candidateId: candidateId)
            let runStr = res.runId.map { "Run #\($0)" } ?? "task"
            notice = WorkbenchNotice(kind: .info, message: "Applied result \(candidateId.prefix(8)) to \(runStr). Checks queued.")
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
            notice = WorkbenchNotice(kind: .info, message: "Opened PR #488.")
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
        let buildStepRun = stepCards?.cards
            .first(where: { $0.label.lowercased().contains("build") })?
            .runs.max()
        let targetRun = stepCards?.review?.run ?? buildStepRun ?? stepCards?.liveRun ?? stepCards?.cards.flatMap(\.runs).max()
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
            let isRepoScratch = started.scratch ?? (started.branch == "main")
            terminalIsScratch = isRepoScratch
            if isRepoScratch {
                let why = started.note.map { " \($0)" } ?? " This task has no saved build to open yet."
                notice = WorkbenchNotice(
                    kind: .info,
                    message: "Opened a scratch shell on \(targetProject ?? "the project")'s own branch.\(why) Agents run in the background; watch them in Activity."
                )
            } else {
                notice = WorkbenchNotice(
                    kind: .info,
                    message: started.reused
                        ? "Attached to \(started.program) take-over shell on \(started.branch)."
                        : "Opened \(started.program) take-over shell on \(started.branch)."
                )
            }
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

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
           terminalSession.taskId != taskId || terminalSession.connectionState != .connected || terminalIsScratch {
            Task { await attachOrStartTerminal(taskId: taskId, program: "shell", openDrawer: false) }
        }
    }

    public func activeWorktreeBranch(for row: WorkRow) -> String {
        if terminalSession.taskId == row.id,
           !terminalSession.branch.isEmpty,
           (taskViewMode == .terminal || !terminalIsScratch) {
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
        let needsTotal = rows.filter { $0.status == .needs }.count + pendingAgentRequests.count
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

    public func openLeadCanvas() {
        openWorkHome()
        preferredOrchestrationMode = "lead"
        Task { await refreshLeadChat() }
    }

    public func refreshLeadChat() async {
        guard let client, !activeProfile.isDemo else { return }
        if let refreshed = try? await client.fetchLeadChat(project: selectedProject) {
            leadChat = refreshed
            startLeadBusyPollingIfNeeded()
        }
    }

    public func confirmLeadProposal(_ card: LeadChatCard) async {
        guard let client, !activeProfile.isDemo else { return }
        busyLabel = "\(card.primary?.label ?? "Confirming")…"
        defer { busyLabel = nil }
        do {
            let said = try await client.confirmLeadProposal(
                id: card.id,
                irreversible: card.primary?.irreversible ?? false
            )
            notice = WorkbenchNotice(kind: .info, message: said)
            await refreshLeadChat()
            await refreshAll()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func dismissLeadProposal(_ card: LeadChatCard) async {
        guard let client, !activeProfile.isDemo else { return }
        busyLabel = "Dismissing…"
        defer { busyLabel = nil }
        do {
            let said = try await client.dismissLeadProposal(id: card.id)
            notice = WorkbenchNotice(kind: .info, message: said)
            await refreshLeadChat()
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func openLeadLink(_ link: LeadChatLink) async {
        if let taskId = link.task, !taskId.isEmpty {
            await selectTask(taskId)
            if link.tab == "diff" {
                isInspectorVisible = true
                inspectorTab = .diff
            }
            return
        }
        let href = link.href.trimmingCharacters(in: .whitespacesAndNewlines)
        if href == "/flows" || href.hasPrefix("/flows/") {
            workspaceMode = .automations
            return
        }
        if href == "/projects" {
            isAddProjectSheetOpen = true
            return
        }
        if href == "/settings/appearance" {
            isAppearanceSheetOpen = true
            return
        }
        if href.hasPrefix("/direct-chats/") {
            let chatId = String(href.dropFirst("/direct-chats/".count)).components(separatedBy: "?").first ?? ""
            if !chatId.isEmpty, chatThreads.contains(where: { $0.id == chatId }) {
                selectChatThread(chatId)
                return
            }
        }
        openInBrowser(path: href)
    }

    @discardableResult
    public func askLeadAboutCanvas(_ message: String) async -> String? {
        openLeadCanvas()
        return await sendLeadMessage(message)
    }

    private func encodeLeadImages(from attachments: [ComposerAttachment]) -> [ToolrollClient.LeadImageUpload] {
        let imageItems = attachments.filter { $0.kind == .image }.prefix(4)
        var uploads: [ToolrollClient.LeadImageUpload] = []
        for item in imageItems {
            let url = URL(fileURLWithPath: item.path)
            guard let nsImage = NSImage(contentsOf: url) else { continue }
            var pixelSize = nsImage.size
            if let rep = nsImage.representations.first, rep.pixelsWide > 0, rep.pixelsHigh > 0 {
                pixelSize = NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
            }
            let maxSide: CGFloat = 1600
            let scale = min(1.0, maxSide / max(pixelSize.width, pixelSize.height, 1))
            let targetW = max(1, Int((pixelSize.width * scale).rounded()))
            let targetH = max(1, Int((pixelSize.height * scale).rounded()))
            guard let bitmap = NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: targetW,
                pixelsHigh: targetH,
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0
            ) else { continue }
            bitmap.size = NSSize(width: targetW, height: targetH)
            NSGraphicsContext.saveGraphicsState()
            if let ctx = NSGraphicsContext(bitmapImageRep: bitmap) {
                NSGraphicsContext.current = ctx
                ctx.imageInterpolation = .high
                nsImage.draw(
                    in: NSRect(x: 0, y: 0, width: targetW, height: targetH),
                    from: .zero,
                    operation: .copy,
                    fraction: 1.0
                )
            }
            NSGraphicsContext.restoreGraphicsState()
            let jpegData = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.82])
            let pngData = bitmap.representation(using: .png, properties: [:])
            let chosenData: Data
            let mediaType: String
            if let jpegData, let pngData {
                if pngData.count <= 450_000 || pngData.count <= jpegData.count {
                    chosenData = pngData
                    mediaType = "image/png"
                } else {
                    chosenData = jpegData
                    mediaType = "image/jpeg"
                }
            } else if let jpegData {
                chosenData = jpegData
                mediaType = "image/jpeg"
            } else if let pngData {
                chosenData = pngData
                mediaType = "image/png"
            } else {
                continue
            }
            guard chosenData.count <= 3_500_000 else { continue }
            uploads.append(ToolrollClient.LeadImageUpload(
                filename: item.displayName,
                mediaType: mediaType,
                dataBase64: chosenData.base64EncodedString()
            ))
        }
        return uploads
    }

    @discardableResult
    public func sendLeadMessage(_ text: String, attachments: [ComposerAttachment] = []) async -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        busyLabel = "Sending to Lead…"
        defer { busyLabel = nil }

        if activeProfile.isDemo {
            var msgs = leadChat.messages
            let nextId = (msgs.last?.id ?? 0) + 1
            msgs.append(LeadMessage(id: nextId, role: "user", text: trimmed, at: "now"))
            msgs.append(LeadMessage(id: nextId + 1, role: "assistant", text: "Demo mode: start local Toolroll (`toolroll up`) or connect a remote workspace (`⌘⇧P`) to chat with your real central Lead.", at: "now"))
            leadChat = LeadChatResponse(leadName: leadChat.leadName, canSend: true, busy: false, messages: msgs)
            return nil
        }
        guard let client else { return "Not connected to Toolroll." }
        let imageUploads = encodeLeadImages(from: attachments)
        do {
            _ = try await client.sendLeadMessage(
                message: trimmed,
                project: selectedProject,
                session: leadChat.session,
                images: imageUploads
            )
            if let refreshed = try? await client.fetchLeadChat(project: selectedProject) {
                leadChat = refreshed
            }
            startLeadBusyPollingIfNeeded()
            return nil
        } catch {
            let words = error.localizedDescription
            notice = WorkbenchNotice(kind: .refusal, message: words)
            return words
        }
    }

    private var leadBusyPollTask: Task<Void, Never>?

    private func startLeadBusyPollingIfNeeded() {
        leadBusyPollTask?.cancel()
        guard leadChat.busy, let client, !activeProfile.isDemo else { return }
        let project = selectedProject
        leadBusyPollTask = Task { [weak self] in
            for _ in 0..<90 {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                if Task.isCancelled { return }
                guard let self else { return }
                if let refreshed = try? await client.fetchLeadChat(project: project) {
                    self.leadChat = refreshed
                    if !refreshed.busy { return }
                }
            }
        }
    }

    public func openInBrowser(path: String) {
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Demo mode: connect a workspace to open that page.")
            return
        }
        let base = activeProfile.origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if let url = URL(string: base + (path.hasPrefix("/") ? path : "/" + path)) { NSWorkspace.shared.open(url) }
    }

    public var leadDraftSeed: String?

    public internal(set) var automations: AutomationsResponse?
    public var automationToResume: Automation?

    public func startAutomationWithLead() {
        openLeadCanvas()
        workDraftText = "Set up an automation: every "
        leadDraftSeed = "Set up an automation: every "
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

    public func openProjectSettings(projectName: String? = nil) {
        projectSettingsTargetName = projectName ?? selectedRow?.project ?? activeProject ?? selectedProject ?? allProjects.first
        isProjectSettingsOpen = true
    }

    public func openProjectLiveViewSettings() {
        openProjectSettings()
    }

    public func loadProjectSettings(repoPath: String) async -> ToolrollClient.ProjectSettingsSnapshot? {
        if activeProfile.isDemo {
            let demo = ToolrollClient.ProjectSettingsSnapshot(
                repoPath: repoPath,
                projectName: (repoPath as NSString).lastPathComponent,
                liveCommandsShown: false,
                liveViewNonce: "demo",
                networkOpen: false,
                networkLocalAny: false,
                networkHosts: "",
                concurrency: 1,
                suggestedSetupCommand: "pnpm install --frozen-lockfile"
            )
            projectSettingsSnapshot = demo
            return demo
        }
        guard let client else { return nil }
        do {
            let snap = try await client.fetchProjectSettings(repo: repoPath)
            projectSettingsSnapshot = snap
            return snap
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            return nil
        }
    }

    public func updateProjectLiveCommands(
        repoPath: String,
        show: Bool,
        nonce: String?,
        password: String
    ) async -> (ok: Bool, message: String) {
        if activeProfile.isDemo {
            return (true, show ? "Commands shown (demo)." : "Commands hidden (demo).")
        }
        guard let client else { return (false, "Not connected.") }
        do {
            let reply = try await client.setProjectLiveCommands(repo: repoPath, show: show, nonce: nonce, password: password)
            notice = WorkbenchNotice(kind: .info, message: reply)
            return (true, reply)
        } catch {
            handleSignInRefusal(error)
            return (false, error.localizedDescription)
        }
    }

    public func updateProjectNetwork(
        repoPath: String,
        open: Bool,
        localAny: Bool,
        hosts: String,
        password: String
    ) async -> (ok: Bool, message: String) {
        if activeProfile.isDemo {
            return (true, "Saved network settings (demo).")
        }
        guard let client else { return (false, "Not connected.") }
        do {
            let reply = try await client.setProjectNetwork(repo: repoPath, open: open, localAny: localAny, hosts: hosts, password: password)
            notice = WorkbenchNotice(kind: .info, message: reply)
            return (true, reply)
        } catch {
            handleSignInRefusal(error)
            return (false, error.localizedDescription)
        }
    }

    public func updateProjectConcurrency(repoPath: String, concurrency: Int) async -> (ok: Bool, message: String) {
        if activeProfile.isDemo {
            return (true, "Saved. Up to \(concurrency) at once (demo).")
        }
        guard let client else { return (false, "Not connected.") }
        do {
            let reply = try await client.setProjectConcurrency(repo: repoPath, concurrency: concurrency)
            notice = WorkbenchNotice(kind: .info, message: reply)
            return (true, reply)
        } catch {
            handleSignInRefusal(error)
            return (false, error.localizedDescription)
        }
    }

    public var resolvedLocalDatabasePath: String? {
        if let localDatabasePath, !localDatabasePath.isEmpty { return localDatabasePath }
        return LocalConsoleConnector.candidateDatabasePaths().first {
            FileManager.default.fileExists(atPath: $0)
        }
    }

    public func refreshTouchIDState() {
        isTouchIDAvailable = TouchIDVault.isAuthenticationAvailable()
        touchIDLabel = TouchIDVault.biometryLabel()
        touchIDSystemImage = TouchIDVault.biometrySystemImage()
        isTouchIDEnabled = isTouchIDAvailable && TouchIDVault.hasStoredPassword(account: activeProfile.account)
    }

    @discardableResult
    public func enableTouchID(password: String) -> (ok: Bool, message: String) {
        let trimmed = password
        guard !trimmed.isEmpty else {
            return (false, "Enter your Toolroll password to enable \(touchIDLabel).")
        }
        do {
            try TouchIDVault.savePassword(trimmed, account: activeProfile.account)
            refreshTouchIDState()
            return (true, "\(touchIDLabel) enabled for quick approvals.")
        } catch {
            return (false, error.localizedDescription)
        }
    }

    public func disableTouchID() {
        TouchIDVault.deletePassword(account: activeProfile.account)
        refreshTouchIDState()
        notice = WorkbenchNotice(kind: .info, message: "\(touchIDLabel) password removed from Keychain.")
    }

    /// The app never remembers a password. An empty password is sent as empty: the server alone decides whether a
    /// password verified moments ago on this session stands in (docs/guide/security.md: standard plan approval and
    /// chat messages, 15 minutes, direct local requests only). Every other step-up needs a password typed now or a
    /// Touch ID unlock that actually runs.
    public func unlockPasswordWithTouchID(reason: String) async -> String? {
        do {
            return try await TouchIDVault.unlockPassword(account: activeProfile.account, reason: reason)
        } catch TouchIDVaultError.cancelled {
            return nil
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            return nil
        }
    }

    public func approveSelectedTaskWithTouchID() async {
        let title = selectedRow?.title ?? selectedTaskId ?? "this task"
        guard let pw = await unlockPasswordWithTouchID(reason: "Approve plan for \(title)") else { return }
        await approveSelectedTask(password: pw)
    }

    public func refreshAgentRequests(notifyNew: Bool = true) {
        guard !activeProfile.isDemo, let dbPath = resolvedLocalDatabasePath else {
            pendingAgentRequests = []
            return
        }
        let pending = AgentRequestStore.loadPending(databasePath: dbPath)
        let hadBaseline = !knownAgentRequestIds.isEmpty || !pendingAgentRequests.isEmpty
        if notifyNew {
            for req in pending where !knownAgentRequestIds.contains(req.id) {
                if hadBaseline || isLocalSession {
                    DesktopNotifier.shared.notify(
                        taskId: req.id,
                        title: "\(req.requester) · \(req.projectName)",
                        subtitle: "Approval requested",
                        body: req.why.isEmpty ? req.summary : "\(req.summary) — \(req.why)"
                    )
                }
            }
        }
        for req in pending {
            knownAgentRequestIds.insert(req.id)
        }
        if pending != pendingAgentRequests {
            pendingAgentRequests = pending
            let needsTotal = workRowsResponse.rows.filter { $0.status == .needs }.count + pending.count
            DesktopNotifier.shared.updateDockBadge(needsCount: needsTotal)
        }
    }

    private func startAgentRequestPolling() {
        agentRequestPollTask?.cancel()
        agentRequestPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled, let self else { return }
                self.refreshAgentRequests(notifyNew: true)
            }
        }
    }

    public func approveAgentRequest(_ request: AgentRequest, typedPassword: String? = nil) async -> (ok: Bool, message: String) {
        guard let dbPath = resolvedLocalDatabasePath else {
            return (false, "No local Toolroll database connected.")
        }
        resolvingAgentRequestId = request.id
        defer { resolvingAgentRequestId = nil }

        let password: String
        if let typed = typedPassword, !typed.isEmpty {
            password = typed
        } else {
            guard let unlocked = await unlockPasswordWithTouchID(
                reason: "Approve \(request.requester)'s request for \(request.projectName): \(request.summary)"
            ) else {
                return (false, "Cancelled.")
            }
            password = unlocked
        }

        let outcome: (ok: Bool, message: String)
        switch request.kind {
        case .network:
            let open = request.params.mode == "open"
            let localAny = request.params.local == "any"
            let hosts = (request.params.hosts ?? []).joined(separator: ", ")
            outcome = await updateProjectNetwork(
                repoPath: request.repo,
                open: open,
                localAny: localAny,
                hosts: hosts,
                password: password
            )
        case .worktreeSetup:
            let cmd = request.params.command ?? ""
            let ok = await approveProjectWorktreeSetup(repoPath: request.repo, command: cmd, password: password)
            outcome = (ok, notice?.message ?? (ok ? "Approved worktree setup." : "Could not approve worktree setup."))
        case .liveView:
            let show = request.params.showCommands ?? true
            let snap = await loadProjectSettings(repoPath: request.repo)
            outcome = await updateProjectLiveCommands(
                repoPath: request.repo,
                show: show,
                nonce: snap?.liveViewNonce,
                password: password
            )
        }

        guard outcome.ok else {
            return outcome
        }

        AgentRequestStore.resolve(
            databasePath: dbPath,
            id: request.id,
            status: .approved,
            note: outcome.message
        )
        refreshAgentRequests(notifyNew: false)
        await refreshAll()
        notice = WorkbenchNotice(kind: .info, message: "Approved \(request.requester) request: \(request.summary)")
        return (true, outcome.message)
    }

    public func declineAgentRequest(_ request: AgentRequest, note: String? = nil) {
        guard let dbPath = resolvedLocalDatabasePath else { return }
        AgentRequestStore.resolve(
            databasePath: dbPath,
            id: request.id,
            status: .declined,
            note: note ?? "Declined in Toolroll.app"
        )
        refreshAgentRequests(notifyNew: false)
        notice = WorkbenchNotice(kind: .info, message: "Declined request from \(request.requester).")
    }

    public func refreshBackgroundServiceStatus() async {
        backgroundServiceStatus = await BackgroundServiceBridge.fetchStatus(databasePath: resolvedLocalDatabasePath)
    }

    @discardableResult
    public func setBackgroundServiceEnabled(_ enabled: Bool) async -> (ok: Bool, message: String) {
        isUpdatingBackgroundService = true
        defer { isUpdatingBackgroundService = false }
        if enabled, let child = managedLocalEngineProcess, child.isRunning {
            child.terminate()
            for _ in 0..<20 {
                if !child.isRunning { break }
                try? await Task.sleep(for: .milliseconds(200))
            }
            managedLocalEngineProcess = nil
        }
        let res = await BackgroundServiceBridge.setEnabled(enabled, databasePath: resolvedLocalDatabasePath)
        await refreshBackgroundServiceStatus()
        if res.ok {
            directChatBackgroundOn = enabled
            if enabled {
                showBackgroundServiceBanner = false
            }
            if enabled {
                for _ in 0..<10 {
                    if await connectToLocalConsoleIfAvailable(silent: true) {
                        await refreshDirectChats()
                        break
                    }
                    try? await Task.sleep(for: .milliseconds(400))
                }
            }
            notice = WorkbenchNotice(kind: .info, message: res.message)
        }
        return res
    }

    public func loadCachedGeminiSubscription() {
        guard !activeProfile.isDemo, let dbPath = resolvedLocalDatabasePath else { return }
        if let stored = SubscriptionUsageBridge.loadGeminiStatus(databasePath: dbPath) {
            geminiSubscription = stored
        }
    }

    private func maybeAutoRefreshSubscriptionUsage() {
        guard isLocalSession, !activeProfile.isDemo, !didAutoRefreshUsage, !isRefreshingUsage else { return }
        let limits = workRowsResponse.limits ?? []
        let hasStale = limits.contains { limit in
            if case .passed = limit.resetState(now: Date()) { return true }
            return false
        }
        let missingGemini = geminiSubscription == nil
        guard hasStale || missingGemini else { return }
        didAutoRefreshUsage = true
        Task { await refreshSubscriptionUsage(silent: true) }
    }

    public func refreshSubscriptionUsage(silent: Bool = false) async {
        guard !activeProfile.isDemo, !isRefreshingUsage else { return }
        isRefreshingUsage = true
        defer { isRefreshingUsage = false }
        let res = await SubscriptionUsageBridge.refreshAll(databasePath: resolvedLocalDatabasePath)
        if let gemini = res.gemini {
            geminiSubscription = gemini
        } else {
            loadCachedGeminiSubscription()
        }
        if res.ok {
            lastUsageRefreshAt = Date()
            if let client, let rows = try? await client.fetchWorkRows() {
                workRowsResponse = rows
            }
            if !silent {
                notice = WorkbenchNotice(kind: .info, message: "Updated Claude, Codex, and Gemini usage.")
            }
        } else if !silent, let msg = res.message {
            notice = WorkbenchNotice(kind: .refusal, message: msg)
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

    private func restartSSE() {
        var rooms = ["workspace", "chat"]
        if let taskId = selectedTaskId {
            rooms.append("task:\(taskId)")
        }
        if let chatId = selectedChatThreadId, !chatId.hasPrefix("pending-") {
            rooms.append("direct-chat:\(chatId)")
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
        if room == "workspace" || room == "home" {
            await refreshAll()
        } else if room == "chat" || room.hasPrefix("chat?"), let client {
            if let chat = try? await client.fetchLeadChat(project: selectedProject) {
                leadChat = chat
                if !chat.busy {
                    leadBusyPollTask?.cancel()
                }
            }
        } else if room.hasPrefix("direct-chat:") {
            let chatId = String(room.dropFirst("direct-chat:".count))
            await refreshDirectChatDetail(threadId: chatId)
        } else if room.hasPrefix("task:") {
            let taskId = String(room.dropFirst(5))
            if taskId == selectedTaskId {
                await loadSelectedTaskDetails(taskId: taskId)
            }
            if let client, let rows = try? await client.fetchWorkRows() {
                workRowsResponse = rows
                processTaskNotifications(rows.rows)
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
