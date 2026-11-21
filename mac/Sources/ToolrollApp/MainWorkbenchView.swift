import SwiftUI
import ToolrollCore

/// Top-level 3-pane native macOS Workbench (T3 Code attention-first inbox + Rex zero-chrome speed + Toolroll Signal 1.0.0).
public struct MainWorkbenchView: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        ZStack {
            VStack(spacing: 0) {
                topChromeBar
                HairlineDivider()

                HSplitView {
                    InboxSidebarView(store: store)
                        .frame(minWidth: 235, idealWidth: 265, maxWidth: 340)

                    TaskCockpitView(store: store)
                        .frame(minWidth: 420, maxWidth: .infinity)

                    if store.isInspectorVisible {
                        InspectorView(store: store)
                            .frame(minWidth: 360, idealWidth: 460, maxWidth: 700)
                    }
                }
            }
            .background(ToolrollPalette.paper)

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

            // Workspace switcher
            Menu {
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
                if !store.activeProfile.isDemo {
                    Divider()
                    Button("Preview Demo Workspace") {
                        Task { await store.switchProfile(name: "demo") }
                    }
                }
                Divider()
                Button("Reconnect Local Toolroll") {
                    Task { _ = await store.connectToLocalConsoleIfAvailable(silent: false) }
                }
                Button("Connect / Pair Remote Workspace…") {
                    store.isPairSheetOpen = true
                }
            } label: {
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2.5)
                        .fill(ToolrollPalette.ink)
                        .frame(width: 10, height: 10)
                    Text(store.activeProfile.displayTitle)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            // Project filter
            Menu {
                Button("All projects") { store.selectedProject = nil }
                if !store.allProjects.isEmpty {
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
            } label: {
                HStack(spacing: 4) {
                    Text(store.selectedProject ?? "All projects")
                        .font(.system(size: 12))
                        .foregroundStyle(ToolrollPalette.muted)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            if store.activeProfile.isDemo {
                Button("Connect Workspace…") {
                    store.isPairSheetOpen = true
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
            }

            Spacer()

            // + New Task (⌘N)
            Button {
                store.isNewTaskSheetOpen = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .semibold))
                    Text("New Task")
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("New Task (⌘N)")

            // ⌘K Command Palette pill
            Button {
                store.isCommandPaletteOpen.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11))
                    Text("Command Palette")
                        .font(.system(size: 11.5))
                    Text("⌘K")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                }
                .foregroundStyle(ToolrollPalette.muted)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
            }
            .buttonStyle(.plain)

            // Refresh button
            Button {
                Task { await store.refreshAll() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            .buttonStyle(.plain)
            .help("Refresh Workspace (⌘R)")

            // Toggle Inspector
            Button {
                store.isInspectorVisible.toggle()
            } label: {
                Image(systemName: "sidebar.right")
                    .font(.system(size: 12.5))
                    .foregroundStyle(store.isInspectorVisible ? ToolrollPalette.ink : ToolrollPalette.muted)
            }
            .buttonStyle(.plain)
            .help("Toggle Inspector (⌘J)")
        }
        .padding(.trailing, 14)
        .frame(height: 38)
        .background(ToolrollPalette.ground)
    }
}
