# Toolroll — design v0.4

**Standing orders for your agents. Wake me only for these.**

Status: the pre-M0 design, kept as written — the sections below are the
original bet, and [PROGRESS.md](PROGRESS.md) is the ledger of what each
milestone actually shipped and what its adversarial reviews changed.

**Built since this document** (each behind its own Codex review rounds;
the ledger has every finding): the M1–M4 loop as designed; typed
decisions answered from terminal, console, or Telegram; publication
grants (push + PR under exact approved terms; merge stays human);
capability probes and worktree setup commands; the fleet console (board,
workbench, inbox, triage, activity, review queue);
the live worktree peek (a native no-execution reader — names and counts,
never contents); dependency chains and queue ordering (`task
block/unblock/next`); per-worker queue columns with drag reservation
enforced in the claim primitive; and external dispatch (GitHub issues
mirrored as ordinary local tasks under an explicit dispatch grant —
titles validated, bodies never imported, closure latched with
completion-time disowning, done never regressed); the attested
runtime (four providers, tier-2 by versioned conformance). Schema v27.
(Tournaments and labeled comparisons, and the attended core of watched
live sessions, once listed here, were removed in schema v115.)

v0.4 makes the work graph a pluggable backend chosen during onboarding, and adds the supervision rule that makes overnight runs affordable.

---

## 1. The bet

A captain's night orders are written standing instructions for the officer of the watch: *proceed on this course without me, and wake me under exactly these conditions.* The name is the specification.

**Sixty seconds to first value.** One command shows every branch, PR, and open issue in flight across every repo on the machine — before configuring anything, before an agent runs.

**It survives the night, cheaply.** Work dispatches itself from a dependency graph, fails safely, parks a typed decision rather than guessing, and **costs nothing while idle**. In the morning you read a briefing, not a transcript.

---

## 2. Positioning

