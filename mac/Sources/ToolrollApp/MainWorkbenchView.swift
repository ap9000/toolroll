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
                        if store.isSidebarVisible {
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
                    withAnimation(.easeInOut(duration: 0.14)) {
                        store.isSidebarVisible.toggle()
                    }
                } label: {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 12))
                        .foregroundStyle(store.isSidebarVisible ? ToolrollPalette.ink : ToolrollPalette.muted)
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

                // Back / Forward navigation (⌘[ / ⌘])
                HStack(spacing: 6) {
                    Button {
                        Task { await store.goBack() }
                    } label: {
                        Image(systemName: "arrow.left")
                            .font(.system(size: 11))
                            .foregroundStyle(store.canGoBack ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.35))
                    }
                    .buttonStyle(.plain)
                    .disabled(!store.canGoBack)
                    .help("Back (⌘[)")

                    Button {
                        Task { await store.goForward() }
                    } label: {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 11))
                            .foregroundStyle(store.canGoForward ? ToolrollPalette.ink : ToolrollPalette.muted.opacity(0.35))
                    }
                    .buttonStyle(.plain)
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

                // Clean Workbench | Canvas mode pill (⌘3)
                HStack(spacing: 2) {
                    ForEach(WorkspaceMode.allCases) { mode in
                        let active = store.workspaceMode == mode
                        Button {
                            store.workspaceMode = mode
                        } label: {
                            Text(mode.rawValue)
                                .font(.system(size: 11, weight: active ? .semibold : .regular))
                                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(2)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))

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

                // Clean right-edge drawer toggles: Artifact | Diff | Terminal | Lead
                HStack(spacing: 6) {
                    drawerIconButton(systemName: "doc.richtext", tab: .artifact, help: "Toggle Artifact Window (⌘4)")
                    drawerIconButton(systemName: "doc.text.magnifyingglass", tab: .diff, help: "Toggle Diff (⌘2)")
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

    private func drawerIconButton(systemName: String, tab: InspectorTab, help: String) -> some View {
        let active = store.isInspectorVisible && store.inspectorTab == tab
        return Button {
            withAnimation(.easeInOut(duration: 0.14)) {
                store.toggleInspector(tab: tab)
            }
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 12.5))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .frame(width: 24, height: 22)
                .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
