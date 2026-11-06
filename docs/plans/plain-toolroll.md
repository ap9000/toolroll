# Plain Toolroll — plan

Status: **v1** (2026-11-05). Branch `plain-toolroll`, off main 5b5681d7. Nothing in `src/` changes with this document.

Inputs: the UI and CLI copy audit (109 findings, file:line) and the comparison with Conductor, Orca and Paperclip, both
from 2026-11-05. Finding numbers below (`#N`) are the audit's. The audit was taken at the same commit; line numbers were
spot-checked here and may drift by a line or two.

## What and why

Toolroll asks people things only the machine can know, speaks its own internals ("scope", "digest", "sealed",
"witness"), offers about 11 verbs on a result, and spreads one job across ten list pages. The competitors are simpler
in four ways that matter: one noun, prompt-first starts, one readiness list, and one-line phone pings. Toolroll stays
ahead on approvals, evidence and unattended safety; this arc keeps all of that and removes the rest.

Alex's decisions (final):

1. **Toolroll fixes its own state before asking.** It settles its own runs, reruns checks, retries, collects evidence
   and restarts its own builder service. Needs you holds only real decisions; everything else is a plain
   "Waiting: Toolroll is …" line. Never ask a person to vouch for machine facts.
2. **One vocabulary.** "Plan", never "scope", wherever a person reads it. No digests, "signs", "sealed" or "binds" on
   approvals. One word each for builder, approver, finishing a result, archiving and numbering. Extend `BANNED_WORDS`
   and test every person-facing renderer.
3. **Fewer choices.** Results: Accept / Send back / Retry. Approvals: Approve / Request changes / Reject, with a password
   field only when the act needs one. One `toolroll release <branch>` that decides by itself. A routing change keeps
   the approval unless cost, model class or access changed.
4. **Fast path.** Small tasks a person is watching skip plan approval and build straight away. Plan approval stays for
   large or risky work, flows, schedules, anything unattended, protected paths, and release or merge.
5. **Pages.** Keep Home and Tasks (with a Board view). Retire `/inbox`, `/work`, `/next`, `/workbench`, `/board`,
   `/review`, `/queue` and the portfolio overview, with redirects.
6. **From the comparison.** One-line phone pings with one button; one "Can I merge?" checklist per task with "Ask the
   agent to fix" per blocker; start a task from a GitHub issue or PR; keyboard shortcuts on the primary verbs.

Out of scope: the "Confirm it stopped" removal. It is being built on branch `auto-stop-proof` (auto-settle of
`unprovable` runs, teardown-then-settle of `unknown` ones, deletion of `NEEDS["confirm-stopped"]` /
`["check-stopped"]`, `ConfirmStopped*` forms and `POST /t/:id/confirm-stopped` as a person act). This plan builds on it
and does not repeat it. Slice 1 only lands after it, or rebases onto it.

## The words (one vocabulary)

| Say | Never say to a person |
|---|---|
| **plan** | scope, contract, terms (as a noun for the plan) |
| **Approved by Alex · 2:14 pm** | signs, signed, sealed, seal, binds, digest, version hex |
| **builder** | worker, runner, computer (as a role), watch, daemon, background service |
| **approver** (says yes to work), **owner** (runs this Toolroll) | operator, instance operator, admin, "someone who manages this Toolroll" |
| **Accept** (finishing a result) | Complete, mark complete, Accept and finish, finish |
| **Send back** (result), **Request changes** (plan) | Revise, Draft a repair task, re-file |
| **Archive** | put away, tidy |
| **build #N** | run #N, attempt #N, result #N |
| **automatic review** | independent review, previous assessment, reviewer (as a status) |
| **your lead** | coordinator, mate |
| **research** | scout, scouting |
| **requirement** | criterion, evidence, proof, verdict, caveat |
| **Waiting: Toolroll is …** | reconcile, requeue, claim, lease, custody, incident, plane, fence, attested, receipt, regate, carried, incarnation, admission, quiescence, witness |

Code, the database, `--json` output, the agent contract (`docs/agents.md`, `audience: "agent"` rows in
`src/surface.ts`) and the audit page's hash detail keep their own words. Only what a person reads changes.

## Slices

Each slice ships alone, behind nothing, in this order (cheapest and most visible first). Every slice carries:

- **Tests**: the focused rule tests named in the slice, plus its rows in the renderer vocabulary test (slice 2 adds it;
  slice 1 extends the existing `needs-you.test.ts` checks). Per AGENTS.md "Lean verification", no per-string wording
  tests: the vocabulary test is one rule table, the same kind of contract `BANNED_WORDS` already is.
