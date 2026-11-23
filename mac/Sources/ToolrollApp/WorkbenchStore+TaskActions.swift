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
            await archiveRetryingWhileWinding(taskId: pending.taskId, title: pending.title)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            await refreshAll()
        }
    }

    // MARK: Models for one task

    /// The steps a task's own model choice covers ("all" sets each).
    static let taskModelPhases = ["plan", "build", "review"]

    /// Sets the model for one step (or every step) of this task only. Leaves the picker open with the server's words
    /// when it refuses (a run holding the task, a model that can't do that step).
    public func setTaskModel(taskId: String, roleKey: String, value: String, label: String) async {
        guard let client, !activeProfile.isDemo else {
            modelChangeError = "Demo tasks keep their models."
            return
        }
        modelChangeError = nil
        busyLabel = "Changing models…"
        defer { busyLabel = nil }
        do {
            // A row's id is its family's root; the route belongs to the current version.
            let current = try await client.fetchSteps(taskId: taskId).task.id
            let phases = roleKey == "all" ? Self.taskModelPhases : [roleKey]
            var reply = ""
            for phase in phases {
                reply = try await client.routeTask(taskId: current, phase: phase, agent: value)
            }
            modelPickerTaskId = nil
            notice = WorkbenchNotice(kind: .info, message: "\(label) for this task. \(reply)")
            await refreshAll()
        } catch {
            modelChangeError = error.localizedDescription
        }
    }

    // MARK: Archive / restore

    /// Archive; on a running task, stop its run first and archive once it has wound down.
    public func archiveTask(_ row: WorkRow) async {
        guard isFreeForTaskAction() else { return }
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Demo tasks can't be archived.")
            return
        }
        guard let client else { return }
        if row.status == .running {
            busyLabel = "Stopping before archiving…"
            defer { busyLabel = nil }
            // A row's id is its family's root; stop acts on the current version, which the steps read names.
            // A stop that comes back refused (already finished, not live) still leaves the archive to decide.
            if let steps = try? await client.fetchSteps(taskId: row.id), let live = steps.liveRun {
                _ = try? await client.stopTask(taskId: steps.task.id, runId: live)
            }
            await archiveRetryingWhileWinding(taskId: row.id, title: row.title)
            return
        }
        busyLabel = "Archiving…"
        defer { busyLabel = nil }
        await archiveNow(taskId: row.id, title: row.title)
    }

    public func restoreTask(taskId: String) async {
        guard let client else { return }
        busyLabel = "Restoring…"
        defer { busyLabel = nil }
        do {
            _ = try await client.restoreTask(taskId: taskId)
            notice = WorkbenchNotice(kind: .info, message: "Restored.")
            await refreshAll()
            await selectTask(taskId)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
    }

    public func performNoticeAction(_ action: NoticeAction) async {
        switch action {
        case .restore(let taskId): await restoreTask(taskId: taskId)
        }
    }

    /// After a stop the run takes a few seconds to wind down, and archive refuses until it has: retry only that refusal.
    private func archiveRetryingWhileWinding(taskId: String, title: String) async {
        guard let client else { return }
        for attempt in 1...Self.archiveRetryLimit {
            do {
                _ = try await client.archiveTask(taskId: taskId, reason: Self.archiveReason)
                await didArchive(taskId: taskId, title: title)
                return
            } catch {
                let words = error.localizedDescription
                guard words.contains(Self.stillWorkingWords) else {
                    notice = WorkbenchNotice(kind: .refusal, message: words)
                    await refreshAll()
                    return
                }
                if attempt < Self.archiveRetryLimit { try? await Task.sleep(for: Self.archiveRetryInterval) }
            }
        }
        notice = WorkbenchNotice(kind: .info, message: "Stopped. It's still winding down, so archive it again in a moment.")
        await refreshAll()
    }

    private func archiveNow(taskId: String, title: String) async {
        guard let client else { return }
        do {
            _ = try await client.archiveTask(taskId: taskId, reason: Self.archiveReason)
            await didArchive(taskId: taskId, title: title)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
            await refreshAll()
        }
    }

    private func didArchive(taskId: String, title: String) async {
        await leaveTaskIfSelected(taskId)
        notice = WorkbenchNotice(kind: .info, message: "Archived \u{201C}\(title)\u{201D}.", action: .restore(taskId: taskId))
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

    /// An archived task leaves the list: open the next task in the list (or the new-work screen) instead.
    private func leaveTaskIfSelected(_ taskId: String) async {
        guard selectedTaskId == taskId, !isComposingNewWork else { return }
        let ordered = needsRows + runningRows + queuedRows + (isSettledExpanded ? settledRows : [])
        let remaining = ordered.filter { $0.id != taskId }
        guard let idx = ordered.firstIndex(where: { $0.id == taskId }), !remaining.isEmpty else {
            openNewWorkCanvas()
            return
        }
        await selectTask(remaining[min(idx, remaining.count - 1)].id)
    }
}
