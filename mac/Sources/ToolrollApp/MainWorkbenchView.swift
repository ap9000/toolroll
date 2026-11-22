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
            // Authentic macOS 26 behind-window vibrancy + subtle theme glass veil
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

                    HSplitView {
                        if store.isSidebarVisible && !WorkspaceThemeEngine.shared.config.isSidebarOnRight {
                            InboxSidebarView(store: store)
                                .frame(minWidth: 196, idealWidth: 238, maxWidth: 310)
                        }

                        Group {
                            if store.workspaceMode == .canvas {
                                CanvasWorkspaceView(store: store)
                            } else if let cliThread = store.selectedCliThread {
                                LocalCliThreadView(store: store, thread: cliThread)
                            } else if store.isComposingNewWork || store.selectedRow == nil {
                                NewWorkCanvasView(store: store)
                            } else {
                                TaskCockpitView(store: store)
                            }
                        }
                        .frame(minWidth: 360, maxWidth: .infinity)
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
        .preferredColorScheme(WorkspaceThemeEngine.shared.preferredColorScheme)
        .task {
            await store.start()
        }
    }

    private var breadcrumbProject: String {
        if let cliThread = store.selectedCliThread {
            return "\(cliThread.provider.displayName) · \(cliThread.projectName)"
        }
        if store.isComposingNewWork {
            return store.activeProject ?? store.selectedProject ?? store.allProjects.first ?? store.activeProfile.displayTitle
        }
        return store.selectedRow?.project ?? store.activeProject ?? store.selectedProject ?? store.activeProfile.displayTitle
    }

    private var breadcrumbTitle: String {
        if let cliThread = store.selectedCliThread {
            return cliThread.title
        }
        if store.isComposingNewWork || store.selectedRow == nil {
            return "New task"
        }
        return store.selectedRow?.title ?? "Workbench"
    }

    private var topChromeBar: some View {
        HStack(spacing: 10) {
            // Left glass navigation cluster (aligned past traffic lights)
            HStack(spacing: 6) {
                Spacer().frame(width: 68)

                ToolrollGlassGroup(spacing: 6) {
                    // Sidebar + Workspace menu glass capsule
                    HStack(spacing: 2) {
                        Button {
                            withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                                store.isSidebarVisible.toggle()
                            }
                        } label: {
                            Image(systemName: "sidebar.left")
                                .font(.system(size: 12))
                                .foregroundStyle(store.isSidebarVisible ? ToolrollPalette.ink : ToolrollPalette.muted)
                                .frame(width: 26, height: 24)
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
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
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(ToolrollPalette.ink)
                                    .lineLimit(1)
                                Circle()
                                    .fill(store.sseConnected ? ToolrollPalette.success : ToolrollPalette.muted)
                                    .frame(width: 5.5, height: 5.5)
                            }
                            .padding(.trailing, 6)
                            .frame(height: 24)
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                    }
                    .padding(.horizontal, 4)
                    .toolrollGlassCapsule(interactive: true)

                    // Back / Forward glass capsule (⌘[ / ⌘])
                    HStack(spacing: 0) {
                        Button {
                            Task { await store.goBack() }
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(store.canGoBack ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.4))
                                .frame(width: 24, height: 24)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!store.canGoBack)
                        .help("Back (⌘[)")

                        Button {
                            Task { await store.goForward() }
                        } label: {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(store.canGoForward ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.4))
                                .frame(width: 24, height: 24)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!store.canGoForward)
                        .help("Forward (⌘])")
                    }
                    .padding(.horizontal, 2)
                    .toolrollGlassCapsule(interactive: true)
                }
            }

            // Quiet centered-left breadcrumb
            HStack(spacing: 5) {
                Text(breadcrumbProject)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
                Text("/")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.45))
                Text(breadcrumbTitle)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.leading, 4)

            Spacer(minLength: 8)

            // Right Liquid Glass cluster: Mode switch + ⌘K + Inspector drawer pills
            ToolrollGlassGroup(spacing: 6) {
                // Workbench | Canvas glass capsule
                HStack(spacing: 2) {
                    ForEach(WorkspaceMode.allCases) { mode in
                        let selected = store.workspaceMode == mode
                        Button {
                            withAnimation(WorkspaceThemeEngine.shared.snappyAnimation) {
                                store.workspaceMode = mode
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

                // Quiet ⌘K glass pill
                Button {
                    store.isCommandPaletteOpen.toggle()
                } label: {
                    Text("⌘K")
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 8)
                        .frame(height: 26)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .toolrollGlassCapsule(interactive: true)
                .help("Command Palette (⌘K)")

                // Right-edge Inspector toggles inside one unified glass capsule
                HStack(spacing: 2) {
                    drawerIconButton(systemName: "doc.richtext", tab: .artifact, help: "Toggle Artifact Window (⌘4)")
                    diffDrawerButton
                    drawerIconButton(systemName: "terminal", tab: .terminal, help: "Toggle Live Terminal (⌘1)")
                    drawerIconButton(systemName: "sidebar.right", tab: .lead, help: "Toggle Lead / Drawer (⌘J)")
                }
                .padding(.horizontal, 3)
                .frame(height: 26)
                .toolrollGlassCapsule(interactive: true)
            }
            .padding(.trailing, 10)
        }
        .frame(height: 44)
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
                    .font(.system(size: 11.5))
                    .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                if added > 0 {
                    Text("+\(added)")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.success)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, added > 0 ? 7 : 5)
            .frame(height: 22)
            .background(active ? Color.white.opacity(0.14) : Color.clear, in: Capsule())
            .contentShape(Capsule())
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
                .font(.system(size: 11.5))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .frame(width: 24, height: 22)
                .background(active ? Color.white.opacity(0.14) : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
