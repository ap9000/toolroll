# Plan v2: attach mode for Toolroll

Add an opt-in interactive Claude runtime whose PTY belongs to the engine. The thread’s owner can view and control it from the local workbench or a signed-in browser, including a phone. Keep stream-json as the default.

Interactive threads have **no turn counting, turn limits or cost display**. They use the owner’s Claude subscription. Every authority check remains: the owner’s current sign-in and removal epoch, approved level, network and fence, revocation, and a live launch. A launch-scoped interactive session replaces the requirement for a running structured turn.

Codex builds every slice. A separate Codex session reviews each security slice before merge. Restricted clones can build and run isolated contract tests; the lead runs the explicitly identified PTY, localhost and real-fence checks outside that sandbox.

This plan was prepared as a read-only revision based on `PLAN-V1.md` and the checkout identifying itself as **0.9.114**, schema **172**. That planning pass changed no implementation files, ran no tests, deployed nothing and inspected no live runtime. Branch overlaps below retain v1’s supplied coordination constraints; their unmerged contents have not been verified.

## 1. Scope and existing foundations

Support newly created interactive Claude threads, detach and reattach, several visible agent panes, authorized browser viewers and one controller per launch across every client.

Keep both runtimes, selected at thread creation:

| Runtime | Behavior |
|---|---|
| Stream-json — default | Existing structured input, results, permission channel, turn admission and accounting. |
| Interactive — opt-in | Native Claude UI in an engine-owned PTY; unlimited interaction while the launch’s authority stands. No structured conversational turn claims. |

The runtime choice is saved and bound into the approved start terms. An active thread cannot switch transports. Existing threads migrate as stream-json.

A headless launch cannot acquire a native terminal retrospectively. Show **“This thread has no agent window”** and its existing reply action. Do not silently restart or convert it.

Reuse these foundations:

| Existing code | Reuse and boundary |
|---|---|
| `src/flexible-agents.ts`, `src/flexible-thread.ts`, `src/flexible-launch.ts`, `src/flexible-custody.ts` | Confined launch, isolated configuration, relay credentials, custody and verified process-tree shutdown. |
| `src/flexible-session.ts`, `src/server/engine-api.ts`, `src/contracts/engine-api.ts` | Thread identity, owner checks, lifecycle and LiveSession facts. Structured records remain separate from terminal output. |
| `src/live-terminal.ts` | PTY interfaces, bounded queues, screen mirror and snapshot-before-live ordering. Do not inherit its shell launcher or shell authorization. |
| `src/server/terminals.ts` | Browser terminal page and WebSocket transport, including host, origin, session and mutation-key checks. |
| `src/browser/terminal-app.tsx`, `src/browser/terminal.css` | Existing xterm renderer, fitting, reconnect handling and mobile key bar. This is the existing web terminal, bundled as `terminal` by `scripts/browser-build.mjs`. |
| `tui/crates/toolroll-api/src/term.rs` | Authenticated terminal transport utilities. |
| `tui/crates/toolroll-tui/src/term.rs` | VT parsing, cleaned-cell rendering and paste handling. |
| `tui/crates/toolroll-tui/src/panes.rs`, `run.rs` | Pane layouts, bounded output processing and input priority. |

Ordinary task-build control remains outside this arc. **Open build shell** continues to open a separate shell in a separate copy of a saved build.

This plan carries the owner’s bounded attach-mode scope. It does not authorize unrelated flow, subagent, starter-kit, inbox or eval capabilities under the feature freeze.

## 2. Interactive authority replaces structured turn admission

### Launch-scoped session

Introduce a durable interactive authority record, owned by trusted Toolroll state and bound to:

- Thread, exact launch and engine holder.
- Thread owner and account generation.
- Interactive runtime, Claude provider and subscription billing.
- Approved terms identity and digest, Full level, selected model and permitted helper models.
- Approved fence and network identity.
- The owner’s sign-in removal epoch.
- Lifecycle: prepared, active, ended; with an immutable end reason.

There is at most one active interactive session for a launch. Activation occurs only after custody registration and the final launch authorization succeed. Ended sessions cannot reactivate.

This record is **not a synthetic `thread_turn`**. Do not admit one permanent turn, increment turn counters for prompts or relay requests, or treat terminal screen changes as turn boundaries.

The browser attachment permit and controller lease are separate, narrower objects. Neither can create or extend launch authority.

### Exact relay changes

The present relay requires `currentTurn(...)` around `src/flexible-relay.ts:582`. Its dispatch, streaming and cancellation paths also depend on a running turn. Replace those dependencies only for interactive launches.

