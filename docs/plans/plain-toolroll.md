# Plain Toolroll — plan

Status: **v2** (2026-11-05). Branch `plain-toolroll`, rebased on main f98078fb (0.9.92). Nothing in `src/` changes with
this document.

Inputs: the UI and CLI copy audit (109 findings, file:line) and the comparison with Conductor, Orca and Paperclip, both
from 2026-11-05. Finding numbers (`#N`) are the audit's. Line numbers were spot-checked here and may drift by one or two.

Review history:
- Codex round 1 (on v1, 8b6d673): NO-GO, with 1 Critical, 9 High and 3 Medium findings. Each was checked against the
  code and all are accepted. v2 closes them; the ledger is at the end.
- Round 2 is the last round for this arc (budget: 2). Anything still open after it goes to Alex with options.

## What and why

Toolroll asks people things only the machine can know. It speaks its own internals ("scope", "digest", "sealed",
"witness"), offers about 11 verbs on a result, and spreads one job across ten list pages. The competitors are simpler
in four ways that matter: one noun, prompt-first starts, one readiness list and one-line phone pings. Toolroll stays
ahead on approvals, evidence and unattended safety, and this arc keeps all of that.

The arc has two phases:
- **Phase 1 changes presentation only.** No act gains or loses authority. It ships first and fixes most of what people
  see.
- **Phase 2 changes authority.** Each slice ships alone and carries its own safety acceptance criteria and attack
  tests.

Alex's decisions (final):

1. **Toolroll fixes its own state before asking.** It settles its own runs, reruns checks, retries, collects evidence
   and restarts its own builder service. Needs you holds only real decisions; everything else is a plain
   "Waiting: Toolroll is …" line. Never ask a person to vouch for machine facts.
2. **One vocabulary.** "Plan", never "scope", wherever a person reads it. No digests, "signs", "sealed" or "binds" on
   approvals. One word each for builder, approver, finishing a result, archiving and numbering.
3. **Fewer choices.** Results: Accept / Send back / Retry. Approvals: Approve / Request changes / Reject, with a password
   field only when the act needs one. One `toolroll release <branch>`. Routing changes ask as little as possible.
4. **Fast path.** Small tasks a person is watching skip plan approval and build straight away. Plan approval stays for
   large or risky work, flows, schedules, anything unattended, protected paths, and release or merge.
5. **Pages.** Keep Home and Tasks (with a Board view), and retire the rest with redirects.
6. **From the comparison.** One-line pings with one button; a "Can I merge?" checklist; start from a GitHub issue or PR;
   keyboard shortcuts.

Defaults Alex kept:
- The fast path is on for single-approver installs and off on shared servers.
- The fast path's small caps are 3 files and 150 changed lines.
- `/tasks` is the page.

Out of scope: the "Confirm it stopped" removal. It is being built on branch `auto-stop-proof` (auto-settle of
`unprovable` runs; teardown-then-settle of `unknown` ones; deletion of `NEEDS["confirm-stopped"]` and
`["check-stopped"]`, the `ConfirmStopped*` forms and `POST /t/:id/confirm-stopped` as a person act). This plan builds on
it and does not repeat it.

## The words

| Say | Never say in product copy |
|---|---|
| **plan** | scope, contract, terms (as a noun for the plan) |
| **Approved by Alex · 2:14 pm** | signs, signed, sealed, seal, binds, digest, version hex |
| **builder** | worker, runner, computer (as a role), watch, daemon, background service |
| **approver** (says yes to work), **owner** (runs this Toolroll) | operator, instance operator, admin |
| **Accept** (finishing a result) | Complete, mark complete, Accept and finish |
| **Send back** (a result), **Request changes** (a plan) | Revise, Draft a repair task, re-file |
| **Archive** | put away, tidy |
| **build #N** | run #N, attempt #N, result #N |
| **your lead** | coordinator, mate |
| **research** | scout, scouting |
| **requirement** | criterion, evidence, proof, verdict, caveat |
| **Waiting: Toolroll is …** | reconcile, requeue, claim, lease, custody, incident, plane, fence, attested, receipt, regate, carried, incarnation, admission, quiescence, witness |

**Product copy** is the text Toolroll writes. **Preserved content** is everything a person, an agent or an outside
source wrote: goals, requirements, notes, agent reports, issue text, commit messages, and the exact terms a consent
shows. Preserved content is never rewritten to satisfy the word list. That includes approval terms: a person consents
to exactly what was filed (AGENTS.md: keep full approval terms visible before consent). Code, the database, `--json`,
the agent contract (`docs/agents.md`, `audience: "agent"` rows in `src/surface.ts`) and the audit page's hash detail
keep their own words.

## Every slice carries

- **Tests:** the slice's focused rule tests and its rows in the product-copy vocabulary test (P1.1). Per AGENTS.md
  "Lean verification", there are no per-string wording tests: the vocabulary test is one rule table, the same kind of
  contract as `BANNED_WORDS`.
- **Journeys:** one scripted journey at desktop (1280×800) and one at phone (390×844), covering the slice's empty,
  long-content and failure states. Screenshots go in `evidence/` and are never committed.
