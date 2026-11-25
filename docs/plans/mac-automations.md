# Automations in the Mac app — native, no browser hop

Owner (2026-11-22): "if I open automations why do we go to the web UI?" and the Work card is "really ugly". Build a
native Automations screen. Decisions already taken (docs/plans/automations-reintegration.md): surfacing existing
automations is Work-screen work under the freeze (AGENTS.md note); shown to anyone with a flow; no new flow behaviour.

## Server

1. **Read: `GET /engine/automations`** (engine contract: ENGINE_RESPONSES, schema in src/contracts/engine-api.ts,
   fixture `test/fixtures/engine-api/automations.json`, schemas.json regenerated, TUI model + fixture map in
   tui/crates/toolroll-api, a wire-budget row with a ceiling). Same facts and access rules as the web `/flows` list
   (src/flows-ui.ts flowListRow / triggerWords / nextWords; projects the caller can see only):
   ```
   { version, canAct: boolean,
     automations: [{ id, name, project, group: "needs"|"running"|"on"|"paused",
                     starts: string,            // triggerWords: "Every weekday at 09:00", "When …", "Cards added by hand"
                     nextAt: string|null, waiting: number, inProgress: number, trouble: string|null,
                     triggers: [{ id, kind, words, state: "active"|"paused", nextAt, lastAt, lastOutcome, failures,
                                  canPress: boolean /* button */, canCheck: boolean /* polled or scheduled */ }] }] }
   ```
2. **Acts from this Mac's own session.** Today `flow.trigger.pause|resume|check|press` (src/server/route-table.ts ~674)
   are not in LOCAL_POSTS, so the local owner is refused. Add one local-owner act `control-automations` (not a
   password act) mapped from exactly those four rows; pin them in src/server/adapter-inventory.test.ts; update
   docs/plans/local-owner-acts.md. The handlers' own rules (EDIT_FLOWS guard, project access, a flow's sealed terms)
   stay as they are — the act only admits the session, it never widens what the handler allows.
   - pause: lowers activity. resume / check / press: cause work under the flow's already-approved terms; nothing
     here approves new terms or edits a flow.
3. Tests: journeys (read shape per group; pause → paused; resume; check; press), attack file (bearer/lead token and
   other acts refused; a project the person can't see is invisible and refused; a removed trigger refused), contract
   fixture, wire budget.

## Mac app

4. Sidebar row **Automations** (under Canvas), always present; a count badge when something waits on you.
5. **Automations screen** (native, same visual system as Work): title + "New automation"; groups Needs you / Running /
   On / Paused; row = trigger-kind icon, name, "starts" words, project · next run, last result or trouble; trailing
   **Pause/Resume** and **Run now** (press or check, whichever the trigger offers); right-click: the same + Copy name.
   Empty state: one sentence and "New automation".
6. **New automation** stays in the app: the Lead panel opens with a starter sentence; the Lead's existing
   `propose_flow` card is approved in chat (existing road, chat parity per AGENTS.md).
7. The Work **Automations** widget becomes a compact native list (up to 3 rows: name, next run, Pause/Run now),
   hidden when there are none; the browser button and the explanatory card go away.

## Out of scope
Editing a flow's stages or triggers, the gallery/kits, insights, removing triggers, webhooks secrets.

---

## Revised after critic review (2026-11-22) — supersedes the sections above where they differ

Scope stays: read + pause, resume, run now; **no new flow capability** (freeze line 2026-11-22). Create/edit/remove,
share, renew, secrets and unattended signing stay on the web.

Server:
1. Export `canCheckTrigger(config)` (script schedule, plane-review, `polled()`) and `canPressTrigger(trigger)` (active
   button) from src/flow-triggers.ts; `checkFlowTriggerNow` and the wire both use them. A plain schedule has NO manual
   run (fires only when due) — `canCheck:false`; we do not add one (that would be new capability).
2. Extract a pure `automationsOf(store, flows, now)` from flowListRow/triggerWords; the HTML row and the JSON route
   both call it. Use `listFlows(consoleProjects())` (same visibility as the web list). Cap flows (100) and
   `lastOutcome` (200 chars). `nextAt` ISO on the wire; relative wording client-side.
3. `GET /engine/automations` → `{ version, canAct, automations[] }`; per trigger `id, kind, words, state, nextAt,
   lastAt, lastOutcome, failures, canPress, canCheck, label|null, questions[]|null, resumeRunsNow` where
   `resumeRunsNow` = paused && nextAt <= now && an active unattended grant covers the flow. `canAct` = approver role
   (false for read bearers). EDGE_LOCAL read mark + adapter-inventory edge list.
4. Acts `trigger-pause`, `trigger-resume`, `trigger-run` (check and press) in LOCAL_OWNER_ACTS (owner-decision
   comment; never reuse pause-run/resume-run); LOCAL_POSTS rows for flow.trigger.pause/resume/check/press only;
   `triggerAct` (src/server/flows.ts) calls `localActNow` for exactly those verbs when who.authority is local-owner;
   resume re-reads the trigger inside `store.transact`. Denied siblings stay denied (share, renew, secret, setup,
   sender, scope, remove, unshare, dropped) — attack test.
5. Contract: schema + ENGINE_RESPONSES, fixtures (incl. every-kind), schemas.json, engine-api.test FIXTURES, TUI
   models.rs + tests/fixtures.rs map + round_trip arm. Not in /work/rows (no wire-ceiling change).
6. Tests: inventory pins; local-owner bypass (denied siblings); a local-owner check of a schedule under a live grant
   does not self-approve (onTime:false); contract round trips.

Mac:
7. Models match the schema exactly (nullables, label, questions, resumeRunsNow). Run now only where `canCheck`
   (button "Start…" with a question sheet is a follow-up; no Run now for buttons yet). Resume confirms "It may run once
   right away" when `resumeRunsNow`. Disable actions in flight. Show the server's `said`/refusal words, never "Done.".
