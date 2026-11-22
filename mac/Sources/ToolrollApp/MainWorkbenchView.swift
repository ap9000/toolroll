import SwiftUI
import ToolrollCore

/// Top-level native macOS Workbench — ultra-clean multiplexer chrome:
/// Left: sidebar toggle + Toolroll workspace menu + ←/→ history.
/// Center: project / task breadcrumb + 3 right-edge drawer toggles (Diff / Terminal / Lead).
public struct MainWorkbenchView: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        ZStack {
            if store.isSetupOpen {
                SetupWorkbenchView(store: store)
            } else {
                VStack(spacing: 0) {
                    topChromeBar
                    HairlineDivider()

                    HSplitView {
                        if store.isSidebarVisible && !WorkspaceThemeEngine.shared.config.isSidebarOnRight {
                            InboxSidebarView(store: store)
                                .frame(minWidth: 225, idealWidth: 250, maxWidth: 320)
                        }

                        Group {
                            if store.workspaceMode == .canvas {
                                CanvasWorkspaceView(store: store)
                            } else if store.isComposingNewWork || store.selectedRow == nil {
                                NewWorkCanvasView(store: store)
                            } else {
                                TaskCockpitView(store: store)
                            }
                        }
                        .frame(minWidth: 460, maxWidth: .infinity)

                        if store.isInspectorVisible {
                            InspectorView(store: store)
                                .frame(minWidth: 360, idealWidth: 480, maxWidth: 860)
                        }

                        if store.isSidebarVisible && WorkspaceThemeEngine.shared.config.isSidebarOnRight {
                            InboxSidebarView(store: store)
                                .frame(minWidth: 225, idealWidth: 250, maxWidth: 320)
                        }
                    }
                }
                .background(ToolrollPalette.paper)
            }

            if store.isCommandPaletteOpen {
                CommandPaletteView(store: store)
            }
        }
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
        .preferredColorScheme(WorkspaceThemeEngine.shared.preferredColorScheme)
        .task {
            await store.start()
        }
    }

    private var breadcrumbProject: String {
        if store.isComposingNewWork {
            return store.selectedProject ?? store.allProjects.first ?? store.activeProfile.displayTitle
        }
        return store.selectedRow?.project ?? store.selectedProject ?? store.activeProfile.displayTitle
    }

    private var breadcrumbTitle: String {
        if store.isComposingNewWork || store.selectedRow == nil {
            return "New task"
        }
        return store.selectedRow?.title ?? "Workbench"
    }

    private var topChromeBar: some View {
        HStack(spacing: 0) {
            // Left section aligned with sidebar
            HStack(spacing: 8) {
                Spacer().frame(width: 68)

                Button {
                    withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                        store.isSidebarVisible.toggle()
                    }
                } label: {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 12))
                        .foregroundStyle(store.isSidebarVisible ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
                .buttonStyle(ToolrollIconButtonStyle(size: 26, isActive: store.isSidebarVisible))
                .help("Toggle Sidebar (⌘B)")

                Menu {
                    Section("Workspace") {
                        ForEach(store.profiles) { profile in
                            Button {
                                Task { await store.switchProfile(name: profile.name) }
                            } label: {
                                HStack {
                                    Text(profile.displayTitle)
                                    if profile.name == store.activeProfile.name {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    }
                    Divider()
                    Button("Setup & Agents…") {
                        store.isSetupOpen = true
                    }
                    Button("Add Project…") {
                        store.isAddProjectSheetOpen = true
                    }
                    Button("Reconnect Local Toolroll") {
                        Task { _ = await store.connectToLocalConsoleIfAvailable(silent: false) }
                    }
                    Button("Connect Remote Workspace…") {
                        store.isPairSheetOpen = true
                    }
                    Button("Pair Phone for Push Alerts…") {
                        store.isPhonePairSheetOpen = true
                    }
                    Button("Appearance & Lead Themes…") {
                        store.isAppearanceSheetOpen = true
                    }
                    if !store.activeProfile.isDemo {
                        Divider()
                        Button("Preview Demo Workspace") {
                            Task { await store.switchProfile(name: "demo") }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text("Toolroll")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink)
                        Circle()
                            .fill(store.sseConnected ? ToolrollPalette.success : ToolrollPalette.muted)
                            .frame(width: 5, height: 5)
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()

                Spacer(minLength: 4)

                // Back / Forward navigation (⌘[ / ⌘]) with generous 26×26pt targets
                HStack(spacing: 2) {
                    Button {
                        Task { await store.goBack() }
                    } label: {
                        Image(systemName: "arrow.left")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.ink)
                    }
                    .buttonStyle(ToolrollIconButtonStyle(size: 26))
                    .disabled(!store.canGoBack)
                    .help("Back (⌘[)")

                    Button {
                        Task { await store.goForward() }
                    } label: {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.ink)
                    }
                    .buttonStyle(ToolrollIconButtonStyle(size: 26))
                    .disabled(!store.canGoForward)
                    .help("Forward (⌘])")
                }
            }
            .padding(.trailing, 10)
            .frame(width: store.isSidebarVisible ? 250 : nil)

            if store.isSidebarVisible {
                HairlineDivider(vertical: true)
            }

            // Center/Right breadcrumb + 3 whisper-quiet drawer icons
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Text(breadcrumbProject)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                    Text("/")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted.opacity(0.5))
                    Text(breadcrumbTitle)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer(minLength: 12)

                // Native macOS segmented Workbench | Canvas switcher (⌘3)
                Picker("", selection: $store.workspaceMode) {
                    ForEach(WorkspaceMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .frame(width: 170)

                // Quiet ⌘K trigger
                Button {
                    store.isCommandPaletteOpen.toggle()
                } label: {
                    Text("⌘K")
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2.5)
                        .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Command Palette (⌘K)")

                // Clean right-edge drawer toggles: Artifact | Diff (+N) | Terminal | Lead
                HStack(spacing: 4) {
                    drawerIconButton(systemName: "doc.richtext", tab: .artifact, help: "Toggle Artifact Window (⌘4)")
                    diffDrawerButton
                    drawerIconButton(systemName: "terminal", tab: .terminal, help: "Toggle Live Terminal (⌘1)")
                    drawerIconButton(systemName: "sidebar.right", tab: .lead, help: "Toggle Lead / Drawer (⌘J)")
                }
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity)
        }
        .frame(height: 38)
        .background(ToolrollPalette.ground)
    }

    private var diffDrawerButton: some View {
        let active = store.isInspectorVisible && store.inspectorTab == .diff
        let added = store.diffResponse?.totals?.added ?? 0
        return Button {
            withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                store.toggleInspector(tab: .diff)
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                if added > 0 {
                    Text("+\(added)")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.success)
                }
            }
            .padding(.horizontal, added > 0 ? 7 : 6)
            .frame(height: 26)
            .toolrollHoverSurface(cornerRadius: 5, isSelected: active)
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Toggle Diff Inspector (⌘2)")
    }

    private func drawerIconButton(systemName: String, tab: InspectorTab, help: String) -> some View {
        let active = store.isInspectorVisible && store.inspectorTab == tab
        return Button {
            withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                store.toggleInspector(tab: tab)
            }
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 12.5))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
        }
        .buttonStyle(ToolrollIconButtonStyle(size: 26, isActive: active))
        .help(help)
    }
}
