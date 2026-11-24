import AppKit
import SwiftUI
import ToolrollCore

@MainActor
final class ToolrollWindowCoordinator {
    static let shared = ToolrollWindowCoordinator()
    var openMainWindow: (() -> Void)?

    func showMainWindow() {
        NSApp.setActivationPolicy(.regular)
        let mainWindows = NSApp.windows.filter { window in
            window.identifier?.rawValue == ToolrollMacApp.mainWindowId
                || window.title == "Toolroll"
                || (window.canBecomeMain && !(window is NSPanel))
        }
        if let existing = mainWindows.first {
            if existing.isMiniaturized {
                existing.deminiaturize(nil)
            }
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        openMainWindow?()
        DispatchQueue.main.async {
            if let created = NSApp.windows.first(where: { $0.canBecomeMain && !($0 is NSPanel) }) {
                created.makeKeyAndOrderFront(nil)
            }
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}

final class ToolrollAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated {
            if !flag {
                ToolrollWindowCoordinator.shared.showMainWindow()
            } else {
                sender.activate(ignoringOtherApps: true)
            }
        }
        return true
    }
}

private struct WindowOpenerRegistrar: ViewModifier {
    @Environment(\.openWindow) private var openWindow

    func body(content: Content) -> some View {
        content.onAppear {
            ToolrollWindowCoordinator.shared.openMainWindow = { [openWindow] in
                openWindow(id: ToolrollMacApp.mainWindowId)
            }
        }
    }
}

@main
struct ToolrollMacApp: App {
    static let mainWindowId = "main"
    @NSApplicationDelegateAdaptor(ToolrollAppDelegate.self) private var appDelegate
    @State private var store = WorkbenchStore()

    private func archiveSelectedTask() {
        let picked = store.bulkSelectedRows
        if picked.count > 1 {
            Task { await store.archiveTasks(picked) }
            return
        }
        guard let row = store.selectedRow else { return }
        Task { await store.archiveTask(row) }
    }