| Existing check or behavior | V2 treatment |
|---|---|
| Per-launch relay token shape, stored digest and constant-time comparison | **Keep.** |
| Grant unrevoked; grant and launch belong to this thread; launch state is live | **Keep.** Also require the matching active interactive session. |
| Exactly one current running turn, correct provider, owner and launch holder | **Replace for interactive launches** with exactly one active session matching thread, launch, holder, provider and owner. Keep the structured path unchanged. |
| Thread starter equals authority owner equals credential person | **Keep.** Resolve owner and generation from the interactive session instead of a turn row. |
| `signInForTurn` credential selection | Reuse its owner/generation credential lookup through a shared helper. Interactive dispatch reads only the thread owner’s current active setup-token. No installation credential or API-key fallback. |
| `signInStandsAt` dispatch invariant | **Keep every identity, generation, active-approver, active-sign-in, billing and refusal check.** Add an interactive-session variant replacing its running-turn lookup. Recheck inside the dispatch transaction. |
| `signInHoldsFor` and `signInEpochOf` during an in-flight call | **Keep their semantics.** Extend the authority reference to a discriminated turn/session reference. For interactive calls, resolve owner/account generation from the session and require its pinned removal epoch still matches. Never bypass this helper because there is no turn. |
| Thread level and organizational ceiling | **Keep.** Require Full to remain permitted and match the approved session and launch. Never silently lower or widen authority. |
| Approved project terms, network, fence, credential isolation and launch custody | **Keep.** Interactive activation must perform the non-accounting checks previously reached through turn admission. |
| Threads-enabled check in the dispatch transaction | **Keep**, and include it in continuing-authority checks. |
| Route, method, query, header and beta allowlists | **Keep.** |
| Body size, JSON shape, duplicate/reserved keys, model/helper-model restrictions and `max_tokens` bounds | **Keep.** These are request and resource safeguards, not conversational turn limits. |
| Server-tool, connector and server-fetch restrictions; proxy-only network | **Keep.** |
| Fixed upstream, credential injection outside the fence, redirect refusal and credential redaction | **Keep.** |
| Concurrent-call and bounded-buffer safeguards | **Keep.** No cumulative prompt, turn or spend allowance. |
| Turn admission, turn reservations, daily turn allowances and interactive cost budgets | **Remove from the interactive path.** Keep structured behavior unchanged. |
| `chargeFlexibleTurn`, unknown-cost holds and cost settlement blocking later interactive calls | **Do not use for interactive sessions.** |
| Relay call records | May retain sanitized call status and usage silently, bound to the interactive session and launch. They do not become a displayed or enforced cost ledger. |
| Per-event answer authorization, final-answer authorization, cancellation bus and cross-process watcher | **Keep.** Use the interactive session in place of running-turn identity. Fail closed on unreadable authority. |

Separate optional usage recording from mandatory authority recording. A missing usage figure does not hold an interactive session or create a budget debt. Failure to read or validate authority still refuses or cuts the call.

Do not count interactive calls toward structured threads’ daily limits, budgets or unknown-cost holds. Historical structured rows retain their original meaning.

Preserve ordinary sign-in replacement semantics: replacing an active credential without a removal may preserve existing authority; subsequent calls use the current credential. Removing and saving again advances the epoch and **cannot revive the old interactive session**.

### Ending authority

End the interactive session, revoke its grants, abort matching upstream calls and invalidate attachment/control authority when any of these occurs:

- Owner sign-in removal, password/account reset, account removal or loss of approver authority.
- Revocation of the session, launch or required approved authority.
- End, Stop or threads being turned off.
- Launch exit, unresolved custody, engine shutdown or recovery proving its holder is gone.
- Required level, terms, network or fence authority no longer standing.
- Claude refusing the credential generation used for dispatch.

Revocation takes effect before waiting for process shutdown. Stop remains unresolved until the recorded process tree is proved gone.

A browser logout ends that browser’s attachment and lease. It does not, by itself, end the owner’s independent launch authority. Detach likewise leaves the agent running while its engine and launch authority remain live.

## 3. Engine-owned PTY and terminal protocol

The existing thread host owns the PTY master, child lifecycle, relay, proxy, screen mirror and controller lease. Clients never supply an executable, working directory, credential or launch command.

Adapt the confined Claude launch path. Do not launch through the generic live-terminal shell service.

Preserve the existing start gate. Today it consumes stdin; interactive mode needs a separate engine-controlled gate channel compatible with the real fence and launcher. Viewer input cannot open it, gate bytes cannot appear on screen, and registration or final authorization failure executes no Claude code.

Add an optional terminal capability to LiveSession facts:

- Runtime and availability.
- Exact launch generation and lifecycle.
- Viewing/control state.
- Supported protocol version and canonical dimensions.

Expose dedicated thread-terminal operations, proposed under:

- `GET /agents/live/thread/<id>/terminal`
- `GET /agents/live/thread/<id>/terminal/socket`
- `POST /agents/live/thread/<id>/terminal/authorize` for browser password proof.

The GETs do not create launch authority or acquire control. Define the page/JSON representation explicitly in the route contract. Keep PTYs out of `/term/start`, generic shell listings and generic terminal ownership rules.

