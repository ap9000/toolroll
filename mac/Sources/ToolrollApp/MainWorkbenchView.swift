import SwiftUI
import ToolrollCore

/// Top-level native macOS Workbench — serene 2-pane default focus (Inbox + Task Cockpit)
/// with progressive disclosure for Setup Studio, Inspector drawer (⌘J), and Command Palette (⌘K).
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
                        InboxSidebarView(store: store)
                            .frame(minWidth: 230, idealWidth: 255, maxWidth: 320)

                        TaskCockpitView(store: store)
                            .frame(minWidth: 460, maxWidth: .infinity)

                        if store.isInspectorVisible {
                            InspectorView(store: store)
                                .frame(minWidth: 360, idealWidth: 460, maxWidth: 700)
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
        .task {
            await store.start()
        }
    }

    private var topChromeBar: some View {
        HStack(spacing: 10) {
            // Reserve space for macOS hidden-titlebar traffic lights
            Spacer().frame(width: 68)

            // Unified Workspace & Project switcher (clean, single control)
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

                if !store.allProjects.isEmpty {
                    Divider()
                    Menu("Project: \(store.selectedProject ?? "All")") {
                        Button("All projects") { store.selectedProject = nil }
                        Divider()
                        ForEach(store.allProjects, id: \.self) { proj in
                            Button {
                                store.selectedProject = proj
                            } label: {
                                HStack {
                                    Text(proj)
                                    if store.selectedProject == proj {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    }
                }

                Divider()
                Button("Setup & Agents…") {
                    store.isSetupOpen = true
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
                HStack(spacing: 6) {
                    Circle()
                        .fill(store.sseConnected ? ToolrollPalette.success : ToolrollPalette.muted)
                        .frame(width: 6, height: 6)
                    Text(store.selectedProject ?? store.activeProfile.displayTitle)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            Spacer()

            // Quiet ⌘K Command Palette pill
            Button {
                store.isCommandPaletteOpen.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 10.5))
                    Text("Jump or run…")
                        .font(.system(size: 11.5))
                    Text("⌘K")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .buttonStyle(.plain)

            // + New Task (⌘N)
            Button {
                store.isNewTaskSheetOpen = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 10.5, weight: .semibold))
                    Text("New Task")
                }
            }
            .buttonStyle(KitButtonStyle(.primary, compact: true))
            .help("New Task (⌘N)")

            // Inspector toggle (⌘J)
            Button {
                store.isInspectorVisible.toggle()
            } label: {
                Image(systemName: "sidebar.right")
                    .font(.system(size: 12.5))
                    .foregroundStyle(store.isInspectorVisible ? ToolrollPalette.ink : ToolrollPalette.muted)
                    .padding(4)
            }
            .buttonStyle(.plain)
            .help("Toggle Terminal / Diff / Lead Drawer (⌘J)")
        }
        .padding(.trailing, 14)
        .frame(height: 38)
        .background(ToolrollPalette.ground)
    }
}
