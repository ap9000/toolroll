# Central workspace terminal client contract

Status: Sprint 0 builder contract, 20 November 2026. Proposed behavior, not shipped capability. Baseline: 0.9.116 and `docs/plans/central-workspace.md`. This file owns the client/startup/interaction contract; server admission is specified in `central-workspace-server-contract.md`. No runtime changes or verification runs were made for this document.

## Job and first delivery

A person opens the team's existing task in their own terminal, sees the same authorized saved work, and returns to it after a disconnect. The first delivery is a remote-person, read-only TUI using central execution. Personal startup remains unchanged. Task mutations follow in Sprint 2; laptop execution and raw agent PTY control are separate work.

The experience has one obvious primary action in each state. The workspace and signed-in account remain visible. Secondary connection diagnostics live on demand. Network location must never silently change the meaning of a task or confer local-owner authority.

## Source-grounded inventory

| Current part | What it actually does | Required client change |
| --- | --- | --- |
| `src/cli.ts`, `src/easy-start.ts`, `src/tui-launch.ts` | Bare startup currently reaches local easy-start; `maybeRunRemoteCommand` does not turn the bare TUI into a central client. Native launch selects an installed trusted native binary, verifies its exact build/engine contract, checks file identity again before launch, waits for protected startup, then hands a one-time local link through FD 3. FD 4 carries bounded control messages such as opening the browser. | Preserve the binary trust/protected-start ordering. Add a distinct central credential bootstrap; never send a remote credential through the local link parser. |
| `src/engine-handoff.ts`, `src/tui-contract.ts` | Own the protected descriptor handoff, browser request and local lifecycle contract. Existing exit codes can stop or preserve workers this terminal owns. | Central sessions never own the server worker. Their exit is disconnect, not a stop request; do not reuse local lifecycle ownership. |
| `tui/.../src/main.rs` | Disables dumps before reading FD 3, redeems the link, checks `hello`, and constructs `run::Options { owned, project, control, stats_out, fatal }`. Errors can request the local classic-screen fallback. | Branch by an explicit bootstrap kind before redeeming a credential. A central error cannot enter the personal/classic local startup path. |
| `toolroll-api/src/client.rs:parse_link`, `redeem` | Only accepts an exact loopback HTTP one-time link. Stores browser cookie, CSRF and mutation key in zeroizing memory. Requests do not follow redirects and the client does not use proxies. | Keep unchanged for personal mode. A central-person client has a separate credential type and origin policy. No bearer-to-cookie conversion. |
| `client.rs:check_hello`, `src/contracts/engine-api.ts` | Exact engine API version plus schema digest check. `hello` currently exposes install mode and default chain, not a portable workspace identity or remote capability grant. | Use the proposed separate `/engine/connection` envelope for central admission/capabilities; retain exact engine read-contract checking and old local `hello`. |
| `client.rs:work_rows`, `steps`, `diff`, `diff_file`, `diff_context` | Typed reads of `/work/rows`, `/t/<task>/steps`, and `/t/<task>/diff` query variants. | First central surface: these authorized reads, through the server's proper person principal. |
| `client.rs:agents`, `models`, `agents_check` | The console machine's provider inventory/model settings and a status probe. | Do not label these as the laptop's agents. Keep absent in the first central capability set rather than expose server installation controls. |
| `client.rs:live_window`, `threads`, `thread_window`, `live` | Bounded run/thread reads plus `/live` invalidations. Current central source has local-runner/file assumptions; `/live` is not a universal durable event log. | Sprint 1 starts with authorized typed polling. Add bounded bearer run output only after its server admission exists. Never synthesize cookies to reuse the old stream. |
| `client.rs:act`, `post_form_json`, `approval` | Browser form actions carrying a CSRF token and mutation key. Approval reads can mint a one-time form nonce. | Central read tokens have no access to these write paths. Sprint 2 adds declared actions through the shared owner; approvals still open the browser ceremony. |
| `toolroll-tui/src/state.rs` | `tui-state.toml`: 0600, bounded, strict own-data resume state. It holds selected task/tab/scroll/filter/layout; no titles, credentials, agent words or notes. | Namespace central resume by workspace/account. Do not load the legacy global task selection into a central session. |
| `toolroll-tui/src/viewstate.rs` | `view.json`: bounded owner-only per-project view/unread data, currently keyed by a hash of the server-named project path. | Central keys use workspace/account/public-project identity, not a laptop/server path. Preserve personal legacy parsing. |
| `toolroll-tui/src/app.rs` | Draft notes are in-memory and tied to `(task, run)`. Submitted note batches keep request identity for the draft's lifetime. | Add workspace/account to the enclosing state lifetime. No automatic persistent draft/cache feature is assumed. Drop stale asynchronous answers across session generations. |
| `toolroll-tui/src/agents.rs`, `term.rs`, `editor.rs` | Can invoke provider sign-in/install, models writes and a separate build shell; editor export has its own isolation. | Deny these effects at dispatch for the initial central client. A hidden button is not the security boundary. |

