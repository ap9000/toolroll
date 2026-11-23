import AppKit
import Foundation
import ToolrollCore

/// Archive, restore and cancel for ANY task (a sidebar row's right-click), not only the open one.
extension WorkbenchStore {
    /// States the server cancels (store.cancelTask applies to queued, failed and running).
    static let cancellableStates: Set<String> = ["queued", "failed", "running"]
    private static let archiveRetryInterval: Duration = .seconds(1)
    private static let archiveRetryLimit = 30
    /// The server's words when archive is refused because a run is still winding down (store.ts archiveTaskFamily
    /// "live"): the one refusal worth retrying after a stop. Every other refusal is shown as it is.
    static let stillWorkingWords = "still has work going on"
    private static let archiveReason = "Archived from the Mac app"

    public var canArchiveTasks: Bool { activeProfile.isDemo || isLocalSession }

    // MARK: Cancel

    /// Reads the task fresh and asks the person to confirm exactly what they're shown.
    public func prepareCancel(taskId: String, alsoArchive: Bool) async {
        guard isFreeForTaskAction() else { return }
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Demo tasks can't be cancelled.")
            return
        }
        guard let client else { return }
        do {
            let steps = try await client.fetchSteps(taskId: taskId)
            // A worker's claim leaves the task "queued" while it builds: the live run is what says it's running, and
            // the server refuses a cancel under it. Say so instead of confirming a cancel that would be refused.
            if steps.liveRun != nil {
                notice = WorkbenchNotice(kind: .info, message: "This task is running right now. Stop it first, or use Stop & Archive.")
                return
            }
            guard let state = steps.task.state, Self.cancellableStates.contains(state) else {
                notice = WorkbenchNotice(kind: .info, message: "This task has already ended, so there's nothing to cancel.")
                return
            }
            pendingCancel = PendingCancel(
                taskId: steps.task.id, title: steps.task.title, state: state,
                shownRun: steps.shownRunForCancel, alsoArchive: alsoArchive
            )
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func confirmCancel(_ pending: PendingCancel) async {
        pendingCancel = nil
        guard let client else { return }
        busyLabel = "Cancelling task…"
        defer { busyLabel = nil }
        do {
            let reply = try await client.cancelTask(taskId: pending.taskId, state: pending.state, runId: pending.shownRun)
            guard pending.alsoArchive else {
                notice = WorkbenchNotice(kind: .info, message: reply)
                await refreshAll()
                return
            }
            let failure = await archiveOne(id: pending.taskId, running: false)
            let row = WorkRow(id: pending.taskId, title: pending.title, status: .finished, word: "Cancelled")
            await finishArchive(archived: failure == nil ? [row] : [], failure: failure, asked: 1)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            await refreshAll()
        }
    }

    // MARK: Models for one task

    /// The steps a task's own model choice covers; review is never per-task.
    static let taskModelPhases = ["plan", "build"]

    /// The read the picker offers choices from: the open task's, or the one fetched for a right-clicked row.
    public func taskStepsForPicker(_ taskId: String) -> StepCardsResponse? {
        for steps in [modelPickerSteps, stepCards].compactMap({ $0 }) where steps.task.id == taskId || steps.task.root == taskId {
            return steps
        }
        return nil
    }

    /// Opens the picker for a row (right-click → Change Models…) with that task's allowed models read fresh.
    public func openTaskModelPicker(taskId: String) async {
        modelChangeError = nil
        modelPickerSteps = try? await client?.fetchSteps(taskId: taskId)
        modelPickerTaskId = taskId
    }

    /// Sets this task's model for one step or both. No password: picking is the yes. While an agent is working the
    /// person chooses when it applies (`pendingModelPick` drives that dialog).
    public func setTaskModel(taskId: String, roleKey: String, value: String, label: String) async {
        guard let client, !activeProfile.isDemo else {
            modelChangeError = "Demo tasks keep their models."
            return
        }
        modelChangeError = nil
        do {
            let steps = try await client.fetchSteps(taskId: taskId)
            guard let digest = steps.scopeDigest else {
                modelChangeError = "This task has no plan to change models on yet."
                return
            }
            if steps.liveRun != nil {
                // One change waits per task, and the builder is what runs next: "all" waits as the build change.
                let phase = roleKey == "all" ? "build" : roleKey
                modelPickerTaskId = nil
                pendingModelPick = ModelPick(taskId: steps.task.id, phase: phase, value: value, label: label, sawDigest: digest)
                return
            }
            busyLabel = "Changing models…"
            defer { busyLabel = nil }
            var sawDigest = digest
            var reply = ""
            for phase in roleKey == "all" ? Self.taskModelPhases : [roleKey] {
                reply = try await client.routeTask(taskId: steps.task.id, phase: phase, agent: value, sawDigest: sawDigest)
                // The first change re-files the scope; the next one is checked against what that change produced.
                sawDigest = (try? await client.fetchSteps(taskId: steps.task.id).scopeDigest ?? sawDigest) ?? sawDigest
            }
            modelPickerTaskId = nil
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            modelChangeError = error.localizedDescription
        }
    }

    /// The running-task choice: "next-run" (the server keeps it until this run ends) or "restart" (stop, apply, rerun).
    public func applyModelPick(_ pick: ModelPick, when: String) async {
        pendingModelPick = nil
        guard let client else { return }
        busyLabel = when == "restart" ? "Restarting on \(pick.label)…" : "Saving the change…"
        defer { busyLabel = nil }
        do {
            let reply = try await client.routeTask(taskId: pick.taskId, phase: pick.phase, agent: pick.value, sawDigest: pick.sawDigest, when: when)
            notice = WorkbenchNotice(kind: .info, message: reply)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
        await refreshAll()
    }

    // MARK: Archive / restore

    /// Archive one task; a running one is stopped first and archived once it has wound down.
    public func archiveTask(_ row: WorkRow) async {
        guard canStartArchive() else { return }
        busyLabel = row.status == .running ? "Stopping before archiving…" : "Archiving…"
        defer { busyLabel = nil }
        let failure = await archiveOne(id: row.id, running: row.status == .running)
        await finishArchive(archived: failure == nil ? [row] : [], failure: failure, asked: 1)
    }

    /// Archive every selected row (running ones are stopped first): one notice, and one Undo restores them all.
    public func archiveTasks(_ rows: [WorkRow]) async {
        guard !rows.isEmpty, canStartArchive() else { return }
        busyLabel = "Archiving \(rows.count) tasks…"
        defer { busyLabel = nil }
        var archived: [WorkRow] = []
        var firstFailure: String?
        for row in rows {
            if let failure = await archiveOne(id: row.id, running: row.status == .running) {
                firstFailure = firstFailure ?? failure
            } else {
                archived.append(row)
            }
        }
        bulkSelection = []
        await finishArchive(archived: archived, failure: firstFailure, asked: rows.count)
    }

    public func restoreTask(taskId: String) async {
        await restoreTasks([taskId])
    }

    public func restoreTasks(_ taskIds: [String]) async {
        guard let client, !taskIds.isEmpty else { return }
        busyLabel = "Restoring…"
        defer { busyLabel = nil }
        var restored = 0
        var failure: String?
        for id in taskIds {
            do {
                _ = try await client.restoreTask(taskId: id)
                restored += 1
            } catch {
                failure = failure ?? error.localizedDescription
            }
        }
        let message = restored == 1 && taskIds.count == 1 ? "Restored." : "Restored \(restored) of \(taskIds.count)."
        notice = WorkbenchNotice(kind: failure == nil ? .info : .refusal, message: failure.map { "\(message) \($0)" } ?? message)
        await refreshAll()
        if taskIds.count == 1, restored == 1 { await selectTask(taskIds[0]) }
    }

    public func performNoticeAction(_ action: NoticeAction) async {
        switch action {
        case .restore(let taskId): await restoreTask(taskId: taskId)
        case .restoreAll(let taskIds): await restoreTasks(taskIds)
        }
    }

    // MARK: Multi-select (⌘-click adds or removes a row, ⇧-click selects a range, a plain click selects one)

    /// The active and visible settled rows in sidebar order: what a ⇧-click range runs over.
    var selectableRows: [WorkRow] { needsRows + runningRows + queuedRows + (isSettledExpanded ? settledRows : []) }

    public var bulkSelectedRows: [WorkRow] { selectableRows.filter { bulkSelection.contains($0.id) } }

    public func handleRowClick(_ row: WorkRow) async {
        let flags = NSEvent.modifierFlags
        let ordered = selectableRows
        guard ordered.contains(where: { $0.id == row.id }) else {
            bulkSelection = []
            await selectTask(row.id)
            return
        }
        if flags.contains(.command) {
            if bulkSelection.isEmpty, let current = selectedTaskId, !isComposingNewWork { bulkSelection.insert(current) }
            if bulkSelection.contains(row.id) { bulkSelection.remove(row.id) } else { bulkSelection.insert(row.id) }
            bulkAnchorId = row.id
            return
        }
        if flags.contains(.shift), let anchor = bulkAnchorId ?? selectedTaskId,
           let from = ordered.firstIndex(where: { $0.id == anchor }), let to = ordered.firstIndex(where: { $0.id == row.id }) {
            bulkSelection = Set(ordered[min(from, to)...max(from, to)].map(\.id))
            return
        }
        bulkSelection = []
        bulkAnchorId = row.id
        await selectTask(row.id)
    }

    // MARK: Archive internals

    private func canStartArchive() -> Bool {
        guard isFreeForTaskAction() else { return false }
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Demo tasks can't be archived.")
            return false
        }
        return client != nil
    }

    /// Archives one task; nil when it worked, else the words to show. After a stop the run takes a few seconds to wind
    /// down and archive refuses until it has, so that one refusal is retried; any other is returned as it is.
    func archiveOne(id: String, running: Bool) async -> String? {
        guard let client else { return "Not connected to Toolroll." }
        // A row's id is its family's root; stop acts on the current version, which the steps read names.
        // A stop that comes back refused (already finished, not live) still leaves the archive to decide.
        if running, let steps = try? await client.fetchSteps(taskId: id), let live = steps.liveRun {
            _ = try? await client.stopTask(taskId: steps.task.id, runId: live)
        }
        for attempt in 1...Self.archiveRetryLimit {
            do {
                _ = try await client.archiveTask(taskId: id, reason: Self.archiveReason)
                return nil
            } catch {
                let words = error.localizedDescription
                guard words.contains(Self.stillWorkingWords) else { return words }
                if attempt < Self.archiveRetryLimit { try? await Task.sleep(for: Self.archiveRetryInterval) }
            }
        }
        return "Stopped. It's still winding down, so archive it again in a moment."
    }

    /// One notice for what was archived (with its Undo) and what wasn't, then the list again.
    func finishArchive(archived: [WorkRow], failure: String?, asked: Int) async {
        await leaveSelectionIfArchived(Set(archived.map(\.id)))
        let ids = archived.map(\.id)
        if ids.isEmpty {
            notice = WorkbenchNotice(kind: .refusal, message: failure ?? "Nothing was archived.")
        } else {
            let done = ids.count == 1 ? "Archived \u{201C}\(archived[0].title)\u{201D}." : "Archived \(ids.count) tasks."
            let rest = failure.map { " \(asked - ids.count) couldn't be: \($0)" } ?? ""
            notice = WorkbenchNotice(kind: .info, message: done + rest,
                                     action: ids.count == 1 ? .restore(taskId: ids[0]) : .restoreAll(taskIds: ids))
        }
        await refreshAll()
    }

    /// One task action at a time: they share the busy label, and a second click mid-stop would race the first.
    private func isFreeForTaskAction() -> Bool {
        guard busyLabel == nil else {
            notice = WorkbenchNotice(kind: .info, message: "Wait for \u{201C}\(busyLabel ?? "the last action")\u{201D} to finish.")
            return false
        }
        return true
    }

    /// Archived tasks leave the list: open the next remaining task in the list (or the new-work screen) instead.
    private func leaveSelectionIfArchived(_ archived: Set<String>) async {
        guard let current = selectedTaskId, archived.contains(current), !isComposingNewWork else { return }
        let ordered = selectableRows
        let remaining = ordered.filter { !archived.contains($0.id) }
        guard let idx = ordered.firstIndex(where: { $0.id == current }), !remaining.isEmpty else {
            openNewWorkCanvas()
            return
        }
        let after = ordered[idx...].first { !archived.contains($0.id) } ?? remaining.last!
        await selectTask(after.id)
    }
}