[agor](https://github.com/preset-io/agor) (preset-io, BSL 1.1) owns the execution-plane category: daemon, browser UI, six agent runtimes, branches with isolated dev environments, MCP-native sessions, multiplayer with RBAC, per-user credentials, token and dollar accounting. We do not compete there.

**Deferred, not rejected:** the spatial board and zones, multiplayer cursors, in-browser terminals, dev-server management. Those come after M4.

| | agor | firstmate | Toolroll |
|---|---|---|---|
| Getting started | init → daemon → open → add repo → wizard | clone a distro, launch a harness inside it | one command, zero config |
| Dispatch | manual — drag a branch into a zone | first mate decides, conversationally | dependency graph + ready-query |
| Unattended | `schedules` fire prompts on a timer | bash watcher wakes the mate on events | daemon tick + failure taxonomy |
| Blocked on a human | conversation history | prose conventions in `AGENTS.md` | typed, validated record |
| Missing credential | env vars you set in advance | — | probed pre-dispatch, ranked by unblocks |
| Surface | web app | repo of conventions, tmux | daemon + CLI + small web UI |

Agor optimizes for a team steering agents *live*. firstmate optimizes for one conversational liaison. **Toolroll optimizes for long-running work nobody is watching** — the operator may be asleep, in meetings, or gone for the weekend; the plane behaves the same.

**Licence: MIT** — a structural opening BSL 1.1 cannot occupy.

### Delegated, not rebuilt

`treehouse` (pool + lease semantics, copied wholesale) · `no-mistakes` (gate) · **`beads` / `tasks-axi` / `Backlog.md` / GitHub Issues (the work graph — see §4)** · `gnhf` (failure taxonomy) · `sandcastle` (schema repair) · `axi` (CLI shape).

---

## 3. Onboarding

The wedge. Read-only, using credentials that already exist — `git` and `gh` are authenticated, so there is **no OAuth app, no client secret, no callback server, no token to store.**

```sh
npx toolroll            # no init, no daemon start, no wizard
```

First run walks the filesystem for `.git`, then per repo:

```sh
git worktree list --porcelain
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads
git diff --name-only <base>...<branch>
gh pr list    --json number,headRefName,statusCheckRollup
gh issue list --json number,title,labels
```

and prints what is in flight. **No agent has run. Nothing has been configured.** Every other tool in this space starts from an empty database it expects you to fill.

**Discovery is total and read-only; management is opt-in per repo.** Toolroll indexes everything it can see and drives only what you enroll.

Adoption is the hard part, not discovery. treehouse's rules apply: untracked files count as dirty even when repo config hides them; in-use is detected from running processes; reconstructed state is marked leased-until-verified.

### Choosing the graph

Detected, not asked — and **detection is not authorization.** Finding a populated tracker tells you it exists; it does not tell you the operator wants Toolroll scheduling, closing, or restructuring its contents.

```
  Work graph — detected in your repos
  ▸ beads            .beads/ in 2 repos · 47 open · native deps · runtime ok
    GitHub Issues    112 open across 6 repos · native deps · gh 2.67 too old
    built-in         local task store · nothing to install
  Nothing is enrolled. `toolroll enroll <repo>` grants write access.
```

**Data and runtime are detected independently.** A populated `backlog.md` with no working runtime is displayed and recommended; it is not dispatchable. That is the correct failure mode for unattended operation — better a visible gap at 9am than a dead loop at 3am.

**The ladder:**

1. A previously enrolled, healthy backend with a valid write grant.
2. The *sole* populated, healthy repo-local tracker with native readiness and dependencies, and an available runtime — beads, tasks-axi, Backlog.md. **Several populated → stay discovery-only until one is enrolled.** Task count is not write authority; the biggest tracker may be the abandoned one.
3. GitHub Issues **only** where existing native dependency use signals real tracker intent, and the operator confirms repo write scope.
4. The built-in local task store.
5. Edge-free GitHub Issues stay visible in discovery but are never an autonomous-scheduling default.

GitHub Issues has native `blocked_by` dependencies and sub-issues over REST, so an earlier draft's "no deps" was wrong. Native relations are used where a capability probe confirms them — including the `gh` version, since dependency fields need `gh ≥ 2.94` even though the REST route works on any version. Cross-repository dependency semantics are **unverified and fail closed.**

Switching later does not lose Toolroll's own state, because Claim, Run, Decision, and Capability reference tasks by `(backend, external_id)`. See §4.

### Capability preflight

The most expensive overnight failure is a missing or expired credential found at 3am, after an agent has burned 40k tokens discovering it.

Capabilities are inferred from what is on disk — `.env.example`, `.mcp.json`, `supabase/config.toml`, CI `env:` blocks — each with a cheap liveness probe:

```
gh auth status · supabase projects list · mcp initialize <server> · test -n "$KEY"
```

**Presence is not enough**; an expired key costs more than a missing one. Probes run at enrollment and at every checkpoint, and a task whose capabilities are not *verified* does not dispatch.

### Secrets

**The control plane stores metadata about secrets and never their values.** Values live on the runner — OS keychain, a gitignored `.env`, or an existing manager (`op read`, Doppler, `gh secret`). A value pasted in the browser travels over the local runner connection into the keychain; the control plane records only `present, verified at T`.

The human pastes credentials. Agents never do.

---

## 4. The graph is a backend

Two proven graph layers already exist — `beads` (26k★) and `tasks-axi`, which openly borrows beads' dependency and ready-query model. Rebuilding either would re-fight a solved problem and put every task-CRUD feature request on us.

The honest statement of the boundary:

> **Toolroll owns a minimal local task store as a fallback, adapts richer external trackers when present, and keeps operational Claim, Run, Decision, Capability, and event state in a backend-independent overlay.**

An earlier draft claimed we own *no* task store while shipping a built-in one. That was self-deception: anything that can create, store, transition, and link tasks is a task store, whether it takes 150 lines or 15,000. The defensible position is not "we own nothing" — it is "we own something deliberately small and decline to compete with full trackers." The built-in ships enough authoring and inspection to be usable, and no search, labels, comments, or sync.

**Never install anything.** Discovery executes no package manager, package runner, or third-party initializer — not `npx -y tasks-axi`, which fetches and runs code, and emphatically not `bd init`, which can modify agent integrations and hooks, stage files, and create a bootstrap commit. When installation or initialization is needed, Toolroll prints the upstream command *and a summary of its side effects* as text. The operator runs it outside Toolroll. Management then requires separate write enrollment.

```
GraphBackend
  list_ready(caps) → TaskRef[]        create(spec) → id
  get(id) → Task                      set_state(id, state)
  add_edge(from, to)                  hold(id, reason, until) / unhold(id)
```

**Scheduling edges are never emulated.** A dependency graph the backend cannot see is shadow data: other tools and teammates read a task as ready while our private overlay says it is blocked, and the divergence becomes migration-critical the moment anyone wants out. If a backend has no native edges, it is **ineligible for dependency scheduling** — not repaired with invisible ones. Holds may live in the overlay, because a hold is an operational pause rather than a claim about the work's structure.

**No network calls in the scheduler hot path.** GitHub allows 5,000 authenticated REST requests/hour; reading dependencies for 112 issues once a minute is 6,720 requests/hour before any ordinary query. External backends are read into a **local materialized snapshot out of band**, and dispatch stops when the snapshot's freshness bound expires rather than degrading into rate-limit failures at 3am.

**What we own regardless of backend:**

| Record | Carries |
|---|---|
| **TaskRef** | `(backend, external_id)` · zones[] · capability_requirements[] · park_rate |
| **BackendGrant** | repo · backend · exact paths or GitHub repos · allowed mutation classes · task selector · credential scope · whether git history observes the writes |
| **Claim** | task · runner · `lease_id` (immutable) · `lease_generation` (fencing) · expires_at · heartbeat_at |
| **Run** | task · runner · role · base_revision · branch · provider · model · tokens · parent_run · caused_by_event |
| **Decision** | run · urgency · state · recap · question · options[{id,label,consequence,reversible}] · recommendation · evidence[] · assignee · deadline |
| **Capability** | repo · kind · name · required_by[] · probe · status · last_verified_at · expires_at — **no value column, ever** |
| **SetupRequest** | capability · blocks_count · instructions · verify_command |
| **Runner** | host · credential_hash · scopes[] · repos[] · capacity · agents[] · quotas[] · heartbeat |
| **Artifact** | run · kind · runner_ref · retention_until · redacted |
| **Event** | seq · event_id · actor · aggregate · aggregate_version · causation_id · correlation_id |
| **Notification** | subject · channel · dedupe_key · attempts · delivered_at · receipt |

Every record carries `workspace_id` and `actor_id`; every mutation takes an `idempotency_key`.

**`Claim` is the one that matters.** Dispatch is a compare-and-swap on `(task, lease_generation)`; a completion is *accepted* only if the generation has not moved. A runner that dies holding a lease is reclaimed on expiry and its late completion fenced out. Without it there is no scheduler, only a race. No existing graph backend provides this — which is precisely why it is ours.

The distinction between accepting a completion and replaying one is load-bearing, and M1's duplicate-completion reconciliation lives in the gap. A lease that never released and has been superseded is fenced: its work was never accepted and must not be. A lease that *did* release and was superseded afterwards is a different thing — its work was accepted at the time — so a retry of that same completion is idempotent rather than refused. Answering "fenced" there would tell an honest runner its work never counted, which is false.

Evidence lives on the runner; the control plane stores a reference and serves it through a signed, short-lived runner proxy.

### Writing to someone else's store

Discovery is always read-only. Managing a repo requires a persisted per-repo **`BackendGrant`** that displays and constrains exactly what Toolroll may touch: which files or GitHub repos, which mutation classes, which tasks, which credential scope, and whether the changes will be visible to other tools or land in git history.

**Default write scope covers only tasks explicitly enrolled or created through Toolroll** — never every open task it happened to find. Agents operate strictly inside the grant; widening it takes another human action.

### When a backend vanishes

A deleted `.beads/`, an uninstalled binary, a moved repo, an incompatible schema, and a revoked API token need different diagnosis and different recovery, so this gets its own path rather than borrowing the expired-credential one.

The operational overlay **stays writable** — it must still fence claims, preserve runs and artifacts, and record mutations pending replay. Only the last-known task projection goes read-only. New dispatch stops for the affected backend; work already running preserves its result without claiming backend completion. The operator gets a typed **`BackendIncident`**, which reuses `SetupRequest`'s ranking, notification, and presentation but not its capability schema.

---

## 5. Supervision costs nothing

**Never let an LLM poll.** This is the rule that decides whether an eight-hour unattended run is affordable.

`firstmate` gets this right: a bash watcher sleeps on the fleet and wakes the agent only when something needs attention — "event-driven, zero-token supervision." v0.3 had a driver agent monitoring the gate, which burns tokens per turn, all night, mostly to observe that nothing changed.

**The daemon does everything that does not require judgement**, at zero token cost: scheduler ticks, capability probes, process and lease reaping, ready-set computation, PR and CI polling, artifact collection, notification delivery.

**An agent is invoked only to:** build, take a gate turn that has genuinely new output, repair a finding, or compose a decision.

That gives a testable invariant rather than a vibe: **an eight-hour run with twelve tasks should show near-zero token spend across idle windows.** The event log makes it measurable, and a regression is a bug.

---

## 6. The night

```
daemon tick (free) ─► gates ─► claim ─► lease worktree
                                  │
                         BUILDER (Opus, 150–200k)
                         spec → failing test → implement → verify
                         commit · HANDOFF: INTENT
                                  │      (agent exits; watcher sleeps)
                         DRIVER (Sonnet, few-k, woken per event)
                    ┌─────────────┼─────────────┐
               auto-fixable  needs a human    green
               apply         PARK → briefing  open PR
                    └────────► tick ◄─────────┘
```

Parking never stalls the loop. A blocked task steps aside and the scheduler returns to the ready set.

**Failure handling, adopted from gnhf rather than reinvented** — including the parts most tools omit: agent-reported failure → next iteration immediately; retryable infrastructure error → exponential backoff; permanent error (exhausted credit, revoked auth) → abort with the run log; **commit failure → preserve the work for repair**, never blanket-reset; complete no-op iteration → counts as a failure; three consecutive → abort. Plus mid-iteration token caps, graceful stop, persisted notes, resume, and a permanent exit summary.

One deterministic environment repair is narrower than that general retry
policy. `verify set --self-heal` first previews the exact approved setup and
its digest; confirmation must echo it with `--setup-digest <shown> --yes`. If
the project check cannot start because a required project executable is
missing, the worker can run that setup once and retry the exact check once.
Ordinary failures, timeouts, and executables that exist but cannot run do not
trigger this setup replay. It records all three steps in one evidence log and stops if
the setup or project check changes, setup fails, files change, the checkout
moves, unchanged files cannot be confirmed, worker custody is lost, or the
executable remains missing. This is not permission to invent a shell command,
install system software, or retry without a bound.


A failed project check or verification timeout on a saved result can instead
start the existing bounded repair loop when the project's signed mode allows
`repairAuto`. The complete machine receipt and log must still match the
candidate, original run base, scope and approved command. The repair inherits
the same scope, rubric and routes; it shares the existing attempt cap,
no-progress stop and duplicate prevention with review-driven repairs. A failed
project check remains a repair target even if every individual criterion was
reported as passing. No database migration or additional scheduler is involved.

The repair builder receives the verified failure as quoted evidence. It
inspects the failure first, can rerun the failing test once to diagnose a
suspected timeout or transient failure, and runs affected checks while fixing.
The unchanged full command runs at the native final gate for the result;
independent review follows a passing gate. A repair that needs no code edit
still gets a fresh gate and review. Prior failures remain recorded. Test skips,
weaker assertions, higher timeouts and changed approval terms are not repairs.
Missing or changed evidence, lost custody, changed setup authority, holds and
stops require attention rather than another unattended edit.

A builder working against signed acceptance criteria can finish with only its
short terminal handoff. The controller captures the exact diff, current source,
approved check and output; one existing independent reviewer assesses those
facts against the goal and every criterion. Available evidence and passing
checks do not mean the goal is satisfied. Direct assessment is required even
under default quality, and a repair chain resolves only after that assessment.
An optional screenshot-only inventory uses the existing bounded proof parser;
no criterion restatement or self-reported changed-file list is needed. Explicit
legacy proofs retain their original integrity and claim-validation rules.

Missing observations stay named evidence gaps and do not create report-writing
repairs. Contradicted behavior uses the existing bounded repair path; human-only
acceptance still requires a person. Builder caveats are supplied as sealed notes,
not as proof of success. A fresh review can also assess an older result stopped
solely by missing builder proof, using its original source, command authority
and gate receipt. It records that reassessment, preserves the old artifacts and
never runs a replacement gate merely to create paperwork. Changed candidates,
failed checks, stale authority or damaged evidence cannot take that shortcut.

Rollback proves worktree cleanliness and base revision first. `git reset --hard` leaves untracked files behind and can destroy repairable work.

**Malformed decisions get bounded repair, not an instant 422** — the adapter
resumes the same session with a compact error so the agent re-emits only the bad
payload (sandcastle's mechanism), twice, then emits `malformed-decision`
(hyphenated, like every public reason token).

Structured planner and reviewer handoffs use the same bound with a stricter
contract. The plane may strip only transport syntax that cannot change meaning
(a byte-order mark, one whole-response code fence, or one JSON-string wrapper),
then applies the ordinary strict parser. A remaining failure returns the exact
validation errors as inert JSON data to at most two child runs in the same
resumable session. It never fills a field, extracts JSON from prose, invents
scope or acceptance criteria. Every reply is sealed as `structured-output`
evidence on the run that authored it, even when a later provider-status or
session-identity check rejects it. The planner
re-proves branch, HEAD, and tree after each turn; the artifact-only reviewer
re-verifies its sealed scratch bundle under the provider's cwd-restricted,
read-only review profile. Transport events remain bounded; an over-limit event
becomes an explicit byte-counted receipt rather than false silence. Accepted
correction children close in the same transaction as the root plan/decision
fence or review ingest, and result queries exclude correction bookkeeping. No
session means no correction, and provider, custody, identity, or tamper failures
keep their own fail-closed outcome rather than being misclassified as formatting
work. A reviewer can judge only the exact scope digest and complete criterion
matrix attached to the source build; later scope revisions never apply
retroactively.

**A revision inherits the contract, never the grants.** Annotation
revisions, CI repair drafts, and criterion repair drafts all file through
one boundary that proves the source task, run, scope digest, and brief
custody inside its transaction, then carries the source's goal, exclusions,
touches, exact rubric, quality, posture, budget ceiling, route overrides,
and pins verbatim — the installation's defaults of the day never downgrade
or widen them. The route and profile are re-resolved for a fresh approval; the approval stamp, publication and
merge grants, and the plan never inherit. A
detour through an annotation or CI revision keeps the repair chain's root
and remaining automatic bound. The full field-by-field policy is
[docs/REVISION_TERMS.md](REVISION_TERMS.md).

**Irreversible options never auto-apply**, regardless of stated confidence.

### The morning

One ritual. Gaps rank by **how many tasks they unblock** — never alphabetically.

```
toolroll ── good morning ──────────────────────
  overnight    7 PRs · 2 aborted · 412k tokens · $18.40
  idle spend   $0.02                    ← §5, measured
  ▸ BLOCKED    1 gap unblocks 3 tasks
       SUPABASE_SERVICE_ROLE_KEY — oddcircle
       expired 2d ago    [paste] [verify]
  ▸ DECIDE     3 waiting
  ▸ REVIEW     7 PRs
```

Notifications are a **durable outbox** — attempts, dedupe keys, receipts, escalation, quiet hours, deep links.

---

## 7. The decision record

The convention agents drift from in prose becomes a schema the server validates. `POST /runs/:id/park` returns **422** without a recap, options, and a recommendation.

```json
{
  "urgency": "blocking",
  "recap": "Tightening the onboarding form. The agent added a migration
            dropping `signup_source`, which analytics reads.",
  "question": "Drop the column, or keep it and backfill?",
  "options": [
    { "label": "Keep + backfill", "reversible": true,
      "consequence": "Analytics unaffected. +1 migration." },
    { "label": "Drop it", "reversible": false,
      "consequence": "3 dashboards break silently." }
  ],
  "recommendation": 0,
  "evidence": [{ "kind": "diff" }, { "kind": "screenshot" }, { "kind": "test" }]
}
```

Typed rather than transcribed, so it renders identically every time and fits on a phone. `reversible` being a *field* is what lets the scheduler refuse to auto-apply it.

firstmate converged on the same primitive — "escalates only real decisions" — implemented as prose in `AGENTS.md`. That it was reached independently is evidence the primitive is real; that it is prose is the gap we fill.

A missing credential is **not** this. `SetupRequest` is simpler — what is missing, what it blocks, how to supply it, how we verify. A missing key is not a judgement call.

---

## 8. Dispatch gates

1. **Dependencies satisfied** — from the graph backend, or the overlay when it lacks edges.
2. **No active hold.**
3. **Capacity** — a runner has this repo, a free slot, the role's agent, **and remaining provider quota.** A free CPU slot against an exhausted quota is not capacity.
4. **Capabilities verified** — §3.
5. **Claim acquired** — CAS on the lease generation. Losing is normal, not an error.
6. **Attention budget** — above `--max-open-decisions` (default 5), stop dispatching tasks whose measured `park_rate` exceeds threshold.

**Cut in v0.2:** refusing dispatch on predicted file-glob overlap. Tasks cannot honestly predict their file surface before exploring, and inferring it converts uncertainty into authoritative-looking bad data. Branch isolation is the concurrency boundary; `zones[]` survive as protected-path policy and advisory scoring; real overlap is computed after the fact from `git diff --name-only` across in-flight branches, before integration.

---

## 9. Role routing

**Tier is economics** — a park → decide → resume roundtrip is ~30k tokens on a cheap driver against ~200k on the builder, which holds 150–200k of context resent every gate turn. **Provider is correctness** — a different vendor catches a different bug distribution.

| Role | Provider | Tier | Context |
|---|---|---|---|
| Planner | claude | Opus 5 | interactive |
| Builder | claude | Opus 5 | 150–200k |
| Driver | claude | **Sonnet 5** | few-k, event-woken |
| Reviewer | codex | — | fresh |
| Repair | claude | Opus 5 | resumed |

Config, not law. `Run` records resolved provider, model, and tokens, so role cost is measured — and the briefing reports real dollars.

A builder is never resumed *to drive the gate*, but **is** resumed when a finding needs real code fixes.

---

## 9b. Principals, and what each may do (Parity II foundations)

Four principals, not two — because "the agent" conflates the supervised
process with the machinery that supervises it:

| Principal | Credential | May |
|---|---|---|
| **operator** | password (scrypt, typed again per act) | approve scopes, steer, grant/revoke authority, answer decisions, enroll devices, clone repositories |
| **coordinator** | minted token (operator ceremony), hashed, shown once; immutable cid; repo allowlist bound at the mint | rate-limited proposal filing through the canonical door — filings are quarantined until a password ceremony seals their scope; reads inside the allowlist. Nothing else is expressible. |
| **runner** | minted token, hashed, shown once | claim, heartbeat, release, tick; every beat re-authenticated |
| **attempt** | none — it is the supervised process | submit its prescribed outputs (handoff, park decision) through the builder's own protocol files; nothing else |

**The MCP threat boundary.** stdio is a transport, not an authority
sandbox: the boundary the coordinator credential draws covers the MCP
surface and every remote or bridged caller behind an MCP host. A
same-UID process on the machine can open the SQLite file directly —
local OS-user compromise is out of scope, and the db, WAL, SHM, and
their directory are created 0700/0600 to keep it that way.

Authorship always derives from an authenticated principal. A
caller-supplied author string is FORBIDDEN as authority anywhere — the
compile-level `VerifiedAuthor` brand on steering enforces the rule at
its sharpest point, and briefs promote only verified notes into the
OPERATOR STEERING fence.

**The execution-profile rule (ruling 10).** An approval binds WHAT RUNS:
provider, exact model (always on the argv — nothing resolves later),
permission argv, sandbox mode, turn and clock bounds, and the repair
model, sealed as an immutable snapshot at the yes. Dispatch REDERIVES
the approved digest from the live fields plus the snapshot immediately
before every invocation — builder and repair alike — and anything that
moved refuses with `stale-approval`. Scopes that cannot say exactly what
would run are `profile-unresolved`: filed, visible, unapprovable until
restated. Approvals from before v24 are grandfathered: their signed
bytes untouched, their effective profile pinned at migration and
labeled.

**The positioning turn, stated.** Toolroll is unattended-first. The
maintenance budget is explicit: exactly ONE tier-2 provider adapter is
funded; adding another requires retiring the first or a new reviewed
strategy decision.

## 9c. Watched sessions (removed in v115)

Schema v25–v114 carried an "attended core": one watched attempt held open
under a signed authorization, with a mid-session conversation, crash
custody by a supervisor process, and continuations. It was never used and
was removed in schema v115. Opening an older database ends any attempt a
held session still owned as an ordinary interrupted attempt (outcome
`failed`, reason `interrupted`), hands its claim back, and queues its task
again; the authorization, turn and custody tables are dropped, while the
`run.attended_authorization`, `decision.session_turn` and
`decision.delivered_turn` columns and the `interrupted` and `held` words in
old rows stay readable as history.

## 9d. Attested runtimes (Parity II Phase 3)

Two tiers of provider, by what the plane can prove — never by brand.

**Tier 1** (claude, codex, openrouter-on-codex) is the audited core:
transports read at the source, money contracts stated as data, behavior
covered by the suite since each shipped. Their spawn road carries no
version gate — the audit rows say exactly what is and is not proven.

**Tier 2** (gemini, the only funded adapter) is admitted by **versioned
semantic attestation**: the adapter's conformance fixtures were recorded
against an exact CLI version, and dispatch runs ONLY inside the attested
range `[floor, ceiling)`. The check lives in the one spawning gateway,
immediately before every spawn — build, plan, and repair alike — against
one PATH-resolved realpath that is both probed and executed, revalidated
by a fresh stat (`dev/ino/ctime/size`) each time. What that proves,
exactly: the version of the binary observed at spawn time — not an
exclusive lock on the path. Only plain `x.y.z` releases attest;
prereleases and nightlies are out by rule. The probed version is stamped
durably on every run in the same pre-spawn write as `provider_started_at`,
and even a refused race stamps what it refused.

Out-of-range never claims: the tick's pre-claim skip reads the SEALED
approval snapshot's provider (planner runs read their own resolver) and
skips in words — no claim, no run, no worktree, no wake churn. The
gateway's own refusal covers only the race where the binary changes
mid-pass, disposes like any infrastructure failure, and consumes the
road's existing strike or turn budget.

Capabilities are EARNED by fixture, not asserted: gemini's terminal
contract (exit 0 believed only with init + a success `result`), its
minted session identity (`--session-id` chosen by the plane, the init
echo proven equal), its native resume-by-UUID in the same working directory,
and its per-invocation usage scope each trace to a test. A resumed correction
uses that proven session; minting a new identity and resuming are mutually
exclusive. Unproven fields stay null and fail closed.
Money honesty is unchanged: gemini reports tokens, never dollars, and
every spend rollup states
measured coverage ("$X measured across N of M runs") instead of summing
a lie.

**Re-attestation is a release act**: run the conformance suite against
the new CLI, move the ceiling in a reviewed commit. **Removal criterion**
(strategy ruling 13's N): three consecutive minor releases failing
conformance without a fixable adapter change retire the adapter, typed
and stated on the providers screen. A second tier-2 adapter requires
retiring this one or a new strategy decision — there is no quiet
accretion road.

The audit rows carry the leak surface in words: `~/.gemini/settings.json`
hooks run inside every invocation on a machine that has them, project
settings and GEMINI.md ride along, and an API key in env is visible to
the shells the agent runs — cached login or ADC is the recommended
unattended auth road.

## 10. Milestones

| | Scope | Ships when |
|---|---|---|
| **M0** | Zero-config discovery · **graph-backend detection + adapters (beads, GitHub Issues, built-in SQLite)** · overlay records · **Claim/lease with fencing** · idempotency · AXI CLI. No agents run. | `npx toolroll` shows every branch, PR, and issue in flight. **Useful before it is autonomous.** |
| **M1** | Runner registration **with auth from the first commit** · heartbeat · treehouse adapter · claude builder · reconciliation for dead runner / orphaned worktree / duplicate completion. | one task goes queued → branch → commit unattended |
| **M2** | Capability probes · SetupRequest · secrets-on-runner · morning briefing · notification outbox. | fill one gap, three tasks start |
| **M3** | Decision schema · validation · bounded repair · driver role · evidence artifacts · web decision view. | a park renders as one screen, answerable on a phone |
| **M4** | The loop: gnhf failure taxonomy · **zero-token supervision** · quota-aware scheduling · survives crash / duplicate / disconnect. | **queue twelve, sleep, wake to PRs and a briefing — with near-zero idle spend** |
| — | *deferred:* spatial board and zones · multiplayer · in-browser terminals · Postgres · RBAC · export | after M4 earns them |

M4 is the product. M0 is what makes anyone install it long enough to reach M4.

Adopting a graph backend removed roughly a third of M0 and replaced it with adapters — which also means interop on day one instead of a competing store.

---

## 11. Open before M0

1. ~~Whether the graph should project over beads.~~ **Resolved in v0.4:** pluggable backend, detected during onboarding, built-in SQLite only as fallback.
2. ~~Does agor already have an approval primitive?~~ **Resolved:** no. Agor gates *tool calls* (`auto-approve | supervised | manual`), which is a synchronous "may I run this command?" carrying no semantic content. A decision record is asynchronous, describes a judgement call, and lets the loop continue without you. Their callbacks are agent-to-agent, not human escalation. Also confirmed absent: approval inbox, credential preflight, dependency-graph scheduling, failure taxonomy — their Scheduler is cron-style triggers for templated prompts. **Re-check before launch:** *Cards (Beta)* and *In-Conversation Widgets* are plausible substrate for structured decisions and are still moving.
3. ~~Does the loop ever push to `main`?~~ **Resolved: never.** A pull request is always the terminus. The gate is only trustworthy because nothing reaches the default branch without passing it, and an autonomous loop with commit rights to `main` has no safe failure mode.
4. ~~CLI alias.~~ **Resolved:** the command is `toolroll`; `standing-orders` still works as the older name.

---

## Appendix — history

**v0.4** — graph becomes a pluggable backend selected by detection during onboarding; `TaskRef` overlay replaces an owned `Task`; adds §5, the zero-token supervision rule, after finding firstmate's event-driven bash watcher; M0 rescoped from schema ownership to adapters.

**v0.3** — repositioned on onboarding and unattended operation after finding agor; deferred the spatial board, multiplayer, RBAC, and Postgres; made MIT a stated differentiator; promoted zero-config discovery from feature to wedge.

**v0.2** — followed an adversarial Codex review that falsified v0.1's thesis. Removed: "every GUI-first orchestrator has stalled" (contradicted by the doc's own table — Orca and Agent Orchestrator are desktop and thriving); "no other tool is pitching that" (gnhf and Orca both do); "every adapter ships with a fallback"; "every record carries workspace_id"; "the schema already supports all of it"; "builder dies, never resumed"; glob-collision as a dispatch gate. Added: Claim/lease with fencing, Capability, SetupRequest, Artifact, Notification outbox, secrets-on-runner, ingestion, role routing, quota-aware capacity, schema repair, gnhf taxonomy, runner auth at M1.

The corrected argument for a small core is **maintenance surface**, not interface. opcode reached 22k★ and stopped because a wide desktop surface coupled to one fast-moving agent CLI produced an undrainable maintenance queue. Own durable state agent CLIs do not want; keep vendor-facing surface behind narrow, contract-tested adapters; ship nothing an agent CLI's roadmap will obviously eat.

**Sources.** Codex design review (default model/effort, read-only, 2026-08-10). Landscape figures from the GitHub API, 2026-08-10/11, point-in-time. Workflow patterns from Jason Ku's *A Meta Engineer's Agentic Engineering Workflow* and `agents-md-snippets`; mechanisms from `treehouse`, `no-mistakes`, `gnhf`, `firstmate`, `tasks-axi`, and `axi`. Agor and firstmate capabilities are from their READMEs, not hands-on use.
