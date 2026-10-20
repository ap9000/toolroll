# The light cockpit (v6)

Alex, 2026-10-19, after comparing herdr-gpui: "copy the states and adjust for anything missing — do the quick start and
then 3 and 4 — we need the direct steer / terminal view option for every agent that's running if possible."

v2 answers Codex's review of v1 (NO-GO, 16 findings, marked **[Rn]**). v3 answers round 2 (C go-to-spike; R1, R10,
R13, R15, R16, N17 and N18 open), marked **[r2-…]**. The answers are split into phases by risk.

- **Phase A** is display and attention. It changes what people see and when they are pulled in, never what anyone may do:
  §1 states and roll-up, §2 sidebar, §3 attention, §4 the composer wherever steering already works, §5 terminal-style
  view.
- **Phases B–E** each change an authority or execution boundary, so each has its own contract and its own review:
  B is quick start with password freshness, C is Codex continuation, D is ACP multi-turn, and E is a local terminal.
- **Honest scope.** "Nothing weakens a gate" holds for phase A only. Phase B changes what an approval proves about
  re-authentication, and says so (§B2) **[R2]**.

## Phase A

### §1 States, from separate facts [R8]

`src/agent-state.ts` derives a compact display state from **four separate facts**, never stored as one enum:

1. **activity:**
   - queued
   - waiting (one of: on a dependency, a quota or sign-in, another computer, time, a reply or CI)
   - running
   - stuck (running with no output for `STUCK_AFTER_MS`, or a tool running for `TOOL_STUCK_AFTER_MS`)
   - pausing / paused
   - stopping / stopped
   - finished
