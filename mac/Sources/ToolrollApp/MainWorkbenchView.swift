import SwiftUI
import ToolrollCore

public struct MainWorkbenchView: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        ZStack {
            if WorkspaceThemeEngine.shared.config.sidebarVibrancy {
                SidebarVibrancyBackground(material: .underWindowBackground)
                    .ignoresSafeArea()
                ToolrollPalette.ground.opacity(0.34)
                    .ignoresSafeArea()
            } else {
                ToolrollPalette.ground
                    .ignoresSafeArea()
            }

            if store.isSetupOpen {
                SetupWorkbenchView(store: store)
            } else {
                VStack(spacing: 0) {
                    topChromeBar

                    if store.showPasswordNudge {
                        SetPasswordBanner(store: store)
                    }

                    AgentRequestsBannerView(store: store)

                    HSplitView {
                        if store.isSidebarVisible && !WorkspaceThemeEngine.shared.config.isSidebarOnRight {
                            InboxSidebarView(store: store)
                                .frame(minWidth: 196, idealWidth: 238, maxWidth: 310)
                        }

                        Group {
                            if store.workspaceMode == .canvas {
                                CanvasWorkspaceView(store: store)
                            } else if store.workspaceMode == .automations {
                                AutomationsView(store: store)
                            } else if let chatThread = store.selectedChatThread {
                                AgentChatView(store: store, thread: chatThread)
                            } else if store.isComposingNewWork {
                                NewWorkCanvasView(store: store)
                            } else if store.selectedRow == nil {
                                WorkHomeView(store: store)
                            } else {
                                TaskCockpitView(store: store)
                            }
                        }
                        .frame(minWidth: MainWorkbenchView.mainPanelMinWidth, maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                        )
                        .shadow(color: Color.black.opacity(0.22), radius: 10, y: 2)
                        .padding(.top, 2)
                        .padding(.bottom, 8)
                        .padding(.leading, store.isSidebarVisible && !WorkspaceThemeEngine.shared.config.isSidebarOnRight ? 4 : 8)
                        .padding(.trailing, store.isInspectorVisible || (store.isSidebarVisible && WorkspaceThemeEngine.shared.config.isSidebarOnRight) ? 4 : 8)

                        if store.isInspectorVisible {
                            InspectorView(store: store)
                                .frame(minWidth: 320, idealWidth: 460, maxWidth: 860)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                                )
                                .shadow(color: Color.black.opacity(0.2), radius: 10, y: 2)
                                .padding(.top, 2)
                                .padding(.bottom, 8)
                                .padding(.leading, 4)
                                .padding(.trailing, store.isSidebarVisible && WorkspaceThemeEngine.shared.config.isSidebarOnRight ? 4 : 8)
                        }

                        if store.isSidebarVisible && WorkspaceThemeEngine.shared.config.isSidebarOnRight {
                            InboxSidebarView(store: store)
                                .frame(minWidth: 196, idealWidth: 238, maxWidth: 310)
                        }
                    }
                }
            }

            if store.isCommandPaletteOpen {
                CommandPaletteView(store: store)
            }
        }
        .background(WindowGlassConfigurator())
        .sheet(isPresented: $store.isPairSheetOpen) {
            PairWorkspaceSheet(store: store)
        }
        .sheet(isPresented: $store.isNewTaskSheetOpen) {
            NewTaskSheet(store: store)
        }
        .sheet(isPresented: $store.isAddProjectSheetOpen) {
            AddProjectSheet(store: store)
        }
        .sheet(isPresented: $store.isForkSheetOpen) {
            ForkTaskSheet(store: store)
        }
        .sheet(isPresented: $store.isPhonePairSheetOpen) {
            PhonePairSheet(store: store)
        }
        .sheet(isPresented: $store.isAppearanceSheetOpen) {
            AppearanceSheet(store: store)
        }
        .sheet(isPresented: $store.isProjectSettingsOpen) {
            ProjectSettingsSheet(store: store)
        }
        .sheet(isPresented: $store.isSetPasswordOpen) {
            SetPasswordSheet(store: store)
        }
        .modifier(CancelConfirmation(store: store))
        .modifier(ModelPickConfirmation(store: store))
        .sheet(isPresented: Binding(get: { store.modelPickerTaskId != nil }, set: { if !$0 { store.modelPickerTaskId = nil } })) {
            if let taskId = store.modelPickerTaskId {
                ModelPickerPopover(store: store, initialRoleKey: "all", taskId: taskId, onDismiss: { store.modelPickerTaskId = nil })
            }
        }
        .preferredColorScheme(WorkspaceThemeEngine.shared.preferredColorScheme)
        .task {
            await store.start()
        }
    }

    private var breadcrumbProject: String? {
        if let chatThread = store.selectedChatThread {
            return "\(chatThread.provider.displayName) · \(chatThread.projectName)"
        }
        guard store.workspaceMode == .workbench else { return nil }
        if store.isComposingNewWork { return store.activeProject ?? store.selectedProject }
        return store.selectedRow?.project
    }

    private var breadcrumbTitle: String {
        if let chatThread = store.selectedChatThread { return chatThread.title }
        switch store.workspaceMode {
        case .canvas: return "Canvas"
        case .automations: return "Automations"
        case .workbench: break
        }
        if store.isComposingNewWork { return "New task" }
        return store.selectedRow?.title ?? "Work"
    }

    static let chromeControlHeight: CGFloat = 28
    static let mainPanelMinWidth: CGFloat = 440

    private var topChromeBar: some View {
        HStack(spacing: 8) {
            Spacer().frame(width: 70)

            ChromeIconButton(systemName: "sidebar.left", isOn: store.isSidebarVisible, help: "Show or Hide Sidebar (⌘B)") {
                withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) { store.isSidebarVisible.toggle() }
            }

            HStack(spacing: 0) {
                historyButton("chevron.left", enabled: store.canGoBack, help: "Back (⌘[)") { await store.goBack() }
                historyButton("chevron.right", enabled: store.canGoForward, help: "Forward (⌘])") { await store.goForward() }
            }
            .padding(.horizontal, 2)
            .frame(height: Self.chromeControlHeight)
            .toolrollGlassCapsule(interactive: true)

            if let chatThread = store.selectedChatThread {
                chatTopBarLeading(chatThread)
            } else if store.workspaceMode == .workbench && store.isShowingWorkHome {
                if let proj = store.selectedProject {
                    Text(proj)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.leading, 6)
                }
            } else {
                HStack(spacing: 5) {
                    if let project = breadcrumbProject {
                        Text(project)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                        Text("/")
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted.opacity(0.45))
                    }
                    Text(breadcrumbTitle)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .padding(.leading, 6)
            }

            Spacer(minLength: 8)

            if let chatThread = store.selectedChatThread {
                chatTopBarTrailing(chatThread)
            }

            Button {
                store.isCommandPaletteOpen.toggle()
            } label: {
                Text("⌘K")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                    .padding(.horizontal, 10)
                    .frame(height: Self.chromeControlHeight)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .toolrollGlassCapsule(interactive: true)
            .help("Command Palette (⌘K)")

            ChromeIconButton(systemName: "sidebar.right", isOn: store.isInspectorVisible, badge: diffBadge, help: "Show or Hide Drawer (⌘J)") {
                withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) { store.isInspectorVisible.toggle() }
            }
        }
        .padding(.trailing, 10)
        .frame(height: 44)
    }

    @ViewBuilder
    private func chatTopBarLeading(_ thread: AgentChatThread) -> some View {
        let isRunning = store.runningChatThreadIds.contains(thread.id)
        HStack(spacing: 8) {
            if isRunning {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Circle()
                    .fill(ToolrollPalette.success)
                    .frame(width: 6, height: 6)
            }
            Text(thread.title)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
                .truncationMode(.tail)

            Text(thread.projectName)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 7)
                .frame(height: 22)
                .background(ToolrollPalette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))

            Menu {
                ForEach(AgentChatProvider.allCases) { provider in
                    Section(provider.displayName) {
                        ForEach(provider.presets, id: \.id) { preset in
                            Button {
                                store.updateChatThreadModel(threadId: thread.id, provider: provider, modelId: preset.id)
                            } label: {
                                HStack {
                                    Text(preset.label)
                                    if thread.provider == provider && thread.modelId == preset.id {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(thread.provider.shortBadge)
                        .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                    Text(thread.provider.label(for: thread.modelId))
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 8)
                .frame(height: 22)
                .background(ToolrollPalette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(isRunning)
        }
        .padding(.leading, 4)
    }

    @ViewBuilder
    private func chatTopBarTrailing(_ thread: AgentChatThread) -> some View {
        let diff = store.chatThreadDiffs[thread.id] ?? AgentChatGitDiff()
        HStack(spacing: 6) {
            if !diff.isEmpty {
                Button {
                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                        store.isChatDiffDrawerOpen.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 10.5))
                        Text("\(diff.changedFiles.count) changed")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                    }
                    .foregroundStyle(store.isChatDiffDrawerOpen ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .padding(.horizontal, 9)
                    .frame(height: Self.chromeControlHeight)
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .toolrollGlassCapsule(interactive: true)
                .help("Inspect working tree diff in \(thread.projectName)")
            }

            Button {
                Task { await store.promoteChatToTask(threadId: thread.id) }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.up.right.square")
                        .font(.system(size: 10.5))
                    Text("Ship as Task")
                        .font(.system(size: 11.5, weight: .medium))
                }
                .foregroundStyle(ToolrollPalette.ink)
                .padding(.horizontal, 10)
                .frame(height: Self.chromeControlHeight)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .toolrollGlassCapsule(interactive: true)
            .help("Promote this chat to a sandboxed Toolroll task with checks & merge")

            Menu {
                Button("Open Shell in \(thread.projectName)") {
                    Task { await store.startProjectTerminal(project: thread.projectName, program: "shell") }
                }
                Button("Open Canvas for \(thread.projectName)") {
                    store.activeProject = thread.projectName
                    store.workspaceMode = .canvas
                }
                Button("Refresh Diff") {
                    Task { await store.refreshChatDiff(threadId: thread.id) }
                }
                Divider()
                Button("Delete Chat", role: .destructive) {
                    store.deleteChatThread(id: thread.id)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 28, height: Self.chromeControlHeight)
                    .contentShape(Capsule())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .toolrollGlassCapsule(interactive: true)
        }
    }

    private var diffBadge: String? {
        guard !store.isInspectorVisible, let added = store.diffResponse?.totals?.added, added > 0 else { return nil }
        return "+\(added)"
    }

    private func historyButton(_ systemName: String, enabled: Bool, help: String, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(enabled ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.4))
                .frame(width: 26, height: Self.chromeControlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .help(help)
    }
}

struct ChromeIconButton: View {
    let systemName: String
    let isOn: Bool
    var badge: String? = nil
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: systemName)
                    .font(.system(size: 13))
                    .foregroundStyle(isOn ? ToolrollPalette.ink : ToolrollPalette.muted)
                if let badge {
                    Text(badge)
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.success)
                }
            }
            .padding(.horizontal, badge == nil ? 0 : 10)
            .frame(minWidth: 34)
            .frame(height: MainWorkbenchView.chromeControlHeight)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .toolrollGlassCapsule(interactive: true)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityValue(isOn ? "Showing" : "Hidden")
    }
}
