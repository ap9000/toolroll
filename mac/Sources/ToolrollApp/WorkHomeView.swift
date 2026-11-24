import AppKit
import SwiftUI
import ToolrollCore

struct WorkHomeView: View {
    @Bindable var store: WorkbenchStore
    @State private var quickPrompt = ""
    @State private var quickPlanFirst = true
    @State private var attachments: [ComposerAttachment] = []
    @State private var isComposerDropTargeted = false
    @FocusState private var quickPromptFocused: Bool

    private var isTaskMode: Bool {
        store.preferredOrchestrationMode == "task"
    }

    private var rows: [WorkRow] { store.filteredRows }
    private var waiting: [WorkRow] { rows.filter { $0.rank == 0 } }
    private var running: [WorkRow] { rows.filter { $0.rank == 1 } }
    private var queued: [WorkRow] { rows.filter { $0.rank == 2 } }
    private var asks: [NeedRow] { store.workRowsResponse.needs.flatMap(\.rows) }
    private var hasActiveWork: Bool { !waiting.isEmpty || !asks.isEmpty || !running.isEmpty || !queued.isEmpty }

    private var activeProject: String? {
        store.activeProject ?? store.selectedProject ?? store.allProjects.first
    }

    var body: some View {
        VStack(spacing: 0) {
            if let notice = store.notice {
                noticeBar(notice)
                HairlineDivider()
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !hasActiveWork {
                        Spacer().frame(height: 56)
                    }

                    if !waiting.isEmpty || !asks.isEmpty {
                        needsAttentionSection
                    }

                    heroHeading

                    unifiedComposer

                    compactQuotaBar

                    if !running.isEmpty || !queued.isEmpty {
                        activeRunsSection
                    }
                }
                .padding(.horizontal, 36)
                .padding(.vertical, 28)
                .frame(maxWidth: 740, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .background(ToolrollPalette.ground)
        .onAppear {
            quickPromptFocused = true
        }
        .onChange(of: store.composerFocusTick) { _, _ in
            quickPromptFocused = true
        }
    }

    private func noticeBar(_ notice: WorkbenchNotice) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.live)
                .frame(width: 6, height: 6)
            Text(notice.message)
                .font(.system(size: 12))
                .foregroundStyle(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.ink)
            NoticeActionButton(store: store, notice: notice)
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
        .background(ToolrollPalette.raised)
    }

