# Central workspace server contract

Status: Sprint 0 implementation contract proposed on `central-workspace`, 20 November 2026. Baseline is released 0.9.116 plus plan commit `3088ac68`. This document changes no runtime admission. Parent plan: [central workspace](central-workspace.md).

## First vertical slice and enrollment decision

Use the person's existing **ordinary API credential** for the first remote TUI: a token minted in Settings → Sessions & tokens through the existing protected browser ceremony, preferably read-only and limited to the intended projects. The launcher saves it through its protected credential store/profile boundary and passes it to the TUI through a protected descriptor. The TUI keeps it in zeroizing memory. It is never an argv value, environment variable, URL, task attachment or project file.

This is manual browser enrollment using existing credential machinery, not a newly shipped device-code or OAuth flow. `mcp-oauth.ts` has OAuth for the `/mcp` resource, but its tokens/grants are resource-bound and must not be repurposed for the TUI. Token-purpose `api` is required for the new connection protocol; lead/coordinator credentials, password bearers, MCP OAuth credentials and cookies are refused there. Validate purpose from trusted credential records, not the token prefix alone.

Do not convert an API token into a browser cookie or manufacture a `Who` with `via: "cookie"`. Preserve `parse_link`/`redeem` and `/login/once` as the local-owner-only road. Automatic browser-to-terminal pairing is a later, separately reviewed improvement; it is not required to get a useful read-only remote TUI.

The first code slice is **connection metadata and identity storage scaffolding only**, with remote read/action capabilities disabled. It does not make the TUI remote-ready or establish restore safety. Sprint 1 enablement follows the identity, credential-recovery and read-admission proofs below.

## Released call graph and admission matrix

`server/route-table.ts` declares every route. Console GET defaults admit `cookie` and `bearer` with read scope; explicitly cookie-only rows and handler checks narrow that. `routePrincipalOf` preserves a person's API token scope, while `reproveRemote` verifies account generation, current token standing and effective role. Current roles are `viewer` and `approver`; there is no third ordinary member role to invent. A viewer's nominal act token is effectively read-only. Instance operator is an existing derived authority, not a new role.

Caller admission is not enough for scoped credentials: `server/guards.ts:identify(request, touch, limited = false)` currently refuses project-limited API tokens on ordinary console reads because those paths do not propagate token limits. The remote CLI/MCP (and the new metadata adapter) explicitly use limited-principal admission. Thus the existing read projections can be reused, but their complete scoped-token admission is new CW3 work; do not enable it by changing only route caller flags. A native scaffold test preserves the scoped-token `/engine/hello` refusal while checking the unrestricted existing handshake.

| Existing route | Current owner / admission | Remote TUI decision |
| --- | --- | --- |
| `GET /engine/hello` | `engine-api.ts:hello`; existing signed-in console admission | Keep exact response and digest behavior; do not broaden local owner admission |
| `GET /work/rows` | `tasks.ts:workListOf` / Work collection admission | Reuse projection with token project lens and before/after principal proof; validate limited-account rollup explicitly |
| `GET /t/:task/steps` | `engine-api.ts:taskSteps`; task project resource admission | Reuse, including family/version membership and current project proof |
| `GET /t/:task/diff` and existing `run`, `file`, `from`, `count` query variants | `engine-api.ts:taskDiff`; saved result membership, bounded context and trusted repository record | Reuse exact queries/contracts; no arbitrary filesystem path or result from another task |
| `GET /agents/live/run/:run` | `engine-api.ts:liveRun` / `readRunLive`; cookie-only handler; reads files only for `options.localRunner` | Separate reviewed bearer-person read-admission slice required. Share the read core with a revalidation callback, not a synthetic cookie. Off-host output remains unavailable |
| `GET /engine/agents`, `GET /engine/models` | Explicit cookie-only routes/handlers | Disabled remotely initially; no provider sign-in/inventory leak. Later add safe summaries only if needed |
| `POST /engine/agents/check` | Cookie/form-key path and bounded local checks | Disabled remotely |
| `GET /t/:task/approval` | Cookie + terminal mutation key; may mint a held nonce only for locally eligible authority | Never call from API-token TUI. Open the exact protected browser page; no approval nonce or terms capability is minted by remote connection metadata |
| `POST /login/once` | `admitLink`, `spendLink`, `saveLinkSession`; direct loopback and local-owner proof | Unchanged; remote/Tailscale/forwarded requests remain refused |
| `/term/*`, thread start/reply/stop/end/ship | Existing cookie, local owner, operator or thread-owner rules | No remote capability in this arc. No general PTY or interactive attach enablement |
| `POST /api/cli` | `remote.ts:cliEndpoint` → `handleCliHttp` → `runOperateAs` | Sprint 2 action transport; existing command classification and principal are authoritative |
| `GET /live` | `server/live.ts`; bounded rooms, per-signal proof, restart incarnation and reload behavior | Not required for the first read slice. Integrate only admitted remote rooms after snapshot ordering and revocation proof; no generic durable event replay claim |

