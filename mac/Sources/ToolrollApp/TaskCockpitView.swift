import AppKit
import SwiftUI
import ToolrollCore

/// Center Task Cockpit (--so-paper) — 100% native in-app approvals, result reviews, agent questions,
/// plan/retry recovery, Candidates strip, Steps timeline, and bottom composer.
public struct TaskCockpitView: View {
    @Bindable var store: WorkbenchStore
    @State private var steerDraft: String = ""
    @State private var steerAttachments: [ComposerAttachment] = []
    @State private var isComposerDropTargeted: Bool = false
    @FocusState private var steerFocused: Bool
    @State private var approvalPassword: String = ""
    @State private var sendBackOpen: Bool = false
    @State private var sendBackNote: String = ""
    @State private var expandedSteps: Set<String> = []
    @State private var showAllSteps: Bool = false
    @State private var isModelPickerOpen: Bool = false
    @State private var modelPickerInitialRole: String = "build"
    @State private var copiedBranch: Bool = false
    @State private var showFullApprovalChecks: Bool = false
    @State private var showApprovalFiles: Bool = false
    @State private var showStandardSandboxDetails: Bool = false
    @State private var expandedCheckIds: Set<String> = []
    @State private var highlightedSection: String? = nil

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let row = store.selectedRow {
                unifiedTaskBar(row)
                HairlineDivider()

                if let notice = store.notice {
                    inPlaceNoticeBar(notice)
                    HairlineDivider()
                }

                if store.taskViewMode == .terminal {
                    LiveTerminalPaneView(store: store, session: store.terminalSession, inMainPane: true)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollViewReader { proxy in
                        // Top clickable Pipeline Stepper (Plan -> Approval -> Build -> Checks -> Ready)
                        if let cards = store.stepCards?.cards, !cards.isEmpty {
                            pipelineStepperBar(cards: cards, proxy: proxy)
                            HairlineDivider()
                        }

                        ScrollView {
                            VStack(alignment: .leading, spacing: 18) {
                                // 1. Agent Question (answer natively in-app)
                                if let question = row.need?.question {
                                    questionCard(question)
                                        .id("question-card")
                                }

                                // 2. Result Review (Accept or Send Back natively in-app)
                                if let review = store.stepCards?.review {
                                    resultReviewCard(review)
                                        .id("review-card")
                                }

                                // 3. Plan Approval (Review terms & Approve natively in-app!)
                                if let card = store.approvalCard {
                                    inAppApprovalCard(taskId: row.id, card: card)
                                        .id("approval-card")
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                                .strokeBorder(
                                                    highlightedSection == "approval-card" ? ToolrollPalette.ink.opacity(0.45) : Color.clear,
                                                    lineWidth: 1.5
                                                )
                                                .animation(.easeInOut(duration: 0.25), value: highlightedSection)
                                        )
                                } else if row.status == .needs,
                                          row.need?.question == nil,
                                          store.stepCards?.review == nil,
                                          store.stepCards?.planStopped == nil {
                                    fallbackApprovalCard(taskId: row.id, summary: row.ask ?? row.need?.ask ?? "Approval waiting on this task.")
                                        .id("approval-card")
                                }

                                // 4. Stopped Plan / Failure Recovery (Plan Again / Retry natively in-app)
                                if let stopped = store.stepCards?.planStopped {
                                    planStoppedCard(stopped)
                                        .id("recovery-card")
                                } else if let failure = store.stepCards?.failure {
                                    failureCard(failure)
                                        .id("recovery-card")
                                }

                                // 5. Hold Banner (Resume natively in-app)
                                if let held = store.stepCards?.held {
                                    heldBanner(held)
                                }

                                // 6. Explicit Active Agent Banner + Live Agent Activity Stream
                                activeAgentStatusBanner(row: row)
                                    .id("agent-activity")

                                if !store.liveRunRecords.isEmpty {
                                    liveStreamSection(records: store.liveRunRecords)
                                }

                                // 7. Candidates Strip (Promote / Rebase / Open PR)
                                if let cands = store.candidatesResponse?.candidates, !cands.isEmpty {
                                    candidatesSection(taskId: row.id, candidates: cands)
                                        .id("candidates-card")
                                }
                            }
                            .padding(.horizontal, 18)
                            .padding(.top, 16)
                            .padding(.bottom, 16)
                        }
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            composerBar(taskId: row.id)
                                .background(
                                    LinearGradient(
                                        colors: [ToolrollPalette.paper.opacity(0), ToolrollPalette.paper.opacity(0.88)],
                                        startPoint: .top,
                                        endPoint: .bottom
                                    )
                                    .allowsHitTesting(false)
                                )
                        }
                    }
                }
            } else {
                emptyState
            }
        }
        .background(ToolrollPalette.paper)
        .onChange(of: store.selectedTaskId) { _, _ in
            approvalPassword = ""
            sendBackOpen = false
            sendBackNote = ""
            showFullApprovalChecks = false
            showApprovalFiles = false
            showStandardSandboxDetails = false
            expandedCheckIds.removeAll()
        }
    }

    // MARK: - Responsive Liquid Glass Task Bar (ViewThatFits: zero wrapping at any width)

    private func unifiedTaskBar(_ row: WorkRow) -> some View {
        let branch = store.activeWorktreeBranch(for: row)
        let siblings = store.siblingActiveTasks(for: row)

        return ViewThatFits(in: .horizontal) {
            // Tier 1 (Wide): Activity|Terminal + Branch + Parallel + Team + Preview + Fork + …
            HStack(spacing: 8) {
                taskModeGlassSwitch
                branchCopyPill(branch: branch, maxWidth: 190)
                if !siblings.isEmpty { parallelWorktreesMenu(row: row, siblings: siblings) }
                if store.isTeamWorkspace { teamOwnerMenu(row: row) }
                if let busy = store.busyLabel { busyPill(busy) }
                Spacer(minLength: 8)
                ToolrollGlassGroup(spacing: 6) {
                    previewCanvasButton(row: row, compactIconOnly: false)
                    forkTaskButton
                    overflowTaskMenu(row: row, branch: branch)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)

            // Tier 2 (Medium): Activity|Terminal + Preview + … (branch & Fork cleanly inside …)
            HStack(spacing: 8) {
                taskModeGlassSwitch
                if let busy = store.busyLabel { busyPill(busy) }
                Spacer(minLength: 8)
                ToolrollGlassGroup(spacing: 6) {
                    previewCanvasButton(row: row, compactIconOnly: false)
                    overflowTaskMenu(row: row, branch: branch)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)

            // Tier 3 (Condensed): Activity|Terminal + icon-only Preview + … (guaranteed single-line!)
            HStack(spacing: 6) {
                taskModeGlassSwitch
                Spacer(minLength: 6)
                ToolrollGlassGroup(spacing: 6) {
                    previewCanvasButton(row: row, compactIconOnly: true)
                    overflowTaskMenu(row: row, branch: branch)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(ToolrollPalette.paper)
    }

    private var taskModeGlassSwitch: some View {
        HStack(spacing: 2) {
            ForEach(TaskViewMode.allCases) { mode in
                let selected = store.taskViewMode == mode
                Button {
                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                        store.setTaskViewMode(mode)
                    }
                } label: {
                    Text(mode.rawValue)
                        .font(.system(size: 11.5, weight: selected ? .semibold : .medium))
                        .foregroundStyle(selected ? ToolrollPalette.ink : ToolrollPalette.muted)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 10)
                        .frame(height: 22)
                        .background(
                            selected ? Color.white.opacity(0.14) : Color.clear,
                            in: Capsule()
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
        .help("Switch between Activity and raw Worktree Terminal (⌘T)")
    }

    private func branchCopyPill(branch: String, maxWidth: CGFloat) -> some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(branch, forType: .string)
            copiedBranch = true
            Task {
                try? await Task.sleep(for: .seconds(1.4))
                copiedBranch = false
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: copiedBranch ? "checkmark" : "arrow.triangle.branch")
                    .font(.system(size: 10))
                    .foregroundStyle(copiedBranch ? ToolrollPalette.success : ToolrollPalette.muted)
                Text(copiedBranch ? "Copied" : branch)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 9)
            .frame(height: 26)
            .frame(maxWidth: maxWidth, alignment: .leading)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .toolrollGlassCapsule(interactive: true)
        .help("Isolated worktree branch (\(branch)) — click to copy")
    }

    private func parallelWorktreesMenu(row: WorkRow, siblings: [WorkRow]) -> some View {
        Menu {
            Section("Parallel worktrees in \(row.project ?? "project")") {
                ForEach(siblings) { sib in
                    Button {
                        Task { await store.selectTask(sib.id) }
                    } label: {
                        Text("[\(sib.status.rawValue)] \(sib.title)")
                    }
                }
            }
            Divider()
            Button("Fork Another Parallel Approach…") {
                store.isForkSheetOpen = true
            }
        } label: {
            HStack(spacing: 5) {
                Circle().fill(ToolrollPalette.live).frame(width: 5.5, height: 5.5)
                Text("\(siblings.count) parallel")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 9)
            .frame(height: 26)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
        .help("Other active worktrees in this repository")
    }

    private func teamOwnerMenu(row: WorkRow) -> some View {
        Menu {
            ForEach(store.presence.accounts, id: \.self) { person in
                Button {
                    Task { await store.handOffTask(taskId: row.id, to: person) }
                } label: {
                    HStack {
                        Text(person == store.presence.me ? "@\(person) (me)" : "@\(person)")
                        if store.selectedTaskOwner == person {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(store.selectedTaskOwner.map { "@\($0)" } ?? "Unassigned")
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8.5, weight: .semibold))
            }
            .foregroundStyle(ToolrollPalette.muted)
            .padding(.horizontal, 8)
            .frame(height: 26)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
    }

    private func busyPill(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(ToolrollPalette.muted)
            .lineLimit(1)
    }

    private func previewCanvasButton(row: WorkRow, compactIconOnly: Bool) -> some View {
        Button {
            if let proj = row.project, !proj.isEmpty {
                store.selectedProject = proj
            }
            store.workspaceMode = .canvas
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "macwindow.on.rectangle")
                    .font(.system(size: 11))
                if !compactIconOnly {
                    Text("Preview")
                        .font(.system(size: 11.5, weight: .medium))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .foregroundStyle(ToolrollPalette.ink)
            .padding(.horizontal, compactIconOnly ? 0 : 10)
            .frame(width: compactIconOnly ? 26 : nil, height: 26)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
        .help("Open this project's visual Canvas (⌘3)")
    }

    private var forkTaskButton: some View {
        Button {
            store.isForkSheetOpen = true
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 10.5))
                Text("Fork")
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .foregroundStyle(ToolrollPalette.ink)
            .padding(.horizontal, 10)
            .frame(height: 26)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
        .help("Fork into a parallel worktree (⌘⇧F)")
    }

    private func overflowTaskMenu(row: WorkRow, branch: String) -> some View {
        Menu {
            Button("Copy Worktree Branch (\(branch))") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(branch, forType: .string)
            }
            Button("Fork Approach into Parallel Worktree…") {
                store.isForkSheetOpen = true
            }
            Button("Open Task Plan in Artifact Window (⌘4)") {
                store.openTaskArtifact()
            }
            Button("Open Raw Terminal (⌘T)") {
                store.setTaskViewMode(.terminal)
            }
            Button("Attach Terminal in Side Drawer") {
                Task { await store.attachOrStartTerminal(taskId: row.id, program: "shell", openDrawer: true) }
            }
            Divider()
            if store.stepCards?.planStopped?.again != nil || store.stepCards?.plan != nil {
                Button("Plan Again") {
                    Task { await store.planAgainSelectedTask() }
                }
            }
            if store.stepCards?.retry != nil {
                Button("Retry Build") {
                    Task { await store.retrySelectedTask() }
                }
            }
            if store.stepCards?.liveRun != nil {
                Button("Stop Active Run") {
                    Task { await store.stopSelectedTask() }
                }
            }
            Button(store.stepCards?.held != nil ? "Resume Task" : "Pause / Hold Task") {
                Task { await store.holdOrResumeSelectedTask() }
            }
            Divider()
            Button("Cancel Task", role: .destructive) {
                Task { await store.cancelSelectedTask() }
            }
            Divider()
            Button("Open Web View ↗") {
                store.openTaskInBrowser(taskId: row.id)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
                .frame(width: 26, height: 26)
                .contentShape(Circle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .toolrollGlassCapsule(interactive: true)
        .fixedSize()
        .help("More Task Actions")
    }

    private func inPlaceNoticeBar(_ notice: WorkbenchNotice) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.live)
                .frame(width: 6, height: 6)
            Text(notice.message)
                .font(.system(size: 12))
                .foregroundStyle(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.ink)
                .textSelection(.enabled)
            Spacer()
            Button {
                store.notice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(notice.kind == .refusal ? ToolrollPalette.danger.opacity(0.06) : ToolrollPalette.raised)
    }

    // MARK: - Scannable Native In-App Plan Approval Card (Miller's Law + Von Restorff)

    private var approvalStatusBadge: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(ToolrollPalette.ink)
                .frame(width: 6, height: 6)
            Text("Needs approval")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(ToolrollPalette.paper, in: Capsule())
        .overlay(Capsule().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
        .fixedSize()
    }

    private var fullPlanButton: some View {
        Button {
            store.openTaskArtifact()
        } label: {
            HStack(spacing: 4) {
                Text("Full Plan")
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9.5, weight: .semibold))
            }
        }
        .buttonStyle(KitButtonStyle(.ghost, compact: true))
        .fixedSize()
        .help("Read full plan in the right-hand Artifact Window (⌘4)")
    }

    private var approveAndBuildButton: some View {
        Button {
            Task { await store.approveSelectedTask() }
        } label: {
            Text("Approve & Build")
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .buttonStyle(KitButtonStyle(.primary))
        .fixedSize()
    }

    private func inAppApprovalCard(taskId: String, card: ApprovalCard) -> some View {
        let digest = ApprovalPlanDigest.parse(from: card.terms)
        let visibleChecks = showFullApprovalChecks ? digest.checks : Array(digest.checks.prefix(3))
        let hiddenCheckCount = max(0, digest.checks.count - 3)

        return VStack(alignment: .leading, spacing: 14) {
            // 1. TOP ACTION HEADER: Responsive ViewThatFits — primary CTA & badge NEVER wrap!
            ViewThatFits(in: .horizontal) {
                // Wide: single horizontal row
                HStack(spacing: 10) {
                    approvalStatusBadge
                    if let rev = digest.revision {
                        Text(rev)
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 8)
                    fullPlanButton
                    if store.approvalPasswordPrompt == nil {
                        approveAndBuildButton
                    }
                }

                // Condensed: clean 2-row stack with zero text wrapping
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        approvalStatusBadge
                        Spacer(minLength: 6)
                        if store.approvalPasswordPrompt == nil {
                            approveAndBuildButton
                        }
                    }
                    HStack(spacing: 8) {
                        if let rev = digest.revision {
                            Text(rev)
                                .font(.system(size: 11.5))
                                .foregroundStyle(ToolrollPalette.muted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        Spacer(minLength: 6)
                        fullPlanButton
                    }
                }
            }

            // 2. HERO GOAL SUMMARY (Lead with what we're actually building)
            if let goal = digest.goal {
                Text(goal)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineSpacing(3.5)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // 3. SMART DELTA PILLS FOR `Changed` (replaces unreadable "was only ... now only ..." prose!)
            if !digest.addedFiles.isEmpty || !digest.removedFiles.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("PLAN CHANGES")
                        .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                        .tracking(0.6)
                        .foregroundStyle(ToolrollPalette.muted)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(digest.addedFiles, id: \.self) { file in
                                HStack(spacing: 5) {
                                    Text("+")
                                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.success)
                                    Text(file)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                            }
                            ForEach(digest.removedFiles, id: \.self) { file in
                                HStack(spacing: 5) {
                                    Text("−")
                                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.danger)
                                    Text(file)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                            }
                        }
                    }
                }
            } else if let fallbackChanged = digest.changedFallback {
                Text(fallbackChanged)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // 4. COMPACT METADATA ROW: Agent + Expandable File Chips
            HStack(spacing: 10) {
                if let agent = digest.agent {
                    HStack(spacing: 5) {
                        Image(systemName: "cpu")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.muted)
                        Text(agent)
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                    }
                }

                if !digest.files.isEmpty {
                    Button {
                        withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                            showApprovalFiles.toggle()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.on.doc")
                                .font(.system(size: 10))
                            Text("\(digest.files.count) allowed file\(digest.files.count == 1 ? "" : "s")")
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                            Image(systemName: showApprovalFiles ? "chevron.up" : "chevron.down")
                                .font(.system(size: 8.5, weight: .semibold))
                        }
                        .foregroundStyle(ToolrollPalette.ink)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3.5)
                        .toolrollHoverSurface(cornerRadius: 4)
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }

                Spacer()

                if let hash = card.digest {
                    Text(String(hash.prefix(8)))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted.opacity(0.65))
                        .help("Plan digest: \(hash)")
                }
            }

            if showApprovalFiles && !digest.files.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 6)], alignment: .leading, spacing: 6) {
                    ForEach(digest.files, id: \.self) { path in
                        Text(path)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3.5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                }
            }

            // 5. SCANNABLE 1-LINE VERIFICATION CHECKS + COLLAPSED SCOPE & SANDBOX DETAILS
            if !digest.checks.isEmpty || digest.wontTouch != nil || !digest.extraTerms.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if !visibleChecks.isEmpty {
                        HStack {
                            Text("VERIFICATION CHECKS (\(digest.checks.count))")
                                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                                .tracking(0.6)
                                .foregroundStyle(ToolrollPalette.muted)
                            Spacer()
                            Text("Click any check to expand")
                                .font(.system(size: 10))
                                .foregroundStyle(ToolrollPalette.muted.opacity(0.65))
                        }

                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(visibleChecks) { item in
                                let isRowExpanded = expandedCheckIds.contains(item.id)
                                Button {
                                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                                        if isRowExpanded {
                                            expandedCheckIds.remove(item.id)
                                        } else {
                                            expandedCheckIds.insert(item.id)
                                        }
                                    }
                                } label: {
                                    HStack(alignment: .top, spacing: 8) {
                                        Image(systemName: "checkmark.circle")
                                            .font(.system(size: 11))
                                            .foregroundStyle(ToolrollPalette.muted)
                                            .padding(.top, 2)
                                        Text(item.text)
                                            .font(.system(size: 12))
                                            .foregroundStyle(ToolrollPalette.ink.opacity(0.92))
                                            .lineLimit(isRowExpanded ? nil : 1)
                                            .truncationMode(.tail)
                                            .multilineTextAlignment(.leading)
                                            .fixedSize(horizontal: false, vertical: isRowExpanded)
                                        Spacer(minLength: 6)
                                        if let badge = item.badge {
                                            Text(badge)
                                                .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                                                .foregroundStyle(ToolrollPalette.muted)
                                                .padding(.horizontal, 5)
                                                .padding(.vertical, 1.5)
                                                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                                                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                                        }
                                    }
                                    .padding(.vertical, 2)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    // Clean bottom disclosure row: show remaining checks + quiet scope & sandbox details toggle
                    HStack(spacing: 14) {
                        if hiddenCheckCount > 0 {
                            Button {
                                withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                                    showFullApprovalChecks.toggle()
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Text(showFullApprovalChecks ? "Show fewer checks" : "Show all \(digest.checks.count) checks")
                                        .font(.system(size: 11, weight: .medium))
                                    Image(systemName: showFullApprovalChecks ? "chevron.up" : "chevron.down")
                                        .font(.system(size: 8.5, weight: .semibold))
                                }
                                .foregroundStyle(ToolrollPalette.ink.opacity(0.85))
                            }
                            .buttonStyle(.plain)
                        }

                        if digest.wontTouch != nil || !digest.extraTerms.isEmpty {
                            Button {
                                withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                                    showStandardSandboxDetails.toggle()
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "shield")
                                        .font(.system(size: 10))
                                    Text("Scope & sandbox details")
                                        .font(.system(size: 11))
                                    Image(systemName: showStandardSandboxDetails ? "chevron.up" : "chevron.right")
                                        .font(.system(size: 8, weight: .semibold))
                                }
                                .foregroundStyle(ToolrollPalette.muted)
                            }
                            .buttonStyle(.plain)
                        }

                        Spacer()
                    }
                    .padding(.top, 2)

                    if showStandardSandboxDetails {
                        VStack(alignment: .leading, spacing: 8) {
                            HairlineDivider().padding(.vertical, 2)
                            if let wontTouch = digest.wontTouch {
                                HStack(alignment: .top, spacing: 8) {
                                    Text("Won't touch")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(ToolrollPalette.muted)
                                        .frame(width: 84, alignment: .leading)
                                    Text(wontTouch)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(ToolrollPalette.ink.opacity(0.8))
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            ForEach(digest.extraTerms) { extra in
                                HStack(alignment: .top, spacing: 8) {
                                    Text(extra.label)
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(ToolrollPalette.muted)
                                        .frame(width: 84, alignment: .leading)
                                    Text(extra.words)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(ToolrollPalette.ink.opacity(0.8))
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                }
                .padding(12)
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

            // 6. PASSWORD STEP-UP OR SECONDARY ACTIONS
            if let prompt = store.approvalPasswordPrompt {
                VStack(alignment: .leading, spacing: 6) {
                    Text(prompt)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.warning)
                    HStack(spacing: 8) {
                        SecureField("Enter your password to confirm…", text: $approvalPassword)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12.5))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 6)
                            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                            .onSubmit {
                                let pw = approvalPassword
                                approvalPassword = ""
                                Task { await store.approveSelectedTask(password: pw) }
                            }
                        Button("Confirm & Approve") {
                            let pw = approvalPassword
                            approvalPassword = ""
                            Task { await store.approveSelectedTask(password: pw) }
                        }
                        .buttonStyle(KitButtonStyle(.primary))
                        .disabled(approvalPassword.isEmpty)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    if store.stepCards?.plan != nil || store.stepCards?.planStopped?.again != nil {
                        Button("Plan Again") {
                            Task { await store.planAgainSelectedTask() }
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    }

                    Button("Cancel Task") {
                        Task { await store.cancelSelectedTask() }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))

                    Spacer()
                }
            }
        }
        .padding(16)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
        )
    }

    private func fallbackApprovalCard(taskId: String, summary: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusChip(tone: .needs, label: "Needs your approval")
                Spacer()
            }
            Text(summary)
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.ink)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                if store.canApproveInApp {
                    Button("Review & Approve") {
                        Task { await store.approveSelectedTask() }
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                } else {
                    Button {
                        store.openTaskInBrowser(taskId: taskId)
                    } label: {
                        HStack(spacing: 5) {
                            Text("Approve in Browser")
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 10.5, weight: .semibold))
                        }
                    }
                    .buttonStyle(KitButtonStyle(.primary))

                    Button("Ping Phone") {
                        Task { await store.pingApproval(taskId: taskId) }
                    }
                    .buttonStyle(KitButtonStyle(.ghost))
                }
            }
        }
        .padding(14)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.ink.opacity(0.35), lineWidth: 1)
        )
    }

    // MARK: - Native In-App Result Review Card (Accept / Send Back)

    private func resultReviewCard(_ review: TaskReview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusChip(tone: .needs, label: "Ready for review")
                Text("Run #\(review.run)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Button("Inspect Diff") {
                    store.isInspectorVisible = true
                    store.inspectorTab = .diff
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            if !review.accept.blockers.isEmpty {
                ForEach(review.accept.blockers, id: \.self) { blocker in
                    Text("• \(blocker)")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.warning)
                }
            } else {
                Text("Review the diff in the right pane, then accept to complete or send back with notes.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            HStack(spacing: 8) {
                Button("Accept Result") {
                    Task { await store.acceptSelectedResult() }
                }
                .buttonStyle(KitButtonStyle(.primary))

                Button(sendBackOpen ? "Close Note" : "Send Back…") {
                    sendBackOpen.toggle()
                }
                .buttonStyle(KitButtonStyle(.ghost))
            }

            if sendBackOpen {
                HStack(spacing: 8) {
                    TextField("Tell the agent what to change…", text: $sendBackNote)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12.5))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 7)
                        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                        .onSubmit { submitSendBack() }

                    Button("Send Back") { submitSendBack() }
                        .buttonStyle(KitButtonStyle(.danger))
                        .disabled(sendBackNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(14)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.ink.opacity(0.35), lineWidth: 1)
        )
    }

    private func submitSendBack() {
        let note = sendBackNote
        sendBackNote = ""
        sendBackOpen = false
        Task { await store.sendBackSelectedResult(note: note) }
    }

    // MARK: - Native In-App Agent Question Card

    private func questionCard(_ question: TaskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusChip(tone: .needs, label: "Agent question")
                Spacer()
            }

            Text(question.text)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
                .fixedSize(horizontal: false, vertical: true)

            if !question.recap.isEmpty {
                Text(question.recap)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(question.options) { opt in
                    Button {
                        Task { await store.answerQuestion(questionId: question.id, optionId: opt.id) }
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(opt.label)
                                        .font(.system(size: 12.5, weight: .semibold))
                                        .foregroundStyle(opt.recommended ? ToolrollPalette.inverseInk : ToolrollPalette.ink)
                                    if opt.recommended {
                                        Text("Recommended")
                                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.inverseInk.opacity(0.8))
                                    }
                                }
                                if !opt.consequence.isEmpty {
                                    Text(opt.consequence)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(opt.recommended ? ToolrollPalette.inverseInk.opacity(0.8) : ToolrollPalette.muted)
                                }
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(opt.recommended ? ToolrollPalette.ink : ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: opt.recommended ? 0 : 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.ink.opacity(0.35), lineWidth: 1)
        )
    }

    // MARK: - Stopped Plan / Failure Recovery Cards

    private func planStoppedCard(_ stopped: PlanStopped) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusChip(tone: .failed, label: "Planning stopped")
                Spacer()
            }
            Text(stopped.line)
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.ink)
                .fixedSize(horizontal: false, vertical: true)

            if let said = stopped.agentSaid, !said.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(said, id: \.self) { line in
                        Text(line)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

            HStack(spacing: 8) {
                if stopped.again != nil {
                    Button("Plan Again") {
                        Task { await store.planAgainSelectedTask() }
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                }
                Button("Cancel Task") {
                    Task { await store.cancelSelectedTask() }
                }
                .buttonStyle(KitButtonStyle(.ghost))
            }
        }
        .padding(14)
        .background(ToolrollPalette.danger.opacity(0.05), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.danger.opacity(0.35), lineWidth: 1)
        )
    }

    private func failureCard(_ failure: TaskFailure) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusChip(tone: .failed, label: "Failed")
                if failure.failedInARow > 1 {
                    Text("\(failure.failedInARow) attempts")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
            }

            Text(failure.line)
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.ink)
                .fixedSize(horizontal: false, vertical: true)

            if let suggestion = failure.suggestion, !suggestion.isEmpty {
                Text(suggestion)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            if let said = failure.agentSaid, !said.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(said, id: \.self) { line in
                        Text(line)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

            HStack(spacing: 8) {
                if store.stepCards?.retry != nil {
                    Button("Retry Build") {
                        Task { await store.retrySelectedTask() }
                    }
                    .buttonStyle(KitButtonStyle(.primary))
                }
                if store.stepCards?.plan != nil {
                    Button("Plan Again") {
                        Task { await store.planAgainSelectedTask() }
                    }
                    .buttonStyle(KitButtonStyle(.ghost))
                }
                Button("Cancel Task") {
                    Task { await store.cancelSelectedTask() }
                }
                .buttonStyle(KitButtonStyle(.ghost))
            }
        }
        .padding(14)
        .background(ToolrollPalette.danger.opacity(0.05), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.danger.opacity(0.35), lineWidth: 1)
        )
    }

    private func heldBanner(_ held: TaskHold) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Task paused")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text(held.reason)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            Spacer()
            Button("Resume") {
                Task { await store.holdOrResumeSelectedTask() }
            }
            .buttonStyle(KitButtonStyle(.primary, compact: true))
        }
        .padding(12)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    // MARK: - Candidates Strip

    private func candidatesSection(taskId: String, candidates: [HandoffCandidate]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Candidates")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                if let base = store.candidatesResponse?.currentBaseCommit {
                    Text("base \(base.prefix(8))")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }

            VStack(spacing: 8) {
                ForEach(candidates) { cand in
                    candidateCard(taskId: taskId, candidate: cand)
                }
            }
        }
    }

    private func candidateCard(taskId: String, candidate: HandoffCandidate) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(String(candidate.id.prefix(10)))
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)

                Text("by @\(candidate.author)")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)

                Text("· \(candidate.files.count) \(candidate.files.count == 1 ? "file" : "files")")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)

                Spacer()

                candidateBadge(candidate)
            }

            if !candidate.note.isEmpty {
                Text(candidate.note)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.ink)
            }

            HStack(spacing: 8) {
                if candidate.stale {
                    let cmd = "toolroll handoff rebase \(taskId)"
                    HStack(spacing: 6) {
                        Text(cmd)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.warning)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))

                        Button("Copy rebase command") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(cmd, forType: .string)
                            store.notice = WorkbenchNotice(kind: .info, message: "Copied `\(cmd)` to clipboard.")
                        }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    }
                } else if candidate.promotedAt == nil {
                    Button("Promote to Run") {
                        Task { await store.promoteCandidate(taskId: taskId, candidateId: candidate.id) }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }

                if candidate.canOpenPr {
                    Button("Open PR") {
                        Task { await store.openCandidatePr(taskId: taskId, candidateId: candidate.id) }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                }

                if let pub = candidate.publication, let prNum = pub.prNumber {
                    Button {
                        if let url = pub.prUrl { store.openExternalURL(url) }
                    } label: {
                        HStack(spacing: 4) {
                            Text("PR #\(prNum)")
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9.5))
                        }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }

                if let runId = candidate.runId {
                    Button("View Diff (Run #\(runId))") {
                        store.isInspectorVisible = true
                        store.inspectorTab = .diff
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }

                Spacer()
            }
        }
        .padding(12)
        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.line, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func candidateBadge(_ cand: HandoffCandidate) -> some View {
        if let prNum = cand.publication?.prNumber {
            pill("PR #\(prNum)", color: ToolrollPalette.success)
        } else if let state = cand.publication?.state {
            pill("PR \(state)", color: ToolrollPalette.live)
        } else if cand.stale {
            pill("Stale", color: ToolrollPalette.warning)
        } else if let runId = cand.runId {
            let check = cand.liveCheckState ?? cand.checkStatus ?? "promoted"
            let c: Color = (check == "passed") ? ToolrollPalette.success : (check == "failed" ? ToolrollPalette.danger : ToolrollPalette.live)
            pill("Run #\(runId) · \(check)", color: c)
        } else {
            pill("Unverified", color: ToolrollPalette.muted)
        }
    }

    private func pill(_ text: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 5, height: 5)
            Text(text)
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundStyle(ToolrollPalette.ink)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    // MARK: - Top Horizontal Pipeline Stepper + Active Agent Banner + Live Stream

    private func pipelineStepperBar(cards: [StepCard], proxy: ScrollViewProxy) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Array(cards.enumerated()), id: \.element.id) { idx, card in
                    let isAttention = card.needsYou
                    let isDone = (card.mark.isEmpty ? card.state : card.mark).lowercased().contains("done")
                    let isRunning = card.state.lowercased().contains("run") || card.mark.lowercased().contains("run")
                    let iconColor: Color = isAttention ? ToolrollPalette.ink : (isRunning ? ToolrollPalette.live : (isDone ? ToolrollPalette.ink.opacity(0.65) : ToolrollPalette.muted.opacity(0.6)))
                    Button {
                        handlePipelineStepTap(card, proxy: proxy)
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: stepSymbol(for: card))
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(iconColor)
                            Text(card.label)
                                .font(.system(size: 11.5, weight: isAttention || isRunning ? .semibold : .medium))
                                .foregroundStyle(isAttention || isRunning ? ToolrollPalette.ink : ToolrollPalette.muted)
                                .lineLimit(1)
                            if let agent = card.agent, isAttention || isRunning {
                                Text("· \(agent.displayLabel)")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4.5)
                        .background(
                            isAttention || isRunning ? Color.white.opacity(0.08) : Color.clear,
                            in: Capsule()
                        )
                        .overlay(
                            Capsule()
                                .strokeBorder(isAttention || isRunning ? ToolrollPalette.inputLine : Color.clear, lineWidth: 1)
                        )
                        .toolrollHoverSurface(cornerRadius: 12, isSelected: false)
                    }
                    .buttonStyle(.plain)
                    .help(card.sentence.isEmpty ? "Jump to \(card.label)" : "\(card.label): \(card.sentence)")

                    if idx < cards.count - 1 {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted.opacity(0.4))
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
        }
        .background(ToolrollPalette.paper)
    }

    private func handlePipelineStepTap(_ card: StepCard, proxy: ScrollViewProxy) {
        let label = card.label.lowercased()
        let targetId: String
        if label.contains("approv") {
            targetId = "approval-card"
        } else if label.contains("ready") || label.contains("review") {
            if store.stepCards?.review != nil {
                targetId = "review-card"
            } else {
                store.toggleInspector(tab: .diff)
                return
            }
        } else if label.contains("plan") {
            if !store.liveRunRecords.isEmpty {
                targetId = "agent-activity"
            } else {
                store.openTaskArtifact()
                return
            }
        } else if label.contains("build") {
            targetId = store.approvalCard != nil ? "approval-card" : "agent-activity"
        } else if label.contains("check") {
            targetId = store.stepCards?.review != nil ? "review-card" : "approval-card"
        } else {
            targetId = "agent-activity"
        }

        withAnimation(.easeInOut(duration: 0.22)) {
            proxy.scrollTo(targetId, anchor: .top)
            highlightedSection = targetId
        }
        Task {
            try? await Task.sleep(for: .seconds(1.1))
            if highlightedSection == targetId {
                highlightedSection = nil
            }
        }
    }

    /// Shows explicitly WHICH agent & model is actively working (or ran last) + who is assigned next!
    private func activeAgentStatusBanner(row: WorkRow) -> some View {
        let cards = store.stepCards?.cards ?? []
        let activeOrLatestStep = cards.first(where: { $0.state.lowercased().contains("run") || $0.mark.lowercased().contains("run") })
            ?? cards.last(where: { $0.agent != nil })
        let activeAgentName = activeOrLatestStep?.agent?.displayLabel ?? activeBuilderModelLabel
        let activeStage = activeOrLatestStep?.label ?? (row.status == .running ? "Working" : "Agent")
        let isRunning = row.status == .running
        let plannerModel = store.modelsRead.roles.first(where: { $0.key == "plan" })?.words
        let builderModel = store.modelsRead.roles.first(where: { $0.key == "build" })?.words
        let reviewerModel = store.modelsRead.roles.first(where: { $0.key == "review" })?.words

        return VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    activeAgentIdentity(isRunning: isRunning, status: row.status, stage: activeStage, agentName: activeAgentName, at: activeOrLatestStep?.at)
                    Spacer(minLength: 6)
                    roleAgentPillsRow(planner: plannerModel, builder: builderModel, reviewer: reviewerModel)
                }

                VStack(alignment: .leading, spacing: 7) {
                    activeAgentIdentity(isRunning: isRunning, status: row.status, stage: activeStage, agentName: activeAgentName, at: activeOrLatestStep?.at)
                    ScrollView(.horizontal, showsIndicators: false) {
                        roleAgentPillsRow(planner: plannerModel, builder: builderModel, reviewer: reviewerModel)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func activeAgentIdentity(isRunning: Bool, status: TaskStatusTone, stage: String, agentName: String, at: String?) -> some View {
        HStack(spacing: 7) {
            Circle()
                .fill(isRunning ? ToolrollPalette.live : (status == .needs ? ToolrollPalette.warning : ToolrollPalette.success))
                .frame(width: 7, height: 7)
            Text(isRunning ? "\(stage) · \(agentName)" : "Last run: \(stage) · \(agentName)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
            if let at {
                Text(formatStepTimestamp(at))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
            }
        }
    }

    private func roleAgentPillsRow(planner: String?, builder: String?, reviewer: String?) -> some View {
        HStack(spacing: 5) {
            if let p = planner, !p.isEmpty {
                roleAgentPill(prefix: "Plan", model: p, roleKey: "plan")
            }
            if let b = builder, !b.isEmpty {
                roleAgentPill(prefix: "Build", model: b, roleKey: "build")
            }
            if let r = reviewer, !r.isEmpty {
                roleAgentPill(prefix: "Review", model: r, roleKey: "review")
            }
        }
    }

    private func roleAgentPill(prefix: String, model: String, roleKey: String) -> some View {
        Button {
            modelPickerInitialRole = roleKey
            isModelPickerOpen = true
        } label: {
            HStack(spacing: 4) {
                Text(prefix)
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(model)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .toolrollHoverSurface(cornerRadius: 4)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Change \(prefix) model (Claude, Gemini, or Codex)")
    }

    private func liveStreamSection(records: [LiveAgentRecord]) -> some View {
        let isRunning = store.selectedRow?.status == .running
        let timeline = LiveActivityTimeline.build(from: records, isLive: isRunning)
        return VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(timeline.items.suffix(40))) { item in
                    switch item {
                    case .message(_, let text):
                        Text(text)
                            .font(.system(size: 13))
                            .foregroundStyle(ToolrollPalette.ink)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)

                    case .step(_, let kind, let summary, let status, let outputPreview):
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 7) {
                                liveStepStatusIcon(status)
                                Text(kind)
                                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                                Text(summary)
                                    .font(.system(size: 11.5, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.ink)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer(minLength: 0)
                            }
                            if !outputPreview.isEmpty {
                                Text(outputPreview.joined(separator: " · "))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                    .padding(.leading, 20)
                            }
                        }

                    case .hiddenSteps(_, let kind, let count, let failedCount, let runningCount):
                        let label = LiveActivityItem.hiddenStepLabel(
                            kind: kind,
                            count: count,
                            failedCount: failedCount,
                            runningCount: runningCount
                        )
                        let status: LiveStepStatus = failedCount > 0 ? .failed : (runningCount > 0 ? .running : .succeeded)
                        HStack(spacing: 6) {
                            Image(systemName: kind == "command" ? "terminal" : "wrench")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                            Text(label)
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                            liveStepStatusIcon(status)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3.5)
                        .background(ToolrollPalette.raised.opacity(0.75), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .strokeBorder(ToolrollPalette.line, lineWidth: 1)
                        )
                        .help("Shell command text is hidden by Toolroll's default project privacy setting so secrets aren't logged. Enable 'Show commands in the live view' in Settings → Project to view full commands on future runs.")

                    case .output(_, let ok, let lines):
                        HStack(spacing: 6) {
                            Text(ok ? "✓" : "✗")
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(ok ? ToolrollPalette.muted : ToolrollPalette.danger)
                            Text(lines.joined(separator: " · "))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                                .lineLimit(1)
                        }
                        .padding(.leading, 8)
                    }
                }

                if timeline.hasHiddenCommands {
                    HairlineDivider()
                        .padding(.top, 4)
                    HStack(spacing: 6) {
                        Image(systemName: "eye.slash")
                            .font(.system(size: 10))
                            .foregroundStyle(ToolrollPalette.muted.opacity(0.8))
                        Text("Shell commands are hidden by project privacy")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                        Text("·")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted.opacity(0.6))
                        Button {
                            store.openProjectLiveViewSettings()
                        } label: {
                            HStack(spacing: 3) {
                                Text("Show in Settings")
                                Image(systemName: "arrow.up.right")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink.opacity(0.78))
                        }
                        .buttonStyle(.plain)
                        .help("Open Settings → Project in Toolroll to turn on 'Show commands in the live view' for future runs")
                        Spacer()
                    }
                    .padding(.top, 2)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    @ViewBuilder
    private func liveStepStatusIcon(_ status: LiveStepStatus) -> some View {
        switch status {
        case .running:
            Circle()
                .fill(ToolrollPalette.live)
                .frame(width: 6, height: 6)
        case .succeeded:
            Image(systemName: "checkmark")
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
        case .failed:
            Image(systemName: "xmark")
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.danger)
        case .completed:
            Circle()
                .fill(ToolrollPalette.muted.opacity(0.5))
                .frame(width: 5, height: 5)
        }
    }

    // MARK: - Steps Timeline

    private func stepsSection() -> some View {
        let cards = store.stepCards?.cards ?? []
        let hasAttentionStep = cards.contains(where: \.needsYou)
        let isExpanded = showAllSteps || hasAttentionStep || cards.count <= 2

        return VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.14)) {
                    showAllSteps.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                    Text("Steps (\(cards.count))")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(0.6)
                        .foregroundStyle(ToolrollPalette.muted)
                    if !isExpanded && !cards.isEmpty {
                        Text("· " + cards.map(\.label).joined(separator: " → "))
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                    }
                    Spacer()
                    if let headline = store.stepCards?.headline, !headline.isEmpty, isExpanded {
                        Text(headline)
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                if !cards.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(cards.enumerated()), id: \.element.id) { idx, card in
                            stepRow(card)
                            if idx < cards.count - 1 {
                                HairlineDivider()
                            }
                        }
                    }
                    .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(ToolrollPalette.line, lineWidth: 1)
                    )
                } else {
                    Text("No step timeline recorded yet.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.vertical, 6)
                }
            }
        }
    }

    private func stepRow(_ card: StepCard) -> some View {
        let isExpanded = expandedSteps.contains(card.id) || card.needsYou
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                if expandedSteps.contains(card.id) {
                    expandedSteps.remove(card.id)
                } else {
                    expandedSteps.insert(card.id)
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: stepSymbol(for: card))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(stepColor(for: card))
                        .frame(width: 16, alignment: .center)

                    Text(card.label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)

                    if let badge = stepStateBadge(for: card) {
                        Text(badge)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundStyle(stepColor(for: card))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }

                    if let agent = card.agent {
                        Text("\(agent.provider)\(agent.model.map { " · \($0)" } ?? "")")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }

                    Spacer()

                    if let cost = card.costUsd, cost > 0 {
                        Text(String(format: "$%.2f", cost))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    if let at = card.at {
                        Text(formatStepTimestamp(at))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !card.sentence.isEmpty {
                Text(card.sentence)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(isExpanded ? nil : 2)
                    .padding(.leading, 26)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .toolrollHoverSurface(cornerRadius: 4)
    }

    private func stepSymbol(for card: StepCard) -> String {
        let m = (card.mark.isEmpty ? card.state : card.mark).lowercased()
        if m.contains("done") || m.contains("pass") || m.contains("ok") || m == "✓" {
            return "checkmark.circle.fill"
        }
        if m.contains("stuck") || m.contains("fail") || m.contains("err") || m.contains("stop") {
            return "exclamationmark.triangle.fill"
        }
        if m.contains("skip") || m.contains("cancel") {
            return "minus.circle"
        }
        if m.contains("run") || m.contains("work") || m.contains("active") || m.contains("live") {
            return "record.circle"
        }
        if card.needsYou || m.contains("need") || m.contains("wait") {
            return "exclamationmark.circle.fill"
        }
        return "circle"
    }

    private func stepColor(for card: StepCard) -> Color {
        let m = (card.mark.isEmpty ? card.state : card.mark).lowercased()
        if m.contains("done") || m.contains("pass") || m.contains("ok") || m == "✓" {
            return ToolrollPalette.success
        }
        if m.contains("stuck") || m.contains("fail") || m.contains("err") {
            return ToolrollPalette.danger
        }
        if m.contains("run") || m.contains("work") || m.contains("active") {
            return ToolrollPalette.live
        }
        if card.needsYou || m.contains("need") || m.contains("wait") {
            return ToolrollPalette.warning
        }
        return ToolrollPalette.muted
    }

    private func stepStateBadge(for card: StepCard) -> String? {
        let raw = card.mark.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.count >= 2 else { return nil }
        if raw.lowercased() == card.label.lowercased() { return nil }
        return raw.lowercased()
    }

    private func formatStepTimestamp(_ raw: String) -> String {
        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoBasic = ISO8601DateFormatter()
        isoBasic.formatOptions = [.withInternetDateTime]
        guard let date = isoFrac.date(from: raw) ?? isoBasic.date(from: raw) else {
            return raw
        }
        let fmt = DateFormatter()
        fmt.dateFormat = "MMM d, h:mm a"
        return fmt.string(from: date)
    }

    // MARK: - Composer Bar

    private var activeBuilderModelLabel: String {
        store.modelsRead.roles.first(where: { $0.key == "build" })?.words
            ?? store.modelsRead.roles.first?.words
            ?? "Models"
    }

    private var canSubmitSteer: Bool {
        !steerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !steerAttachments.isEmpty
    }

    private func composerBar(taskId: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !steerAttachments.isEmpty {
                ComposerAttachmentStrip(attachments: steerAttachments) { removedId in
                    steerAttachments.removeAll { $0.id == removedId }
                }
            }

            HStack(spacing: 8) {
                ComposerAttachMenuButton(
                    compact: true,
                    onAddAttachments: { incoming in
                        appendUniqueAttachments(incoming, to: &steerAttachments)
                    },
                    onNoClipboardImage: {
                        store.notice = WorkbenchNotice(kind: .info, message: "No image found on the clipboard — copy a screenshot (⌘⌃⇧4) or image first.")
                    }
                )

                TextField("Steer task, paste screenshot, or leave a note…", text: $steerDraft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollPalette.ink)
                    .focused($steerFocused)
                    .frame(minWidth: 110)
                    .onSubmit {
                        submitSteer(taskId: taskId)
                    }

                Button {
                    isModelPickerOpen.toggle()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "cpu")
                            .font(.system(size: 10))
                        Text(activeBuilderModelLabel)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 7.5, weight: .semibold))
                    }
                    .foregroundStyle(ToolrollPalette.muted)
                    .padding(.horizontal, 8)
                    .frame(height: 24)
                    .frame(maxWidth: 155)
                    .background(Color.white.opacity(0.07), in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .fixedSize()
                .popover(isPresented: $isModelPickerOpen, arrowEdge: .top) {
                    ModelPickerPopover(store: store, initialRoleKey: modelPickerInitialRole, onDismiss: { isModelPickerOpen = false })
                }

                Button {
                    submitSteer(taskId: taskId)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(ToolrollPalette.inverseInk)
                        .frame(width: 26, height: 26)
                        .background(
                            canSubmitSteer
                                ? ToolrollPalette.ink
                                : ToolrollPalette.muted.opacity(0.32),
                            in: Circle()
                        )
                }
                .buttonStyle(.plain)
                .disabled(!canSubmitSteer)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .toolrollGlassPanel(cornerRadius: steerAttachments.isEmpty ? 20 : 16, interactive: true)
        .overlay(
            RoundedRectangle(cornerRadius: steerAttachments.isEmpty ? 20 : 16, style: .continuous)
                .strokeBorder(
                    isComposerDropTargeted ? ToolrollPalette.live : Color.clear,
                    style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])
                )
        )
        .shadow(color: Color.black.opacity(0.28), radius: 14, y: 4)
        .onComposerPaste(isActive: steerFocused) { incoming in
            appendUniqueAttachments(incoming, to: &steerAttachments)
        }
        .onDrop(of: ComposerDropHelper.acceptedTypes, isTargeted: $isComposerDropTargeted) { providers in
            ComposerDropHelper.handleDrop(providers: providers) { incoming in
                appendUniqueAttachments(incoming, to: &steerAttachments)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 14)
    }

    private func submitSteer(taskId: String) {
        guard canSubmitSteer else { return }
        let composed = ComposerAttachmentStore.composeSubmission(text: steerDraft, attachments: steerAttachments)
        steerDraft = ""
        steerAttachments = []
        Task { await store.steerTask(taskId: taskId, note: composed.combinedMessage) }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("Select a task from the inbox")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Press ⌘N to file a new task, or ⌘K to jump across tasks and actions.")
                .font(.system(size: 12.5))
                .foregroundStyle(ToolrollPalette.muted)
            Button("+ New Task") {
                store.isNewTaskSheetOpen = true
            }
            .buttonStyle(KitButtonStyle(.primary))
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