Use typed WebSocket controls for snapshot/output sequences, acquire, release, confirmed takeover, sequenced input, acknowledgement, resize, revocation and exit.

### Ordering and delivery

Send a bounded snapshot at its recorded dimensions, followed by live output in sequence. Bind every message to the launch generation. A stale cursor requests a fresh snapshot; an old launch’s input cannot reach its replacement.

Acknowledge acceptance into the PTY delivery path, not completion of a Claude action. Reject duplicate input sequences without writing them twice.

Never replay unacknowledged input after disconnect. Show **“Connection lost. Reattach.”** and disclose uncertain delivery where necessary. Reconnection restores viewing, not typing.

Bound viewers, queues, parser work and backlog. Disconnect a slow viewer rather than indefinitely stalling every viewer or the agent. A gap requires a new snapshot and a visible limitation.

### One controller across every client

The engine owns one lease per launch, shared by workbench panes, browser tabs and phones.

Lease acquisition, revocation and PTY writes use one serialized authority path. Recheck the caller immediately before writing, not only when accepting a frame. Drop queued but unwritten input when its lease loses authority.

Only the controller resizes the PTY. Observers crop, letterbox or locally scale the canonical screen without changing it.

Transfer requires release or an explicit confirmed takeover naming the current controller and launch. A stale confirmation fails. No last-writer-wins behavior.

Disconnect, lost focus, hidden/background browser state, blocking dialogs, launch replacement or invalid pane layout release control. Use a bounded renewable lease so a vanished client cannot hold control forever; this is a connection safeguard, not an agent turn or runtime limit. Reconnect requires deliberate acquisition.

## 4. Owner authentication, local and remote

### Local workbench

Allow the thread owner through the workbench’s existing server-issued terminal session, current terminal epoch, mutation key and direct-loopback provenance. Retain the saved-session, local-owner, solo-install and local-generation checks where that authority type is used.

A header claiming to be a terminal, a loopback peer or knowledge of a thread ID is insufficient.

A full owner session may use the corresponding proven local client path. Do not admit machine, API-token or lead callers.

### Browser decision: password proof required

Require a **full browser session belonging to the thread owner plus a password proved for this attachment**. Apply this to local browsers too; the direct workbench remains the narrowly defined local-owner exception.

A local-owner/passwordless link is insufficient for browser terminal viewing or control. The agent can run code, so a locally obtainable link or ambient cookie must not become a route to a remotely controlled agent window.

Do not infer password proof from `authority === "full"` or `Session.passwordAt`: current code does not establish that field for every remote password sign-in. Add an explicit attach authorization operation:

1. Re-read the saved browser session, owner identity, account generation, project access and exact launch.
2. Verify the owner’s Toolroll password using the existing password verifier; do not accept a passwordless/session substitution.
3. Recheck the same facts and bind the successful proof to this session, account generation, launch and console start.
4. Issue a non-durable attachment permit and origin-bound mutation key through a no-store response.
5. Require that permit for snapshots, output subscription, control acquisition, input and resize.

One password proof permits viewing and repeated deliberate control acquisition for that launch while the session and permit stand. It is not required per keystroke. It does not approve Ship, a release, a grant or a replacement launch.

Restart, logout, reset, session expiry, account-generation change or launch end invalidates the permit. A replacement launch requires new proof. Passwordless owners who want browser attachment must set a password through the existing settings flow.

No passwords or Claude credentials travel in chat, URLs, WebSocket frames or logs.

### Transport and request protection

Reuse the checks in `src/server/terminals.ts:386`:

- Allowlisted host.
- HTTPS or the existing verified private-path policy, including an admitted Tailscale path.
- Exact expected Origin at WebSocket upgrade.
- Cookie session re-read from saved state without resurrecting ended sessions.
- No Authorization, API-token, machine or lead authentication.
- No credential-bearing query strings.
- Bounded frames and viewers; compression disabled as in the existing transport.

Tailscale transport is not identity. Forwarded headers are accepted only through the existing trusted transport interpretation, never as client assertions.

All HTTP mutations require the existing CSRF token and exact-origin validation. The attach key is mandatory even where the general browser mutation-key policy is optional. Reuse the existing key machinery and WebSocket subprotocol convention through a narrowly scoped attach mode; do not change unrelated routes’ policy.

The key is bound to session, origin and console epoch, delivered once after password proof, and never echoed in the selected subprotocol. A cookie and CSRF token obtained by an agent-controlled service on another port cannot substitute for it.

The authorized upgrade binds its validated Origin, session, key and permit to the socket. Every later frame rechecks their current server-side standing; it does not need to resend a password.

### Authority checks while connected

On every HTTP request and immediately before every input write, resize or lease change, recheck:

