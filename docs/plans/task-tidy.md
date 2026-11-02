# Put away old tasks (task tidy) — plan

Status: plan, revision 2, 2026-11-01. Branch `task-tidy` (worktree `so-tidy`) from main `cc65f3b8` (0.9.85).
Codex reviewed revision 1 (NO-GO, 14 findings); revision 2 folds them in (see "Review round 1" at the end).

## Why

About 100 tasks piled up in Needs you on the owner's install: 43 release tasks for versions already published or
replaced by a later attempt, 22 daily "Is the site current? — <date>" runs, 10 "Checks failed on main" notices for old
commits while main is green, weekly routine reports, "Find the cause: …" reports for past failures, and "Ready for
review" items from September. Nothing can take a task out of the lists without cancelling it, and a cancelled task
still shows.

## States

A task keeps its state (`queued`, `running`, `done`, `failed`, `cancelled`). "Archived" is a separate marker, so a put
away task keeps its history, results, ledger, approvals and scope bytes exactly as they were.

- **New table `task_archive`** (v144, new tables only, update-safe):
  `task_ref INTEGER PRIMARY KEY REFERENCES task_ref(id), by TEXT NOT NULL, by_kind TEXT CHECK (by_kind IN ('person','tidy')), rule TEXT, reason TEXT NOT NULL, at TEXT NOT NULL`.
  A row means archived. Putting a task away writes a row for **every version of its family** by the task page's
  own proven lineage (`taskFamilyOf`: same project, each revision bound to its parent's run by its brief), so no
  version can run. Restore deletes those rows. A revision a person files later is not archived, so new work brings
  the family back; an archived earlier version then never counts as "earlier active" or brings its question along.
- **New table `branch_check_run`** (v144): each completed GitHub workflow run (success or failure) pushed to the
  watched branch of the watched repository (`event=push`, head repository = the watched one), keyed by run id,
  written by the "checks failed" trigger's poll (one more `gh api` read of completed runs, recorded only if the
  trigger still watches the same repo and branch after the answer) and by its signed `workflow_run` webhook. This is
  the CI observation rule (c) reads; nothing persisted green runs on main before.
- Every put away and restore appends an action-ledger row (`task archived` / `task restored`, actor
  `operator:<name>` or `tidy`, detail = the reason).

## Where an archived task disappears

The work index (`src/work-index.ts`) computes `archived` per family from its current version. `needs`,
`person_need`, counts, groups, `workStateRows` (cockpit, rail), outcome rows and every existing view exclude archived
rows. A new view **Archived** (`?view=archived`, `task list --view archived`) shows only them. Also filtered: the push
badge (`countInboxScoped`, all branches), `projectPeek`, the evening chat digest, the lead's `list_tasks`, and new
attention notifications for an archived task are not enqueued; putting a task away resolves its open attention
notifications.

## Fail closed: nothing acts on an archived task

| Door | Check |
|---|---|
| Ready list (`Store.listReady`) | `NOT EXISTS task_archive` |
| Dispatch readiness (`taskReadinessBlocker`) | refuses with `archived` |
| Every claim (`acquireLocked`, shared by acquire / acquireIfReady / acquireForCheck) | refuses `archived` |
| Scope approval (`Store.sealScopeApproval`, the one primitive every approval road calls) | refuses `archived` |
| Plan revision apply, requeue/resume | refuse `archived` |
| Release tool | `liveReleaseOf` refuses a put-away task or anchor (deploy, merge, carry); approval is refused |
| Follow-up checks | `checkTarget` refuses (request and run) |
| PR following | `followPullRequests` skips (no automatic revision, merge or ready notice); `mergePullRequest` refuses |
| Flow cards | `workStage` holds the card ("Its task is put away"); `claimStep` runs no step |
| Lead | `leadClaim` refuses; the lead has no archive or restore tool |
| Notifications | `enqueueNotification` drops any notification about a put-away task; putting away resolves open ones |
| Project delete | clears `task_archive` before `task_ref` |

Putting a task away refuses while anything is still going on for any version (a live claim, an unfinished run, a
build Toolroll can't confirm stopped, a stop in progress, a follow-up check asked for and unfinished, a flow step
running for its card, a live release approval naming it, or a release deploy/merge reserved, running or unknown). The
check and the write are one transaction. Accepted residual: a chat message already planned before the put-away commit
may still be sent (planning refuses resolved notifications).

