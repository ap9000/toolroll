import AppKit
import SwiftUI
import ToolrollCore

struct TaskRowMenuItems: View {
    let store: WorkbenchStore
    let row: WorkRow

    private var isCancellable: Bool { row.status == .needs || row.status == .queued || row.status == .failed }

    var body: some View {
        if store.bulkSelection.count > 1 && store.bulkSelection.contains(row.id) {
            bulkItems
        } else {
            singleItems
        }
    }

    @ViewBuilder private var bulkItems: some View {
        let rows = store.bulkSelectedRows
        Button("Archive \(rows.count) Tasks") { Task { await store.archiveTasks(rows) } }
            .disabled(!store.canArchiveTasks || rows.isEmpty)
        Button("Clear Selection") { store.bulkSelection = [] }
    }

    @ViewBuilder private var singleItems: some View {
        Button("Open") { Task { await store.selectTask(row.id) } }
        Button("Open in Web View") { store.openTaskInBrowser(taskId: row.id) }
        Divider()
        if store.canArchiveTasks {
            Button(row.status == .running ? "Stop & Archive" : "Archive") {
                Task { await store.archiveTask(row) }
            }
        } else {
            Button("Archive in Web View…") { store.openTaskInBrowser(taskId: row.id) }
        }
        if isCancellable && !store.canArchiveTasks {
            Button("Cancel in Web View…") { store.openTaskInBrowser(taskId: row.id) }
        } else if isCancellable {
            Button("Cancel Task…", role: .destructive) {
                Task { await store.prepareCancel(taskId: row.id, alsoArchive: false) }
            }
            Button("Cancel & Archive…", role: .destructive) {
                Task { await store.prepareCancel(taskId: row.id, alsoArchive: true) }
            }
            .disabled(!store.canArchiveTasks)
        }
        if isCancellable {
            Divider()
            Button("Change Models…") {
                Task { await store.openTaskModelPicker(taskId: row.id) }
            }
        }
        Divider()
        Button("Copy Task ID") { copyToPasteboard(row.id) }
    }
}

struct ArchivedRowMenuItems: View {
    let store: WorkbenchStore
    let row: WorkRow

    var body: some View {
        Button("Open") { Task { await store.selectTask(row.id) } }
        Button("Restore") { Task { await store.restoreTask(taskId: row.id) } }
            .disabled(!store.canArchiveTasks)
        Button("Open in Web View") { store.openTaskInBrowser(taskId: row.id) }
        Divider()
        Button("Copy Task ID") { copyToPasteboard(row.id) }
    }
}

struct CliThreadMenuItems: View {
    let thread: LocalCliThread

    var body: some View {
        Button("Copy Resume Command") { copyToPasteboard(thread.resumeCommand) }
        Button("Copy Session ID") { copyToPasteboard(thread.sessionId) }
        Button("Reveal in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: thread.filePath)])
        }
    }
}

struct NoticeActionButton: View {
    let store: WorkbenchStore
    let notice: WorkbenchNotice

    var body: some View {
        if let action = notice.action {
            Button("Undo") {
                store.notice = nil
                Task { await store.performNoticeAction(action) }
            }
            .buttonStyle(.plain)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ToolrollPalette.ink)
        }
    }
}

struct CancelConfirmation: ViewModifier {
    @Bindable var store: WorkbenchStore

    func body(content: Content) -> some View {
        content.confirmationDialog(
            title,
            isPresented: Binding(get: { store.pendingCancel != nil }, set: { if !$0 { store.pendingCancel = nil } }),
            titleVisibility: .visible,
            presenting: store.pendingCancel
        ) { pending in
            Button(pending.alsoArchive ? "Cancel & Archive" : "Cancel Task", role: .destructive) {
                Task { await store.confirmCancel(pending) }
            }
            Button("Keep Task", role: .cancel) { store.pendingCancel = nil }
        } message: { pending in
            Text(detail(pending))
        }
    }

    private var title: String {
        guard let pending = store.pendingCancel else { return "Cancel task?" }
        return "Cancel \u{201C}\(pending.title)\u{201D}?"
    }

    private func detail(_ pending: PendingCancel) -> String {
        let run = pending.shownRun.map { " Last run #\($0)." } ?? ""
        let state = pending.state.prefix(1).uppercased() + pending.state.dropFirst()
        return "\(state).\(run) This can't be undone."
    }
}

struct ModelPickConfirmation: ViewModifier {
    @Bindable var store: WorkbenchStore

    func body(content: Content) -> some View {
        content.confirmationDialog(
            "Switch to \(store.pendingModelPick?.label ?? "this model")?",
            isPresented: Binding(get: { store.pendingModelPick != nil }, set: { if !$0 { store.pendingModelPick = nil } }),
            titleVisibility: .visible,
            presenting: store.pendingModelPick
        ) { pick in
            Button("From the Next Turn") { Task { await store.applyModelPick(pick, when: "next-run") } }
            Button("Restart Now") { Task { await store.applyModelPick(pick, when: "restart") } }
            Button("Cancel", role: .cancel) { store.pendingModelPick = nil }
        } message: { pick in
            Text("An agent is working on this task. The \(pick.phase == "plan" ? "planner" : "builder") can switch when this run ends, or restart now.")
        }
    }
}

private func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
