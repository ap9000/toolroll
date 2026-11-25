import AppKit
import Foundation
import ToolrollCore

extension WorkbenchStore {
    static let cancellableStates: Set<String> = ["queued", "failed", "running"]
    private static let archiveRetryInterval: Duration = .seconds(1)
    private static let archiveRetryLimit = 30
    static let stillWorkingWords = "still has work going on"
    private static let archiveReason = "Archived from the Mac app"

    public var canArchiveTasks: Bool { activeProfile.isDemo || isLocalSession }

    public func prepareCancel(taskId: String, alsoArchive: Bool) async {
        guard isFreeForTaskAction() else { return }
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Demo tasks can't be cancelled.")
            return
        }
        guard let client else { return }
        do {
            let steps = try await client.fetchSteps(taskId: taskId)
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

    static let taskModelPhases = ["plan", "build"]

    public func taskStepsForPicker(_ taskId: String) -> StepCardsResponse? {
        for steps in [modelPickerSteps, stepCards].compactMap({ $0 }) where (steps.task.id == taskId || steps.task.root == taskId) && steps.agentChoices != nil {
            return steps
        }
        return nil
    }

    public func loadPickerChoices(taskId: String) async {
        guard taskStepsForPicker(taskId)?.agentChoices == nil else { return }
        modelPickerSteps = try? await client?.fetchSteps(taskId: taskId, withChoices: true)
    }

    public func openTaskModelPicker(taskId: String) async {
        modelChangeError = nil
        modelPickerSteps = try? await client?.fetchSteps(taskId: taskId, withChoices: true)
        modelPickerTaskId = taskId
    }

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
                sawDigest = (try? await client.fetchSteps(taskId: steps.task.id).scopeDigest ?? sawDigest) ?? sawDigest
            }
            modelPickerTaskId = nil
            notice = WorkbenchNotice(kind: .info, message: reply)
            await refreshAll()
        } catch {
            modelChangeError = error.localizedDescription
        }
    }

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

    public func archiveTask(_ row: WorkRow) async {
        guard canStartArchive() else { return }
        busyLabel = row.status == .running ? "Stopping before archiving…" : "Archiving…"
        defer { busyLabel = nil }
        let failure = await archiveOne(id: row.id, running: row.status == .running)
        await finishArchive(archived: failure == nil ? [row] : [], failure: failure, asked: 1)
    }

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

    private func canStartArchive() -> Bool {
        guard isFreeForTaskAction() else { return false }
        if activeProfile.isDemo {
            notice = WorkbenchNotice(kind: .info, message: "Demo tasks can't be archived.")
            return false
        }
        return client != nil
    }

    func archiveOne(id: String, running: Bool) async -> String? {
        guard let client else { return "Not connected to Toolroll." }
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

    private func isFreeForTaskAction() -> Bool {
        guard busyLabel == nil else {
            notice = WorkbenchNotice(kind: .info, message: "Wait for \u{201C}\(busyLabel ?? "the last action")\u{201D} to finish.")
            return false
        }
        return true
    }

    private func leaveSelectionIfArchived(_ archived: Set<String>) async {
        guard let current = selectedTaskId, archived.contains(current), !isComposingNewWork else { return }
        let ordered = selectableRows
        let remaining = ordered.filter { !archived.contains($0.id) }
        guard let idx = ordered.firstIndex(where: { $0.id == current }), !remaining.isEmpty else {
            openWorkHome()
            return
        }
        let after = ordered[idx...].first { !archived.contains($0.id) } ?? remaining.last!
        await selectTask(after.id)
    }

    public func automationAct(_ automation: Automation, trigger: AutomationTrigger, act: String) async {
        guard let client, !activeProfile.isDemo else { return }
        guard busyLabel == nil else { return }
        busyLabel = act == "pause" ? "Pausing…" : act == "resume" ? "Resuming…" : "Starting…"
        defer { busyLabel = nil }
        do {
            let reply = try await client.automationTrigger(flowId: automation.id, triggerId: trigger.id, act: act)
            let ours = "\(automation.name): \(act == "pause" ? "paused" : act == "resume" ? "resumed" : "checked now")."
            notice = WorkbenchNotice(kind: .info, message: reply == "Done." || reply.isEmpty ? ours : reply)
        } catch {
            notice = WorkbenchNotice(kind: .refusal, message: error.localizedDescription)
        }
        automations = try? await client.fetchAutomations()
    }

    public func toggleAutomation(_ automation: Automation) async {
        let act = automation.isPaused ? "resume" : "pause"
        for trigger in automation.triggers where trigger.isPaused == (act == "resume") {
            await automationAct(automation, trigger: trigger, act: act)
        }
    }

    public func runAutomationNow(_ automation: Automation) async {
        guard let trigger = automation.runNowTrigger else { return }
        await automationAct(automation, trigger: trigger, act: "check")
    }
}
