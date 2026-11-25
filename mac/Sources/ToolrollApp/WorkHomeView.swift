import AppKit
import SwiftUI
import ToolrollCore

struct WorkHomeView: View {
    @Bindable var store: WorkbenchStore
    @State private var isComposerDropTargeted = false
    @State private var expandedFleetSection: String? = nil
    @FocusState private var quickPromptFocused: Bool

    private enum ComposerGear: String {
        case lead
        case chat
        case task
    }

    private var currentGear: ComposerGear {
        switch store.preferredOrchestrationMode {
        case "chat": return .chat
        case "task": return .task
        default: return .lead
        }
    }

    private var rows: [WorkRow] { store.filteredRows }
    private var waiting: [WorkRow] { rows.filter { $0.rank == 0 } }
    private var running: [WorkRow] { rows.filter { $0.rank == 1 } }
    private var queued: [WorkRow] { rows.filter { $0.rank == 2 } }
    private var asks: [NeedRow] { store.workRowsResponse.needs.flatMap(\.rows) }
    private var needsTotal: Int { waiting.count + asks.count }
    private var inFlightTotal: Int { running.count + queued.count + store.runningChatThreadIds.count }
    private var hasActiveWork: Bool { needsTotal > 0 || inFlightTotal > 0 }
    private var hasLeadConversation: Bool { !store.leadChat.messages.isEmpty || store.leadChat.busy }

    private var activeProject: String? {
        store.activeProject ?? store.selectedProject ?? store.allProjects.first
    }

    var body: some View {
        VStack(spacing: 0) {
            if let notice = store.notice {
                noticeBar(notice)
                HairlineDivider()
            }

            if hasLeadConversation {
                activeLeadCanvas
            } else {
                freshHomeCanvas
            }
        }
        .background(ToolrollPalette.ground)
        .onAppear {
            if let pending = store.pendingComposerDraft, !pending.isEmpty {
                store.workDraftText = store.workDraftText.isEmpty ? pending : "\(store.workDraftText)\n\(pending)"
                store.pendingComposerDraft = nil
            }
            quickPromptFocused = true
            Task { await store.refreshLeadChat() }
        }
        .onChange(of: store.pendingComposerDraft) { _, pending in
            if let pending, !pending.isEmpty {
                store.workDraftText = store.workDraftText.isEmpty ? pending : "\(store.workDraftText)\n\(pending)"
                store.pendingComposerDraft = nil
            }
        }
        .onChange(of: store.composerFocusTick) { _, _ in
            quickPromptFocused = true
        }
    }

    private var activeLeadCanvas: some View {
        VStack(spacing: 0) {
            if hasActiveWork || store.leadChat.pendingProposals > 0 {
                ambientFleetHeader
                HairlineDivider()
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(store.leadChat.messages) { msg in
                            LeadMessageRow(
                                message: msg,
                                account: store.activeProfile.account,
                                leadName: store.leadChat.leadName,
                                wide: true,
                                onSelectAskOption: { option in
                                    Task { _ = await store.sendLeadMessage(option) }
                                },
                                onConfirmProposal: { card in
                                    Task { await store.confirmLeadProposal(card) }
                                },
                                onDismissProposal: { card in
                                    Task { await store.dismissLeadProposal(card) }
                                },
                                onOpenLink: { link in
                                    Task { await store.openLeadLink(link) }
                                }
                            )
                            .id(msg.id)
                        }

                        if store.leadChat.busy {
                            KineticThinkingRow(
                                provider: "lead",
                                label: "\(store.leadChat.leadName) is thinking…"
                            )
                            .padding(.horizontal, 2)
                            .id(LeadMessageRow.thinkingId)
                        }

                        Color.clear
                            .frame(height: 1)
                            .id("lead-bottom-anchor")
                    }
                    .padding(.horizontal, 28)
                    .padding(.top, 20)
                    .padding(.bottom, 18)
                    .frame(maxWidth: 800, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .onAppear {
                    scrollLeadToBottom(proxy, animated: false)
                }
                .onChange(of: store.leadChat.messages.count) { _, _ in
                    scrollLeadToBottom(proxy, animated: true)
                }
                .onChange(of: store.leadChat.busy) { _, _ in
                    scrollLeadToBottom(proxy, animated: true)
                }
            }

            VStack(spacing: 8) {
                if currentGear == .lead, let problem = store.leadChat.problem, !problem.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.warning)
                        Text(problem)
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(2)
                        Spacer()
                    }
                    .padding(.horizontal, 4)
                }