`tui/...` above abbreviates `tui/crates/toolroll-tui`; the API crate is `tui/crates/toolroll-api`.

## Bootstrap and metadata contract

### Profile

Add a launcher-owned central workspace profile without rewriting the existing remote CLI profile silently. The first safe bootstrap uses an existing per-person API token with purpose `api`, read access and project scope. A person mints it through the existing protected browser Settings ceremony and saves it through the private launcher flow. It is never requested in chat, put in argv, pasted into a URI, logged, or read from a project-controlled file.

Proposed metadata shape; field names become final with the server contract review:

```json
{
  "version": 1,
  "profileId": "acme",
  "kind": "central",
  "origin": "https://toolroll.example.com",
  "workspaceId": "<server-issued immutable workspace ID>",
  "account": "<account returned by the authenticated server>",
  "label": "Acme",
  "credentialRef": "<opaque launcher-owned credential slot>"
}
```

- `credentialRef` is an internal slot, not a caller-selected token path. Keep secret storage outside projects and agent write grants; reuse existing protected file/credential handling where its authority semantics match.
- The authenticated enrollment response pins origin, workspace and account together. A local label or typed username cannot establish identity. Changing origin requires explicit re-enrollment; a redirect is refused.
- Central origins require HTTPS. Existing personal loopback HTTP stays in the separate local bootstrap. Never expand `parse_link` to make HTTPS or non-loopback local-owner links work.
- Metadata parsing rejects duplicate/unknown authority fields, unsafe files, links and malformed targets. Names used for paths are validated or hashed; user-visible labels are cleaned display data.
- The existing `connect` profile may be offered for migration only after the server verifies its account and immutable workspace identity. No automatic widening, copying owner sign-ins, or guessing workspace identity from a URL alone.

### Protected launch

The trusted launcher selects a bootstrap kind before it starts any local service. It proves the native binary and protected-start response before handing a secret through a bounded close-on-exec descriptor. A proposed tagged envelope distinguishes `local-link` from `central-token`; the central envelope includes the bound non-secret profile identity and zeroizing token. Direct native-binary invocation is not a new supported credential entry point.

The native binary must reject unknown tags and inconsistent fields. Local code continues to call `redeem`; central code calls its new person-token constructor and `/engine/connection`. Neither branch falls into the other on an error. Subprocesses/editors receive no inherited credential descriptor or token environment variable.

No public command syntax is claimed shipped. Proposed launcher selection such as `toolroll --workspace acme --task t-123` must be classified in the CLI contract and tested before documentation advertises it. The saved profile selects the origin; a task-opening command cannot smuggle a new server URL or credential.

### Connection handshake

Align with the server contract's proposed `GET /engine/connection`: bearer-person only; `protocol: 1`, immutable `workspaceId`, `recoveryGeneration`, authenticated principal/account and current access, existing engine version/contract digest, and a closed capability set. Local `GET /engine/hello` stays unchanged.

Before any task restore, content read or act, verify protocol, engine version/digest, pinned workspace/account and required capability. Unknown capabilities do not grant an action. A changed recovery generation discards pending action state, re-proves the session and fetches a fresh snapshot; it is not an instruction to replay work. A mismatch is a dedicated connection/update state, never a personal fallback.

Initial capabilities allow declared task/result reads. Remote provider installation, sign-in panes, model changes, task/thread terms, raw terminal, local worker lifecycle, approval and all unclassified effects are false. Permission checks remain server-authoritative even for capabilities marked true.

### Target and state identity