- Saved session existence and lifetime.
- Account generation, active approver status and thread ownership.
- Current project access.
- Applicable local-workbench proof or browser attachment permit.
- Mutation-key epoch and standing.
- Exact live launch, active interactive session, level and revocation state.
- Lease identity and input sequence where relevant.

Protect output equally. Recheck before each snapshot or output/control batch is queued. Do not inherit the existing terminal route’s one-second cached output proof for this path.

Use invalidation notifications and the cross-process watcher as additional protection. On authority loss, close subscriptions and discard unsent output and input. Bytes already delivered cannot be recalled.

## 5. Safe terminal rendering, paste and recording

### Renderer boundary

Agent-controlled terminal bytes must never draw trusted Toolroll controls or trigger host/browser side effects.

Keep the Rust VT-parser-to-cleaned-cells boundary. Reuse the web terminal’s xterm, fitting and mobile facilities, but **do not copy its current raw `term.write(...)` path unchanged**.

Add an incremental terminal safety filter before both the engine mirror and browser renderer. It must handle split sequences and discard unsupported control strings, including:

- OSC 52 clipboard operations.
- OSC 8 links.
- Titles, notifications and bells.
- DCS/APC/PM/SOS payloads and unsupported queries.

Generate reconnect snapshots from the interpreted screen using a restricted, tested serializer. Live output and snapshots must meet the same safety policy. The browser parses only that safe terminal stream; it does not interpret raw output as HTML, activate agent links or install clipboard/title handlers.

Keep legitimate display and input modes through an explicit allowlist. Necessary terminal query responses come from emulator operations, never the person’s host terminal. Emulator-generated input also passes through the controller and lease checks; observers cannot send it.

Use one hostile-output fixture corpus for TypeScript and Rust policy parity, including malformed UTF-8, split terminators, alternate screens and redraws. Test error, copy and reconnect paths too.

### Paste

Route keyboard paste, context-menu paste and mobile paste through the same guard:

- Bound its size and remove embedded controls according to the established safe-paste policy.
- Preview and confirm multiline paste.
- Use bracketed paste when supported.
- Without bracketed paste, explicitly warn that newlines may submit input and require confirmation.
- Recheck exact launch, focus, permit and lease after confirmation.
- Never replay paste after reconnect or send it from a stale dialog.

Do not record pasted text or raw keys.

### Recording and secrets

Keep raw PTY output and screen buffers in bounded memory only. No durable raw capture, browser storage, telemetry, chat/model context or automatic clipboard export. Authorized browser delivery is the owner-requested viewing channel, not a general terminal-output API.

Keep durable Toolroll lifecycle, authority and check records. Audit attach, control, release, takeover, resize, paste and input delivery using actor, session, thread, launch, lease, sequence and outcome. Store no raw payload or unkeyed secret-bearing digest.

Retain v1’s optional redacted saved-screen-history boundary: off by default and unavailable until post-interpretation redaction is proven. A chunk or line regex is insufficient. Any later enablement must disclose that arbitrary secrets cannot be guaranteed detectable. It is not needed to enable attach mode.

## 6. Workbench and browser interaction

Use **Agent window**, **Type in agent** and **Stop typing**. Keep **Open build shell** separate.

In the workbench, select a thread, open its agent window, then press `i` or choose **Type in agent**. Clicking selects a pane; it does not start typing.

The decided release behavior is:

| Input while typing in an agent | Result |
|---|---|
| `Ctrl-]`, then `q` | Release control and return to Toolroll navigation. |
| `Ctrl-]`, then `Ctrl-]` | Send one literal `Ctrl-]` to Claude. |
| Unrecognized suffix | Cancel the prefix without forwarding either key. |

Consume the prefix before forwarding. Clear pending prefix state on focus or connection changes. Keep it independent of remapped workbench keys. `Ctrl-C`, Escape and ordinary Claude shortcuts otherwise reach Claude.

**Build shells retain their current single `Ctrl-]` release behavior.**

Show one trusted status line outside agent cells, for example:

**Typing in Claude · Review parser changes · Ctrl-] q: Stop typing**

Observers see **“Viewing · Another window is typing.”** Keep controller identity and takeover detail available without repeating instructions.

At desktop width, preserve task context and the Toolroll approval area. Incoming approval notifications must not steal focus or redirect typing. Extend two/four-panel layouts so unfocused agent windows continue updating; only one pane receives input.

At narrow widths, show one agent window with compact thread context.

### Browser and phone

Add **Agent window** to the owning thread’s existing browser view. Reuse the terminal bundle and renderer through a thread-terminal adapter; do not offer a program picker, arbitrary folder or new shell.

After password proof, open in viewing mode. **Type in agent** acquires the same engine lease used by the workbench.

Provide a visible **Stop typing** control so phone users do not need a control-key chord. Reuse and adapt the existing mobile Esc, Tab, arrows, Ctrl and Enter bar. Support literal `Ctrl-]` through its key controls.