    private var heroHeading: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(activeProject.map { "Build in \($0)" } ?? "What are we building?")
                .font(.system(size: 24, weight: .semibold))
                .tracking(-0.4)
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 8)

            if !running.isEmpty || !store.runningChatThreadIds.isEmpty {
                let totalLive = running.count + store.runningChatThreadIds.count
                HStack(spacing: 5) {
                    Circle()
                        .fill(ToolrollPalette.live)
                        .frame(width: 6, height: 6)
                    Text(totalLive == 1 ? "1 running" : "\(totalLive) running")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
        }
        .padding(.horizontal, 2)
    }

    private var unifiedComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !attachments.isEmpty {
                ComposerAttachmentStrip(attachments: attachments) { removedId in
                    attachments.removeAll { $0.id == removedId }
                }
            }

            TextField(
                composerPlaceholder,
                text: $quickPrompt,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 14.5))
            .foregroundStyle(ToolrollPalette.ink)
            .lineLimit(2...7)
            .focused($quickPromptFocused)
            .onSubmit { submitQuickPrompt() }
            .padding(.horizontal, 2)
            .padding(.top, 2)

            HStack(spacing: 8) {
                ComposerAttachMenuButton(compact: true) { incoming in
                    appendUniqueAttachments(incoming, to: &attachments)
                }

                projectSelectorMenu

                gearSwitch

                if isTaskMode {
                    planFirstChip
                } else {
                    chatTargetMenu
                }

                Spacer(minLength: 8)

                Button {
                    submitQuickPrompt()
                } label: {
                    HStack(spacing: 5) {
                        Text(submitLabel)
                        Image(systemName: "arrow.up")
                            .font(.system(size: 10.5, weight: .bold))
                    }
                    .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .disabled(quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
            }
        }
        .padding(16)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    isComposerDropTargeted ? ToolrollPalette.live : (quickPromptFocused ? ToolrollPalette.inputLine : ToolrollPalette.line),
                    lineWidth: 1
                )
        )
        .onComposerPaste(isActive: quickPromptFocused) { incoming in
            appendUniqueAttachments(incoming, to: &attachments)
        }
        .onDrop(of: ComposerDropHelper.acceptedTypes, isTargeted: $isComposerDropTargeted) { providers in
            ComposerDropHelper.handleDrop(providers: providers) { incoming in
                appendUniqueAttachments(incoming, to: &attachments)
            }
        }
    }

    private var composerPlaceholder: String {
        if isTaskMode {
            return quickPlanFirst
                ? "Describe a task to plan & verify in \(activeProject ?? "your workspace")…"
                : "Describe a task to build in an isolated worktree…"
        }
        if store.useLeadForNextChat {
            return "Ask Lead across your workspace…"
        }
        return "Message \(store.defaultChatProvider.displayName) in \(activeProject ?? "your workspace")…"
    }

    private var submitLabel: String {
        if isTaskMode {
            return quickPlanFirst ? "Plan" : "Build"
        }
        if store.useLeadForNextChat {
            return "Ask Lead"
        }
        return "Chat"
    }

    private var gearSwitch: some View {
        HStack(spacing: 2) {
            gearPill(title: "Chat", active: !isTaskMode) {
                store.preferredOrchestrationMode = "chat"
            }
            gearPill(title: "Task", active: isTaskMode) {
                store.preferredOrchestrationMode = "task"
            }
        }
        .padding(2.5)
        .background(ToolrollPalette.ground, in: Capsule())
        .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        .help("Chat: direct streaming loop · Task: sandboxed worktree + checks (⌘.)")
    }

    private func gearPill(title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: active ? .semibold : .medium))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .padding(.horizontal, 9)
                .padding(.vertical, 3.5)
                .background(active ? ToolrollPalette.raised : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private var chatTargetMenu: some View {
        Menu {
            ForEach(AgentChatProvider.allCases) { provider in
                Section(provider.displayName) {
                    ForEach(provider.presets, id: \.id) { preset in
                        Button {
                            store.setDefaultChatModel(provider: provider, modelId: preset.id)
                        } label: {
                            HStack {
                                Text(preset.label)
                                if !store.useLeadForNextChat && store.defaultChatProvider == provider && store.defaultChatModelId == preset.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                }
            }
            Divider()
            Button {
                store.useLeadForNextChat = true
            } label: {
                HStack {
                    Text("Workspace Lead")
                    if store.useLeadForNextChat {
                        Image(systemName: "checkmark")
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(store.useLeadForNextChat ? "Workspace Lead" : store.defaultChatProvider.label(for: store.defaultChatModelId))
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(ToolrollPalette.ground, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var planFirstChip: some View {
        Button {
            quickPlanFirst.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: quickPlanFirst ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 10))
                Text("Plan first")
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(quickPlanFirst ? ToolrollPalette.ink : ToolrollPalette.muted)
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(ToolrollPalette.ground, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Approve plan and checks before the agent edits files")
    }

    private var projectSelectorMenu: some View {
        Menu {
            ForEach(store.allProjects, id: \.self) { project in
                Button {
                    store.activeProject = project
                } label: {
                    HStack {
                        Text(project)
                        if project == activeProject {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
            if !store.allProjects.isEmpty {
                Divider()
            }
            Button("Add Local Project…") {
                store.isAddProjectSheetOpen = true
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "folder")
                    .font(.system(size: 10.5))
                    .foregroundStyle(ToolrollPalette.muted)
                Text(activeProject ?? "Workspace")
                    .font(.system(size: 11.5, weight: .medium))
                    .tracking(-0.1)
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(ToolrollPalette.ground, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    @ViewBuilder
    private var compactQuotaBar: some View {
        let perProvider = ProviderLimit.tightestPerProvider(store.workRowsResponse.limits ?? [])
        let spend = store.workRowsResponse.spend
        let showSpend = (spend?.todayUsd ?? 0) > 0.004
        let gemini = store.geminiSubscription
        let hasAny = !perProvider.isEmpty || gemini != nil || showSpend

        if hasAny {
            HStack(spacing: 14) {
                ForEach(perProvider, id: \.provider) { limit in
                    compactLimitItem(limit)
                }

                if let gemini {
                    HStack(spacing: 5) {
                        Text("Gemini")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(ToolrollPalette.muted)
                        Circle()
                            .fill(gemini.connected ? ToolrollPalette.success : ToolrollPalette.muted)
                            .frame(width: 5.5, height: 5.5)
                        Text(gemini.connected ? (gemini.topModel ?? "Ready") : "Off")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(gemini.connected ? ToolrollPalette.ink : ToolrollPalette.muted)
                            .lineLimit(1)
                    }
                }

                if showSpend, let spend {
                    HStack(spacing: 4) {
                        Text("Today")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                        Text(spend.todayUsd, format: .currency(code: "USD"))
                            .font(.system(size: 11, weight: .semibold).monospacedDigit())
                            .foregroundStyle(ToolrollPalette.ink)
                    }
                }

                Spacer(minLength: 4)

                Button {
                    Task { await store.refreshSubscriptionUsage(silent: false) }
                } label: {
                    Group {
                        if store.isRefreshingUsage {
                            ProgressView()
                                .controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                    }
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.isRefreshingUsage)
                .help(refreshTooltip)
                .accessibilityLabel("Refresh subscription usage")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(ToolrollPalette.raised.opacity(0.65), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func compactLimitItem(_ limit: ProviderLimit) -> some View {
        let now = Date()
        let percent = Int(limit.usedPercent.rounded())
        let reachedNow = limit.isReachedNow(now: now)
        let state = limit.resetState(now: now)
        let stale: Bool = { if case .passed = state { return true }; return false }()

        return HStack(spacing: 6) {
            Text(limit.providerLabel)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ToolrollPalette.muted)
            Text(stale ? "—" : "\(percent)%")
                .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(reachedNow ? ToolrollPalette.danger : ToolrollPalette.ink)
            if !stale {
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.10))
                    Capsule()
                        .fill(reachedNow ? ToolrollPalette.danger : ToolrollPalette.ink)
                        .frame(width: 28 * CGFloat(max(0, min(100, percent))) / 100)
                }
                .frame(width: 28, height: 3.5)
            }
        }
        .help("\(limit.providerLabel): \(stale ? "Checking…" : "\(percent)% used")")
    }

    private var refreshTooltip: String {
        if store.isRefreshingUsage { return "Checking Claude, Codex, and Gemini…" }
        if let at = store.lastUsageRefreshAt {
            let mins = max(0, Int(Date().timeIntervalSince(at) / 60))
            return mins == 0 ? "Refresh usage (updated just now)" : "Refresh usage (updated \(mins)m ago)"
        }
        return "Refresh Claude, Codex, and Gemini usage"
    }

    private var needsAttentionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(ToolrollPalette.ink)
                    .frame(width: 6, height: 6)
                Text("Needs you")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("\(waiting.count + asks.count)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 4)

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(waiting.enumerated()), id: \.element.id) { idx, row in
                    if idx > 0 { HairlineDivider() }
                    taskRow(row)
                }
                ForEach(Array(asks.enumerated()), id: \.element.id) { idx, need in
                    if idx > 0 || !waiting.isEmpty { HairlineDivider() }
                    askRow(need)
                }
            }
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
        }
    }

    private var activeRunsSection: some View {
        let active = running + queued
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(running.isEmpty ? ToolrollPalette.muted : ToolrollPalette.live)
                    .frame(width: 6, height: 6)
                Text("In flight")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("\(active.count)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 4)

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(active.enumerated()), id: \.element.id) { idx, row in
                    if idx > 0 { HairlineDivider() }
                    taskRow(row)
                }
            }
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func taskRow(_ row: WorkRow) -> some View {
        Button {
            Task { await store.selectTask(row.id) }
        } label: {
            HStack(spacing: 10) {
                statusDot(row.status)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(subtitle(row))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 10)
                if let chip = row.chip, !chip.isEmpty {
                    Text(chip)
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 7)
                        .frame(height: 20)
                        .background(ToolrollPalette.ground, in: Capsule())
                        .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                Text(row.age)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 12)
            .frame(height: 46)
            .contentShape(Rectangle())
            .toolrollHoverSurface(cornerRadius: 8, isSelected: false)
        }
        .buttonStyle(.plain)
        .contextMenu { TaskRowMenuItems(store: store, row: row) }
    }

    private func askRow(_ need: NeedRow) -> some View {
        HStack(spacing: 10) {
            Circle().fill(ToolrollPalette.ink).frame(width: 6, height: 6)
            Text(need.line ?? need.ask ?? need.reason ?? "Waiting on you")
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 12)
        .frame(height: 42)
    }

    private func subtitle(_ row: WorkRow) -> String {
        let what = row.detail?.isEmpty == false ? row.detail! : row.word
        guard let project = row.project, !project.isEmpty else { return what }
        return "\(project) · \(what)"
    }

    private func statusDot(_ tone: TaskStatusTone) -> some View {
        Group {
            switch tone {
            case .needs: Circle().fill(ToolrollPalette.ink)
            case .running: Circle().fill(ToolrollPalette.live)
            case .failed: Circle().fill(ToolrollPalette.danger)
            case .queued: Circle().fill(ToolrollPalette.muted)
            case .finished, .unknown: Circle().strokeBorder(ToolrollPalette.muted, lineWidth: 1)
            }
        }
        .frame(width: 6.5, height: 6.5)
    }

    private func submitQuickPrompt() {
        let raw = quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty || !attachments.isEmpty else { return }
        let composed = ComposerAttachmentStore.composeSubmission(text: raw, attachments: attachments)
        quickPrompt = ""
        attachments = []
        let targetProject = activeProject

        if isTaskMode {
            let planFirst = quickPlanFirst
            Task {
                await store.createTask(
                    title: composed.title,
                    project: targetProject,
                    body: composed.goal,
                    planFirst: planFirst
                )
            }
            return
        }

        if store.useLeadForNextChat {
            store.isInspectorVisible = true
            store.inspectorTab = .lead
            Task { await store.sendLeadMessage(composed.combinedMessage) }
            return
        }

        Task {
            await store.startChatThread(prompt: composed.combinedMessage, project: targetProject)
        }
    }
}