    var body: some Scene {
        Window("Toolroll", id: ToolrollMacApp.mainWindowId) {
            MainWorkbenchView(store: store)
                .frame(minWidth: 740, minHeight: 580)
                .modifier(WindowOpenerRegistrar())
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    store.previewServer.stopManagedServer()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1380, height: 860)
        .commands {
            CommandMenu("Work") {
                Button("Show Toolroll Window") {
                    ToolrollWindowCoordinator.shared.showMainWindow()
                }
                .keyboardShortcut("0", modifiers: [.command])

                Button("New Task") {
                    ToolrollWindowCoordinator.shared.showMainWindow()
                    store.isSetupOpen = false
                    store.openNewWorkCanvas()
                }
                .keyboardShortcut("n", modifiers: [.command])

                Button("Add Project…") {
                    store.isAddProjectSheetOpen = true
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])

                Button("Command Palette") {
                    store.isCommandPaletteOpen.toggle()
                }
                .keyboardShortcut("k", modifiers: [.command])

                Divider()

                Button("Canvas") {
                    store.workspaceMode = (store.workspaceMode == .canvas) ? .workbench : .canvas
                }
                .keyboardShortcut("3", modifiers: [.command])

                Button("Toggle Task Terminal") {
                    store.toggleTaskTerminalMode()
                }
                .keyboardShortcut("t", modifiers: [.command])

                Button("Fork Approach…") {
                    if store.selectedRow != nil {
                        store.isForkSheetOpen = true
                    }
                }
                .keyboardShortcut("f", modifiers: [.command, .shift])

                Button("Zen Focus") {
                    store.toggleZenFocus()
                }
                .keyboardShortcut("\\", modifiers: [.command])

                Button("Balanced 2-Pane Layout") {
                    store.setLayoutPreset(sidebar: true, inspector: false)
                }

                Button("Full 3-Pane Multiplexer") {
                    store.setLayoutPreset(sidebar: true, inspector: true)
                }

                Button("Toggle Sidebar") {
                    store.isSidebarVisible.toggle()
                }
                .keyboardShortcut("b", modifiers: [.command])

                Button("Toggle Drawer") {
                    store.isInspectorVisible.toggle()
                }
                .keyboardShortcut("j", modifiers: [.command])

                Button("Back") {
                    Task { await store.goBack() }
                }
                .keyboardShortcut("[", modifiers: [.command])

                Button("Forward") {
                    Task { await store.goForward() }
                }
                .keyboardShortcut("]", modifiers: [.command])

                Button("Previous Task") {
                    Task { await store.selectAdjacentTask(delta: -1) }
                }
                .keyboardShortcut(.upArrow, modifiers: [.command])

                Button("Next Task") {
                    Task { await store.selectAdjacentTask(delta: 1) }
                }
                .keyboardShortcut(.downArrow, modifiers: [.command])

                Divider()

                Button("Toggle Live Terminal") {
                    store.toggleInspector(tab: .terminal)
                }
                .keyboardShortcut("1", modifiers: [.command])

                Button("Toggle Diff Inspector") {
                    store.toggleInspector(tab: .diff)
                }
                .keyboardShortcut("2", modifiers: [.command])

                Button("Toggle Artifact Window") {
                    store.toggleInspector(tab: .artifact)
                }
                .keyboardShortcut("4", modifiers: [.command])

                Button("Toggle Lead Thread") {
                    store.toggleInspector(tab: .lead)
                }
                .keyboardShortcut("l", modifiers: [.command])

                Divider()

                Button("Archive Task") {
                    archiveSelectedTask()
                }
                .keyboardShortcut("a", modifiers: [.command, .control])
                .disabled(store.selectedRow == nil || !store.canArchiveTasks)

                Button("Open Task in Browser") {
                    if let taskId = store.selectedTaskId {
                        store.openTaskInBrowser(taskId: taskId)
                    }
                }
                .keyboardShortcut("o", modifiers: [.command])

                Button("Refresh Workspace") {
                    Task { await store.refreshAll() }
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Connect / Pair Remote Workspace…") {
                    store.isPairSheetOpen = true
                }
                .keyboardShortcut("p", modifiers: [.command, .shift])

                Button("Pair Phone for Push Alerts…") {
                    store.isPhonePairSheetOpen = true
                }
                .keyboardShortcut("m", modifiers: [.command, .shift])

                Button("Appearance & Lead Themes…") {
                    store.isAppearanceSheetOpen = true
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])

                Button("Setup & Agents…") {
                    store.isSetupOpen.toggle()
                }
                .keyboardShortcut(",", modifiers: [.command])
            }
        }

        MenuBarExtra {
            ToolrollMenuBarContent(store: store)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: store.needsCount > 0 ? "square.fill" : "square")
                if store.needsCount > 0 {
                    Text("\(store.needsCount)")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                }
            }
        }
    }
}

private struct ToolrollMenuBarContent: View {
    let store: WorkbenchStore
    @Environment(\.openWindow) private var openWindow

    private func showMain() {
        ToolrollWindowCoordinator.shared.openMainWindow = { [openWindow] in
            openWindow(id: ToolrollMacApp.mainWindowId)
        }
        ToolrollWindowCoordinator.shared.showMainWindow()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(store.activeProfile.displayTitle)
                .font(.system(size: 12, weight: .semibold))
            Text(store.needsCount > 0 ? "\(store.needsCount) task(s) need your approval" : "Inbox clear")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Divider()
            ForEach(store.needsRows.prefix(5)) { row in
                Button("Needs you: \(row.title)") {
                    showMain()
                    Task { await store.selectTask(row.id) }
                }
            }
            if !store.needsRows.isEmpty {
                Divider()
            }
            Button("Open Toolroll") { showMain() }
            Button("Refresh") {
                Task { await store.refreshAll() }
            }
            Divider()
            Button("Quit Toolroll") {
                NSApp.terminate(nil)
            }
        }
        .padding(6)
        .onAppear {
            ToolrollWindowCoordinator.shared.openMainWindow = { [openWindow] in
                openWindow(id: ToolrollMacApp.mainWindowId)
            }
        }
    }
}