Account for the on-screen keyboard using the existing visual-viewport fitting path. Only a controlling phone resizes the PTY. Verify composition/IME input is delivered once, controls preserve useful keyboard focus, and keyboard dismissal or backgrounding releases control predictably.

Failure copy names the next action:

- **“Connection lost. Reattach.”**
- **“Agent stopped.”**
- **“Another window is typing.”**
- **“Sign in again to open this agent window.”**

Chat links to the same thread’s **Agent window** control and saved state. The link is navigation, not completed attachment. Password proof, lease acquisition and typing remain actions in the existing workbench/browser control; chat, machine and lead callers cannot inject terminal input.

Use the project System components and tokens. Before implementation, inspect pinned requests and component contracts. Render changed components in light/dark desktop and phone views, run the YouIyouX checks, and address concrete findings. Do not add UI unit tests for wording, markup or CSS.

## 7. Lifecycle, Ready and Ship

Native prompts, quiet output, cursor position and apparent idle screens do not prove conversational completion, Ready or permission to Ship.

Interactive sessions retain their thread/result identity and existing saved-result workflow. Missing structured conversation material is a visible limitation. It is not reconstructed by scraping the terminal.

Keep **Stop-before-Ship**:

1. Revoke interactive authority and stop input/model access.
2. Stop the exact launch’s recorded process tree.
3. Verify exit and complete existing custody/network settlement.
4. Apply the existing exact-candidate, approval and required-check rules.

Ship rejects an active interactive session or any live, stopping or unresolved launch, even though there is no running `thread_turn`. No synthetic “finished turn” bypasses this.

Detach or closing a browser leaves an authorized background-engine agent running. Preserve existing foreground-engine leave/stop/keep semantics; do not promise survival after every workbench exit. Engine death never leaves a claim that the PTY can be reattached.

Native Claude consent is additional consent inside the approved Full boundary. It cannot widen files, network, credentials or Toolroll approvals. Keep Full only, isolated configuration, disabled project/user hooks and MCP isolation. Native sign-in, remote-control features, plugins or commands needing broader access must fail within existing boundaries.

## 8. Reviewable implementation slices

**Codex builds every slice. A separate Codex session reviews every S slice before merge**, including the final diff and its security evidence. The reviewer must not be the builder of that candidate. Codex fixes findings; a changed security diff returns for review. Codex review is not a new product stage and grants no release or deployment authority.

Owner update (2026-11-18): use Codex for implementation, independent security review, verification and follow-up while Claude is unavailable. This replaces the earlier Claude-review requirement for pending and future slices; previous review outcomes retain their original attribution. Required evidence, approvals and release gates remain in force. This changes the development workflow only; the interactive Claude runtime described in this plan keeps its existing scope.

Each slice must be mergeable with production interactive launch disabled. Dependencies are explicit; fixtures must not grant authority that the eventual integration lacks.

Test labels:

- **C — clone:** no listening socket, native PTY or real fence; isolated contracts, migrations, injected transports and pure security rules.
- **L — lead / localhost:** real HTTP/WebSocket or fake-upstream listeners.
- **P — lead / PTY:** native PTYs or the real workbench binary in a PTY.
- **F — lead / real fence:** actual platform sandbox and custody attacks.

All paths below are exact intended paths; newly named files are proposed additions. The migration’s numeric version is allocated after the overlapping schema branch merges.

