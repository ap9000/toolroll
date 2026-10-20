# The light cockpit (v4)

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
  - The CLI sends nothing secret: the socket's filesystem permission is the authentication. The server answers with
    its database path and build, which the CLI compares with its own.
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
  - the CLI never trusts what it says on its own. It opens the database itself (the existing path, behind the agent
    fence) and checks the socket's answer against the record `up` writes there under owner authority (pid alive,
    build, port). The URL it prints or opens comes from that database record, never from the socket. A replaced or
    impostor socket can only make the attach refuse (with the restart command), never send a person to another
    listener;
  - test: a native-sandbox build contacts the socket directly (bypassing the CLI's "under an agent" check), including
    with a custom database directory, and gets only the `hello` facts; any other verb is refused and nothing in the
    database changes; an impostor socket whose answer disagrees with the database record is refused.
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
- If no reliable boundary exists, phase C stops, and Codex stays mailbox-only, said plainly.

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

## Phase D — ACP multi-turn [R6, R7]

- `acp-client.ts` gains per-prompt identities and a turn lifecycle (prompting → cancelling → turn-ended → prompting).
- Cancelling a turn:
  1. cancels pending permission requests;
  2. consumes final updates and the original prompt's terminal response;
  3. resets only turn-local state;
  4. **proves process safety for this continuation [r2-N17, r3-N17]**: the agent's tool processes from that turn
     must be gone, proved by the native containment's own **membership accounting**, never a snapshot of ancestry
     (which misses escaped or re-parented children):
     - **Baseline.** When the agent reports ready, before the first prompt, the runner records the run container's
       members (cgroup `cgroup.procs` on Linux; the job object's process list on Windows) as `(pid, start time)`
       pairs: the agent and its own long-lived helpers.
     - **Proof.** After the cancelled turn's terminal response, every member of the container must be in the
       baseline (same pid **and** start time, so a reused pid never passes). Any other member — a tool still running,
       escaped or re-parented — fails the proof. Whole-container emptiness is not required (the agent stays).
     - **macOS and observed runners** have no membership accounting (process groups don't capture escaped children):
       there, cancel-and-continue is **not offered**, and the agent is mailbox-only, said plainly.
     - Unknown or failed proof refuses the continuation: the note falls back to the mailbox, and the composer says the
       agent will read it at its next check. A real test (Linux cgroup, Windows job object) has a tool process that
       outlives a cancellation answer, and the continuation must be refused; a reused pid with another start time
       must fail the proof;
  5. sends the next `session/prompt` on the **same session**, pinned to the negotiated protocol version.
- Races are handled: cancellation racing a normal completion, duplicate responses, late updates, disconnects, and Stop.
- **Admission.** Admission stays as it is: no conformance bump invalidates working agents. **Cancel-and-continue** is a
  separate, optional **capability attestation** bound to the same attested launch. It is checked by:
  1. a second graded step that cancels mid-tool;
  2. proving the agent's descendants are gone **before** the second prompt, with the agent still running;
  3. sending a second prompt that must use context from the first and finish with permissions working, within bounded
     accounting.

  An agent without the capability is mailbox-only. A failed **mandatory** safety check still refuses it, as today.

## Phase E — A terminal in the agent's checkout [R13]

- **Server-side launch, macOS first, concrete [r2-R13].**
  - The console writes a one-use launcher script, 0700, into its own private directory: a fixed template with the
    checkout path as its only value. The path is proved canonical beforehand and passed as a single-quoted shell word
    with any quote escaped.
  - **An explicit environment at every hop [r3-R13].** `open(1)` passes the caller's environment to an app it
    launches, and a script cleared from inside is cleared too late, so:
    1. the console runs `osascript` with `execFile` and an **explicit environment** — `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
       `HOME`, `USER`, `LOGNAME`, `LANG` only (the existing allowlist mechanism, exec.ts) — and a fixed argv; a
       Terminal it starts inherits only that;
    2. `osascript` tells Terminal to `do script` a fixed line: `exec /usr/bin/env -i HOME=… USER=… LOGNAME=… SHELL=…
       TERM=xterm-256color LANG=… PATH=<the login default> /bin/sh <launcher>` — so the new window's shell starts from
       that allowlist whatever Terminal's own environment is (already running or not);
    3. the launcher (0700, one use) deletes itself, `cd`s to the checkout, and `exec`s the chosen shell.
  - The boundary that remains is stated: the chosen shell then reads the user's own startup files (or, for the plain
    shell, only `/etc/zshenv`), which may set variables of their own; nothing from the console or Terminal does.
  - It is offered only when the console and that attempt's runner are on this machine.
  - It needs operator authority and a password typed now (never freshness).
- **Path.** The checkout path comes from trusted run and lease records. It is re-proved canonical, owned by the local
  runner, and still bound to that attempt immediately before launch; a stale or reassigned path is refused.
- **Environment.** The launch environment is the allowlist above at each hop, never the console's scrubbed: a
  sentinel secret placed in the console's environment (and in Terminal's own, by starting Terminal first from a shell
  that has it) is absent from the new window's `env`.
- **Consent first.** Before the password field, the console says: "This opens your own terminal, outside Toolroll's
  sandbox, in files an agent wrote. Your shell's startup scripts and prompt tools (git status in the prompt, direnv,
  .envrc) can run code from those files." It offers two shells:
  - **your usual shell**;
  - **a plain shell** (`/bin/zsh -f`). That skips your own startup files (`~/.zshenv`, `~/.zshrc` and the rest) but
    still reads the system's `/etc/zshenv`, and the words say so exactly.
- **Tests:**
  - the script is written from the template, with a path that holds quotes and spaces;
  - the argv is fixed;
  - the script removes itself;
  - the `osascript` call's environment is exactly the allowlist (asserted on the spawn), and the `do script` line is
    the fixed `env -i` form;
  - a sentinel-secret check on a real Mac with Terminal closed and with it already running (that Terminal started
    with the sentinel in its environment): `env` in the new window has neither, recorded in the PR.
- **Out of scope:** Linux and Windows (offered later), and an in-browser terminal.

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

**C and D:** as specified in their sections, with real binaries.

**E:**
- A path re-proved stale is refused.
- The argv is fixed.
- The environment is scrubbed.
- It is refused off this machine or without a password typed now.

## Order

1. A (§1 → §2 → §3 → §4/§5)
2. B1
3. B2
4. C0 spike, then C
5. D
6. E

Each step is reviewed before the next. A ships on its own: it changes nothing anyone may do.
