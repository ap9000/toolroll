# Change Models from the Mac app: no password, the pick is the yes, next turn or restart

Owner decisions (2026-11-22): no password for a per-task model change; on an approved task, picking the model counts
as the owner's yes to the new agent (no second approval); on a running task the app asks "next turn" or "restart now".

Today (QA, docs/plans/mac-app-qa.md MO1–MO4): `POST /t/<id>/route` from the Mac's local-owner session is refused
before the handler ("Sign in with your password to do this", route-table.ts has no LOCAL_POSTS entry for
`task.act.route`); on a password session an approved task's change stales the approval; a live claim refuses.

## Server

1. `src/local-owner.ts`: new act `"change-agents"` in LOCAL_OWNER_ACTS (not a LOCAL_PASSWORD_ACT).
2. `src/server/route-table.ts` LOCAL_POSTS: `"task.act.route": "change-agents"`.
3. `src/server/tasks.ts` route handler, local-owner road only (`who` is the local owner, act `change-agents`):
   - Accept only `phase` ∈ {plan, build} + `agent` — no size/risky/clear edits on this road (refuse 400 in words).
   - In ONE `store.transact`: `editTaskRoute(...)`; if `edited.staled`, `approve(store, taskId, who.name, now,
     refiledScope.digest, "")` under the local-owner method. If approve refuses, throw to roll back the edit and answer
     the refusal in words (nothing changes).
   - `src/scope.ts approve()`: the local-owner branch accepts `local.act === "change-agents"` as well as
     "approve-plan", ONLY when called from this road (pass an explicit `carriedBy: "agent-change"` marker the road sets;
     a direct approve POST under change-agents stays refused). Every other approve rule still applies (eligibility,
     protected work / second approver, repo access, policy).
   - The route_change / scope author record names the person and the old → new agent.
   - Configured-agent rule unchanged (editTaskRoute still refuses an agent not configured for the role).
4. Live claim: unchanged on the server (still refused under a live claim). The app handles "next turn"/"restart".

## App

5. Picker in task mode: list only agents configured for the role. Source: a new `choices` field per phase on the steps
   read (`models[].choices: [{provider, model}]`, from agentconfig `agentChoicesFor`) or an existing endpoint — pick
   whichever already exists. "All roles" = plan + build (review isn't per-task).
6. Running task (steps.liveRun != nil): after the pick, a dialog "Use <model> from the next turn" (default) / "Restart
   now".
   - Next turn: save `{taskId, phases, agent}` as a pending change (UserDefaults, survives relaunch); the task screen
     says "Switches to <model> when this run ends". On each refresh, a pending task with `liveRun == nil` gets the route
     POST; cleared on success or on a refusal other than live-claim (shown). Race: a retry that claims first just
     defers it one more run.
   - Restart now: stop the live run; retry the route POST while refused for the live claim (1s, ≤30s, same pattern
     as Stop & Archive); then, when the steps read offers `retry`, POST the retry so it runs again on the new model.
7. No password prompt anywhere on this road.

## Tests
- Server (src/server/mac-app-journeys.test.ts): MO1 via the local-owner session succeeds; MO3 approved task stays
  approved with the new agent sealed; a refused approve rolls back the edit; size/clear edits on the local road are
  refused; a direct approve POST using change-agents is still refused; MO4 live claim refusal words.
- Swift: pending-change persistence and apply-on-idle; picker choices filtering.

## Safety self-review (AGENTS.md)
- Check and write together: edit + approve in one transaction; the digest approved is the one this transaction filed.
- Never widen implicitly: only the agent for plan/build, only configured agents; size, risk, scope, network, grants
  untouched. The owner's explicit pick is the confirmed step; it is logged with old and new agent.
- Approvals mean yes to exactly this: the re-seal covers exactly the refiled digest the person's pick produced, by that
  person, on this computer's owner session; protected-work/second-approver rules still apply.

---

## Revised after critic review (2026-11-22) — this section supersedes the sections above where they differ

Owner decisions added: the SERVER keeps a pending change for a running task; a planner change on an approved task
with a drafted plan re-plans and then asks for approval of the new plan (build changes need none).

### API (the contract both halves build to)

`GET /t/<id>/steps` gains:
- `scopeDigest: string | null` — the current scope digest (what the app sends back as `sawDigest`).
- `agentChoices: { plan: {provider, model}[], build: {provider, model}[] } | null` — from `agentChoicesFor`, selectable
  only, the same function the writer proves against. Review is never per-task.
- `pendingAgentChange: { phase, provider, model, when: "next-run" | "restart", by, at, problem: string | null } | null`.

`POST /t/<current id>/route`, local-owner road (`who.via === "cookie" && who.authority === "local-owner"`, act
`change-task-agents`): fields `phase` (plan|build only), `agent` (`provider|model`), `sawDigest` (required, non-empty),
`when` (`now` default | `next-run` | `restart`). Any other route field on this road → 400 in words. Password sessions
keep today's behavior unchanged.
- No live claim: apply now (below). `when` is ignored.
- Live claim + `next-run`: store the pending change; words "Switches to <model> when this run ends."
- Live claim + `restart`: request the live run's stop (existing requestRunStop) and store the pending change with
  restart; words "Stopping the run; it starts again on <model>."
- Live claim + `now`: 409, words exactly "This task is running right now." (constant, pinned by a test).

Apply (now, or at claim release for a pending change), one transaction, writer `localOwnerChangeAgents` in
src/local-owner-acts.ts (standard `{ok:false,status,message}` shape):
1. `localActNow(store, "change-task-agents")` (at release: the stored owner + a recorded act, not a live request),
   project access, scope digest === sawDigest else refuse "The plan changed since you picked — pick again.".
2. `editTaskRoute` (configured agents only, expectDigest: sawDigest).
3. If the task was approved at sawDigest and the edit staled it:
   - if `replanned` → leave unapproved (owner decision: the new plan needs their yes); words say so.
   - else compare sealed vs refiled route/profile: only the picked phase (plus the repair twin of build) may differ;
     network, permissions, chain, billing identical (reuse route-change.ts / routeChangeWords logic). If anything else
     differs → leave unapproved with words "Your model setup changed since you approved — approve again.".
   - else `approve()` under the local-owner proof via a predicate in approve()'s local branch modeled on `laptopShip`
     (act === change-task-agents, chat/fastStart undefined, approved at the pre-edit digest). Any non-ok → sentinel
     throw → rollback; return its words.
4. `recordScopeAuthor` AFTER approve; an `action_ledger` entry (person, phase, old → new agent, sealed digest, act).
- Pending apply at claim release: run the same writer as the stored person; on refusal keep the pending row with
  `problem` set (visible in the steps read). For `restart`: after a successful apply, lift the stop hold so the task
  dispatches again; on refusal leave the stop hold and the problem visible.
- Pending row: new table (migration) keyed by task ref, one row; cleared on apply success, task cancel/archive, or a
  newer pick (replace).

Tests (src/server/mac-app-journeys.test.ts flips MO1–MO4; plus test/attacks/ entry): local road succeeds without a
password; approved task stays approved with only the picked agent sealed; config drift → unapproved + words; stale or
absent sawDigest refused; planner change with drafted plan → re-plan, unapproved; bearer/lead token can't use the road;
another local act can't; rollback undoes edit + author on approve refusal; next-run applies at release; restart stops,
applies, dispatches again; a refused pending apply leaves `problem`; adapter-inventory.test.ts pin updated.
