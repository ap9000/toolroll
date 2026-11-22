import AppKit
import SwiftUI
import ToolrollCore

/// Center Task Cockpit (--so-paper) — 100% native in-app approvals, result reviews, agent questions,
/// plan/retry recovery, Candidates strip, Steps timeline, and bottom composer.
public struct TaskCockpitView: View {
    @Bindable var store: WorkbenchStore
    @State private var steerDraft: String = ""
    @State private var approvalPassword: String = ""
    @State private var sendBackOpen: Bool = false
    @State private var sendBackNote: String = ""
    @State private var expandedSteps: Set<String> = []
    @State private var showAllSteps: Bool = false
    @State private var isModelPickerOpen: Bool = false
    @State private var copiedBranch: Bool = false

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let row = store.selectedRow {
                taskHeader(row)
                HairlineDivider()
                worktreeControlStrip(row)
                HairlineDivider()

                if let notice = store.notice {
                    inPlaceNoticeBar(notice)
                    HairlineDivider()
                }

                if store.taskViewMode == .terminal {
                    LiveTerminalPaneView(store: store, session: store.terminalSession)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            // 1. Agent Question (answer natively in-app)
                            if let question = row.need?.question {
                                questionCard(question)
                            }

                            // 2. Result Review (Accept or Send Back natively in-app)
                            if let review = store.stepCards?.review {
                                resultReviewCard(review)
                            }

                            // 3. Plan Approval (Review terms & Approve natively in-app!)
                            if let card = store.approvalCard {
                                inAppApprovalCard(taskId: row.id, card: card)
                            } else if row.status == .needs,
                                      row.need?.question == nil,
                                      store.stepCards?.review == nil,
                                      store.stepCards?.planStopped == nil {
                                fallbackApprovalCard(taskId: row.id, summary: row.ask ?? row.need?.ask ?? "Approval waiting on this task.")
                            }

                            // 4. Stopped Plan / Failure Recovery (Plan Again / Retry natively in-app)
                            if let stopped = store.stepCards?.planStopped {
                                planStoppedCard(stopped)
                            } else if let failure = store.stepCards?.failure {
                                failureCard(failure)
                            }

                            // 5. Hold Banner (Resume natively in-app)
                            if let held = store.stepCards?.held {
                                heldBanner(held)
                            }

                            // 6. Live Agent Stream (what the agent is actually doing right now)
                            if !store.liveRunRecords.isEmpty {
                                liveStreamSection(records: store.liveRunRecords)
                            }

                            // 7. Candidates Strip (Promote / Rebase / Open PR)
                            if let cands = store.candidatesResponse?.candidates, !cands.isEmpty {
                                candidatesSection(taskId: row.id, candidates: cands)
                            }

                            // 8. Steps Timeline (quietly collapsed unless needed or toggled)
                            stepsSection()
                        }
                        .padding(20)
                    }