```json
{
  "version": 1,
  "workspaceId": "<bound workspace>",
  "taskId": "t-123"
}
```

This is a proposed non-secret task target, not a raw navigation URL. An optional public project ID can narrow navigation but cannot grant access. Existing task IDs need not be globally rewritten. A task target from workspace A is refused while connected to B; the TUI offers an explicit workspace switch rather than resolving the spelling in B.

Resume and view records are scoped to `(workspaceId, account)` and, for project views, `publicProjectId`. A controlled digest of this tuple can select a state filename; raw identifiers never become path fragments. A valid local state file grants nothing: the server must still return the selected task as visible. Keep current personal state/settings compatibility; central sessions never import legacy task selection by accident.

## Interaction contract

The current terminal world remains authoritative: existing task list, panels, palette, diff, step cards and status vocabulary. No replacement visual system or new canvas. Browser additions use the owned kit when implemented; this document specifies no CSS or component props.

| Scene | Short state/outcome | Primary action | Secondary route |
| --- | --- | --- | --- |
| No saved central workspace | Personal work opens as today | New task | Palette: Add workspace |
| Workspace enrollment | Sign into Acme | Open sign-in page | Cancel returns without changing workspace |
| Connecting | Connecting to Acme | None while connecting | Connection details; explicit cancel |
| Connected read-only | Acme · alice; normal work states | Open task | Browse permitted results/steps; capabilities explain unavailable acts |
| Remote task needs approval | Approval needed | Review in browser | Copy an ordinary exact-task URL if browser opening fails |
| Connection lost | Offline · last updated at [time] | Reconnect | Connection details; no queued mutation |
| Session ended/revoked | Sign-in ended | Sign in | Choose another workspace |
| Contract mismatch | Update Toolroll to connect | Update instructions | Connection details |
| Wrong workspace target | This task belongs to Acme | Switch workspace | Stay here |
| Task absent or not allowed | Task unavailable | Back to work | No distinction that reveals whether a forbidden task exists |
| Unsent note while leaving | Leave unsent notes? | Keep editing | Explicit discard; no silent auto-send |

Header information is workspace/account, not a paragraph explaining remote architecture. Execution machine is shown only where relevant and from server facts, never inferred from where the keyboard is. The Agents screen must not call server providers “this computer's agents” in central mode.

### Personal and central switching

No saved workspace means today's personal startup. A new workspace is an explicit secondary choice, not a mandatory organization wizard. After successful enrollment the person can choose the last workspace as default; this is separate from an old CLI profile's active flag.

Switching increments a client session generation, cancels live requests, clears content/action state and loads only the selected workspace/account's safe resume metadata. The same invalidation is mandatory on sign-out, revocation/session-ended, credential replacement, re-enrollment and recovery-generation change, including reconnect after any of them. Late responses from an earlier generation are discarded at delivery, even if a detached async job completed successfully. Do not let a background request update the currently displayed task solely because task IDs happen to match. Sign-out/revocation clears that account's content and secrets; previously copied material cannot be claimed erased.

Central quit means disconnect. It never offers or invokes “stop server agents,” and a local `--owned` flag cannot set central worker ownership. Personal quit retains the existing owned-worker choices.

### Browser step-up and return

In the first remote release, plain API tokens never approve. “Review in browser” opens the enrolled origin's ordinary encoded task route and current scope/revision context; it carries no secret and no automatic approval. The browser authenticates independently as the person and performs its existing exact approval ceremony.

The TUI resumes/re-reads the same workspace/task after the browser act. It shows only the current server outcome and digest/revision, not “approved” because a browser opened, a URI was visited, or an unrelated approval changed. A different browser account or changed scope produces the appropriate current state. If opening the browser fails, copying the ordinary task link is the recovery; never print a credential or approval nonce as fallback.

### Reconnect, offline and drafts

Sprint 1 uses typed snapshot polling, bounded to current selections; it does not claim the existing SSE parser supplies durable replay or bearer admission. A later authorized invalidation stream may wake reads, but fresh snapshots remain the source of state after reconnect, cursor expiry and restart. Re-read selected task visibility after list refresh and before showing result/live data.