2. **outcome:** none, built, no-change, failed (run outcome), or checks-failed (built, but its project checks
   failed: `task-status.ts`'s rule).
3. **open obligation:** a `NeedKey` someone must act on (a question, plan/scope approval, a decision, a result to accept,
   sign-in…), with who may act.
4. **unread:** per person, whether they have seen this exact finished version (§3.5).

**Display state** (the first glance; the second line stays the detailed `task-status.ts` headline):

| Display | When |
|---|---|
| `needs-you` | an open obligation exists (shown as "needs you" to someone who may act, "needs someone" to others) |
| `failed` | outcome failed or checks-failed, and no newer attempt is running — **stays until the failure is resolved** (a retry, a revision, a stop, a cancel), never cleared by looking |
| `stuck` | activity stuck |
| `working` | running, pausing, stopping |
| `waiting` | queued or waiting (with the reason as its line) |
| `paused` | paused (says by whom) |
| `done` | finished, outcome built/no-change, no open obligation, and unread for this person |
| `idle` | everything else |

- Looking clears **only `done`**. A failure, an approval or a result to accept are never cleared by looking.
- Roll-up order: needs-you > failed > stuck > paused > working > waiting > done > idle.
- Every roll-up carries counts of each.

**Complete aggregates, not the board's rows [R9].** Counts come from aggregate queries, separate from the paginated
rows the Agents board shows:
- **tasks** (one per task family: its current version's state; superseded revisions count once);
- **obligations** (`NeedKey` rows, including plan approvals with no builder run, planner questions, flow decisions);
- **running attempts** (every role: builder, planner, scout, reviewer, repair).

Rules:
- Visibility (account projects, server ceiling) is applied before counting.
- An obligation the viewer can't act on still counts, as "needs someone".
- Words and colours come from this module only, and `one-vocabulary.test.ts` grows to enforce it.

### §2 The sidebar

A rail in the console chrome on every non-sensitive page **[R14]** (see the sensitive-page rule below):
- projects, each with its roll-up dot and counts;
- the open project's tasks with something live or unread: a dot, the title, one line (agents-board's row line for a
  running attempt, the obligation's sentence for a need);
- a click opens the task's live view.

Updates come from **one scoped summary subscription per page** **[R12]**: a new SSE room `summary:<account>` carries
versioned count snapshots. It is not one room per row (the server allows one agent room per page), and it is not an
agent-view lease. Being in the sidebar never counts as watching or seeing anything.

On a phone, a header chip ("2 need you") opens the rail as a sheet.

**Sensitive pages [R14]:**
- A page is classed sensitive explicitly (a field on the screen descriptor), not by whether a password input
  renders. This matters once freshness (phase B) can remove the field.
- Sensitive pages render no sidebar and load no extra chrome script.

### §3 Attention

1. **Title and icon [R12].** "(2) Toolroll — shop" and a dot on the favicon. Both are driven by the summary
   subscription, which a hidden tab **keeps** (it is not a viewing lease). The agent-view lease still closes when a tab
   is hidden, as today, so a hidden tab never counts as watching.
2. **Attention items with identities [R11].**
   - Every needs-you notification gets a stable subject (task, obligation key, version).
   - The watch check (`watchedPing`) moves from three kinds to any subject, and is re-checked at the **final send
     boundary** of every channel (`pushSendFence` and the chat/Telegram delivery fences), not only at claim time.
   - Held deliveries are re-evaluated when the watch ends.
   - `pingAllowed` (responsibility, mute, own acts) and unconditional security alerts are unchanged.
   - Residual race, stated: a delivery already handed to the network can't be recalled.
3. **Sound.**
   - An optional chime when a new subject needs you and no visible tab is watching it. Off by default, set per
     browser.
   - It is deduplicated across tabs with a BroadcastChannel keyed by subject and version, and is never replayed on
     reconnect (the snapshot version is remembered).
4. **Usage chip [R16].**
   - It shows the service with the highest **observed** use of a comparable window: subscription windows from
     `provider_limit`, as a percentage, with the window's name and reset ("Claude 5-hour · 82% · resets 3h").
   - Staleness is by **age of the observation**, as `limitsView` already does, not by window length **[r2-R16]**:
     past 30 minutes it reads "as of 2h ago" and stays visibly stale. A window with no known length or reset says
     "resets: unknown".
   - API-key budgets are a separate line in the details, not compared.
   - It is server-side visible only to those `limitsView` allows today (operators), and scoped to this installation's
     runners.
   - A click opens the existing details.
5. **Seen [R11].**
   - A finished attempt is marked seen only when its **finished version** is displayed: its result or its finished
     live view.
   - A visit while it was running doesn't count.

### §4 The composer, wherever steering works today [R10]

The steering composer (Send, Pause and steer, Stop) appears on every live view of a running attempt: the agent's page,
the sidebar's panel, the task page, a flow card's task. It shows only the actions the attempt supports.

**Phase A capability table (role × provider × locality):**

| Attempt | Send | Pause/resume | Stop |
|---|---|---|---|
| Builder, Claude, this computer's runner | live (stdin) | live | yes |
| Builder, Codex / OpenRouter / Gemini / ACP | mailbox ("reads it at its next check") | no | yes |
| Repair *task* (a task filed to fix a result: a builder run) | as its provider's builder row | as builder | yes |
| Protocol repair (`role='repair'` child of a builder attempt) **[r2-R10]** | **not offered**: its brief reads no steering, and the builder's mailbox is closed before it starts | no | **Stop targets the owning attempt** (the repair is part of it), said in the button ("Stop this attempt") |
| Builder on another computer's runner | as its provider row (the runner relays) | as provider | yes |
| Planner, scout, reviewer | **not offered**: they read no mailbox and have none (reviewers are read-only) | no | yes |

Rules:
- The composer says so plainly where a capability is missing ("This planner can't take notes; stop it to change its
  course").
- Every send carries the exact attempt it was written for: a stale card's send is refused.
- Drafts persist per attempt (as agents-view does).
- Delivery status is truthful ("Sent", then "Picked up" or "Not picked up").
- **Remote output:** a run on another computer's runner shows its records only if that runner relays them (today it
  doesn't, `tasks.ts:712`). Its live view says "Output from other computers isn't shown yet" instead of looking empty.

### §5 Terminal-style view [R14]

A view mode of the existing live records:
- monospace and dense;
- auto-scrolls, pausing when you scroll up;
- shows tool calls and their output tails.

Same rules as today:
- the command tier needs the project's existing "Show commands in the live view" consent;
- read-time sanitisation, text only, control characters stripped, output limits, no-store;
- truncated or unavailable output says so.

It is never a pty and never types into the agent.

## Phase B — Quick start

### B1 `toolroll` in a repo [R15]

- Bare `toolroll` inside a git repo runs `up` for it when no console is running. The scan stays available as
  `toolroll scan`, with its flags and JSON. Outside a repo, it scans as today. Under an agent or `--json`, it never
  starts anything, and prints what it would do.
- When a console is already running, `toolroll` attaches over a **Unix domain socket**, never a TCP port
  **[r2-R15]**:
  - `up` creates the socket in the owner-only (0700) configuration directory beside the database. Only the same
    user can connect, so whoever owns a port is irrelevant.
  - The CLI checks the socket's directory and ownership before connecting.
  - The CLI sends nothing secret over it. The socket's permissions keep out other users, but they are **not** what
    proves the console is real (build agents share the user); the instance proof below is.
  - A stale socket (no listener) is removed and treated as "no console running". An impostor can't create one in a
    directory it can't write.
  - Tests:
    - a stale socket;
    - a socket in a directory another user can write is refused;
    - a port taken by another process doesn't matter.
- **The socket carries no authority [r3-N19].** Build agents run under the operator's own user, so filesystem access
  can't tell the operator from an agent. The socket is therefore **discovery only**:
  - it answers one request, `hello`, with the console's pid, build, database path and listening port — nothing
    secret, nothing an agent can't already learn — and refuses every other verb;
  - it changes nothing: no admission, no session, no token, no sign-in;
  - **a live instance proof, not matching facts [r4-N20].** Each start of `up` mints a fresh random instance secret
    and records it, with its listening port, pid and build, in a `console_instance` row in the database — written
    under owner authority, behind the agent fence (which covers a custom database directory too). The CLI opens the
    database itself (the existing path) and reads it. It then proves the **live** console holds that secret, on both
    channels, with fresh challenges: over the socket (`hello` with a random challenge, answered with
    HMAC(secret, "socket:" + challenge)), and over the **advertised HTTP listener** (`GET /__instance?c=<another
    challenge>` on 127.0.0.1:<port>, answered with HMAC(secret, "http:" + challenge + " " + localAddress + " " + localPort),
    where `localAddress`/`localPort` are what **the console itself observed** as the receiving end of that very
    connection (`request.socket.localAddress` / `localPort`) — never `Host` or anything the client sends). The CLI
    requires them to equal the address it dialed (127.0.0.1 and the recorded port); a console bound elsewhere (say
    `--host ::1`) can't be attached on 127.0.0.1, and a relay listening on 127.0.0.1 that forwards to the real
    console's other address produces an answer bound to that other address, so it is refused [r5-N20]. Both must hold. A replayed
    `hello`, a stale record with a recycled pid, or another process now on that port can't answer a new challenge,
    so the attach refuses (with the restart command) and never sends a person to another listener. The URL it prints
    or opens is that proved listener's;
  - tests: a native-sandbox build contacts the socket directly (bypassing the CLI's "under an agent" check), including
    with a custom database directory, and gets only the `hello` facts — it cannot read the instance secret, any other
    verb is refused and nothing in the database changes; **a stale `console_instance` record with a matching replayed
    `hello`, a recycled pid and a replacement HTTP listener on the recorded port is refused**; **a genuine live
    console with a correct instance record, reached through an IPv4-to-IPv6 relay (an agent listening on 127.0.0.1:P,
    forwarding to the console's [::1]:P), is refused on both-channel verification**; a live console reached directly
    passes both proofs.
- Admission uses the existing project-admission path, its registry lock and ceilings, from the CLI's own opened
  database (never through the socket).
- An incompatible build refuses with the command to restart.
- The two-action target excludes first-time identity, project admission and provider sign-in, which stay as they are.

### B2 Password freshness [R1, R2, R3]

Freshness lets an **allowlisted** everyday act proceed without re-typing a password **only when all of these hold**:

- **Transport:** a direct local connection, checked on every request: loopback peer, Host `localhost`/`127.0.0.1`,
  and **no forwarding headers at all**. A forwarded request never qualifies, even if it says it's local.
- **Session:** the exact server-held session and its credential generation.
- **Starting event:** the window starts only from a **verified password entry** or an **explicit SSO
  re-authentication**. A cookie, a one-time link, a bearer token, activity, or a previous freshened act never starts
  it.
- **SSO proof [r2-N18]:** an SSO re-authentication counts only when:
  - its request asked for one (`prompt=login`, `max_age=0`);
  - the ID token carries `auth_time`;
  - `auth_time` is no earlier than that request was made, and not in the future beyond 60 seconds of skew.

  The window starts at that `auth_time`, not at when the callback ran. A missing, invalid, older or future value is
  not fresh. Today's callback, which accepts a missing value and records `Date.now()`, is fixed for every use, not
  only for freshness.
- **Window:** fixed at 15 minutes from that entry. It is not extended by use.
- **Ending:** it ends at sign-out, at session rotation or revocation, at Forget (a CSRF-checked POST), or on any
  credential change, and it is re-checked at mutation time.
- **Unchanged:** CSRF and origin checks are unchanged.

**Allowlist (default deny)**, decided by the **operation and its current sealed terms**, not by the route:
- approving a plan or scope whose **sealed profile is standard permissions**, not protected work (one approver), not
  coordinator/mate/scout-quarantined;
- sending a chat message;
- replying to an agent question.

Steering, pausing and resuming already need no password and are unchanged.

**Never covered by freshness:**
- full-access profiles
- merge, publish and deploy
- signing a mode or "runs on its own"
- credentials, secrets, exports, tool connections
- people, access and security policy
- project admission
- deletion
- overriding process-exit evidence or resuming a hard-stopped attempt
- quarantine ceremonies and protected (two-person) approvals
- anything a chat proposal leads to beyond the allowlisted act (proposals are classed by their underlying action)

**The audit covers every authentication path, not one function [r2-R1].** That means every call to
`authenticateApprover` and **every direct read of SSO freshness** (`session.sso.fresh`), including:
- OAuth consent (`remote.ts`);
- viewer-token creation (`people-tokens.ts`);
- the step-up guard (`guards.ts`).

These move behind one function, `proveFreshHuman(request, who, operation)`. It takes the operation's class and is the
only place freshness is honoured. A static test fails any other read of `sso.fresh` or any password check outside it,
and every route whose handler calls it carries `freshness: "never" | "allowlist"`. Task merge, for one, isn't declared
step-up today; it gets `never`. OAuth consent and token creation are `never`.

**Accepted 2026-10-20 with a stated limit.** Codex found the runtime sound (round 7). Rounds 8–21 hardened the static
audit, which pins every mention of `fresh` and of each authentication function by place. It is a **regression
guard, not a proof**: round 21 listed nine ways an ordinary refactor can move an existing read or helper into an
authorization path without changing any pin, such as destructuring, slots, aliases, helper reuse and label
collisions. Closing them needs whole-program binding/use tracking. Alex accepted B2 with the audit as it stands. The
runtime gates in `scope.ts` (one prover, live facts, refunds only inside one transaction) are what carry the
guarantee, and code review covers changes that touch them.

**What an approval then records [R2]:**
- The seal is unchanged: an explicit Approve, the exact terms, the one-shot nonce, the transactional digest check.
- Each approval also records `auth_method` (password-now | sso-now | fresh-password | fresh-sso), `auth_at` and the
  session generation, beside the seal (`scope_approval_auth`).
- The approval's words say "approved by alex (password remembered from 10:42)".
- The trade-off is stated plainly in the docs: under freshness, a session taken over within the window can approve
  standard-permission work.

The chrome shows "Password remembered · 12 min · Forget".

## Phase C — Codex continuation [R4, R5]

The goal is a note reaching a running Codex build at a real turn boundary. v2 specifies the contract; its spike decides
whether it can be built.

**C0 spike (gates C):** against the real Codex CLI version pinned by the runner, under native containment:
- Establish what interrupting `codex exec --json` does mid-turn and mid-tool.
- Establish what the session file holds afterwards, and whether `codex exec resume <exact session id>` resumes from the
  last completed turn.
- If no reliable boundary exists, phase C stops, and Codex stays mailbox-only, said plainly. (Until C0 proves one and C
  is separately decided, Codex is mailbox-only in production, as D's deferral says of every agent but Claude.)

**C0 result (2026-10-20, codex-cli 0.156.1, macOS, four real runs, uncontained, interrupt 3 s into a tool or 1.2 s
into a turn, then `codex exec resume <id>` with an operator note).** The spike **holds, with conditions**:

| Signal | Codex exits | Session file | Running tool | Resume |
| --- | --- | --- | --- | --- |
| SIGINT mid-tool | 1, no stdout terminal event | `turn_aborted` (reason `interrupted`) + a developer note that aborted tools "may have partially executed" | killed; its write never happened | exact id; context intact; step treated as unknown, not replayed; note obeyed |
| SIGINT mid-reasoning | 1 | `turn_aborted` | none started | clean |
| SIGTERM mid-tool | **0**, no abort record | ends at the open `function_call` | **orphaned, finished, wrote its file** | works; step unknown |
| SIGKILL to the `codex` pid | killed | — | — | **the native binary under the npm launcher kept running and finished the whole turn**, step 3 included |

What this means for C, if it is built:
- **Interrupt with SIGINT only.** SIGTERM looks like success (exit 0) and leaves tools running. That makes it no
  boundary at all.
- **The boundary evidence is the session file, not stdout.** An interrupted `exec --json` prints no terminal event.
  The runner reads the rollout's `turn_aborted` record for the exact turn id, or the stream's `turn.completed`.
  Exit code alone means nothing.
- **Custody before resume is mandatory.** The `codex` pid is a Node launcher, and killing it alone leaves the agent
  running. Codex itself warns that unified-exec processes may outlive an interrupt. So after SIGINT the runner kills
  the rest of the containment, and resumes only when the witness reports it empty. Otherwise two writers share one
  session.
- **The aborted tool's outcome is unknown and recorded as unknown.** Codex agrees: on resume it said so and did not
  re-run it.
- Not yet seen: repeat runs (one SIGINT-mid-tool sample), Linux, a tool that detaches its own child, and runs under
  Toolroll's containment and per-launch `CODEX_HOME`. Further runs spend Codex quota and need Alex's OK. Building C
  stays its own decision.

**If the spike holds**, the contract is:
- **Boundary.** A continuation happens only between turns: the runner waits for the turn-complete event, never a
  timer. A pending note waits for that event.
- **Custody.** Before resuming, the previous invocation's process tree is proved gone through the existing custody and
  containment witnesses. A tool whose outcome is unknown stays unknown and is recorded; nothing is replayed.
- **Segments.** A run gains **invocation segments**, one row per invocation, with:
  - the note ids it delivered;
  - the exact session id;
  - spawn and exit witnesses;
  - usage;
  - the interruption outcome.

  Usage accumulates across segments (`invokeAgent` gains a cumulative mode for continuations). Budget and wall-clock
  limits are the attempt's, never reset. Attempt and retry accounting is unchanged: one attempt.
- **One door.** Every segment launches through `invokeAgent()`, with the same approved model, permissions, fence,
  tool grants and isolated environment. It always resumes the exact session id: never `--last`, never a cold session.
- **Order.** Stop, a lost lease, a changed approval or a failed containment proof all beat a queued continuation.
  Continuation and final settlement are serialised: a settled run takes no continuation, and a superseded handoff is
  invalidated.
- **Tests:** a real-CLI interruption under containment, and crash recovery between segments (an orphaned segment is
  reconciled, never double-counted).

### C1 — the build (decided 2026-10-20: Alex, "build it"; v2 answers Codex c1-r1, findings marked **[c1-n]**)

**Where it exists [c1-1].** Continuation needs custody that the OS proves. It is offered only when the runner's
containment is **native**: a cgroup2 on Linux, or a Job Object on Windows. On macOS (observed mode), or when native
containment fell back to observed, a Codex build stays mailbox-only, and its composer says so: "It reads notes at its
next check (this computer can't prove a stopped agent is fully gone)". Alex chose this on 2026-10-20 over a
best-effort Mac mode.

**Who gets it.** A Codex **builder** run qualifies only when all of these hold:
- native containment is in effect;
- its launch brokers **no project tools** [c1-3]. Brokered MCP servers and HTTP calls run outside the provider's
  container, so their quiescence is not proved. A run with project tools stays mailbox-only, and says why;
- it is not a prepared candidate.

The builder stamps `continue_opened_at` at the first spawn and `continue_closed_at` when the loop ends.
`continuationRun(taskRef, now)` is the predicate, beside `liveInputRun`. `steerCapabilityOf` returns
`send: "continue"`, with the words "It stops at its next step to read your note, then carries on." On such a run the
tick mails no notes: notes travel only in segments.

**One interrupt per segment [c1-9].** The tick reads pending, verified notes for the task. It latches one interrupt
request on the live segment when all of these hold:
- the segment has seen `turn.started`;
- it has seen no `turn.completed`, `turn.failed` or exit;
- **no item is in flight**: any `item.started`, of any type, without its `item.completed`.

Then it calls a new `interruptOwnedLeader(owner)` in exec.ts. That function sends SIGINT once to the leader pid
alone, never SIGTERM and never the group. Once latched, nothing signals that segment again. After terminal evidence, no
signal is sent.

**Precedence when the segment ends**, highest first:
1. stop (durable or `shouldStop`);
2. timeout;
3. a gateway refusal;
4. `turn.completed` seen. This counts as completed even if our SIGINT raced it, so a nonzero exit is normalised only
   when the interrupt was ours and completion came first;
5. a proven interrupted boundary (below);
6. otherwise "no boundary". The attempt settles as today, and its notes stay pending.

**The boundary is read inside the gateway [c1-10, c1-4].** `invokeAgent` gains `continuation: { sinceMs }`.
1. Before the launch, it resolves the operator's sessions directory to its **realpath**, and adds that realpath and
   the link path to the fence's **deny** list. The agent can then neither write nor read rollouts by any alias. The
   harness writes them outside the command sandbox, so Codex itself is unaffected.
2. After the transport settles and proves the container empty, and **before** its `finally` removes the launch home,
   it reads the rollout from that realpath and returns `turn: RolloutTurn` (`src/codex-rollout.ts`).
3. If the sessions path cannot be resolved, or its realpath is not a directory, the gateway refuses the continuation
   option. The run then stays mailbox-only.

**Custody [c1-2].** With native containment, `runStreamJsonl` already kills the container when the leader exits and
awaits the kernel's "empty", before it resolves. That is inside the transport lifecycle, before ownership is dropped.
The segment's custody fact is:
- `result.containment.empty === true`; and
- the segment's own `run_process` witness, the row reserved for this spawn, has `container_empty_at` set.

Anything else gives `continuation-custody`. There is no resume, and settlement runs.

**A final launch gate inside the gateway [c1-5].** `invokeAgent` gains `launchGate: () => string | null`. It is
evaluated **after** every await (attestation, tools, fence probe), immediately before `stampProviderStart`, and
refuses with `stale-approval` when it returns a reason. It runs on every segment, the first included. The builder's
gate checks all of these:
- `request.shouldStop`, the durable stop, and the `fencedMidBuild` latch;
- the scope's `approved_digest` still equals the run's stamped `scopeDigest`;
- `proveApprovedProfile` re-derives a profile whose `profileDigestOf` equals the stamped `profileDigest`;
- the sealed route digest still equals the run's admitted route;
- `modeApprovalLive`;
- `runPolicy` still allows the profile;
- the attempt's wall clock has time left, and the continuation count is under 4.

**Notes reserved per segment [c1-6].** Segments are a table (v128) — `run_segment(id, run, ordinal, session_id,
spawned_at, exited_at, exit_code, boundary, turn_id, unknown_calls_json, tokens_in, tokens_out, custody, receipt_at)` —
and `task_steer` gains `attached_segment`. A continuation runs in this order:
1. **One transaction** inserts the segment row and reserves its batch: pending verified notes are stamped
   `attached_run` and `attached_segment`.
2. The prompt is built from exactly the reserved rows.
3. The receipt is the segment's `thread.started` with the same id, followed by `turn.started`. It settles
   `delivered_at` only for notes `WHERE attached_segment = ?`.

The first segment gets a receipt too: today the Codex transport fires none, so the builder settles the brief's notes on
`turn.started`. A note reserved to a segment that never got its receipt is **uncertain**. When the attempt ends, it
returns to pending with `uncertain = 1`. A later brief or segment quotes it under "This note may already have reached
the agent once; act on it only if it has not been done."

**Usage from the rollout, for every segment [c1-7].** Codex reports cumulative session usage, so `turn.completed`
totals are never added. Each segment's tokens are the rollout's delta: the running total at its turn end minus the
total before its `task_started`. That holds for completed and interrupted segments alike, the first included. In one
transaction the segment row is written and the run's tokens are **set** to the sum over its segments. If any segment
is unmeasured, the run's tokens are null (unmeasured), never a partial sum. Continuation launches pass
`recordUsage: false` to `invokeAgent`, so the gateway does not write its cumulative figure over the sum.

**Settlement after the loop [c1-8].** The loop ends with a typed reason:
- `none-pending`;
- `cap`, `clock`, `stopped`, `authority`, `custody` or `no-boundary`.

`settleProviderOutcome` receives it. For any reason other than `none-pending`, settlement **launches nothing more**:
`resumeUnhandedWork` is skipped, and changes without a handoff become "agent: stopped before its handoff". Before each
continuation segment, the handoff files a previous segment wrote (`done`, `mailbox`, `proposal`) are moved into the
quarantine (`quarantineMailboxes`). Only the final segment's handoff can be read.

**Crash.** Recovery finds a segment with no `exited_at`. It writes `exited_at = now`, `boundary = 'none'` and
`custody = 'unknown'` once, guarded on `exited_at IS NULL`, and marks the segment's unreceipted notes uncertain.

**Words, CLI and tests.**
- `task steer` accepts a continuation run as live. Lead tools, steer status and the composer read the new mode.
- Tests use `test/fake-codex-exec.mjs` (rollout + SIGINT + orphan + ignore-SIGINT).
- They include unit tests of the gate, the reservation, the receipt, usage, precedence and recovery. A scripted
  native container (`overrideContainerFactoryForTests`) proves custody, and a scripted populated container refuses.
- A real contained run (Linux cgroup2) is an opt-in slow test that skips without cgroup2 and the real CLI. Running it
  spends Codex quota.

## Phase D — ACP multi-turn [R6, R7] — deferred (decided 2026-10-20)

Cancel-and-continue for agents other than Claude is **not built in this arc**. Review showed a cancelled turn's work
can't be proved stopped when an agent runs tools inside its own long-lived processes (r4-N22), and Linux membership
needs a whole-subtree proof (r4-N21). Alex chose the safe road: Codex, Gemini, OpenRouter and ACP agents stay
**mailbox-only** — their composer says "It reads notes at its next check" (phase A, §4) — and nothing here weakens
that. A later arc may revisit a narrow form (tools only through terminals Toolroll hosts, on Linux/Windows) with its
own proof.

## Phase E — A terminal in the agent's checkout [R13] — copy, don't launch (decided 2026-10-20)

Review showed that a console-launched Terminal runs its startup shell before any environment can be cleaned (r4-R13),
so Toolroll **launches nothing**. Instead, on a live view of an attempt whose checkout is on this machine:
- **Copy the command**: copies `cd '<checkout>'` (the path proved canonical, owned by the local runner and still bound
  to that attempt when the page was drawn; single-quoted, any quote escaped). The person pastes it into their own
  terminal, under their own environment — no console process, environment or secret is involved.
- **Show in Finder** (macOS): `open -R <checkout>` on the server, a fixed argv, after the same path proof and an
  operator's act (cookie + CSRF). Finder reveals; nothing executes.
- **The words**, before both: "These files were written by an agent. Your shell's startup scripts and prompt tools (git
  status in the prompt, direnv, .envrc) can run code from them when you open a terminal there."
- Offered only when the console and that attempt's runner are on this machine; never on a phone (no clipboard path to
  a terminal there — the path is shown as text instead).
- **Tests:** the copied text for a path with quotes and spaces; a stale or reassigned path refused for Show in Finder;
  `open -R`'s argv fixed; the act refused to viewers and bearer callers.

## Tests, per phase

**A:**
- Fact-to-display mapping: every activity, outcome and obligation combination; looking clears only `done`;
  checks-failed shows `failed`.
- Aggregates: plan approval with no run, planner question, flow decision, superseded revision, cap > 80, visibility.
- Summary subscription:
  - a hidden tab keeps its title count;
  - a sidebar never marks seen;
  - one room per page.
- Attention:
  - a watch opened after claim stops the send at the final fence;
  - non-run subjects;
  - chime dedup across tabs and no replay.
- The usage chip shows stale readings as stale, and only to operators.
- Composer:
  - stale attempt refused;
  - capability words per row;
  - remote "not shown yet".
- Terminal mode respects the command-tier consent.
- Sensitive pages have no sidebar.
- The phone revision journey: one primary action, a durable draft, and truthful delivery status.

**B:**
- Freshness negatives:
  - a cross-route bypass (an allowlisted window used on a never route);
  - a forwarded request;
  - a Host mismatch;
  - CSRF on Forget;
  - session revocation and rotation;
  - a credential change;
  - SSO reuse on a never route;
  - a full-access approval;
  - quarantine;
  - two-person.
- `auth_method` is recorded.
- Instance attach refuses a mismatched identity file or build.

**C:** the C0 spike's real-binary evidence decides C; D is deferred (nothing to test in this arc).

**E (copy, don't launch):**
- The copied `cd` text for a path with quotes and spaces.
- Show in Finder: a stale or reassigned path is refused; `open -R`'s argv is fixed; viewers and bearer callers are
  refused; it is not offered off this machine.

## Order

1. A (§1 → §2 → §3 → §4/§5) — done
2. B1
3. B2 — accepted with the audit's stated limit
4. E
5. C0 spike — holds with conditions (2026-10-20); building C is its own decision

D is deferred (mailbox-only for every agent but Claude).

Each step is reviewed before the next. A ships on its own: it changes nothing anyone may do.