| Slice | Exact implementation files | Acceptance and proving tests | Review / branch overlap |
|---|---|---|---|
| **0. Contract and stand-in** | New `docs/plans/attach-mode.md`, `test/fixtures/interactive-claude.mjs`, `test/interactive-claude-kit.ts`; update `src/contracts/engine-api.ts`, `test/fixtures/engine-api/live-session-window-thread.json`, `tui/crates/toolroll-api/src/models.rs`. | Typed runtime/terminal facts; legacy fixtures remain valid; stand-in protocol supports deterministic input, output, resize, exit and attacks. **C:** new `src/interactive-claude-contract.test.ts`; existing Rust `tests/fixtures.rs`. The fixture protocol can be tested over ordinary injected streams. | **S.** Additive preparation now. Coordinate LiveSession fields with `task-loop`; production remains disabled. |
| **1. Session schema and authority** | New `src/flexible-interactive-schema.ts`, `src/flexible-interactive.ts`; update `src/store.ts`, `src/flexible-sign-in.ts`, `src/flexible-start.ts`, `src/flexible.ts`. | Default stream-json; immutable interactive mode/terms binding; owner, generation, level, sign-in and epoch checks; exactly one session; terminal end states cannot revive. No interactive turn admission or cost terms. **C:** new `src/migration-flexible-interactive.test.ts`, `src/flexible-interactive.test.ts`; extend `src/flexible-start.test.ts`, `src/flexible-sign-in.test.ts`. | **S.** Wait for `threads-everyday` schema v173 and start/lifecycle changes. Allocate the next free migration; do not assume v174. Preserve function ordinals in `store.ts`. |
| **2. Relay authority adapter** | Update `src/flexible-relay.ts`, `src/flexible-relay-cancel.ts`, `src/flexible-sign-in.ts`; new `src/flexible-relay-authority.ts`; extend the new schema module. | Discriminated structured/interactive dispatch; all retained checks in §2; session-bound grants/pending/call records; no fake turn, limit decrement or cost hold; abort on every authority-ending event. **C:** new `src/flexible-relay-authority.test.ts`, extend migration cases. **L:** new `src/flexible-relay-interactive.test.ts`; extend existing `src/flexible-relay.test.ts`, `src/flexible-relay-sign-in.test.ts`. **F:** extend `test/attacks/flexible-relay-fence.slow.test.ts`. | **S.** After slice 1 and `threads-everyday`. Coordinate relay schema/turn changes; keep structured behavior intact. |
| **3. Confined PTY launch and stop** | New `src/flexible-pty.ts`; update `src/flexible-agents.ts`, `src/flexible-thread.ts`, `src/flexible-launch.ts`, `src/flexible-launcher.ts`, `src/flexible-custody.ts`, `src/flexible-session.ts`; reuse PTY interfaces from `src/live-terminal.ts`. | Separate start gate; no viewer-triggered start; registration failure executes nothing; real controlling terminal; resize; end authority before shutdown; verified descendants/exit; no dead-launch reattach. **C:** new `src/flexible-pty.test.ts` with injected PTY/custody; extend existing launch/session contract cases. **P:** new `src/flexible-pty.slow.test.ts`. **F:** extend `test/attacks/flexible-claude-startup.slow.test.ts`, `flexible-thread-custody.slow.test.ts`, `flexible-thread-fence.slow.test.ts`. | **S.** New adapter can start after contracts; wait for `threads-everyday` before shared host wiring. |
| **4. Terminal service, lease and safe stream** | New `src/thread-terminal.ts`, `src/terminal-safety.ts`, `src/server/thread-terminals.ts`; update `src/live-terminal.ts`, `src/server/engine-api.ts`, `src/server/handler-registry.ts`, `src/contracts/engine-api.ts`, `src/contracts/console-api.ts`; new `test/fixtures/terminal-attacks.json`. | Snapshot/live ordering; one cross-client lease; duplicate rejection; no uncertain replay; per-write and per-output authority; observer resize denial; bounded slow-viewer isolation; safe live/snapshot streams. **C:** new `src/thread-terminal.test.ts`, `src/terminal-safety.test.ts`. **L:** new `src/server/thread-terminals.test.ts`. Extend `src/live-terminal.test.ts` where shared behavior changes. | **S.** After slices 1–3. Coordinate engine targeting/cards and route ownership with `task-loop`; extract shared primitives without broadening `/term` access. |
| **5. Rust transport and single-window control** | New `tui/crates/toolroll-api/src/thread_term.rs`; update its `lib.rs`; update `tui/crates/toolroll-tui/src/term.rs`, `thread.rs`, `keys.rs`, `app.rs`, `view.rs`, `run.rs`; update fake-engine support in `tui/crates/toolroll-fake-engine/src/lib.rs`. | Exact launch/lease frames; explicit typing; decided prefix/quoting; trusted status; paste guard; bounded scheduling; safe VT output; build-shell shortcut unchanged. **C:** new `tui/crates/toolroll-api/tests/thread_term_contract.rs`, `tui/crates/toolroll-tui/tests/attach.rs`. **L/P:** new `tui/crates/toolroll-api/tests/thread_term.rs`, `tui/crates/toolroll-tui/tests/attach_pty.rs`; retain `tests/take_over_pty.rs` regression. | **S.** After slice 4. Wait for `threads-everyday` edits to `thread.rs`, `keys.rs`, `app.rs` and `task-loop` dialogs/targeting. |
| **6. Browser and phone attachment** | New `src/server/thread-terminal-browser-auth.ts`, `src/browser/thread-terminal.tsx`; update `src/server/thread-terminals.ts`, `src/server/session.ts`, `src/server/mutation-key.ts`, `src/browser/mutation-key.ts`, `src/browser/terminal-app.tsx`, `src/browser/terminal.css`, `src/browser/app.tsx`, `scripts/browser-build.mjs`. | Password-proved owner permit; local-owner browser denial; mandatory attach key; CSRF/origin defenses; all callers rechecked; browser/workbench lease conflict; safe rendering and paste; phone controls/IME/keyboard handling. **C:** new `src/server/thread-terminal-browser-auth.test.ts`, extend `src/server/mutation-key.test.ts`, shared safety cases. **L:** extend `src/server/thread-terminals.test.ts`; new `scripts/attach-browser-journey.mjs`. Real browser desktop/phone checks are lead-run. | **S.** After slices 4–5 for cross-client proof. Coordinate browser thread entry with `threads-everyday` and `task-loop`; preserve existing terminal routes. Auth/session/key helpers are shared security files requiring explicit integration review. |
| **7. Several panes** | Update `tui/crates/toolroll-tui/src/panes.rs`, `app.rs`, `view.rs`, `run.rs`; extend `tests/attach.rs`, `tests/attach_pty.rs`. | Two/four agents update independently; only one local focused input target; global lease still wins; canonical resize; hidden/dialog/too-small state releases control; no starvation. **C:** lease/focus contract cases in `tests/attach.rs`. **L/P:** multi-pane cases in `tests/attach_pty.rs`. No new layout unit suite. | **S.** After slice 5; final integration after shared `app.rs` changes settle. Coordinate slice 6’s lease scenarios. |
| **8. Ship, verification and enablement** | Update `src/flexible-ship.ts`, `src/flexible-session.ts`, `src/flexible-ui.ts`, `scripts/verify.mjs`, `scripts/verify-world.mjs`, `docs/feature-map.json`, `docs/testing.md`, `docs/plans/attach-mode.md`. | Stop-before-Ship without synthetic turns; truthful saved-result/check status; both runtime regressions; no interactive count/cost display; selectable journeys; exact-candidate evidence complete. **C:** new `src/flexible-ship-interactive.test.ts` with trusted store/custody fixtures; extend `src/verify-cli.test.ts`. **L/P/F:** existing `src/flexible-stop.slow.test.ts`, `src/flexible-ship.slow.test.ts`, selected verify journeys and applicable attacks. | **S.** After both overlapping branches and slices 1–7. Feature-map/gate-file changes require the appropriate `Gate-change` trailer. Enable only after review and required lead evidence. |

