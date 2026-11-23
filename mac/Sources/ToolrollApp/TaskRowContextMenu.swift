import AppKit
import SwiftUI
import ToolrollCore

/// Right-click actions on a sidebar task row. Shows only what applies to the row's state.
struct TaskRowMenuItems: View {
    let store: WorkbenchStore
    let row: WorkRow

    /// A running task's claim refuses a cancel (store.cancelTask "claimed"): it gets Stop & Archive instead.
    private var isCancellable: Bool { row.status == .needs || row.status == .queued || row.status == .failed }

    var body: some View {
        if store.bulkSelection.count > 1 && store.bulkSelection.contains(row.id) {
            bulkItems
        } else {
            singleItems
        }
    }

    /// Right-click inside a ⌘/⇧-click selection acts on all of it.
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
            // A remote workspace's archive takes the web view's signed-in session.
            Button("Archive in Web View…") { store.openTaskInBrowser(taskId: row.id) }
        }
        if isCancellable && !store.canArchiveTasks {
            // A remote workspace's cancel takes the web view's signed-in session.
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
            // A run holds the task's route while it works, so a running task keeps its models until it stops.
            Button("Change Models…") {
                store.modelChangeError = nil
                store.modelPickerTaskId = row.id
            }
        }
        Divider()
        Button("Copy Task ID") { copyToPasteboard(row.id) }
    }
}

/// Right-click actions on an archived row: bring it back, or look at it.
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

/// Right-click actions on a discovered Claude/Codex/Gemini CLI thread.
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

/// The "Undo" a notice offers (Archive → restore).
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

/// Confirms a cancel with exactly what will be sent: the task's state and newest run, read just now.
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

private func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