                unifiedComposer

                compactQuotaBar
            }
            .padding(.horizontal, 24)
            .padding(.top, 6)
            .padding(.bottom, 14)
            .frame(maxWidth: 848)
            .frame(maxWidth: .infinity)
        }
    }

    private func scrollLeadToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.18)) {
                proxy.scrollTo("lead-bottom-anchor", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("lead-bottom-anchor", anchor: .bottom)
        }
    }

    private var ambientFleetHeader: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if needsTotal > 0 {
                    fleetPill(
                        id: "needs",
                        dotColor: ToolrollPalette.warning,
                        isLive: false,
                        title: needsTotal == 1 ? "1 needs you" : "\(needsTotal) needs you"
                    )
                }
                if inFlightTotal > 0 {
                    fleetPill(
                        id: "inflight",
                        dotColor: ToolrollPalette.live,
                        isLive: true,
                        title: inFlightTotal == 1 ? "1 in flight" : "\(inFlightTotal) in flight"
                    )
                }
                if store.leadChat.pendingProposals > 0 {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(ToolrollPalette.ink)
                            .frame(width: 5.5, height: 5.5)
                        Text(store.leadChat.pendingProposals == 1 ? "1 proposal ready" : "\(store.leadChat.pendingProposals) proposals ready")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                    }
                    .padding(.horizontal, 9)
                    .frame(height: 24)
                    .background(ToolrollPalette.raised, in: Capsule())
                    .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 8)
            .frame(maxWidth: 848, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)

            if expandedFleetSection == "needs" && needsTotal > 0 {
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
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                .padding(.horizontal, 24)
                .padding(.bottom, 10)
                .frame(maxWidth: 848)
                .frame(maxWidth: .infinity)
            } else if expandedFleetSection == "inflight" && inFlightTotal > 0 {
                let activeTasks = running + queued
                let activeChats = store.chatThreads.filter { store.runningChatThreadIds.contains($0.id) }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(activeTasks.enumerated()), id: \.element.id) { idx, row in
                        if idx > 0 { HairlineDivider() }
                        taskRow(row)
                    }
                    ForEach(Array(activeChats.enumerated()), id: \.element.id) { idx, thread in
                        if idx > 0 || !activeTasks.isEmpty { HairlineDivider() }
                        runningChatRow(thread)
                    }
                }
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                .padding(.horizontal, 24)
                .padding(.bottom, 10)
                .frame(maxWidth: 848)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func fleetPill(id: String, dotColor: Color, isLive: Bool, title: String) -> some View {
        let isOpen = expandedFleetSection == id
        return Button {
            withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                expandedFleetSection = isOpen ? nil : id
            }
        } label: {
            HStack(spacing: 6) {
                if isLive {
                    ToolrollKineticLoader(provider: "lead", height: 9)
                } else {
                    Circle().fill(dotColor).frame(width: 5.5, height: 5.5)
                }
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                Image(systemName: isOpen ? "chevron.up" : "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(isOpen ? ToolrollPalette.raised : ToolrollPalette.ground, in: Capsule())
            .overlay(Capsule().strokeBorder(isOpen ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var freshHomeCanvas: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !hasActiveWork {
                    Spacer().frame(height: 52)
                }

                if needsTotal > 0 {
                    needsAttentionSection
                }

                heroHeading

                unifiedComposer

                if currentGear == .lead {
                    leadStarterChips
                }

                compactQuotaBar

                if !running.isEmpty || !queued.isEmpty {
                    activeRunsSection
                }
            }
            .padding(.horizontal, 36)
            .padding(.vertical, 28)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private var leadStarterChips: some View {
        let prompts = [
            "What needs my attention right now?",
            "Summarize recent progress across my projects",
            "Check my agents and project setup",
        ]
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(prompts, id: \.self) { prompt in
                    Button {
                        Task { _ = await store.sendLeadMessage(prompt) }
                    } label: {
                        Text(prompt)
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(ToolrollPalette.muted)
                            .padding(.horizontal, 11)
                            .frame(height: 28)
                            .background(ToolrollPalette.raised.opacity(0.65), in: Capsule())
                            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .toolrollHoverSurface(cornerRadius: 14, isSelected: false)
                }
            }
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
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(ToolrollPalette.raised)
    }

    private var heroHeading: some View {
        HStack(alignment: .center, spacing: 10) {
            ProviderBrandGlyph(provider: "lead", size: 24, tinted: false, inTile: true)

            Text(heroTitle)
                .font(.system(size: 23, weight: .semibold))
                .tracking(-0.4)
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 8)

            if inFlightTotal > 0 {
                HStack(spacing: 5) {
                    Circle()
                        .fill(ToolrollPalette.live)
                        .frame(width: 6, height: 6)
                    Text(inFlightTotal == 1 ? "1 running" : "\(inFlightTotal) running")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
        }
        .padding(.horizontal, 2)
    }

    private var heroTitle: String {
        switch currentGear {
        case .lead:
            return activeProject.map { "Coordinate \($0) with \(store.leadChat.leadName)" } ?? "What should \(store.leadChat.leadName) coordinate?"
        case .chat:
            return activeProject.map { "Chat in \($0)" } ?? "Start a direct chat"
        case .task:
            return activeProject.map { "Build in \($0)" } ?? "Kick off a task"
        }
    }

    private var unifiedComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !store.workDraftAttachments.isEmpty {
                ComposerAttachmentStrip(attachments: store.workDraftAttachments) { removedId in
                    store.workDraftAttachments.removeAll { $0.id == removedId }
                }
            }

            TextField(
                composerPlaceholder,
                text: $store.workDraftText,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 14.5))
            .foregroundStyle(ToolrollPalette.ink)
            .lineLimit(hasLeadConversation ? 1...6 : 2...7)
            .focused($quickPromptFocused)
            .onSubmit { submitQuickPrompt() }
            .padding(.horizontal, 2)
            .padding(.top, 2)

            HStack(spacing: 8) {
                ComposerAttachMenuButton(compact: true) { incoming in
                    appendUniqueAttachments(incoming, to: &store.workDraftAttachments)
                }

                projectSelectorMenu

                gearSwitch

                if currentGear == .task {
                    planFirstChip
                } else if currentGear == .chat {
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
                .disabled(
                    (store.workDraftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.workDraftAttachments.isEmpty)
                        || (currentGear == .lead && !store.leadChat.canSend && !store.activeProfile.isDemo)
                )
            }
        }
        .padding(hasLeadConversation ? 13 : 16)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    isComposerDropTargeted ? ToolrollPalette.live : (quickPromptFocused ? ToolrollPalette.inputLine : ToolrollPalette.line),
                    lineWidth: 1
                )
        )
        .onComposerPaste(isActive: quickPromptFocused) { incoming in
            appendUniqueAttachments(incoming, to: &store.workDraftAttachments)
        }
        .onDrop(of: ComposerDropHelper.acceptedTypes, isTargeted: $isComposerDropTargeted) { providers in
            ComposerDropHelper.handleDrop(providers: providers) { incoming in
                appendUniqueAttachments(incoming, to: &store.workDraftAttachments)
            }
        }
    }

    private var composerPlaceholder: String {
        switch currentGear {
        case .lead:
            return "Ask \(store.leadChat.leadName) to plan, delegate, or check \(activeProject ?? "your workspace")…"
        case .chat:
            return "Message \(store.defaultChatProvider.displayName) directly in \(activeProject ?? "your workspace")…"
        case .task:
            return store.workDraftPlanFirst
                ? "Describe a task to plan & verify in \(activeProject ?? "your workspace")…"
                : "Describe a task to build in an isolated worktree…"
        }
    }

    private var submitLabel: String {
        switch currentGear {
        case .lead:
            return "Ask \(store.leadChat.leadName)"
        case .chat:
            return "Chat"
        case .task:
            return store.workDraftPlanFirst ? "Plan" : "Build"
        }
    }

    private var gearSwitch: some View {
        HStack(spacing: 2) {
            gearPill(title: store.leadChat.leadName, active: currentGear == .lead) {
                store.preferredOrchestrationMode = "lead"
            }
            gearPill(title: "Chat", active: currentGear == .chat) {
                store.preferredOrchestrationMode = "chat"
            }
            gearPill(title: "Task", active: currentGear == .task) {
                store.preferredOrchestrationMode = "task"
            }
        }
        .padding(2.5)
        .background(ToolrollPalette.ground, in: Capsule())
        .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
        .help("Lead: coordinate across projects · Chat: direct streaming CLI · Task: isolated worktree + checks (⌘.)")
    }

    private func gearPill(title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: active ? .semibold : .medium))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .padding(.horizontal, 9)
                .frame(height: 22)
                .background(active ? ToolrollPalette.raised : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .contentShape(Capsule())
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
                                if store.defaultChatProvider == provider && store.defaultChatModelId == preset.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                ProviderBrandGlyph(
                    provider: store.defaultChatProvider.rawValue,
                    size: 12,
                    tinted: true,
                    inTile: false
                )
                Text(store.defaultChatProvider.label(for: store.defaultChatModelId))
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
            .contentShape(Capsule())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var planFirstChip: some View {
        Button {
            store.workDraftPlanFirst.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: store.workDraftPlanFirst ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 10))
                Text("Plan first")
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(store.workDraftPlanFirst ? ToolrollPalette.ink : ToolrollPalette.muted)
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(ToolrollPalette.ground, in: Capsule())
            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .contentShape(Capsule())
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
            if !store.unconnectedGitRepos.isEmpty {
                Divider()
                Menu("Found on this Mac (\(store.unconnectedGitRepos.count))") {
                    ForEach(store.unconnectedGitRepos.prefix(20)) { repo in
                        Button(repo.branch.map { "\(repo.name) (\($0))" } ?? repo.name) {
                            Task { await store.addLocalProject(path: repo.path) }
                        }
                    }
                }
            }
            if !store.allProjects.isEmpty || !store.unconnectedGitRepos.isEmpty {
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
            .contentShape(Capsule())
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
                        ProviderBrandGlyph(provider: "gemini", size: 11, tinted: true, inTile: false)
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
            .padding(.vertical, 6)
            .background(ToolrollPalette.raised.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
            ProviderBrandGlyph(provider: limit.provider, size: 11, tinted: true, inTile: false)
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
                    .fill(ToolrollPalette.warning)
                    .frame(width: 6, height: 6)
                Text("Needs you")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("\(needsTotal)")
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

    private func runningChatRow(_ thread: AgentChatThread) -> some View {
        Button {
            expandedFleetSection = nil
            store.selectChatThread(thread.id)
        } label: {
            HStack(spacing: 10) {
                ToolrollKineticLoader(provider: thread.provider.rawValue, height: 11)
                    .frame(width: 14, height: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    Text("\(thread.projectName) · \(thread.provider.label(for: thread.modelId))")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 10)
                Text(thread.relativeAge)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .contentShape(Rectangle())
            .toolrollHoverSurface(cornerRadius: 8, isSelected: false)
        }
        .buttonStyle(.plain)
    }

    private func taskRow(_ row: WorkRow) -> some View {
        Button {
            expandedFleetSection = nil
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
            Circle().fill(ToolrollPalette.warning).frame(width: 6, height: 6)
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
            case .needs: Circle().fill(ToolrollPalette.warning)
            case .running: Circle().fill(ToolrollPalette.live)
            case .failed: Circle().fill(ToolrollPalette.danger)
            case .queued: Circle().fill(ToolrollPalette.muted)
            case .finished, .unknown: Circle().strokeBorder(ToolrollPalette.muted, lineWidth: 1)
            }
        }
        .frame(width: 6.5, height: 6.5)
    }

    private func submitQuickPrompt() {
        let raw = store.workDraftText.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = store.workDraftAttachments
        guard !raw.isEmpty || !attachments.isEmpty else { return }
        let composed = ComposerAttachmentStore.composeSubmission(text: raw, attachments: attachments)
        store.workDraftText = ""
        store.workDraftAttachments = []
        let targetProject = activeProject

        switch currentGear {
        case .lead:
            Task { _ = await store.sendLeadMessage(composed.combinedMessage) }
        case .task:
            let planFirst = store.workDraftPlanFirst
            Task {
                await store.createTask(
                    title: composed.title,
                    project: targetProject,
                    body: composed.goal,
                    planFirst: planFirst
                )
            }
        case .chat:
            Task {
                await store.startChatThread(prompt: raw, project: targetProject, attachments: attachments)
            }
        }
    }
}