Schema work must explicitly accommodate existing non-null turn references and immutable triggers in launch/grant/pending tables. Use a migration with exactly-one-authority constraints, preserving old structured rows and their guards. Do not edit historical schema definitions to pretend the new shape always existed.

## 9. Verification and handoff

### Restricted-clone build contract

Every slice includes its implementation, fixtures, acceptance criteria, exact focused test list and a handoff identifying the candidate commit.

Run:

- `npm run typecheck`.
- The changed files’ focused TypeScript tests.
- Relevant Rust contract/test targets.
- For UI edits, the required YouIyouX checks and available rendering checks.

Do not run the whole unit suite or `vitest related`. Split socket/native cases out of clone-safe suites. A test that cannot run because localhost, PTYs or the real fence are unavailable is **not passed**; list it for the lead.

Do not weaken a test, add a success-producing skip or replace real-fence proof with mocks to make the restricted clone green. Injected tests establish contracts; the lead tests establish integration and containment.

### Stand-in interactive Claude

The stand-in must draw a full-screen UI and exercise:

- Keys, slash-command responses and fake permission prompts.
- Resize, alternate screen, Unicode and long output.
- Input/output backpressure and controlled exit.
- Hostile terminal escapes and split sequences.
- Deterministic synchronization signals separate from screen appearance.

It makes no model calls and never falls back to the installed Claude CLI.

Build every spawned environment through the existing isolation kit, with `checkedEnv` immediately before spawning. Use throwaway HOME/XDG/config/state, short socket paths, fake credentials and approved tools. Rust harnesses must use the same isolated-world policy through the test launcher and explicit cleared child environments. Tests never reach the person’s real setup.

### Required security evidence

Add cases to existing rule tables where applicable:

- Wrong owner; stale/deleted session; account reset/demotion; expired permit.
- Forged terminal provenance; local-owner/passwordless browser attempts; machine/API-token/lead callers.
- Wrong/missing Origin, CSRF or attach key; wrong epoch; another-port cookie theft; forwarded-header spoofing.
- Sign-in removal followed by immediate resave, credential refusal and cross-process revocation during streaming.
- End, Stop, threads off and launch replacement racing dispatch or input.
- Lease takeover races, duplicate sequences, ambiguous delivery, stale paste confirmation and queued input after revocation.
- Unauthorized output/snapshot disclosure and buffered-output disposal.
- Registration failure, engine death, escaped descendants and verified shutdown under the actual fence.
- Native “yes” and slash commands failing to widen Toolroll authority.
- Live/snapshot escape parity, malformed output, secret-bearing errors and absence of durable raw capture.
- Arbitrarily many interactive prompts without turn-limit or cost holds; unchanged structured limits and accounting.
- Ship refusal until verified exit and the existing exact-candidate checks.

### Lead-run journeys

Extend `verify.mjs` and `docs/feature-map.json` with selectable attach features. Declare prefix keys and dialog actions explicitly.

Run stand-in journeys covering open, type, release, literal prefix, reattach, two agents, cross-client controller conflict, takeover, resize, paste refusal, disconnect, exit and Ship refusal while live.