## Automatic tidy rules

Runs in the worker's reconcile pass (`reconcileCommand`, every 5 minutes), at most 25 tasks per pass, newest
evidence first. Idempotent: an archived task is skipped, and a restored task is never put away again by the same
rule (a `task restored` ledger row after the last tidy archive exempts it). Each archive records `by_kind='tidy'`,
the rule and a one-line reason.

**Never**, for every rule, checked on every version of the family: anything still going on (above); an `asked` row
(`task ask`); pending feedback (a live person's `diff_comment` on any run, an undelivered `task_steer`, an open lead
proposal naming the task, an unconsumed `review_request`); a family whose lineage doesn't prove; a task already
Complete. Provenance is per producer: (a) and (c) only take tasks the flow engine filed for that very flow as the
card's automation (or a standing order's immutable `flow_trigger_event.task`); (b) only takes tasks named by a release
journal that match their own gate id and scope candidate. Unknown provenance is never eligible.

- **(a) Old routine runs.** Accepted firings of a `schedule` trigger by the clock: key `slot:` / `script:slot:`, or a
  plane review's `plane:<problem>:<date>` with `on_time=1` (Run now shares the plane key, so it is excluded by
  `on_time`; a schedule's Run now key is `now:`). Grouped by trigger (plane review: by trigger and problem). Every task
  the newest firing touched is kept, whoever filed it; older firings' unfinished, automation-filed tasks are put away.
  Tasks whose firing can't be proven (a card's later stage pointer moved on) are left alone. Reason: "A newer run of “Is the site current?”
  (Nov 1) replaces it."
- **(b) Old releases.** From the release journals in the plane's state folder (`releases/*.json`, written only by
  `toolroll release`; symlinks and unreadable files are skipped). A task named by a journal is put away when
  - its journal is published ("Release 0.9.84 is published"), or
  - only superseded journals name it ("A newer attempt of release 0.9.84 replaced it"), or
  - its version is older than the newest published version ("Release 0.9.85 is already published").

  "Newest published" is per package (journal `github` + `packageName`). Never: a task named by a current journal
  that is not stopped and not done (running or waiting for approval), a stopped release at or above the newest
  published version (the person may resume it), or a task some journal names inconsistently. One unreadable,
  symlinked or malformed journal turns the whole release rule off for that pass. A release task no journal names
  is left alone.
- **(c) Resolved CI notices.** Tasks from a `github` trigger watching checks (event key `checks:<sha>`, one card per
  commit). The workflows that failed on that commit are the one its title names plus every failure `branch_check_run`
  saw on that sha. The notice is put away only when, for **each** of them, either a run of that workflow on a
  different commit, created after the failure, passed ("“CI” passed on main at 1a2b3c4"), or a newer notice from the
  same trigger carries that workflow's failure ("a newer “CI” failure on main replaces it"). So the newest notice of a
  still-red workflow stays. No observation means the notice stays.

## Put away by hand (console and CLI, same rules and words)

- **Put away** one task: a row action on Needs you / Tasks and an item in the task page's More menu. Approver,
  cookie session, CSRF; no password (it is reversible). CLI `toolroll task archive <id...> [--reason <text>]`,
  credentialed like `task stop`.
- **Restore**: on a task in the Archived view and on an archived task's page. Approver, CSRF. CLI
  `toolroll task restore <id...>`.
