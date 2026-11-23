# Task row actions: right-click menu, archive/restore, cancel fix (Mac app)

Branch: `feat/native-mac-app-v1`. Decisions taken with the user (2026-11-22):
Stop & Archive on a running task; offer both "Cancel Task…" and "Cancel & Archive…"; multi-select later.

## 1. Bug: Mac cancel is always refused once a task has had a run

`store.cancelTask(seen)` (src/store.ts) compares `seen.run` to `MAX(run.id)` for the task's ref (the
LATEST run). The Mac client sends `stepCards.liveRun` (the LIVE run — nil whenever nothing is running),
so any queued/failed task with a past run is refused "This task changed since it was shown".

Fix:
- `stepCardsOf` (src/engine-reads.ts) adds `latestRun: number | null` = max id over `store.runsFor(ref.id)`
  — the same ref + same MAX the cancel transaction proves against.
- `stepCardsSchema` (src/contracts/engine-api.ts) gains `latestRun: z.number().int().nullable()`; fixtures
  under test/fixtures/engine-api/step-cards-*.json gain the key; schemas.json regenerated
  (ENGINE_WRITE_SCHEMAS=1). Contract digest changes (clients compare it only for display/handshake).
- Swift `StepCardsResponse` decodes `latestRun` (optional; fallback to `cards.flatMap(runs).max()` for an
  older server). `cancelTask` sends `latestRun`.
- Engine test: a queued task with a finished run is cancellable with `state=queued&run=<latestRun>` and
  refused with `run=none`.

## 2. Per-task actions in the store (not just the selected task)

New file `WorkbenchStore+TaskActions.swift` (WorkbenchStore.swift is already 2.7k lines):
- `archiveTask(_ row: WorkRow)` → POST `/t/<id>/archive` (reason "Archived from the Mac app"). On success:
  notice "Archived "<title>"" with an **Undo** action (restore). If the archived task was selected, move
  selection to the adjacent row (or the launchpad when none).
- `restoreTask(id:title:)` → POST `/t/<id>/restore`.
- `stopAndArchiveTask(_ row:)` → fetch steps; if `liveRun` → stop; poll steps every 1s up to 20s until
  `liveRun == nil`; then archive. If it never stops: notice "Stopped, but it's still winding down — archive
  it in a moment." busyLabel shows progress.
- `prepareCancel(_ row:)` → fetch fresh steps for that task, publish a `PendingCancel { taskId, title,
  state, latestRun, alsoArchive }` that the UI confirms. Confirm sends exactly what the dialog showed
  (server's "seen" contract stays honest). `alsoArchive` archives after a successful cancel.
- The existing `cancelSelectedTask` goes through the same `prepareCancel` path (adds a confirm it lacked).
- Remote (non-local) sessions: archive/restore need a password-backed CLI token, so the menu items are
  disabled with a help line ("Archive from the web view on remote workspaces").
- `busyLabel` setter widened from `private(set)` to `internal(set)` so the extension can set it.

`WorkbenchNotice` gains `action: NoticeAction?` (`enum NoticeAction: Equatable { case restore(taskId, title) }`);
both notice bars (TaskCockpitView, NewWorkCanvasView) render an "Undo" button via a shared view.

## 3. Context menu on sidebar rows

New `TaskRowContextMenu.swift`, applied with `.contextMenu { }` to `activeRow` and `settledRow`:
- Open · Open in Web View
- (active rows) Pause/Resume · Retry Build (when `stepCards.retry` and selected) · Stop Active Run (running)
- Archive (⌃⌘A) — becomes "Stop & Archive" on running rows; Restore for archived rows is not needed
  (archived rows are not listed; Undo covers the immediate case)
- Cancel Task… · Cancel & Archive… — only for queued/running/failed (server's cancellable states);
  confirm dialog: "Cancel "<title>"? It's <state>; last run #N." Destructive role.
- Copy Task ID
CLI thread rows: Copy Resume Command · Reveal in Finder · Copy Session ID.

Keyboard: ⌃⌘A archives the selected task (Apple Mail's archive shortcut — Jakob's law). NOT ⌘⌫: it
would steal "delete to line start" from the composer text field.

## 4. Header label
TaskCockpitView's pipeline crumb "Build · claude · ⊖ Cancelled" shows the LAST RUN's state; prefix it
"Run #N" so it doesn't read as the task's state.

## Verification
- `npx vitest run src/contracts/engine-api.test.ts src/server/engine-api.test.ts`
- `swift build` + `swift test` in mac/
- Build the app, right-click a queued task with a past run → Cancel… succeeds; Archive → Undo restores.

## Outcome (as built, after critic review)

- Cancel/stop act on the CURRENT version id from the steps read (a row id is the family root); archive/restore use
  the row id (family-wide).
- Running rows offer Stop & Archive only (a live claim refuses cancel). Stop & Archive retries the archive itself
  while the server says the task "still has work going on" (up to 30s), not on `liveRun`.
- Header label change dropped: the "Cancelled" header was the task's true state. The real bug was the sidebar mapping
  the shared "muted" tone to Queued; rows now map by status token first (`TaskStatusTone(workTone:token:)`).
- Added: a stale-key refusal after a Toolroll restart reconnects the local session and resends once (the key check
  refuses before acting), so the app never asks the person to run `toolroll --web`.
- Added: per-task models. Steps reads carry `models` (routeOfTask legs); right-click "Change Models…" and the task
  screen's model picker set this task's route (`POST /t/<id>/route`), and its pills show the task's models.
- Remote workspaces: Archive opens the web view (the archive route takes a browser session). Viewer accounts can't
  occur on the local session (mintLocalLink signs in the approver owner only).