Keep the verifier’s zero-relay-call assertion. Test relay behavior separately with an isolated fake upstream; do not weaken global outbound/privacy checks.

Inspect one desktop journey and one phone viewport journey, including empty, long-content and failure states. Include the existing saved-result path: open the result, inspect changes, leave realistic feedback and create a revision. Inspect both directions of shared state between chat and the screen where affected.

Check actual keyboard access, tap targets, contrast, overflow, fixed-control overlap, single-line short actions and mobile keyboard resizing. Phone viewport emulation does not prove physical-device keyboard behavior; report that gap unless tested on a device.

Save screenshots and journey output only under ignored `evidence/`. Label synthetic output clearly and leave evidence images out of commits.

Each handoff states:

- Exact candidate and covered base.
- Checks actually passed.
- Lead-only checks still pending.
- Independent Codex security-review outcome (or the original reviewer attribution for a review already completed).
- Concrete simplicity findings and before/after evidence.

Before live work, verify deployed UI, worker and resolved CLI identity. Follow normal update, drain, backup, compatibility, approval and health checks. A source merge or passing build is not deployment. Use the unchanged approved machine verification command once at the final gate; changed candidates or failed gates require fresh evidence.

## 10. Decisions

| Decision | Status | V2 decision |
|---|---|---|
| Bounded attach scope | **Decided** | Claude thread attachment in workbench and owner browser; ordinary task-build control and unrelated frozen features excluded. |
| Runtime default | **Decided** | Stream-json remains default; interactive selected at creation. |
| Interactive turns and cost | **Decided** | No turn counting, turn limits, spend enforcement or cost display. Optional silent usage records only. |
| Relay authority | **Decided** | Launch-scoped interactive session replaces running-turn identity; current sign-in, epoch, level, network/fence, revocation and live-launch checks remain. |
| Implementation and review | **Decided** | Codex builds every slice; a separate Codex session reviews every security slice before merge while Claude is unavailable. |
| Who may attach | **Decided** | Thread owner through a proven local workbench session or password-proved owner browser session, wherever admitted transport permits. |
| Passwordless browser links | **Decided in this plan** | Insufficient for browser attach. Direct local-workbench authority remains the explicit exception. |
| Machine/API-token/lead callers | **Decided** | No terminal viewing or input authority. |
| Simultaneous control | **Decided** | Several authorized viewers; one engine-owned controller lease across all clients. |
| Release key | **Decided** | `Ctrl-]`, then `q`; doubled `Ctrl-]` sends the literal key. Build shells unchanged. |
| Levels | **Decided** | Full only; native prompts cannot establish Supervised enforcement. |
| Recording | **Decided** | No durable raw PTY capture. Optional redacted history remains off and unenabled until proven. |
| Ready and Ship | **Decided** | No screen-inferred completion; Stop and verified exit before Ship; existing candidate/check requirements remain. |
| Detach and quitting | **Decided** | Detach preserves an authorized agent only while its owning engine remains running; preserve explicit foreground exit choices. |

Enablement requires a person to operate the native Claude UI from both supported clients, release and transfer control reliably, and reattach without restarting the agent. Required authority and containment attacks must pass on the exact candidate, with no interactive turn/cost enforcement and no weakening of structured-mode guarantees.

## Slice 0 clone handoff (2026-11-18)

Working-tree candidate on `attach-0`, base `main` at `f91ea7745e08412759acd8079da4ef2bd5b7cb43` (0.9.114).
Production launch remains disabled. This slice adds facts and synthetic test infrastructure only, plus the standalone
terminal safety filter from slice 4; it does not wire the filter into a transport or implement a snapshot serializer.

`test/fixtures/engine-api/schemas.json` is intentionally untouched. The lead must regenerate it with
the canonical `engineJsonSchemas()` and `engineContractDigest()` exports after building, verify the new digest and
Rust fixture round trips, and rerun the crate tests outside the clone's socket restriction. The contract test's
`ENGINE_WRITE_SCHEMAS=1` switch is currently dropped by the standard isolated worker; the lead can generate directly
from the built contract module instead. Do not edit the snapshot by hand or weaken its equality test.

Focused clone tests: `src/interactive-claude-contract.test.ts`, `src/terminal-safety.test.ts`, and
`src/contracts/engine-api.test.ts`; Rust `toolroll-api` fixtures and `toolroll-tui`'s
`term::terminal_attack_corpus` test. The shared corpus specifies a display difference for a malformed OSC:
the raw VT parser renders the text after the cancelling ESC as plain cells, while the engine filter drops it
through ST. Neither boundary emits host controls; no Rust runtime behavior changed.

Lead evidence remains: native PTY/resize and process-exit journeys with the stand-in, later live/snapshot transport
integration, real-fence proof where applicable, and the required independent security review before merge (Codex while Claude is unavailable).
No product screen changed; desktop/phone product journeys belong to later UI slices.