                    HairlineDivider()
                    composerBar(taskId: row.id)
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
        }
    }

    // MARK: - Compact Status & Action Strip (Breadcrumb lives cleanly in the top chrome bar)

    private func taskHeader(_ row: WorkRow) -> some View {
        HStack(spacing: 10) {
            StatusChip(tone: row.status, label: row.word)

            if store.isTeamWorkspace {
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
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                    }
                    .foregroundStyle(ToolrollPalette.muted)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }

            if let presSummary = store.selectedTaskPresence?.summary {
                HStack(spacing: 5) {
                    Circle().fill(ToolrollPalette.live).frame(width: 5, height: 5)
                    Text(presSummary)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }

            if let busy = store.busyLabel {
                Text(busy)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }

            Spacer()

            Button {
                store.isForkSheetOpen = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10.5))
                    Text("Fork")
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("Fork into a parallel worktree to try another approach or agent (⌘⇧F)")

            Button {
                store.openTaskArtifact()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "doc.richtext")
                        .font(.system(size: 10.5))
                    Text("Artifact")
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("Open Task Plan & Summary in Right Artifact Window (⌘4)")

            if let diff = store.diffResponse, !diff.files.isEmpty {
                Button {
                    store.toggleInspector(tab: .diff)
                } label: {
                    HStack(spacing: 4) {
                        Text("Diff")
                        if let totals = diff.totals {
                            Text("+\(totals.added)")
                                .foregroundStyle(ToolrollPalette.success)
                                .font(.system(size: 10.5, design: .monospaced))
                        }
                    }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            Menu {
                Button("Fork Approach into Parallel Worktree…") {
                    store.isForkSheetOpen = true
                }
                Button("Open Raw Terminal (⌘T)") {
                    store.setTaskViewMode(.terminal)
                }
                Button("Attach Terminal in Side Drawer") {
                    Task { await store.attachOrStartTerminal(taskId: row.id, program: "shell", openDrawer: true) }
                }
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
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 24, height: 22)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }

    // MARK: - In-Place Notice

    // MARK: - Worktree & Fluid Activity ↔ Terminal Strip (Orca + AGOR Parity)

    private func worktreeControlStrip(_ row: WorkRow) -> some View {
        let branch = store.activeWorktreeBranch(for: row)
        let siblings = store.siblingActiveTasks(for: row)

        return HStack(spacing: 10) {
            // Native macOS segmented Activity | Terminal switch (⌘T)
            Picker("", selection: Binding(
                get: { store.taskViewMode },
                set: { store.setTaskViewMode($0) }
            )) {
                ForEach(TaskViewMode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .frame(width: 158)
            .help("Switch seamlessly between structured Activity and raw Worktree Terminal (⌘T)")

            // Active Worktree Branch pill (click to copy)
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
                    Text(copiedBranch ? "Copied branch" : branch)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3.5)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Isolated worktree branch — click to copy")

            // Sibling parallel worktrees awareness (AGOR-style coordination visibility)
            if !siblings.isEmpty {
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
                        Circle()
                            .fill(ToolrollPalette.live)
                            .frame(width: 5.5, height: 5.5)
                        Text("\(siblings.count) parallel")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3.5)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("Other active worktrees in this repository")
            }

            Spacer()

            // Quick jump to Canvas visual preview for this project
            Button {
                if let proj = row.project, !proj.isEmpty {
                    store.selectedProject = proj
                }
                store.workspaceMode = .canvas
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "macwindow.on.rectangle")
                        .font(.system(size: 10.5))
                    Text("Preview UI")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open this project's visual Canvas (⌘3)")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(ToolrollPalette.ground)
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

    // MARK: - Native In-App Plan Approval Card

    private func inAppApprovalCard(taskId: String, card: ApprovalCard) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                StatusChip(tone: .needs, label: "Needs your approval")
                if let digest = card.digest {
                    Text(String(digest.prefix(16)))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
            }

            if !card.terms.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(card.terms.enumerated()), id: \.element.id) { idx, term in
                        HStack(alignment: .top, spacing: 12) {
                            Text(term.label)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.muted)
                                .frame(width: 96, alignment: .leading)
                            Text(term.words)
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.ink)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        if idx < card.terms.count - 1 {
                            HairlineDivider()
                        }
                    }
                }
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

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
                    Button("Approve Plan") {
                        Task { await store.approveSelectedTask() }
                    }
                    .buttonStyle(KitButtonStyle(.primary))

                    if store.stepCards?.plan != nil || store.stepCards?.planStopped?.again != nil {
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
        }
        .padding(14)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(ToolrollPalette.ink.opacity(0.35), lineWidth: 1)
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

    // MARK: - Live Agent Stream (GET /agents/live/run/<run>)

    private func liveStreamSection(records: [LiveAgentRecord]) -> some View {
        let visible = records.filter { $0.k == "say" || $0.k == "step" || $0.k == "done" }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(store.selectedRow?.status == .running ? ToolrollPalette.live : ToolrollPalette.muted)
                    .frame(width: 6, height: 6)
                Text("Agent Activity")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
            }

            VStack(alignment: .leading, spacing: 8) {
                ForEach(visible.suffix(24)) { rec in
                    if rec.k == "say", !rec.textLines.isEmpty {
                        Text(rec.textLines.joined(separator: "\n"))
                            .font(.system(size: 13))
                            .foregroundStyle(ToolrollPalette.ink)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if rec.k == "step" {
                        HStack(spacing: 8) {
                            Text(rec.kind ?? "tool")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                            Text(rec.target ?? "")
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.ink)
                                .lineLimit(1)
                            Spacer()
                        }
                    } else if rec.k == "done", !rec.out.isEmpty {
                        HStack(spacing: 6) {
                            Text(rec.ok == false ? "✗" : "✓")
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(rec.ok == false ? ToolrollPalette.danger : ToolrollPalette.success)
                            Text(rec.out.prefix(2).joined(separator: " · "))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                                .lineLimit(1)
                        }
                        .padding(.leading, 8)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
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

    private func composerBar(taskId: String) -> some View {
        HStack(spacing: 8) {
            TextField("Steer task or leave a note for the active run…", text: $steerDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .foregroundStyle(ToolrollPalette.ink)
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
                    Image(systemName: "chevron.down")
                        .font(.system(size: 7.5, weight: .semibold))
                }
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .popover(isPresented: $isModelPickerOpen, arrowEdge: .top) {
                ModelPickerPopover(store: store, initialRoleKey: "build", onDismiss: { isModelPickerOpen = false })
            }

            Button {
                submitSteer(taskId: taskId)
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(ToolrollPalette.inverseInk)
                    .frame(width: 24, height: 24)
                    .background(
                        steerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? ToolrollPalette.muted.opacity(0.35)
                            : ToolrollPalette.ink,
                        in: Circle()
                    )
            }
            .buttonStyle(.plain)
            .disabled(steerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(ToolrollPalette.composer, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
        )
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func submitSteer(taskId: String) {
        let note = steerDraft
        steerDraft = ""
        Task { await store.steerTask(taskId: taskId, note: note) }
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