- **Parity:** the same act and the same words in the console, the CLI, the TUI and chat (lead chat and the chat apps),
  or a named gap.
- **Fix rounds** run only the affected tests. The full suite is GitHub CI and the release check.

---

# Phase 1 — presentation only

Phase 1 adds no automatic act and no new approval basis. It does not change who may do what, or when anything
dispatches, completes, publishes or merges. A Phase 1 slice that turns out to need an authority change stops, and the
change moves to Phase 2.

### P1.1 — One vocabulary in product copy

Facts:
- "Scope" appears about 190 times on the task and result pages (#6): `render-pages.ts:116`, `render-tasks.ts:569-619,
  1979-2605`, `render-results.ts:744-767`.
- Digest and seal copy appears in `render-tasks.ts:3090` ("Approving signs plan version 3f2a9c1b04de"),
  `:1989-1994, 2321-2341`, `:2196, 2200`, `:105-135` and `:900-905, 3059-3071` ("carried"), and in
  `render-chat.ts:841`.
- Run reason words come from `needs-you.ts:191-225` (`RUN_REASON_WORDS`). CLI people text: `operate.ts:1889, 9946,
  10223, 10761, 10827, 11417`, plus "operator act" in about 18 places (#90). Agent plumbing sits in top-level help at
  `cli-help.ts:52-70`. The TUI help is at `tui/app.tsx:40-50`.
- `BANNED_WORDS` (`needs-you.ts:138`) has six words and covers only Needs you and Waiting sentences.
- **Two CLI meanings collide.** `task accept` today records an *acceptance with limitations* that changes neither checks
  nor completion (`surface.ts:317`). `task complete` is the exact-receipt completion (`task-outcome-cli.ts:45-60`: a
  `--digest` is required under `--json` or a coordinator).

Build:
- `src/plain-words.ts` holds the table, with word boundaries and no case. `needs-you.ts` re-exports it.
- Approved cards read "Approved by Alex · 2:14 pm" and "Edited after approval". The plan version moves into Details.
  The approval card still shows the full plan terms.
- The filed-contract panel says "The planner changed 2 things from your request:" and lists the changes; the full
  filed words stay one tap away (#20).
- Requirement rows get a "How we'll know" picker, and the CLI keeps the grammar (#19).
- `RUN_REASON_WORDS`, Toolroll's requirement-detail sentences (`proof.ts:43-700` through one mapper over its own
  strings), lifecycle subjects and CLI people messages use the table.
- `cli-help.ts`: plumbing moves under `toolroll internals --help`, and the commands keep working.
- **CLI verb migration, explicit:**
  - `task accept <id>` becomes the person's Accept: the same exact-receipt road as `task complete` today, with the
    same `--digest` rule under `--json` and for coordinators.
  - Today's acceptance-with-limitations becomes `task accept <id> --despite "<reason>"`. That is the "Accept anyway"
    outline act, with a reason required.
  - `task complete` stays as an alias of the new `task accept`.
  - The old bare `task accept` meaning is reachable only with `--despite`. A bare call that today would have recorded a
    limitation refuses with words naming `--despite`, so nobody silently completes where they meant to note a
    limitation.
  - `task archive` (alias `tidy`) and `task recheck` (alias `regate`) are renames only.

Tests:
- **The product-copy vocabulary test** (`src/plain-words.test.ts`) is one rule table of renderers × seeded fixture
  states. It covers: plan draft, approved, edited after approval, building, waiting, failed, Ready, accepted, release
  card, Needs you, Home, Tasks, Board, settings, push payloads, chat cards, TUI frames and CLI people output.
- Fixtures fill every person- or agent-authored field with a **sentinel** that contains banned words ("scope digest
  sealed lease"). The test extracts visible text plus `aria-label`, `title` and `placeholder`, and removes exactly the
  sentinel spans. What remains is product copy, and it must hold no banned word.
- A second assertion makes every sentinel appear byte-identical where it is rendered. Preserved content is never
  rewritten.
- `task accept` / `--despite` / `complete`: one contract table. Completion still requires the exact receipt, and a bare
  legacy-shaped call refuses.

Journey: file → approve → build → accept, with no "scope", hex or "signs" in product copy.
Parity: the TUI, the CLI and the four chat apps are rows in the same test.
It may ship as P1.1a (cards, Needs you, push, chat, TUI) and P1.1b (results, release, CLI).

### P1.2 — Needs you is honest (reclassification only)

Facts: `work-index.ts:98-100` (`PERSON_CODES`) and `:643-676` label 15 codes "Needs your decision".
- Some of those codes need nothing from a person: `stopping` (#10), `planning-ready`, `scouting-ready`,
  `worker-at-capacity` (#14, #15) and `retry-scheduled`.
- Others are real needs with poor words: `vanished-run` (#2), `no-worker-online` (#9), `earlier-active` (#12),
  `waiting-incident` (#13), `history-problem` (#11), and the result asks in `workspace-ui.ts:305-342` (#35-#39).

Build: `work-index.ts` reads `NEEDS`/`WAITS` and stops keeping its own word table.
- Codes that need nothing from a person become waits: `stopping` → "Waiting: Toolroll is stopping build #N.";
  `planning-ready` → "Waiting to plan"; `scouting-ready` → "Waiting to research"; `worker-at-capacity` → "Waiting its
  turn: builders are busy."; `retry-scheduled` → "Waiting: Toolroll retries build #N at 2:14 pm."
- Codes that stay needs get plain words over **the same acts they have today**:
  - `vanished-run`: "Build #N stopped unexpectedly. Retry it."
  - `no-worker-online`: "The builder is offline. Start the builder." That is one label everywhere, and "Check
    connection" is deleted.
  - `earlier-active` names and links the earlier task.
  - `waiting-incident`: "The last attempts failed the same way (reason). Retry, or change the plan."
  - `history-problem`: "Toolroll can't read this task's history. Open it to retry or archive it." This is an
    actionable need, never a quiet Waiting.
  - Result asks: "No check result for this build yet — Run checks" and "Ready · no project check set up".
- Pushes that need nothing (#52-#57, #60) go to the activity log only. Removing a notification removes no authority.
- The automatic acts (retry, recheck, restart) are Phase 2, P2.1-P2.3. Each code that one of them would handle
  stays a need until its slice ships.

Tests: a `CODE_NEED` rule table, where every code is a need or a wait and never both. Each need keeps its existing
action code, which proves no act changed. No push is sent for a wait.
Journey: a stopping build reads Waiting; a vanished build reads one plain need with Retry.
Parity: the TUI rows, `toolroll task show` and chat cards use the same sentence.

### P1.3 — Three verbs, as relabels over today's acts

Facts: `result-acts.ts:57` (`ResultActKind`, 11 kinds) feeds about 11 verbs on the result page (#51). The resume
ceremony page is `render-tasks.ts:1093-1135` (#17). The More menu is `render-tasks.ts:2866-2878`.

Build: the act row shows only:
- results: **Accept**, **Send back** and **Retry**;
- plans: **Approve**, **Request changes** and **Reject**.

Each maps one-to-one onto an existing post:
- Accept → today's Accept and finish, or "Accept anyway" (outline, with a reason) where today's rules allow it.
- Send back → today's Request changes or Revise for an unpublished result, and Draft a repair task for a published or
  merged one. The rule is fixed and shown on the button's confirm line.
- Retry → today's Retry or Build again.

"Run checks" stays in the Checks row. Resume stays the existing road, but its page collapses to one card with one
button over the same post and the same proof rule. The password field shows exactly when today's rules
(`freshlyApprovable` `scope.ts:1642`, `localApprovalEligible` `:2120`, Passwordless, protected and escalated work) ask
for one, read by one shared function so every form agrees. The More menu loses Evidence pack and Reuse as recipe, which
move to the Plan tab.

Tests:
- The `result-acts` rule table maps each state to one ink act from the three.
- Each verb posts to the same handler with the same fields as before (a route-for-route table).
- The shared password function agrees with the handlers on every row: protected, escalated, coordinator-filed,
  Passwordless on and off, and local owner.

Journey: open result → line note → Send back → revision → Accept.
Parity: TUI `a` Accept (`c` is an alias), `b` Send back, `r` Retry. Chat cards carry the same three. CLI `task accept
| send-back | retry` are aliases of today's commands.

### P1.4 — Home and Tasks, with permanent redirects

Facts:
- Routes: `route-table.ts:339-362` serves `/inbox`, `/work`, `/next`, `/workbench` (the portfolio:
  `render-pages.ts:780`, `pages.ts:64`), `/board`, `/review`, `/queue`, and `/tasks` (today a redirect to `/work`,
  `:361`).
- The legacy page: `inboxPage` is at `render-pages.ts:57`.
- Push and service-worker allowlists: `push.ts:230-236` (`LINK_SHAPES`, `CLASS_FALLBACK` → `/next`, `/review`) and
  `pages-assets.ts:47-73` (the worker's `SHAPES`, fallback `/next`). **An installed phone keeps its old worker until it
  updates.**
- Task ids are not machine numbers: `task add` derives them from titles (`operate.ts:9408` `slug(title, now)`) or
  takes `--id`. Task routes match `/t/[^/]+/…` (`route-table.ts:254`), so any new number route must live outside `/t/`.
- Other links: `serve.ts:1460-1484`, `shell.tsx:26` (#109), `chat-quiet.ts:112, 184, 243`, `render-chat.ts:317-350`,
  `nightly-github.ts:512, 873, 886`, `render-pages.ts:228, 520, 839, 1049, 1253`, `provider-auth.ts:185`,
  `limits-ui.ts:91`, `publish.ts:665`, and `docs/guide/`.

Build:
- `/` **Home** holds Needs you, Running and Waiting. `/tasks` **Tasks** has List / Board / Ready / Archived and an
  all-projects scope that replaces the portfolio.
- Permanent GET redirects with the target's access rules: `/work` → `/tasks`, `/inbox` → `/`, `/next` → `/`,
  `/workbench` → `/tasks?scope=all`, `/board` → `/tasks?view=board`, `/board?view=order` and `/queue` →
  `/tasks?view=order`, `/review` → `/tasks?view=ready`, `/done` → `/tasks?view=done`. Only the query keys each target
  knows are kept.
- **Archive keeps its POST exactly.** `POST /work/put-away` keeps its path, step-up and approver rule. Only the GET
  preview gets a new address (`/tasks/archive`, with the old GET redirecting there).
- Push links: `CLASS_FALLBACK` becomes `/` and `/tasks?view=ready`. `LINK_SHAPES` and the worker `SHAPES` allow
  exactly:
  - the new fixed destinations `/`, `/tasks?view=ready` and `/tasks?view=board`;
  - `/n/<display number>`, where the number is the task_ref's stored numeric id. A new redirect route resolves it to
    the task page under the viewer's access, so neither the push nor the URL ever carries a title-derived id;
  - the old `/next` and `/review`, kept indefinitely.
- Deleted: `inboxPage`, `render-next.ts`, the workbench page and rail, and the "clear the queue" links. Every link in
  the list above is repointed, and the guide is updated.

Tests:
- `route-table.test.ts`: every retired GET is a redirect row with no page handler, and the archive POST row is
  unchanged.
- A project-limited person redirected through each path learns nothing about another project.
- `/n/<n>` refuses a number outside the viewer's projects with the same 404 as an unknown one.
- Push rules: the new destinations are accepted; `/n/1x`, `/n/../x` and title ids are refused.
- **Old-worker test:** the previous worker source, kept as a fixture, receives each new payload and lands on an allowed
  page (its `/next` fallback redirects to Home). The new worker accepts every old payload.
- A link sweep: no rendered `href` points at a retired GET.

Journey: Home → Needs you → task → back; List ↔ Board; on the phone, an old `/next` link and a new push both land
right.
Parity: `toolroll open --web` lands on Home, and chat links use the new paths.

### P1.5 — One-line pings with one button

Facts: `PUSH_WORDS` (`push.ts:222-228`) are generic. Push payloads carry static words and machine numbers only
(`push.ts:239`). Chat cards carry every word of the terms (`chat-terms.ts`).

Build:
- Push: one line per class, built from the display number, "#41: plan ready", "#41 is ready to review", "#41 has a
  question". One tap opens `/n/41`. There are no titles in push, and one "Open" action where the platform supports it.
- Chat apps: one line, one button and Details. The button is never an approval: **Review plan** expands the full terms
  in the card, and the existing Approve sits under them with the existing terms digest check. **Open result** for
  results; **Answer** choices inline for questions.

Tests: the payload rule table (one line, allowed link shapes, no free text). A chat Approve is reachable only from the
expanded terms. Stale cards are refused, as today.
Journey: phone push → tap → the right act; Telegram → Review plan → Approve.
Parity: one card builder for the four chat apps. The TUI has no pings (named gap).

### P1.6 — "Can I merge?" checklist

Facts: readiness is spread over `task-status.ts:24-69`, `server/last-checks.ts`, `workspace-ui.ts:271-342`,
`release-card.ts` and `render-tasks.ts:3064-3071` (#79).

Build: one panel per task, read from those same sources with nothing recomputed. Rows: plan approved · build finished ·
project checks passed on this commit · requirements met · pull request open · PR CI on this exact head · up to date with
main · no conflicts · review comments answered · release check (for releases). Each blocker carries an existing act:
Run checks, Retry, or **Ask the agent to fix**. Ask the agent to fix is Send back (P1.3) with a prefilled note naming
the blocker, and it is the person's act. Nothing here acts on its own.
Tests: each row reads its one source (the `one-vocabulary.test.ts` pattern). Ask the agent to fix posts the same
revision as Send back.
Journey: failing PR CI → Ask the agent to fix → revision → all rows green.
Parity: `toolroll task ready <id>` (`--json` for agents), the lead answers "Can I merge #41?", and the TUI task view
shows the panel.

### P1.7 — Keyboard shortcuts

Build: one keymap for the console and the TUI:
- `n` new task;
- `a` the page's ink act (Approve or Accept);
- `b` Send back or Request changes;
- `r` Retry;
- `/` search (`browser/search.tsx:125`);
- `g h` Home, `g t` Tasks;
- `?` the list.

A shortcut only presses the rendered button, so any password field or confirm still appears. Shortcuts are off in
inputs and when the button isn't rendered.
Tests: one shared table for web and TUI. A shortcut never posts a form whose button isn't rendered, and it never
submits a step-up form without its field (a real-browser test).
Journey: keyboard only: new task → Approve → Accept.

---

# Phase 2 — authority changes

Each slice below changes what Toolroll may do on its own, or what an approval covers. Each one:
- runs the AGENTS.md safety self-review before commit;
- states its acceptance criteria as **must-refuse** cases;
- ships its attack tests against the real store and, where it applies, the real sandbox (`sandbox-exec`,
  `codex sandbox`);
- turns a P1.2 need into a wait only when that slice lands.

### P2.1 — Automatic retry of a vanished build

Facts: normal failure settlement charges a strike (`claim.ts:1222` `addStrike`, then `attempts-exhausted` at
`MAX_STRIKES`). Dead-runner recovery marks runs interrupted and requeues them without a strike (`store.ts:21769`,
`operate.ts:3623`), so repeated restarts could evade the limit. Per-run budgets are nullable and bound no episode.

Build:
- Recovery charges the strike **in the same transaction** that marks the run interrupted and requeues the task. It is
  idempotent per run: a run is charged once, whoever recovers it.
- A persisted **episode** per task (attempts and spend since the last person act) has limits: at most 3 automatic
  retries, and a spend ceiling equal to the plan's budget × 2, with each claim reserving its budget against the
  ceiling.
- No budget on the plan means no automatic retry. The task stays the P1.2 need.
- Stop, hold, custody, archive and approval standing are all re-read at the requeue. Any one of them blocks the retry.
- Reaching a limit raises the P1.2 need ("Build #N keeps stopping. Retry, or change the plan").

Must refuse:
- a second charge for one run;
- a retry past the attempt or spend limit, including under concurrent recoverers and a crash between the charge and the
  requeue;
- a retry of a stopped, held, archived or no-longer-approved task;
- a retry on a plan with no budget.

### P2.2 — Automatic recheck under a check-only authorization

Facts: the rerun road proposes a candidate scope that an approver or a mode must seal (`dispose.ts:600-608`), and it
refuses while a verdict is missing (`dispose.ts:558-562`).

Build:
- A durable **check-only authorization** row: task, exact candidate commit, the approved check command's digest, the
  sealed check access, a cap of 1 automatic run per (candidate, command digest), and an expiry.
- It is written only from the existing approval of that exact candidate. It never reseals the plan and never starts a
  build or agent.
- It runs the check with the access that was sealed, or narrower. It never runs wider, and never unsandboxed because a
  record went missing.
- A missing or unreadable verdict reruns only when the authorization stands. Otherwise the P1.2 need stays.
- A changed check command is a different digest. The old authorization doesn't cover it, so the person approves it.
  The approval card shows the new command.

Must refuse:
- a rerun on a different commit or command digest;
- a second automatic rerun (concurrent workers, a crash after the claim);
- a rerun wider than the sealed access;
- any agent or build started by the authorization.

### P2.3 — Restarting this computer's own builder

Facts: the laptop service runs the console and the builder together (`laptop-service.ts:4`). Its start helper
re-enables a disabled label (`laptop-background.ts:163-165`: `background off` disabled it, and loading it is "the
person's explicit yes").

Build: Toolroll restarts the service only when all of these hold:
- a recorded **desired state** of running (set by `background on`, `up`, or install; cleared by `background off`, `stop`
  and uninstall), read from Toolroll's store;
- no stop, update, deploy drain or admission pause in progress;
- the service's process has verifiably exited (launchd/systemd state, plus no live pid for the recorded runtime);
- the recorded runtime identity (build and database format) matches what would be started;
- under 3 attempts in 30 minutes.

A restart never re-enables a disabled label. Anything else raises the P1.2 need with one label, "Start the builder".
Must refuse: a restart after `background off` or `stop`, during an update or drain, while the process lives, on an
identity mismatch, or past the attempt cap.

### P2.4 — Fast path: small, watched work starts right away

Facts:
- Sizing: `task-sizing.ts`, which uses `heuristicSizing` (`:52`, never risky) plus a classifier refine within 5 s
  (`refineFiledSizing` `:205`).
- No-plan rule: `makesNoPlan` (`phase-routing.ts:128`).
- Approval bases: the allowlist at `scope.ts:849-850`, and one dispatch predicate in `approval-authority.ts:25-44`.
- Filing and sealing together: `fileAndSealUnderMode` (`scope.ts:1472-1514`).
- Proof readers: `proofDetailOf` (`scope.ts:1884`) needs `{v:1, at, digest}`. `localSealStandsSql`
  (`approval-authority.ts:57`) matches the local generation in the detail text with `LIKE '% · local <gen> %'`.
- Check access: `sign-ins` lets checks read and send Claude, Codex and GitHub credentials (`check-access.ts:33-34`).
  Checks run at build time, before disposal (`builder.ts:2731`). The wider levels seal only on a password ceremony
  (`store.ts:9168`).
- Completion accepts machine callers for ordinary work (`assignment.ts:508-511`). A project's publication grant pushes
  right after a build (`dispose.ts:234-240`). The whole change, including revision ancestry, is
  `familyChangedFiles` (`result-completion.ts:53`), which returns null when any part is unreadable.
- Outside-request quarantine: `store.ts:9161` refuses automatic bases for youiyoux-filed tasks, keyed on an immutable
  filed-via.

**What "attended" promises, honestly.** The promise is *a person's authenticated initiation on a person surface*, with
nothing more claimed.
- The person surfaces are:
  - a browser session (cookie: a typed or remembered password, SSO, passkey or Passwordless session);
  - the TUI as the local owner (a new `build-now` local-owner act beside `approve-plan`);
  - interactive `toolroll task new`.
- Under the easy-start local-owner threat model (`local-owner.ts:1-8`), an unfenced process running as the same OS user
  **is** that user: it can already approve plans with the remembered login (`scope.ts:1377`). The fast path claims no
  presence proof beyond that and adds no road past `task approve`.
- What it does reject: fenced build agents, every token (lead, coordinator, runner, remote, API), the MCP gateway, chat
  bridges, flows, schedules, webhooks, triggers, issue imports, nightly jobs and the release tool.
- Those rejections are decided **inside the writer and the dispatch guard**, from trusted admission context
  (`machineActing()`, the request's caller kind and the proof method), never from the surface's say-so.
  `task add` (agent-invocable, `surface.ts:162`) never fast-starts.

**The FAST execution profile (sealed before anything runs).** A fast task's plan seals a restricted profile, and
setup, build and checks all run under it:
- checks **sandboxed**: never `sign-ins`, never unsandboxed;
- **no credential access**: no GitHub or other sign-ins in the workspace or the checks. The agent's own provider sign-in
  goes only through the gateway, exactly as today;
- **workspace-only writes**: the project's extra write paths aren't applied;
- **provider-only network**: the agent reaches its provider hosts, and checks get no network;
- no macOS service widenings;
- the project's approved setup command unchanged;
- a **finite spend cap**: the per-build budget is required, at most the project's default and at most the fast cap.

The FAST profile only narrows. If the project's own settings are narrower, those apply. If the project *needs* wider
access (its checks require sign-ins, an unsandboxed level is stored, or write paths are required), the task is not
eligible, and nothing is ever widened to fit. The existing rule that wider check access seals only on a password
ceremony (`store.ts:9168`) is unchanged.

**What counts as small.** One function, `fastStartEligible`, is read by the preview and again inside the seal's
transaction:
- the heuristic size is small, **and** the classifier answered small and not risky within its budget. On this road the
  filing waits for the classifier, at most 5 s. No answer means normal approval: the model can confirm a small size,
  never grant one;
- `makesNoPlan`; default quality;
- the gate seals with one approver, no protected work, and declared paths present when the project protects any;
- the FAST profile can be applied, as above;
- no release or deploy terms, no CI hold, no trial, no fallback chain;
- the monthly limit isn't reached; no org-policy refusal;
- the project setting **Small tasks start right away** is on. The default is on for single-approver installs and off on
  servers with more than one approver. Turning it on is a person's logged settings act.

**One proof contract (versioned).** `approval proved` detail v2 is the one shape every reader parses:

```
{v:2, at, digest, method, account:{name, generation}, local:{generation, transport}|null,
 session:{id_hash}|null, basis, fast:{rule, profile_digest, sizing:{heuristic, classifier}, until}|null}
```

- `proofDetailOf`, `personSealSql`, `localSealStandsSql` (which moves from the `LIKE` match to `json_extract` on
  `local.generation`), `approvalProofDetail`, the evidence pack and the audit renderers are all updated **in one
  change**. v1 rows and the legacy text stay readable as they are.
- `session.id_hash` binds a browser-session fast seal to its session: signing out or ending that session (it stops
  being saved, `session.ts:173`) stops the seal standing. `account.generation` revokes it on a password change.

**When it stands.** A `fastSealStandsSql` clause in `authorityStandsSql`:
- a person proof v2 at the seal's instant, method in `PERSON_PROOFS` minus `chat`, and no machine seal;
- no flow trigger event, coordinator or quarantined filed-via (youiyoux, issue import);
- the approver stands, and the setting is still on;
- the bound session is still saved, the account generation is unchanged, and the local generation is unchanged;
- the sealed profile is the FAST profile digest;
- the **first dispatch within 30 minutes** of the seal. After that it lapses to an ordinary "Approve plan".

P2.1 retries ride the seal only inside the window. A person's Retry or Send back is a new person act and re-checks
everything.

**Where the restrictions hold.** Every primitive checks them, so none of them depends on the Accept screen:
- **Completion:** a fast task completes only by a person (`COMPLETION_BY_PERSON`). A machine caller (`assignment.ts:508`)
  is refused, and auto-accept never applies.
- **Publication:** the project's publication grant never pushes a fast task's build (`dispose.ts:234`). It publishes
  only after a person's Accept, and only within caps.
- **Merge:** a merge grant or `--match-head-commit` merge refuses a fast task until it is accepted and within caps.
- **The change inspected** is the whole carried change: `familyChangedFiles` over the revision ancestry, against the
  task's recorded base. If it is null or unreadable, everything fails closed (no completion, publication or merge).
- **The caps** are 3 files and 150 changed lines, with no protected path (`protectedChanges`) and no dependency,
  lockfile, migration or schema file.
- **Growth beyond the caps** requires the person to approve **the actual expanded candidate**: a plan proposed with
  `candidate` = the exact head (the `dispose.ts:604` pattern), shown with its diff summary, on the normal ceremony.
  Only then can it be completed, published or merged.
- **The basis's limits:** `fast` never counts as a person's yes for trials (`trialSealStandsSql`), releases or carries
  (`releaseStandsSql`, `carrySealSql`), two-person votes or the counters that read `personSealSql` (`scope.ts:1915`),
  wider check access, or the youiyoux quarantine. A mode never writes it.

The result still goes through the project's checks and is accepted by a person. No model review is added (AGENTS.md
"Lean verification").

**Interactions.**
- The mode road runs first when a mode auto-approves filings.
- The lead, scouts, coordinators and chat get one-tap Approve on the card instead.
- Route-result rows record the basis, and the size cohort is unchanged for earned rules.
- A trial route is never fast.
- Any two-person or requester rule makes the task ineligible.

**Must refuse (attack tests).**
- **Callers:** lead, coordinator, runner, remote and API tokens; MCP; each chat bridge; a flow, a schedule, a webhook;
  an issue import; `task add`; `--json`; a fenced agent calling the CLI inside the real `sandbox-exec` and
  `codex sandbox`; a PTY-driven `task new` from inside the fence.
- **Plans:** escalated; checks at sign-ins or unsandboxed; required write paths; protected paths; no declared paths on a
  protecting project; release or CI hold; a trial; a fallback chain; no or over-cap budget; the monthly limit reached;
  classifier silent, risky or medium; heuristic medium; the setting off; a two-person or requester rule.
- **Standing:** the window lapsed; the session ended; the password changed; local mode off or its generation moved;
  the setting turned off; an edit after the seal; a profile digest other than FAST.
- **Forgery:** a `fast` row with no proof, a v1 proof, a proof at another instant, a chat proof, a machine proof, a
  proof naming another session; a replayed filing.
- **Execution:** a check trying to read `~/.config/gh` or the Claude credentials, to reach github.com, or to write
  outside the workspace, each run in the real sandbox and denied.
- **Primitives:** machine completion; a publication-grant push; a merge before Accept; an over-cap, protected,
  lockfile or migration diff through each of completion, publication and merge; an unreadable ancestor; a revision
  that brings the whole change over the caps; approval of a stale candidate after growth.

Journey: type "Fix the typo in the footer" → **Build now** → Ready → Accept. A protected path, or a large description,
shows Approve plan.
Parity: console New task (Build now / Add task), interactive `toolroll task new`, TUI `n` then Enter. Chat and the lead
use one-tap Approve, a named and deliberate difference.

### P2.5 — Routing changes: one step to approve the new route

Facts: a sealed route is exact, and a global configuration change never rewrites it (`phase-routing.ts:44-48`). What
the audit saw (#7, #8) is the task-level re-route and the legacy unrouted rows: "re-file the scope"
(`render-tasks.ts:586-619, 865, 916`), the push at `dispose.ts:464`, and `operate.ts:10761, 10827`. Tiers are labels the
operator configures, not guarantees of price or capability (`phase-routing.ts:31`).

Build: **no route classes.** Approvals stay bound to the exact route.
- When the route a task would dispatch on differs from the sealed one, Toolroll proposes the new exact route itself (no
  edit-and-save). Needs you shows one Approve with one "what changed" line: "The builder changes from Claude Sonnet 4.5
  to Claude Opus 5 (API key → subscription). Approve to continue."
- Legacy unrouted rows get the same treatment after Toolroll routes them.
- Pins, trials and exact-model result attribution are unchanged.

Must refuse: dispatch on any route other than the sealed bytes; an Approve whose shown diff doesn't match the proposed
route digest.

### P2.6 — One `toolroll release <branch>`

Facts: the loop between `release <branch>`, `--recover-deploy`, `--release-gate` and `publish-ok`
(`release-cli.ts:47-103`; `release.ts:527-529, 691, 699, 787, 831, 999, 1099, 1230, 1362, 1390-1401`;
`deploy-rescue.ts:53-94`). Carries are limited to tests, docs and the changelog, plus identical production output
(`release-carry.ts:1-14`).

Build:
- `toolroll release <branch>` reads the journal and picks one action: finish forward, roll back, lift a pause the
  journal proves was left before the swap, wait for another running release (named by host and pid), or wait for
  approval and then resume. It prints what it did.
- A held auto-approved release gets a web button and resumes itself.
- **Behind main:** Toolroll updates the branch through the hardened git/gh helper, under the release's lease and the
  PR's expected head (`--match-head-commit`-style compare-and-swap; a concurrent push aborts). The updated head is a
  **new candidate**: it needs the approval and fresh CI and native check like any other. There is **no patch-id
  carry**; a delegated "main-update" policy would be a separate plan.
- The old flags stay as hidden aliases under `toolroll internals`.

Must refuse: two coordinators acting on one release; an update racing a push; any approval reused across the update;
deploy of an unchecked or unaccepted candidate (`deploy-gate.ts`). Each journal phase × crash converges.

### P2.7 — Start a task from a GitHub issue or PR

Facts: `runGhTree` (`onboard.ts:81-96`) resolves `gh` through PATH and inherits the environment. The outside-request
quarantine is enforced centrally at the seal (`store.ts:9161`, immutable filed-via). `task_source` keeps outside
provenance and its revisions copy it (`task-source.ts:1-10`).

Build:
- A "From an issue or PR" field, `toolroll task new --from <url>`, and the lead's "work on <url>" share one importer.
- The importer runs a **pinned `gh`** (resolved once to a real path and recorded) with a controlled environment (an
  allowlist; no `GH_HOST`, `GH_REPO` or config dir from the caller) and an explicit `--repo`.
- It validates the returned owner/repo against the project's registered identity from Toolroll's records, and for a
  PR, that the head repository is the same repository (no forks) and the head sha matches what was shown.
- It persists **immutable provenance** (`task_source` plus a new filed-via `issue-import`) **before** any seal exists.
  `sealScopeApproval` refuses every automatic basis (mode, grant, schedule, auto-check, auto-green, carry, fast) for it,
  centrally, beside the youiyoux quarantine. Only a person's ceremony, or a chat tap with the full terms digest, seals
  it.
- Provenance is copied through revisions and repairs.
- Issue text is preserved content (P1.1), shown as quoted outside text.

Must refuse: a foreign host, an unregistered repo, or a returned identity that differs; a fork PR; a head sha that
changed; a mode or fast seal on an imported task, including after a revision; a PATH-planted `gh`; inherited `GH_*`
environment.

---

## What gets deleted

- Phase 1:
  - `work-index.ts`'s own word table;
  - "Check connection";
  - the "display only — this is not evidence" caveat (`render-tasks.ts:1710`, `render-history.ts:64`);
  - digest chips on approval cards;
  - "re-file" copy;
  - the CLI digest line on the archive page (`render-pages.ts:1257`);
  - the separate resume page;
  - `inboxPage`, `render-next.ts`, the workbench page and rail;
  - page handlers for retired GETs (their redirect rows stay);
  - lifecycle pushes that need nothing;
  - top-level help for plumbing commands.
- Phase 2: the edit-and-save re-route road (P2.5); the release recovery flags from people-facing help (P2.6).

## Open decisions

None blocking. Alex's defaults above are final. Two constants live in one place and are recorded in each seal's
`fast.rule` version: the 30-minute first-dispatch window and the P2.1 episode limits (3 retries, budget × 2).

## Codex round 1 ledger

| # | Sev | Finding | Fix in v2 |
|---|---|---|---|
| 1 | High | A PTY prompt isn't presence; CLI fast-start can't promise "never an agent" | P2.4 states the promise as authenticated initiation under the easy-start same-user model. Fenced agents, tokens, MCP, chat and automation are rejected in the writer and dispatch guard from trusted context. There are PTY-in-fence attack tests. |
| 2 | **Critical** | The Accept backstop comes after checks that could read sign-ins | The FAST execution profile is sealed before anything runs: sandboxed checks, no credentials, workspace-only writes, provider-only network, a finite cap. It only narrows, ineligible otherwise. There are real-sandbox exfiltration tests. |
| 3 | High | Guards are needed beyond Accept | Restrictions are enforced in completion, publication and merge. The whole carried change with ancestry is inspected and fails closed when unreadable. Growth needs approval of the exact expanded candidate. `fast` is excluded from trial, release, carry and person-only counters. |
| 4 | High | The proof record doesn't match its readers | One v2 proof contract (at, account and local generations, session binding), with every reader updated in one change, `localSealStandsSql` on `json_extract`, and v1 still readable. |
| 5 | High | Route classes lack trustworthy membership | Dropped. One-step approval of the new exact route with a "what changed" line. The premise is corrected: global configuration changes already leave sealed routes alone. |
| 6 | High | Vanished recovery doesn't charge strikes | P2.1 charges the strike atomically with the requeue, once per run, with persisted episode attempt and spend limits and reservations, and re-reads stop, hold and custody. |
| 7 | High | Automatic recheck is new authority | P2.2 adds a durable check-only authorization per exact candidate, command digest and access, capped at 1. It never reseals and never runs wider. |
| 8 | High | Restart vs intentional shutdown | P2.3 requires a recorded desired state, no drain, update or stop, a verified exit, matching runtime identity and bounded attempts, and never re-enables a disabled label. History corruption is an actionable need (P1.2). |
| 9 | High | Patch-id can't authorize an updated release | P2.6 updates under a lease and compare-and-swap, then asks for approval and fresh CI and check on the new candidate. No carry. |
| 10 | High | Issue quarantine must survive every route | P2.7 persists immutable provenance before any seal, rejects automatic bases centrally at `sealScopeApproval`, validates identity, runs a pinned gh with a controlled environment, and keeps provenance through revisions. |
| 11 | Med | Push allowlist omission; ids aren't machine numbers | P1.4 allowlists the exact new destinations, uses `/n/<stored numeric id>` (outside `/t/`, whose routes match any id), keeps old redirects forever, tests old workers against new payloads, and leaves the archive POST unchanged. |
| 12 | Med | Vocabulary vs consent text; two `task accept` meanings | P1.1 tests product copy separately from preserved content with sentinels (which must render unchanged), and migrates `task accept` / `--despite` / `complete` explicitly with the exact-receipt rule kept. |
| 13 | Med | Split presentation from authority; the automatic-review conflict | Two phases. Phase 1 adds no authority. Each Phase 2 slice has must-refuse criteria and attack tests. The automatic-review promise is removed (lean verification). |
