import AppKit
import SwiftUI
import ToolrollCore

@main
struct ToolrollMacApp: App {
    @State private var store = WorkbenchStore()

    var body: some Scene {
        WindowGroup("Toolroll") {
            MainWorkbenchView(store: store)
                .frame(minWidth: 960, minHeight: 620)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1380, height: 860)
        .commands {
            CommandMenu("Workbench") {
                Button("Command Palette") {
                    store.isCommandPaletteOpen.toggle()
                }
                .keyboardShortcut("k", modifiers: [.command])

                Button("Toggle Inspector") {
                    store.isInspectorVisible.toggle()
                }
                .keyboardShortcut("j", modifiers: [.command])

                Divider()

                Button("Focus Live Terminal") {
                    store.isInspectorVisible = true
                    store.inspectorTab = .terminal
                }
                .keyboardShortcut("1", modifiers: [.command])

                Button("Focus Diff Inspector") {
                    store.isInspectorVisible = true
                    store.inspectorTab = .diff
                }
                .keyboardShortcut("2", modifiers: [.command])

                Button("Focus Lead Thread") {
                    store.isInspectorVisible = true
                    store.inspectorTab = .lead
                }
                .keyboardShortcut("l", modifiers: [.command])

                Divider()

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
            }
        }

        MenuBarExtra {
            VStack(alignment: .leading, spacing: 6) {
                Text(store.activeProfile.displayTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(store.needsCount > 0 ? "\(store.needsCount) task(s) need your approval" : "Inbox clear")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Divider()
                ForEach(store.needsRows.prefix(5)) { row in
                    Button("Needs you: \(row.title)") {
                        NSApp.activate(ignoringOtherApps: true)
                        Task { await store.selectTask(row.id) }
                    }
                }
                if !store.needsRows.isEmpty {
                    Divider()
                }
                Button("Open Toolroll") {
                    NSApp.activate(ignoringOtherApps: true)
                }
                Button("Refresh") {
                    Task { await store.refreshAll() }
                }
                Divider()
                Button("Quit Toolroll") {
                    NSApp.terminate(nil)
                }
            }
            .padding(6)
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