`showTask` currently assembles a browser task page, not a new typed detail JSON API. Do not parse its HTML. Work rows, step cards and diff are enough for the first bounded read-only slice. Further task facts must be a deliberate shared projection/contract addition, not an undocumented `?format=json` assumption.

## Identity storage

Proposed additive storage is one protected `workspace_identity` singleton containing:

```text
singleton = 1
workspace_id = lowercase UUID v4, immutable for the logical workspace
recovery_generation = 32 lowercase hexadecimal characters, opaque
created_at = server timestamp
```

The server-controlled migration creates the identity once for an admitted old schema. Current-schema missing, duplicate or malformed identity is an explicit unavailable/corrupt state; never regenerate it during a request or from a client/checkout field. The next schema number is allocated by the integration lead; do not assume 177 is free once parallel work exists. Append Store methods per `AGENTS.md`; keep migration/schema-shape validation additive and exact.

Public project IDs are also lowercase UUID v4, mapped by trusted central records to the existing canonical server path. That mapping is not a grant and does not replace strict realpath checks. Execution contract owns device/project binding details. Task references are at least `{ workspaceId, taskId }`; local cache keys also include the account. A task spelling must never resolve against whichever workspace is selected later.

Recovery generation is distinct from stable workspace identity, content revision, account generation, credential ID and server-process incarnation. A process restart does not rotate it or change task links. A deliberate database restore must rotate it through the protected restore path, and perform real credential retirement/re-proof before admission resumes.

## Proposed connection protocol

Add `GET /engine/connection` as a **new, separately versioned metadata contract**. Do not add it to `ENGINE_RESPONSES` merely for convenience: that would change `engineContractDigest()` and break the current strict local handshake. The connection contract can reference the existing engine version/digest without changing either. A future engine contract change follows the existing fixture/digest process explicitly.

Request:

```http
GET /engine/connection HTTP/1.1
Authorization: Bearer so_<id>_<secret>
Accept: application/json
x-toolroll-client: terminal-remote
```

No body, query, cookie, browser Origin, Sec-Fetch header, URL credential or second Authorization header is accepted. HTTPS is required for the central profile; the existing direct loopback local-owner path is separate. Do not follow redirects or accept an origin with userinfo, a path, query or fragment. Respect the existing trusted proxy/Host policy; forwarded headers cannot choose a credential destination.

Proposed strict response, illustrated with placeholders rather than live values:

```json
{
  "protocol": 1,
  "workspace": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "recoveryGeneration": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "label": "Acme"
  },
  "principal": {
    "account": "alice",
    "role": "approver",
    "access": "read",
    "expiresAt": "2026-12-20T00:00:00.000Z"
  },
  "engine": { "version": 1, "contract": "<64 lowercase hex>" },
  "capabilities": {
    "workRows": false,
    "stepCards": false,
    "resultDiff": false,
    "runLiveWindow": false,
    "commands": [],
    "approval": "browser",
    "providerSetup": false,
    "localCode": false,
    "localExecution": false,
    "interactive": false
  }
}
```

All capability booleans are false and commands empty in scaffolding. The illustrated digest is a schema placeholder, not a valid example value. Production schemas require the actual digest shape. The label is sanitized display data from installation settings, not an identity. Credential expiry comes from the trusted token record; do not return token ID, secret/hash, account password state, hidden project names or installation-wide provider details.

