# Mac app QA: end-to-end requirements

Scope: the native Mac app's task management (sidebar, right-click actions, cancel, archive, models, password memory,
restart recovery). Each requirement names what "working" means and the level that proves it.

Levels:
- **C, contract**: the real server in-process (`test/local-owner-world.ts`), driven exactly as `ToolrollClient` drives
  it (same paths, form fields, headers). Catches app/server disagreements, the class behind the stale-cancel and
  cancelled-as-queued bugs.
- **S, Swift client**: `ToolrollClient` / models against canned answers (URLProtocol stub). Catches request shape,
  decoding and retry logic.
- **U, UI smoke**: the running app through macOS Accessibility (System Events), read-only on real data: open menus and
  dialogs, read them, dismiss. Never confirm an irreversible act on the person's real tasks.

## Sidebar

| # | Requirement | Level |
|---|---|---|
| SB1 | Every row lands in the right section: needs-you → Needs you; building → Running; queued, retrying, on hold → Queued; cancelled, done → Settled; failed → Settled (failed). For every status token/tone the server can send. | C + S |
| SB2 | Archived tasks are absent from the default list and present in `?view=archived`; Settled → Archived lists them. | C + U |
| SB3 | Each row is reachable and named for Accessibility (VoiceOver reads the task title). | U |

## Right-click menu

| # | Requirement | Level |
|---|---|---|
| RM1 | A task row has a context menu; items match its state (running: Stop & Archive, no Cancel; queued/failed/needs: Archive, Cancel…, Cancel & Archive…, Change Models…; all: Open, Open in Web View, Copy Task ID). | U |
| RM2 | An archived row offers Open, Restore, Open in Web View, Copy Task ID. | U |
| RM3 | A ⌘/⇧-click selection of 2+ rows offers "Archive N Tasks" and Clear Selection. | U |
| RM4 | A CLI thread row offers Copy Resume Command, Copy Session ID, Reveal in Finder. | U |

## Cancel

| # | Requirement | Level |
|---|---|---|
| CA1 | A queued task with a past run is cancellable with exactly what the steps read shows (`state`, `latestRun`). | C |
| CA2 | A revised task (family with 2+ versions): the cancel names the CURRENT version id from the steps read; the row's root id is refused or wrong. | C |
| CA3 | A running task's cancel is refused (claimed) with plain words, never a silent no-op. | C |
| CA4 | An already-cancelled task: the app says it has ended; no 409 "changed" banner. | C + S |
| CA5 | The confirm dialog names the task, its state and last run; "Keep Task" dismisses without acting. | U |

## Archive / restore

| # | Requirement | Level |
|---|---|---|
| AR1 | Archive (form `reason`, `return`) removes the task from the default list; restore brings it back. | C |
| AR2 | Archive of a task with work going on is refused with words containing "still has work going on" (the app retries only on that phrase). | C |
| AR3 | Stop & Archive: stop, then the archive succeeds once the run winds down. | C |
| AR4 | Bulk archive of N: each archived; one Undo restores all. | C + S |

## Models per task

| # | Requirement | Level |
|---|---|---|
| MO1 | `POST /t/<current>/route` with `phase` + `agent=provider|model` changes that step; the steps read's `models` shows it with `chosen: "override"`. | C |
| MO2 | Workspace defaults are unchanged by a per-task change. | C |
| MO3 | A route change on an approved task marks the approval out of date (the task asks for approval again). | C |
| MO4 | A route change while a run holds the task is refused with words. | C |

## Restart and session

| # | Requirement | Level |
|---|---|---|
| RS1 | After a console restart, a form act with the old key is refused with words the app recognizes (`staleSessionWords`), before anything changes. | C |
| RS2 | The client reconnects and resends once; a second stale refusal is shown, not looped. | S |

## Password memory

| # | Requirement | Level |
|---|---|---|
| PW1 | Remembered only for the chosen window; "Every time" remembers nothing. | S |
| PW2 | Never recalled for a different account/origin; a workspace switch clears it. | S |
| PW3 | Settings shows "Remember password for" with the five choices. | U |

## Exit criteria

Every C and S requirement has a passing test or a filed finding with evidence. Every U requirement is observed (menu
items read back from Accessibility) or marked "not observable" with the reason. Findings list: severity, repro, the
requirement it breaks.