Keep unsent notes in memory during a temporary connection loss. Initial central delivery does not persist agent content, artifacts or unsent notes to disk. Current resume files continue to hold safe IDs/own UI words only. Persistent private drafts or a content cache are a later reviewed capability; do not sneak them into `view.json`.

Offline controls cannot approve, cancel, reassign, answer or queue actions for automatic delivery. Once writes are added in Sprint 2, an unconfirmed response retains its request key and requires outcome reconciliation before retry; changing the text deliberately creates a new action only after the prior outcome is understood. Workspace/account switch with unsent notes asks the person to stay or explicitly discard. Avoid data loss disguised as a convenient connection switch.

## First implementation slices

### TUI-1 — explicit target/bootstrap separation

Add typed personal/central launch selection, strict bound profile/target parsing and a protected bootstrap envelope without changing local link redemption. Wire an explicit central selection before the existing personal service startup; unsupported central admission gives an explicit not-yet-supported connection state. Do not ship an unused permissive remote URL parser or make the present API client broadly public.

Candidate areas: `src/tui-contract.ts`, `src/tui-launch.ts`, `src/engine-handoff.ts`, `src/cli.ts`, `src/easy-start-args.ts`, `src/easy-start.ts` and a small new workspace-profile/target module after the server contract is settled; `tui/crates/toolroll-tui/src/main.rs`; `src/easy-start.test.ts`, `src/tui-launch.test.ts`, `src/engine-handoff.test.ts` and `tui/crates/toolroll-tui/tests/startup.rs`. Keep `client.rs:parse_link/redeem` and their rejection tests intact.

### TUI-2 — person-token connection and read-only shell

Depends on reviewed `/engine/connection` plus person-authorized typed reads. Add a distinct central credential client, handshake bindings, capability guards at effect dispatch, read-only task/result navigation and safe disconnect behavior. Central mode does not invoke `/term/*`, provider/model operations, local work shells or thread paths.

Candidate areas: `tui/crates/toolroll-api/src/client.rs` and models/export modules; `toolroll-tui/src/main.rs`, `run.rs`, `app.rs`, `agents.rs`, `palette.rs`; `toolroll-fake-engine` fixture scenarios for distinct users/workspaces. Engine schema/inventory changes require the appropriate gate disclosure and coordinated generated fixture updates, not weakened digest checks.

### TUI-3 — scoped resume and reconnect

Depends on stable public workspace/account identity from TUI-2. Namespace `state.rs`/`viewstate.rs`; add session-generation suppression and snapshot reconciliation. Prove old personal files still behave as before. New read-only central state must not claim durable off-host live output before that server capability exists.

Sprint 2 task acts, browser return and task-opening handoff are separate slices after these contracts pass; do not turn this read-only implementation into implicit write enablement.

## Focused verification obligations

Reuse `toolroll-api/tests/client.rs`, `fixtures.rs`, TUI `startup.rs`, `review_engine.rs`, `review_pty.rs`, `stranger*.rs` or the smallest corresponding existing tests for affected contracts. Add a table case to the relevant security rule rather than a wording/markup test suite. No manual whole suite or import-selected run.

- Existing non-loopback/local-link rejection remains unchanged; central authentication cannot set local-owner authority.
- Secret handoff occurs only after native dump protection, descriptors are close-on-exec, debug/error output is redacted, and spawned editors receive no secret.
- Profile/target wrong workspace, wrong account, changed origin, replayed enrollment, unsafe file and redirect cases refuse; invalid profiles do not start personal mode.
- Two workspaces with the same task ID and two accounts on one workspace cannot share restore state, drafts, unread marks or stale async responses.
- Protocol/digest mismatch performs no mutation; false/unknown capabilities block effects even if a key path or stale screen invokes one.
- Revocation removes future reads and content display; browser step-up opening is not approval; changed scope/revision cannot be mistaken for the prior approval.
- Connection loss never starts a second attempt, stops central workers, replays an unconfirmed act or silently persists notes.
- Bounded fake-engine/native terminal journeys cover 80-column and wide layouts, long workspace/account names, offline, forbidden task and update states. Browser enrollment/step-up needs desktop and phone viewport evidence when implemented; physical-device/IME behavior remains unverified until exercised.

Security-sensitive code requires the planned separate Codex review before integration. This Sprint 0 document is a concrete implementation brief, not that code review or native evidence.