- **Put away old tasks** (bulk): `GET /work/put-away?days=14` is a read-only preview (no writes, GET-quiet): each
  candidate family (one row per family, with how many versions go with it) and why it qualifies, grouped **Old
  releases**, **Old routine runs**, **Resolved CI notices**, **Finished more than N days ago** (done, failed or
  stopped, untouched for N days, not Complete; this group may include tasks a person filed, because putting them away
  here is the person's explicit act). Each row is a ticked checkbox. The page carries the preview digest = sha256 of
  the canonical list of `[task, every version's task_ref, project, rule, reason]` plus `days`, and
  says "or run: `toolroll task tidy --apply --digest <d>`". `POST /work/put-away`: approver, step-up (password, or
  Passwordless per the settings kit's step-up contract), CSRF, cookie only. The server recomputes the preview with
  the same `days`; a different digest refuses ("The list changed since you looked. Check it again."); a ticked id
  outside the previewed set refuses; then it re-checks every task inside one transaction and puts away exactly the
  ticked set, each family only if its versions are still exactly the ones shown.
- CLI: `toolroll task tidy --preview [--days N] [--json]` prints the same groups and the exact next command; read-only,
  no credential. `toolroll task tidy --apply --digest <d> [--days N] [--keep <id,...>]` is credentialed and
  person-only; a stale digest refuses with the fresh preview.
- `toolroll task list --view archived` and the console's **Archived** tab.

## Who may

Putting away and restoring are a person's acts. The CLI verbs refuse a lead token, `TOOLROLL_LEAD_TOKEN` and remote
API tokens (`person-only`; rows are `step-up` in the remote policy). The console routes are cookie-only. The lead gets
one read-only tool, `tidy_preview`, which answers what tidy would put away; it cannot archive.

## Words

"Put away", "Archived", "Restore", "Put away old tasks". The task page shows "Archived by tidy: <reason>" or
"Archived by alex: <reason>" with the time, and the Restore action.

## Tests

- Rules: one table per rule, with each never-case (live attempt, asked, pending feedback, person-filed, Run now,
  newest kept, Complete, in-flight release, stopped current release, journal-less release, red main keeps newest).
  Idempotence, the per-pass bound, restore exemption.
- Gates: an archived task is not in `listReady`, `taskReadinessBlocker` refuses, `acquire`/`acquireIfReady` refuse,
  `sealScopeApproval` refuses (so `approve` refuses), restore makes it claimable again.
- Ceremony (HTTP): stale digest refused, ticked id outside the set refused, viewer refused, bad CSRF refused, bearer
  refused, wrong password refused, GET preview writes nothing (get-quiet sample), success puts away exactly the
  ticked set.
- CLI contract rows for `task archive`, `task restore`, `task tidy`; envelope snapshot; lead token refused.
- Migration v144 test in the existing pattern; `UPDATE_SAFE_MIGRATIONS` gains 144.
- Guards: fake-pid, password-freshness (new `authenticateApprover` pins), ci-workflow, CLI contract.
- One scripted journey step: Needs you → Put away old tasks → preview → confirm → gone; Archived → Restore.

## Review round 1 (Codex, plan revision 1: NO-GO, 14 findings) — how revision 2 answers

1. Release doors: `liveReleaseOf` refuses put-away tasks and anchors (deploy, merge, carry); putting away refuses
   while a live release approval names the task or a release operation is reserved/running/unknown.
2. Follow-up checks and PR automation: `checkTarget` refuses; `followPullRequests` skips; `mergePullRequest` refuses;
   an unfinished follow-up check counts as live.
3. Flow cards: the card holds while its task is put away; no step is claimed; a running step counts as live.
4. Release journals: any unreadable/symlinked/malformed journal turns the rule off; identity checked against the
   gate id and the scope's candidate; newest published per package; operations checked independently.
5. Lineage: the task page's proven `taskFamilyOf`; broken families are never tidied; every member is checked.
6. Digest binds each family's versions, project, rule and reason; apply re-proves membership per family in the
   same transaction.
7. Firing origin: plane keys need `on_time=1`; skipped/held firings are excluded; everything the newest firing touched
   is kept.
8. Linkage: only `flow_trigger_event.task`, or the card's current pointers proven by `filed_via` and filer kind;
   anything else stays.
9. Provenance is per producer (above).
10–11. CI: per-run observations (success and failure, push events on the watched repo and branch, poll re-validated
   after I/O, signed webhook too); a multi-workflow notice needs every failed workflow settled.
12. Archived versions don't count as earlier-active or carry questions; the task page still finds archived tasks.
13. Nudges: every notification about a put-away task is dropped at enqueue; `leadClaim` refuses. Residual: chat parts
   planned before the commit.
14. Project delete clears `task_archive`; ceremony tests cover ceilings, Passwordless, duplicate fields, empty
   selection and rollback.