For enabled Sprint 1 reads, `workRows`, `stepCards` and `resultDiff` become true only after their implementation/review proofs; `runLiveWindow` is separate and may remain false. Both read and act tokens get the read capabilities their current project access permits. In Sprint 1, an act token still advertises no commands. In Sprint 2, `commands` is the intersection of the finite supported TUI command list, the existing remote contract and the current effective principal. It never advertises approval, people/policy, setup, shell or worker/device commands. Capabilities guide the interface; every request re-proves permission and never treats advertised capability as a grant.

Responses use `Cache-Control: no-store` and existing credential-safe logging. Unknown protocol versions/capabilities are disabled by the client. A digest mismatch disables engine reads with an update message; it does not fall back to a local database.

After initial profile consent, every request made through the new remote TUI transport carries the pinned workspace ID and recovery generation in dedicated headers (`x-toolroll-workspace`, `x-toolroll-recovery`). A shared server guard validates them **before** task/project lookup or output for `terminal-remote` requests. Duplicate/missing/mismatched values refuse. Current non-terminal API users retain their existing transport; the marker is not new authority. A changed generation ends the remote connection and requires the defined browser re-proof; the client cannot silently overwrite its saved binding.

## Principal and project proof

The new endpoint and remote read adapter accept only a principal authenticated through the existing person API-token path, plus the trusted token-purpose check. Reuse or factor the narrow `tokenPrincipalOf` logic presently inside `createRemoteHandlers`; do not copy password bearer fallback. Call `reproveRemote` and `remoteAllows` against current records. Token project limits and account project grants are intersected, never unioned. Never use an account role alone to recover permissions dropped by its token.

For each task/result/live read: prove principal and stored resource project before reading, obtain the bounded shared projection, then prove standing and resource membership again immediately before output. A record that moved outside the person's current view returns the same not-found response as an absent record. If the token's effective scope narrows, update capability display and reject pending disallowed acts. Authenticated empty views and missing resources must not reveal hidden task counts or project names.

Required refusal cases: unauthenticated/expired/revoked/wrong-purpose credential; ambiguous credentials; forbidden browser headers; invalid Host/origin/TLS; malformed or unknown query/header; workspace mismatch; recovery mismatch; unavailable identity storage; incompatible protocol; inaccessible task/run/file. Use a typed refusal vocabulary in the new contract, but do not change existing route refusal schemas in an unrelated slice. The connection endpoint may say sign-in changed; object roads retain non-enumerating not-found behavior.

## Snapshots, cursors and reconnect

There is already a durable `workspace-content:v1` service cursor through `prepareWorkspaceRevision` and `trackWorkspaceWrites`. It is invalidation/cache metadata, not process evidence, authority or an event history. Reuse it rather than introduce a queue/event service.

Initial remote TUI refreshes typed snapshots, using the existing bounded HTTP read path. Snapshot data is not an authorization cache. On sign-in/account/workspace change, revocation, session-ended response, credential replacement, re-enrollment or recovery-generation change, cancel in-flight requests, invalidate the old view generation and discard late answers before painting the view again. A server restart or recovery mismatch restarts the connection handshake; neither authorizes resending a mutation. Current unconditional TUI agent/model/SSE/effect startup must be guarded by the selected connection mode and explicit capabilities; a disabled/read-only connection cannot issue a background mutation, provider check or terminal request.

When adding live updates, subscribe with bounded buffering, fetch an authoritative snapshot, then drain/reconcile against revision; on `reload`, stale cursor or lost ordering, re-read. Existing live windows have per-console cursor keys and can explicitly report restarted/earlier/skipped/quarantined/off. Preserve those limitations. Do not present an unavailable off-host run file as an empty successful transcript. No live data is durable evidence simply because it appeared in the TUI.

## Sprint 2 actions and idempotency

Keep remote actions on `POST /api/cli` and `runOperateAs`; no new form-post adapter with fabricated CSRF/cookies. Classify the finite actions from the current command contract, not arbitrary argv from a server-provided link. Existing examples include `task add`, `task steer`, `task complete`, `task revise`, `task assign` and `task show`; their remote `yes` classification does not guarantee every optional flag is supported or that every account may invoke them. `reproveRemote`, `remoteProjectOf`, `remoteArgumentsOf` and the command owner decide.

