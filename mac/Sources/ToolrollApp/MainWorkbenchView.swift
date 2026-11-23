import SwiftUI
import ToolrollCore

/// Top-level native macOS Workbench — ultra-clean multiplexer chrome:
/// Left: sidebar toggle + ←/→ history. Middle: where you are. Right: ⌘K + the drawer toggle.
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
                            } else if let cliThread = store.selectedCliThread {
                                LocalCliThreadView(store: store, thread: cliThread)
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

    /// The project segment, only where it names something real (a task's or a new task's project).
    private var breadcrumbProject: String? {
        if let cliThread = store.selectedCliThread {
            return "\(cliThread.provider.displayName) · \(cliThread.projectName)"
        }
        guard store.workspaceMode == .workbench else { return nil }
        if store.isComposingNewWork { return store.activeProject ?? store.selectedProject }
        return store.selectedRow?.project
    }

    /// Where you are: the screen's name, or the task's title.
    private var breadcrumbTitle: String {
        if let cliThread = store.selectedCliThread { return cliThread.title }
        switch store.workspaceMode {
        case .canvas: return "Canvas"
        case .automations: return "Automations"
        case .workbench: break
        }
        if store.isComposingNewWork { return "New task" }
        return store.selectedRow?.title ?? "Work"
    }

    /// Every control in the top bar shares one height, so the left and right sides line up.
    static let chromeControlHeight: CGFloat = 28
    /// The drawer can widen only until the main panel reaches this, so its text never gets crushed.
    static let mainPanelMinWidth: CGFloat = 440

    /// Left: sidebar toggle and back/forward (past the traffic lights). Middle: where you are. Right: ⌘K and the drawer
    /// toggle, mirroring the sidebar toggle. The workspace menu lives on the sidebar's Toolroll row; the drawer's own tabs
    /// pick Artifact / Diff / Terminal / Lead.
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

            Spacer(minLength: 8)

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

    /// "+12" beside the drawer toggle while the drawer is closed and the task has changes to look at.
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

/// A top-bar toggle: one icon in a glass capsule, lit while its panel is showing.
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