- **Journeys**: one scripted journey at desktop (1280×800) and one at phone (390×844), including the slice's empty,
  long-content and failure states. Screenshots go in `evidence/`, never committed.
- **Parity**: the same act and the same words in the console, the CLI, the terminal UI and chat (lead chat and the
  chat apps), or a named gap.
- Fix rounds run only the affected tests; the full suite is GitHub CI and the release check.

### Slice 1 — Needs you is honest (decision 1)

Facts:
- Two word tables disagree. `src/needs-you.ts` has `NEEDS`/`WAITS`; `src/work-index.ts:98-100` (`PERSON_CODES`) and
  `:643-676` label 15 codes "Needs your decision", including `stopping` (#10), `history-problem` (#11),
  `earlier-active` (#12), `waiting-incident` (#13), `vanished-run` (#2), `no-worker-online` (#9).
- `planning-ready` / `scouting-ready` / `worker-at-capacity` say "Planner ready", "Scout ready", "worker capacity"
  (`work-index.ts:670-675`, #14, #15).
- `needs-you.ts:66-69`: "Start the builder" / "Check the build" ask the person to do plumbing.
- Results ask for machine work: "verification needed" (`workspace-ui.ts:305-327`, #35), "check result couldn't be
  read" (`:335`, #37), "check command changed; run checks again" (`task-status.ts:125`, #36), raw "awaits independent
  goal assessment" reasons (`proof.ts:478, 765, 786` via `render-results.ts:520-605`, #33).
- Pushes for things that need nothing: "Independent review requested" (`store.ts:11989`), "went dead holding work"
  (`operate.ts:3914`), "worktrees need review" (`worktree-notices.ts:13`), "repair ancestry" (`dispose.ts:782`)
  (#53-#57).

Build:
- `work-index.ts` reads `NEEDS`/`WAITS` and stops keeping its own word table. A code is a person need only if it maps to
  a `NEEDS` key (approval, question, result to review, sign-in, hold, choose project or agent, earlier task, retry limit
  reached). Everything else maps to a `WAITS` key.
- New waits: `stopping` → "Waiting: Toolroll is stopping build #N."; `history-problem` → an incident plus a quiet note on
  the task, never Needs you; `planning-ready` → "Waiting to plan"; `scouting-ready` → "Waiting to research";
  `worker-at-capacity` → "Waiting its turn: builders are busy."
- **Vanished build** → Toolroll retries it under the existing backoff and strike rules (`retry-scheduled`), shown as
  "Waiting: build #N stopped unexpectedly; Toolroll is starting it again." Needs you only after the strike limit:
  "Build #N keeps stopping. Retry, or change the plan."
- **Builder offline** → when the builder is this computer's installed service (`laptop-service.ts`,
  `laptop-background.ts`), Toolroll restarts it and shows "Waiting: Toolroll is restarting the builder." Ask only when
  the builder is another computer or the restart fails, with one label everywhere: "Start the builder". Delete "Check
  connection" (`agents-view.tsx:128-137`).
- **Results** → no verdict, unreadable check record or changed check command: Toolroll reruns the project's machine
  check once and shows "Waiting: running the project's checks…". No check configured: "No automatic check for this
  project. Review the changes yourself." These are machine checks only. AGENTS.md "Lean verification" still holds:
  no model review, repair or resubmission loop is added. A report/changes mismatch stays a person's call (Send back).
- "Earlier work is still active" names and links the earlier task: "T-9 (an earlier version) is still running. Stop it
  or wait for it to finish."
- Lifecycle pushes that need nothing go to the activity log only (#52-#57, #60).

Tests: a `CODE_NEED` rule table, so every work-index code is a need or a wait and none is both. Auto-retry stops at the
strike limit. The service restart runs only for this computer's own installed service (stored records, never a path from
the checkout), and a failed restart becomes the need. A check rerun happens once per changed check-command record, never
in a loop.
Journey: a vanished build reads Waiting, then Ready, with no click. An offline local builder restarts itself.
Parity: TUI rows show the same Waiting sentence; `toolroll task show` prints it; chat cards carry it; no chat push for
waits.

### Slice 2 — One vocabulary (decision 2)

Facts:
- "Scope" appears about 190 times on the task and result pages (#6): `render-pages.ts:116`, `render-tasks.ts:569-619,
  1979-2605`, `render-results.ts:744-767`. Needs you, the kit approve box and the TUI already say "plan".
- Digest and seal copy: `render-tasks.ts:3090` ("Approving signs plan version 3f2a9c1b04de"), `:1989-1994, 2321-2341`
  (digest chips), `:2196, 2200` ("sealed into its scope"), `:105-135` ("filed contract", "binds the AMENDED terms"),
  `:900-905, 3059-3071` ("carried"), `render-chat.ts:841` ("seals these agents").
- Run reason words: `needs-you.ts:191-225` (`RUN_REASON_WORDS`: "lease", "operator", "scout"), #106.
- CLI people text: `operate.ts:1889, 9946, 10223, 10761, 10827, 11417`; "operator act" in about 18 places (#90);
  `cli-help.ts:8, 52-70` puts `claim`, `heartbeat`, `reap`, `tick`, `reconcile` in top-level help (#81).
- TUI: `tui/app.tsx:44-47` ("mark the result Complete").
- `BANNED_WORDS` (`needs-you.ts:138`) holds six words and is checked only on Needs you and Waiting sentences
  (`needs-you.test.ts:52-79, 209-215, 479-490`).

Build:
- Move the word list to `src/plain-words.ts` (`needs-you.ts` re-exports it), with the "Never say" column above, word
  boundaries, case-insensitive, and an exemption list (the audit page's hash detail, `--json`, the agent contract,
  `toolroll internals --help`).
- Approval and approved cards: "Approved by Alex · 2:14 pm"; "Edited after approval" when the plan changed; the plan
  version moves into a Details disclosure. The filed-contract panel becomes "The planner changed 2 things from your
  request:" plus the list (#20). The pipe grammar for requirements becomes one row per requirement with a "How we'll
  know" picker; the CLI keeps the grammar (#19).
- `RUN_REASON_WORDS`, result requirement details (`proof.ts:43-700` through one plain mapper, #44), lifecycle subjects
  (#60-#62), CLI people messages and the TUI help use the table.
- `cli-help.ts`: agent and runner plumbing moves under `toolroll internals --help`. The old commands keep working.
- Rename people-facing CLI verbs with old ones kept as aliases: `task accept` (alias `complete`), `task archive`
  (alias `tidy`), `task recheck` (alias `regate`).

Tests: **the renderer vocabulary test** (`src/plain-words.test.ts`). One rule table of person-facing renderers × seeded
fixture states (plan draft, approved, edited after approval, building, waiting, failed, Ready, accepted, release card,
Needs you, Home, Tasks, Board, settings groups, push payloads, chat cards, TUI frames, CLI people output). Each renders
over real HTTP or its pure function, visible text plus `aria-label`, `title` and `placeholder` are extracted, and no
banned word may appear. A new renderer joins by adding a row. Plus a static check that every `NEEDS`/`WAITS` sentence
and `RUN_REASON_WORDS` value passes.
Journey: file, approve, build, accept. Screenshots show no "scope", hex or "signs".
Parity: TUI, CLI people output and the four chat apps are rows in the same test.

Slice 2 may ship in two parts (2a: plan and approval cards, Needs you, push, chat, TUI; 2b: results, release, CLI). The
test lands in 2a with those rows and grows in 2b.

### Slice 3 — Three verbs on results and approvals (decision 3)

Facts:
- `result-acts.ts:57` `ResultActKind` has 11 kinds; the page and its More menu show about 11 verbs (#51).
- The result-page stop form always asks for a password; the task-page one doesn't under Passwordless
  (`status-summary.tsx:108-121` vs `task-view.tsx:151-162`). `auto-stop-proof` deletes both forms; the rule below
  covers every form that is left.
- Resuming your own paused task is a separate ceremony page (`render-tasks.ts:1093-1135`, #16, #17), and chat dead-ends
  there (`chat-task-actions.ts:11, 53`, #96).
- The task page More menu has about 10 items (`render-tasks.ts:2866-2878`).

Build:
- Results: **Accept** (ink when ready; outline "Accept anyway" with a reason when something failed), **Send back**
  (note required), **Retry**. Send back picks the road by a fixed rule: an unpublished result gets a revision on the
  same task; a published or merged one gets a repair task. "Run checks" leaves the act row and stays in the Checks row.
- Plans: **Approve**, **Request changes** (note), **Reject**.
- Password field only when the act needs one. One shared function decides it, from the same rules as today
  (`freshlyApprovable`, `localApprovalEligible`, `scope.ts:1642, 2120`; Passwordless; protected and escalated work), and
  every form asks it.
- Resume is one button on the task card. When the plan is no longer approved, it shows Approve instead (no separate
  page).
- More menu: Dependencies, Holds and Task options move to the Plan tab; Evidence pack and Reuse as recipe leave the
  default menu.

Tests: a `result-acts` rule table maps each state to exactly one ink act from the three, plus at most one outline. Send
back's road rule. The password rule table covers protected, escalated, coordinator-filed, Passwordless on and off, and
local owner. Resume refuses when the approval no longer stands.
Journey: open result → leave a line note → Send back → revision appears → Accept (desktop and phone).
Parity: TUI `a` Accept (`c` kept as alias), `b` Send back, `r` Retry; chat cards carry the same three; CLI `task
accept | send-back | retry`.

### Slice 4 — A routing change keeps the approval (decision 3)

Facts: an upgrade or routing change voids approvals and asks for a fake edit-and-save: "This scope predates agent
routing… re-file" (`render-tasks.ts:586-619, 865, 916`, #7), the push "its approval no longer matches the build routing"
(`dispose.ts:464`, #8), and the CLI "the approval sealed under the previous route is now stale" (`operate.ts:10761,
10827`). `approve()` refuses unrouted rows (`scope.ts:1566`). `surface.ts:319`: "phase and size changes require renewed
approval".

Build:
- A new approval covers a **route class** per phase: provider, model tier, how it is paid (subscription, API key, paid
  fallback) and access (permission level, network, check access, write paths). Toolroll may pick the exact model inside
  that class at dispatch, and records it on the run's route stamp. The approve card says so in one line: "Uses Claude
  (everyday tier). Toolroll may use a newer model in the same tier."
- A re-route inside the class keeps the approval. One outside it (higher cost class, a different tier or provider,
  wider access, a trial) shows one Approve with only what changed: "The builder changed from Claude Sonnet to Claude
  Opus. Approve to continue." No "re-file". Unrouted legacy rows get the same one-step Approve, with Toolroll
  re-routing them first.
- **Old approvals keep their exact binding.** They were a yes to an exact route, and widening them to a class would
  mint an approval nobody gave. Only approvals given after this ships cover a class.

Safety: the class goes into the digest, so a changed class is a changed plan. The dispatch belt (`authorityStandsSql`)
and the build belt re-check "exact model ∈ approved class" at the moment of use. Trials stay person-only
(`trialSealStandsSql`, `approval-authority.ts:47`). Earned rules may only narrow cost.
Tests: a re-route inside the class dispatches; each outside dimension refuses (cost, tier, provider, access, trial); a
legacy exact approval never accepts a different model; a forged class field in `approved_route_json` without a matching
digest refuses.
Journey: an upgrade changes the default model in the same tier, and the task builds without asking. A tier change shows
the one-line Approve.
Parity: CLI `task approve` prints the same one-line change; chat cards carry it; the TUI `a` shows it.

### Slice 5 — Fast path: small, watched work starts right away (decision 4)

Facts:
- Sizing exists: `task-sizing.ts` sizes every filing from the description at once (`heuristicSizing`, `:52`, never
  risky), then a classifier (Haiku or Jev) refines it within 5 s (`refineFiledSizing`, `:205`; `SIZING_BUDGET_MS`).
  `makesNoPlan` (`phase-routing.ts:128`) is "small, not risky, routine risk", and such tasks already skip the planner.
- Approval bases are an allowlist (`scope.ts:849-850`, `approvalOf` `:1659-1675`) read by one dispatch predicate
  (`approval-authority.ts:25-44`). Person proofs are `PERSON_PROOFS` (`:20`).
- Model for the code: `fileAndSealUnderMode` (`scope.ts:1472-1514`) files and seals in one transaction.
- Who may approve without retyping already has two rules: `freshlyApprovable` (`scope.ts:1642`) and
  `localApprovalEligible` (`scope.ts:2120`): one approver, standard permissions, not coordinator-filed, not release,
  sandboxed checks.
- Protected work is judged from declared paths (`store.ts:9854-9873`, `approval-policy.ts:99-103`; no paths counts as
  protected when the project protects paths). The built diff can be checked with `protectedChanges`
  (`approval-policy.ts:92`).
- `task add` is an agent-invocable command (`surface.ts:162`, `agentMayInvoke: true`). Under Passwordless, a
  remembered CLI login proves as `cli-login` (`scope.ts:1377`), which any process in the person's shell can use.

Design:

**Who counts as attended.** A person filing their own task, at that moment, from an interactive person surface:
- the console in a browser session (cookie): typed or remembered password, SSO, passkey, or Passwordless session;
- the terminal UI as the local owner (a new `build-now` local-owner act, beside `approve-plan`);
- `toolroll task new` in an interactive terminal, after a typed "Build now? [Y/n]".

Never: `task add`, `--json`, a non-TTY stdin or stdout, a process inside a Toolroll fence, the lead or any coordinator,
lead, runner, remote or API token, the MCP gateway, the chat apps, flows, schedules, webhooks, GitHub or Linear
triggers, issue imports (slice 10), nightly jobs, the release tool, or a revision an agent asked for. Chat gets one-tap
**Approve** on the card instead. That is an ordinary person approval, not the fast path.

**What counts as small.** All of these, decided by one function `fastStartEligible(store, by, input, proof)` that the
New task preview and the seal both call (the seal re-reads it inside its transaction):
- the description's own size is small (`heuristicSizing`), **and** the classifier answered small and not risky within
  its budget. On this road the filing waits for the classifier (5 s at most); no answer means normal plan approval. The
  model can only confirm a size the deterministic rule already gave, never widen it;
- `makesNoPlan` on the routed task: routine risk, default quality;
- the approval gate seals with one approver and no protected work, with declared paths present when the project
  protects any;
- a standard permission profile (never escalated), checks not stored as unsandboxed, no network widening;
- no release or deploy terms, no CI hold, no trial selection in the route, no fallback chain with paid fallback;
- a budget at or under the project's per-build default, and the monthly spend limit not reached; the org policy
  (`scopePolicyRefusal`) has nothing to say;
- the project's **Small tasks start right away** setting is on (open decision 1).

**What is sealed and recorded.** The same plan bytes and digest as a normal approval: goal, requirements, route class,
budget, profile. New basis `fast` in `APPROVAL_BASES`. One `approval proved` ledger row at the seal's instant, with the
person's proof method and a versioned detail: `{v:1, digest, fast:{rule:1, surface, heuristic, classifier:{size,
risky, reason, model}, until}}`. A `task_act` `approved` with `lead = 0`. The task page says "Started right away: a small
change you started yourself", and its Plan tab shows the plan with "Approve plan" hidden.

**When it stands** (a new clause in `authorityStandsSql`, `fastSealStandsSql`, conjunctive with the release, local and
trial clauses that are already there):
- a person proof at the seal's instant, outcome in `PERSON_PROOFS` minus `chat`, and no machine seal;
- no flow trigger event, no coordinator, not a quarantined author;
- the approver still stands in the project, and the project setting is still on;
- **first dispatch within 30 minutes of the seal.** After that it lapses to an ordinary "Approve plan" in Needs you.
  Automatic retries (slice 1) ride the fast seal only inside that window. A person's Retry or Send back is a new person
  act and re-checks eligibility.

**What it never does.** It never carries into a release, carry, merge or publication grant, auto-check or auto-green,
or any mode. A mode never writes a `fast` seal, and turning a mode off doesn't touch one. The result still goes through
the project's checks and the automatic review, and is accepted by a person. A fast task is never auto-accepted.

**The result guard (deterministic, at disposal).** If the built diff touches a protected path (`protectedChanges`),
changes dependencies, lockfiles, migrations or schema files, or exceeds the small cap (open decision 2), the result reads
"This grew beyond a small change. Approve its plan to keep it." Accept is then refused until the plan gets a normal
approval, with the password wherever that approval would take one. This is why a wrong size answer can waste one small
build but can't ship anything unapproved.

**Interactions.**
- *Modes*: the mode road (`fileAndSealUnderMode`) runs first when an active mode auto-approves filings. The fast path is
  for everything else and is person-only.
- *Local owner*: allowed through the TUI `build-now` act. `localSealStandsSql` still applies (local mode on, same
  generation, checks not unsandboxed).
- *Lead filings and chat*: lead-, scout- and coordinator-filed plans never fast-start. The card's Approve is one tap.
- *Budgets*: the plan carries the default per-build budget; the monthly limit is re-read at the seal and at the claim.
- *Results-routing records and trials*: route-result rows record the basis so the Results page can separate fast tasks.
  They stay in their size cohort for earned rules. A route with a trial is never fast. A trial stays a person's approval
  per task (`trialSealStandsSql`).
- *Two-person and requester rules*: any vote verdict, or `notRequester`, refuses the fast path.

**Safety self-review (AGENTS.md), answered in the design.**
- *Check and write together*: eligibility, proof and seal are one transaction (the `fileAndSealUnderMode` pattern), and
  everything is re-read inside it.
- *Never widen implicitly*: turning the setting on is a person's logged settings act. The classifier can only confirm
  "small", never decide it alone.
- *Don't let input choose what's trusted*: size comes from the person's own description and a no-tools classifier.
  Paths, protection, profile and budget come from Toolroll's records. The result guard reads the captured diff, never
  the agent's report.
- *Approvals mean a person's yes to exactly this*: the person's act at filing, on these exact bytes, recorded with its
  proof. Every machine and agent road is excluded by surface and proof method, and re-checked at dispatch.
- *Credentials*: there are no new credentials. The CLI road refuses non-interactive and in-fence use, so a remembered
  login in a script can't use it. Under Passwordless an agent in the person's own shell can already run
  `task approve`; the fast path adds no road past that, and `task add` stays excluded.

Tests (a rule table plus bypass attempts, run against the real store):
- each refusal row: lead token, coordinator, remote or API token, MCP, chat bridge, flow, schedule, webhook, issue
  import, `task add`, `--json`, non-TTY, inside-fence environment, escalated, unsandboxed, protected path, no declared
  paths on a protecting project, release terms, CI hold, trial, paid fallback chain, over budget, monthly limit
  reached, classifier silent, classifier says risky or medium, heuristic medium, setting off, two-person project,
  requester rule;
- standing: the window lapses into Needs you; a signed-out or revoked approver, local mode off or moved, or the setting
  turned off stops dispatch; an edit after the seal reads "changed";
- forgery: a `fast` basis row with no proof row, a proof row at another instant, a `chat` proof, or a machine proof
  never stands; a replayed filing makes one task;
- result guard: protected path, lockfile, migration and over-cap diffs refuse Accept until a normal approval;
- never carries: a fast task can't anchor or join a release, get a merge grant, or be auto-accepted.

Journey: a person types "Fix the typo in the footer" → **Build now** → building within seconds → Ready → Accept (desktop
and phone). The same with a protected path shows Approve plan. A large description shows Approve plan.
Parity: console New task (Build now / Add task), `toolroll task new` (interactive prompt), TUI `n` then Enter. Chat and
lead: one-tap Approve, a named and deliberate difference.

Review: Codex reviews this slice's design before any code, and the code before merge. That is at most 2 rounds, per the
arc review budget.

### Slice 6 — Two pages: Home and Tasks (decision 5)

Facts:
- `route-table.ts:339-362` serves `/inbox`, `/work`, `/next`, `/workbench`, `/board`, `/review`, `/queue`, `/tasks`
  (today a redirect to `/work`), `/morning`, `/activity`, `/done`. The portfolio overview is the Workbench
  (`render-pages.ts:780` "Portfolio"; `pages.ts:64` `portfolioOverview`, `workbenchRail`).
- The legacy `inboxPage` (`render-pages.ts:57`) still carries "Approve a scope / Retry stalled work".
- Push links: `push.ts:230-236` (`LINK_SHAPES`, `CLASS_FALLBACK` → `/next`, `/review`). The service worker's own
  allowlist: `pages-assets.ts:47` `SHAPES`, default `/next`. **Installed phones keep the old worker until it updates, so
  `/next` and `/review` must redirect forever.**
- Other links: `serve.ts:1460-1484` (palette), `shell.tsx:26` (Needs-you count → `/work?view=needs-you`, #109),
  `chat-quiet.ts:112, 184, 243`, `render-chat.ts:317-350`, `nightly-github.ts:512, 873, 886`, `render-pages.ts:228,
  520, 839, 1049, 1253`, `provider-auth.ts:185`, `limits-ui.ts:91`, `publish.ts:665`, and docs under `docs/guide/`.

Build:
- `/` **Home**: Needs you, Running, Waiting. `/tasks` **Tasks**: the list, with views List / Board / Ready / Archived
  and an all-projects scope that replaces the portfolio.
- Redirects (302, query kept where it means something, the same access rules as the target): `/work` → `/tasks`,
  `/inbox` → `/`, `/next` → `/#needs-you`, `/workbench` → `/tasks?scope=all`, `/board` → `/tasks?view=board`,
  `/board?view=order` and `/queue` → `/tasks?view=board&order=1`, `/review` → `/tasks?view=ready`, `/done` →
  `/tasks?view=done`. `/work/put-away` → `/tasks/archive`.
- Push: `CLASS_FALLBACK` points at `/` and `/tasks?view=ready`. `LINK_SHAPES` and the worker's `SHAPES` gain `/` and
  `/t/<id>` (id shape `[A-Za-z0-9._-]{1,64}`), and keep `/next` and `/review`.
- Delete `inboxPage`, `render-next.ts`, the workbench page and rail, and the "clear the queue" links. Repoint every link
  above. Update `docs/guide/` and the README screenshots list.

Tests: `route-table.test.ts`: every retired path is a redirect row with no page handler, and a project-limited person is
redirected without learning another project. Push link rules: new shapes accepted, a crafted `/t/../x` refused, old
fallbacks still accepted. A link sweep: no `href` in rendered pages points at a retired path.
Journey: Home → Needs you → task → back; Tasks list ↔ Board; an old `/next` link on the phone lands on Home.
Parity: the TUI already has one list; `toolroll open --web` lands on Home; chat links point at
the new paths.

### Slice 7 — One-line phone pings with one button (decision 6)

Facts: `PUSH_WORDS` (`push.ts:222-228`) is generic ("the plane needs attention", #63). Chat cards carry every word of the
terms (`chat-terms.ts`). Push payloads hold only static words and machine-minted numbers (`push.ts:239`).

Build:
- Push: one line per class with the task number, "T-12: plan ready", "T-12 is ready to review", "T-12 has a
  question", plus one tap to `/t/T-12`. No titles or terms in push (the privacy rule stays). Web push `actions` adds one
  "Open" button where the platform supports it.
- Chat apps: one line plus one button plus "Details". The button is the next act where consent needs nothing more:
  **Answer** choices inline for questions, **Open result** for results, and **Review plan** for approvals. AGENTS.md
  keeps the full terms visible before consent, so a one-liner never approves; Review plan expands the terms in the card
  and its Approve sits under them.
- Waiting events no longer ping (slice 1).

Tests: the push payload rule table (one line, the `/t/<id>` shape, no free text). Chat cards: the approval button never
approves without the expanded terms. A stale card is refused, as it is today.
Journey: phone push → tap → task page on the right act. A Telegram card → Review plan → Approve.
Parity: the four chat apps share one card builder. The TUI has no pings (named).

### Slice 8 — "Can I merge?" checklist per task (decision 6)

Facts: readiness is spread over `task-status.ts:24-69` (headlines, Project checks, PR CI, Checked at release),
`server/last-checks.ts`, `workspace-ui.ts:271-342`, `release-card.ts`, and the release card's "Still to pass (N)"
(`render-tasks.ts:3064-3071`, #79).

Build: one panel on the task page, "Can I merge?", built from those same sources with nothing recomputed. Rows: plan
approved · build finished · project checks passed on this commit · requirements met (and your checks) · pull request
open · PR CI on this exact head · up to date with main · no conflicts · review comments answered · release check (when
it's a release). Each blocker carries one act:
- machine-fixable ones (rerun checks, update from main) Toolroll does itself and shows as Waiting;
- agent-fixable ones carry **Ask the agent to fix**, which is Send back (slice 3) with a prefilled note naming the
  blocker. That is the person's act, through the same revision road.

It replaces the scattered Ready / publication-grant / release-check wording on the task page.
Tests: the panel reads each source once (the `one-vocabulary.test.ts` pattern). "Ask the agent to fix" posts the same
revision as Send back, with the note. Toolroll never sends an agent back on its own.
Journey: a task with failing PR CI → Ask the agent to fix → revision → all rows green (desktop and phone).
Parity: `toolroll task ready <id>` prints the list (`--json` for agents); lead chat answers "Can I merge T-12?" with the
list; TUI task view shows it.

### Slice 9 — One `toolroll release <branch>` (decision 3)

Facts: the loop between `release <branch>`, `--recover-deploy`, `--release-gate` and `publish-ok`
(`release-cli.ts:47-103`; `release.ts:527-529, 691, 699, 787, 831, 999, 1099, 1230, 1362, 1401`;
`release-authority.ts:160`; `deploy-rescue.ts:53-94`; #64-#74). "The branch is behind main; update it and push"
(`release.ts:1230, 1401`).

Build:
- `toolroll release <branch>` reads the journal and decides by itself: finish forward, roll back, lift a pause the
  journal proves was left before the swap, wait for a person's approval and then resume, or wait for another running
  release (named by host and pid). It prints what it did in one line.
- A held auto-approved release gets a web button on the release task, and the release resumes on its own.
- **Behind main**: Toolroll updates the branch through the hardened git/gh helper and waits for CI. The person's
  approval carries to the updated head only when the PR's own patch against the new main is byte-identical (equal
  patch-id, no conflict resolution). That carry is recorded like the release-once carries (`release_carry`, a new
  reason `main-update`). Any other change asks.
- `--recover-deploy`, `--release-gate` and `publish-ok` stay as hidden aliases under `toolroll internals`.

Safety: this touches the release tool, so the full AGENTS.md self-review applies. Every decision and its write happen in
one transaction with a re-read journal. The `main-update` carry is an approval carry and must prove exact patch identity
at the moment of use. A deploy still refuses unchecked or not-accepted work (`deploy-gate.ts`).
Tests: each journal phase maps to exactly one action. A rerun after a crash at each phase converges. The `main-update`
carry refuses a changed patch, a conflict-resolved merge and a force-pushed head. Two concurrent releases: one runs, one
waits.
Journey (CLI): behind main → updated → CI → checked → merged → deployed, in one command.
Parity: the release task page shows the same one-line status; lead chat reports it.

### Slice 10 — Start a task from a GitHub issue or PR (decision 6)

Build: a "From an issue or PR" field on New task, `toolroll task new --from <url>`, and lead chat "work on <url>". The
URL's owner/repo must match a registered project by Toolroll's own records (`githubIdentityOf`,
`render-pages.ts:1090`, fully anchored forms), never the checkout's config. It is fetched through `runGhTree`
(`onboard.ts:81`), bounded and strictly parsed. Title and body become the goal draft as quoted outside text ("From issue
#41"), and the link is saved on the task. A PR starts a task on its branch only when the head is in the same repository
(no forks). **These tasks always get plan approval**, because their words came from outside (never the fast path).
Tests: foreign host or unregistered repo refuses; a fork PR refuses; hostile body text stays data; the task records its
source and never fast-starts.
Journey: paste an issue URL → plan drafted → Approve → build.
Parity: CLI, console and lead chat share one importer.

### Slice 11 — Keyboard shortcuts on the primary verbs (decision 6)

Build: one keymap for the console and the TUI. `n` new task; `a` the page's ink act (Approve plan, or Accept result);
`b` Send back / Request changes; `r` Retry; `/` search (exists, `browser/search.tsx:125`); `g h` Home; `g t` Tasks; `?`
the list. A shortcut only presses the visible button, so a password field or confirm still appears. Shortcuts are off
inside inputs and when no such button is shown. Hints show on the buttons (`kbd`) and in `?`.
Tests: the keymap is one table shared by web and TUI. A shortcut never posts a form whose button isn't rendered.
Journey: keyboard only, desktop: new task → Build now → Accept.
Parity: TUI help lines (`tui/app.tsx:40-50`) come from the same table.

## What gets deleted

- `NEEDS`/`WAITS` duplicates in `work-index.ts:643-676`; the `stopping`, `history-problem`, `process-needs-attention`
  and `vanished-run` person rows (slice 1; the stop forms go on `auto-stop-proof`).
- The "display only — this is not evidence" caveat on live output (`render-tasks.ts:1710`, `render-history.ts:64`).
- Digest chips on approval and approved cards; the filed-contract panel; "re-file the scope" copy and its edit-and-save
  road; the CLI digest line on the web archive page (`render-pages.ts:1257`).
- Result acts `revise`, `draft-repair`, `rebuild` and `run-checks` as separate act kinds (folded into Send back,
  Retry and the Checks row); the resume ceremony page.
- `inboxPage`, `render-next.ts`, the workbench page and rail, and the "clear the queue" links; page handlers for the
  retired routes (redirect rows stay).
- Lifecycle pushes that need nothing.
- Top-level help for `claim`, `heartbeat`, `reap`, `tick`, `reconcile`, `run settle` and the release recovery flags
  (moved under `toolroll internals`).

## Open decisions (recommendations first)

1. **Fast path default.** *Recommend:* on for installs with one approver (laptop and local owner), off on servers with
   more than one approver until an owner turns it on per project. The setting lives in project settings as "Small tasks
   start right away".
2. **"Small" caps for the result guard and the window.** *Recommend:* at most 3 files and 150 changed lines, with no
   protected, dependency, lockfile, migration or schema file, and a 30-minute window for first dispatch. These are
   constants in one place, recorded in each seal's `rule` version.
3. **Tasks URL.** *Recommend:* `/tasks` is the page and `/work` redirects. The page is called Tasks everywhere. Today
   it's the other way round (`route-table.ts:361`).

## Review

This plan goes to Codex once before slice 1, for the whole arc, with slices 4, 5 and 9 named as the approval-touching
ones. Slice 5 gets its own design and code review. That is at most 2 rounds per arc; anything still open after that
goes to Alex with options.