The current CLI transport request is exactly `{ argv, files }`; it does not accept a new top-level command ID. Use the existing command's declared idempotency key flags where supported. Inventory each selected command's real replay/identity semantics before enabling it in the TUI. A missing key/revision guard is a blocking owner-level implementation slice, not permission to call an action twice or add an unreviewed generic deduplication table. `/api/cli` failures/unconfirmed responses require reading the saved outcome; the current client deliberately never automatically retries one request.

`reproveRemote` yields act only when token access is act **and** current account role is approver; browser operator privilege does not enter this path. Every command remains restricted to current project access, and command authorization/write must share the existing transaction boundary. Fresh scope/result digest, expected version and current actor are re-read by the action owner where meaningful. A stale result cannot inherit another result's passing check or approval.

Approvals remain browser-only. The TUI opens an authorized task's ordinary URL on the pinned origin and refreshes after return. It does not mint a nonce, carry a password, assert step-up, or expose an API approval command. A browser visit is not itself a completed approval; the server's actual saved decision determines the next state.

## Blocking recovery policy

`backup.ts:restoreDatabase` currently stages an upgrade and retires Flexible sign-ins before swap. This audit did not find a general restored API-token/browser-session retirement in that path. Therefore a changed connection `recoveryGeneration` alone cannot establish that an old backed-up credential stayed revoked: an attacker could otherwise fetch fresh metadata using the revived credential.

Before remote-TUI recovery guarantees or any laptop worker admission ship, implement a reviewed server-side restore retirement/re-proof slice. It must stage the new recovery generation and retirement of restored remote credential authority before the restored database is served: ordinary API credentials, relevant OAuth/refresh grants and browser sessions must not regain standing from backup; device/attempt grants join this rule when introduced. Keep stable workspace/task identities. Use the existing stopped-service restore ceremony and trusted migration/credential functions; no request can rotate this authority or use caller-controlled state to bless a restore. Specify any operator re-enrollment recovery explicitly and audit existing lead/coordinator credential effects rather than silently preserving a second route.

This is a blocking security design/implementation review, not a runtime change made by this document. The metadata scaffold must report no recovery-ready capability or enable remote TUI automatically while it remains unproved.

## Concrete implementation slices and focused proof

| Slice | Production ownership | Focused tests and required cases |
| --- | --- | --- |
| CW1 connection metadata, disabled | New `src/contracts/terminal-connection.ts`, new shared connection/identity module; explicit route + handler registration; additive Store/migration through integration lead | New contract tests; populated migration/shape tests; route/handler inventory cases; read/act token responses, wrong-purpose, duplicate headers, cookie/Origin, identity corruption; existing engine hello/digest unchanged |
| CW2 recovery retirement | `src/backup.ts`, actual shared credential/session lifecycle owners, identity helper | `src/backup.test.ts` plus credential lifecycle tests: revoke then restore old backup, interrupted staging/swap, old session/token/OAuth refresh reuse, original preserved on refusal, stable workspace IDs, new recovery generation |
| CW3 read admission | `src/server/engine-api.ts`, `src/server/tasks.ts` shared projections only as needed, route policy/identity admission, Rust client | Existing engine API and remote CLI tests plus focused two-person native TLS journey: project-limited rollup, task/run mismatch, revoke mid-read/stream, token downgrade, no owner fallback, workspace/recovery mismatch, central offline/no local fallback |
| CW4 actions | Existing command/action owners and `src/cli-http.ts` only where required; TUI transport | Focused command replay/version cases for each selected action; lost response/reconnect, two clients accepting/revising together, grant/account change before commit, read token refusal and browser-only step-up regression |

Gate fixture/inventory files require their existing `Gate-change` disclosure. Security-related Store methods are appended and receive the repository safety self-review before commit. Independent Codex review of the final exact diff and native evidence is required before integration/enablement. Do not run broad import-selected/manual whole suites, add skips, increase timeouts or introduce new agent execution limits.

No product source or test execution changed during this Sprint 0 contract audit.
