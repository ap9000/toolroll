# MCP gateway — spec (v6, after Codex rounds 1–5)

Parity II's MCP phase. The plane becomes reachable by agent clients as
an MCP **server** — never the other way round.

This document defines the v6 gateway baseline. The later
[mate arc §2](mate-arc.md#2-the-tools-shared-with-mcp),
[§9](mate-arc.md#9-v3-2026-09-02-suggested-answers-and-proposals-over-the-gateway), and
[§10](mate-arc.md#10-v4-2026-09-02-scout-tasks-and-telegram-digests) extend that
baseline with read tools, coordinator proposal rows, and scout reports.
Those sections supersede the six-tool/single-write surface only where
they explicitly add a tool or result; the credential, quarantine,
approval, and transaction requirements here continue to apply.

Structure (round-1 rulings, round-2 corrections folded):

- **No new task state.** The write tool calls the EXISTING canonical
  filing door (`fileTaskProposal`, src/proposal.ts) with `filedVia:
  "mcp:<name>"` (display provenance, inside the existing grammar)
  plus the branded-door-only `coordinator_cid` column (authoritative
  linkage — see credential identity below) and the credential's repo
  allowlist as the ceiling. What it files is an ordinary unapproved
  task.
- **Admission is the existing per-task scope approval ceremony** —
  digest-bound, password-signed, ruling-10 terms restated. The MCP arc
  adds no admission machinery.
- **But "unapproved = inert" is NOT current law** (round 2 finding 1):
  three roads act on unapproved scopes today — pre-approval planner
  claims (claim.ts:367), builder claims under a live attended
  authorization (claim.ts:376), and mode auto-seal — which exists on
  the console scope-edit path (serve.ts:4937), the CLI `task scope`
  road (operate.ts:8184), AND the exported primitive (scope.ts:691).
  Therefore: **the coordinator quarantine, enforced in the
  primitives, never per surface** (round 3 f1). (a)
  `sealScopeApproval(..., {kind: "mode"})` transactionally refuses a
  coordinator-filed task (`coordinator-filed — mode coverage cannot
  admit it; sign the scope`); console, CLI, and any direct caller hit
  the same wall. (b) The claim quarantine lives in the SHARED
  acquisition primitive every claim road flows through — raw acquire,
  planner, attended — one SQL predicate, so roads cannot diverge.
  Tests exercise each road against the primitive. After a password
  seal, an MCP-filed task is ordinary in every respect.

## One paragraph

`toolroll mcp` serves MCP over **stdio**, zero-dep, against the
same SQLite database. ALL tools — reads included — require the
**coordinator** credential (DESIGN.md §9b): minted by an operator
password ceremony, hashed at rest, plaintext shown once, repo-scoped,
rate-limited, revocable, revocation re-checked inside every mutating
transaction. The single write verb files through the canonical door; a
human admits through the existing approval ceremony. Approve, steer,
answer, pick, mint, mode, config, merge: no tool exists, and the
credential cannot express them. The password never transits MCP.

## Over HTTP: an engineer's own agent

The console also serves the gateway at `/mcp` (src/mcp-http.ts), so an
engineer's coding agent on their own laptop uses the one central server.
Make your own API token (Settings → Sessions & tokens), then:

```sh
claude mcp add --transport http toolroll https://<host>/mcp --header "Authorization: Bearer so_…"
```

- Stateless streamable HTTP: one JSON-RPC message per `POST`, one JSON
  answer (a notification gets `202`). No sessions, no event stream, no
  other methods. Bodies are capped at 256 KiB.
- Only an `so_` API token or a coordinator credential signs in, and
  every request signs in again: a revoked or expired token gets `401` on
  its next call. Passwords and cookies sign in nothing here; a request
  carrying a browser `Origin` is refused; the console's Host check runs
  first.
- A coordinator credential sees exactly the stdio tools above.
- A person sees `status`, `list_tasks`, `task_show`, `task_review` (the
  `--brief` packet), `review_findings`, and — with an act token on an
  account that acts — `file_task`, which files under them and waits for
  approval as usual. Each call is the `toolroll` command they could type,
  run on the server as them (`runOperateAs`, source `mcp`), so their
  project grants and the token's scope apply and the ledger names the
  person and the token. Approvals, answers, people and policy stay in
  the console and chat. (`propose_decision` waits for a proposal-only
  decision command.)

## Coordinator credential

- Mint: `coordinator mint --name <n> --repo <path>... [--per-hour N]
  --as <approver>` — password ceremony, ledgered, token printed once.
  Name: 1–32 chars `[a-z0-9-]`, NFC-normalized, unique among LIVE
  credentials. **Identity is the immutable credential id** (`cid`):
  12 chars `[a-z0-9]`, crypto-random, unique with insert-retry on
  collision, never reused. **Linkage is a column, not a string**
  (round 3 f4): `task_ref` gains a nullable `coordinator_cid`
  foreign-key column, written ONLY by the branded coordinator door —
  no other filer can set it, so provenance is unforgeable by
  construction. `filed_via` stays display-only (`mcp:<name>`, inside
  the existing FILED_VIA grammar — no delimiter parsing anywhere).
  Cap accounting, idempotency, and every authority join go through
  `coordinator_cid` = exact join to the credential table. People
  screen shows name, cid fingerprint, allowlist, limit, last filing.
- **Repo allowlist mandatory** (≥1 canonical repo at mint; it IS the
  door ceiling). No global credential exists.
- Rate: default 6/hour, `--per-hour` ∈ [1, 60], sliding window,
  enforced in the filing transaction.
- **Outstanding caps, exact predicate**: a task counts while
  `coordinator_cid = <cid>` AND its scope is unsealed (no approval
  seal — stale-digest unsealed counts) AND its state ∉
  {`done`, `cancelled`} — `failed` COUNTS (dead unsealed filings
  pressure cleanup), with its own test saying so. Per-cid 10,
  global-over-all-cids 50, both queried inside the filing
  transaction. Refusals name the cap and the road.
- Revoke: `coordinator revoke <cid> --as <approver>` — immediate,
  history kept.
- Storage: additive migration — `coordinator_credentials`,
  `mcp_idempotency`, and `coordinator_event` tables + the
  `coordinator_cid` column on `task_ref`; `filed_via` carries display
  provenance only. Event rows (filing, dismissal, revocation) are
  inserted ATOMICALLY with their state change, in the same
  transaction — never as a separate write.
- Brand: new disjoint unforgeable `VerifiedCoordinator` with a
  module-private constructor (the exported-cast mistake of
  `verifiedAuthor()` is named and not repeated). Steering and every
  operator-speech surface never accept it — compile + arch test.

## Token handling (fail closed, no degrade)

- `--token-file <path>` XOR `TOOLROLL_COORDINATOR` env; both →
  refuse; neither → refuse (no unauthenticated mode).
- Token file read through the fd: open `O_NOFOLLOW | O_NONBLOCK` (a
  FIFO must not hang the open — round 3 f7) → fstat → regular file
  (anything else refuses), process-uid owner, mode exactly 0600,
  ≤4 KiB. Any failure: refuse, naming the check.
- Startup verifies against the hash and DIES on invalid/revoked —
  never a read-only fallback. Every `tools/call` re-authenticates;
  the filing transaction re-reads revocation (the law lives in the
  txn).
- `tools/list` is presentation; authorization happens on every call.

## Reads are allowlist-scoped in SQL (round 2 finding 2)

Every read tool intersects the credential's allowlist **inside the
query, before aggregation, ordering, LIMIT, and counts** — the
console-scoped helpers (which admit repo-null rows) are not reused.
Repo-null tasks are EXCLUDED from every MCP result. `get_task`
rechecks allowlist membership before task, run, and evidence lookups
(a ref outside the allowlist answers `not-found`, indistinguishable
from absent). New store methods, credential-scoped by construction;
tests prove repo-null and foreign-repo rows never appear.

## Tools (v1 — the baseline surface)

One typed descriptor per tool is the single source: runtime parsing,
`inputSchema`/`outputSchema`, exposure, projection. Schemas:
`additionalProperties: false`, exact required fields, bounds, enums,
cursor pagination with stable ordering, bounded sizes. Output is
field-by-field typed projection; `...row` spreads are arch-forbidden
in the MCP module.

| tool | returns / does |
|---|---|
| `status` | liveness facts + counts over the allowlist only. "Live" = lease generation + expiry. "Today" = rolling 24h. Waits-on-you categories = the board's attention lanes, verbatim. |
| `list_tasks` | state-enum/repo filter (repo ∈ allowlist), rows: ref, title, state words, repo, chip words; cursor, `limit ≤ 50`. |
| `get_task` | scope words incl. fallback chain + approval standing + filer provenance, attempt ledger (outcome words, provider/model, duration), current wait. Costs: integer micro-USD + coverage words, never floats, never lying sums. Evidence: opaque artifact id, content hash, byte size, capture status, media type — no paths, no bodies. |
| `list_repos` | allowlist ∩ enrolled projects, scope/mode standing in words. |
| `get_contract` | a NEW narrow MCP-contract guide (tools, lifecycle, admission promise). The general agent guide is not served. |
| `file_proposal` | the one write. Input: `repo` (REQUIRED, non-empty, ∈ allowlist), `title`, `intent`, `idempotency_key` (required, 8–64 chars), optional `deliverable` (`branch` \| `report` — a scout task, mate arc §10). Calls the door; **the door is also amended: an omitted or empty repo while a ceiling exists refuses** (`proposal.ts` today lets empty repo bypass the ceiling — closed in this arc, with its own test). Returns ref + admission road in words. |

### Idempotency (MCP-specific, not `Store.replay`)

The existing replay primitive is global-keyed and digest-blind — not
reused. New `mcp_idempotency` table keyed `(cid, key)` storing the
canonical request digest + resulting ref. Same key + same digest →
original ref, no rate charge. Same key + different digest →
`idempotency-conflict`. Authenticate → revocation re-check → replay
lookup → rate check → caps → door filing → ledger event: ONE
transaction.

## Protocol (corrected to the official spec, round 2 finding 6)

- JSON-RPC 2.0 over stdio; stdout carries protocol bytes only, logs
  to stderr; clean EOF = shutdown.
- Two pinned revisions with per-revision byte fixtures: modern
  `2026-07-28` (stateless; per-request `_meta` protocol version +
  capabilities validated, unsupported version answered with the
  spec's unsupported-version error; `server/discover` implemented;
  **modern results are schema-complete**: every success carries
  `"resultType": "complete"` — including `tools/call` results with
  `isError: true`, which are still JSON-RPC results — and
  `ListToolsResult` and `DiscoverResult` additionally carry their
  required `ttlMs` and `cacheScope` fields (semantic choice: no
  caching promised — `ttlMs: 0` with the schema's narrowest
  per-session scope; the exact enum spellings come from the pinned
  official schema and are FROZEN in the byte fixtures)) and legacy
  `2025-11-25`
  (initialize handshake incl. receiving
  `notifications/initialized`; a client requesting an unsupported
  version is answered WITH a supported version per the lifecycle
  spec — negotiation, not refusal). **The eras never cross**: an
  `initialize` handshake can only negotiate the handshake era
  (`2025-11-25`), never counter-offer `2026-07-28`; the modern era
  is entered only via per-request metadata / `server/discover`.
  Legacy responses carry no modern-only fields.
- **No JSON-RPC batching in either revision** — arrays are rejected
  (batching left MCP in 2025-06-18).
- `notifications/cancelled`: a notification — no reply of any kind;
  the server stops work on that request id and suppresses its
  response.
- Limits: request ≤ 256 KiB, depth ≤ 32, in-flight ≤ 4.
  Depth validation must also accept wide, shallow JSON within the byte
  limit without overflowing the runtime's call or argument stack.
- Protocol errors are JSON-RPC errors; tool refusals are `tools/call`
  results with `isError: true` + words. Channels never mix. Malformed
  input never crashes; fixtures prove it.
- Implementation verifies both revision strings and behaviors against
  the official spec text at build time, in a reviewed commit.

## Prerequisite hardening (same arc, before the server ships)

Runner authority (round 1 f3, round 2 f4 — ALL mint/exec roads):

- Every runner mint/rotation road requires the approver password AND
  binds a repo list: `runner register --repo <path>... --as`, the
  `up` road, and any re-registration/takeover. **`up` currently
  proceeds on `verified: false` (operate.ts:6141→6258) — that ends**:
  recovery and registration require `verified === true`, and `up`
  passes its canonical repo list into `registerRunnerIfIdle`.
- **The gate invariant is a three-way tuple** (round 3 f2):
  `task_ref.repo` is non-null AND `worktree.repo === task_ref.repo`
  AND `runner.repos ∋ task_ref.repo`. Authority derives from
  `task_ref.repo` ONLY — a caller `--repo` or worktree that
  disagrees refuses in words (today the builder proves the worktree
  belongs to the task but never that `worktree.repo ===
  task_ref.repo`; that proof is added). **Enforced early and
  everywhere** (round 4 f1):
  - The SHARED acquisition primitive rejects BEFORE its claim CAS
    unless `task_ref.repo` is non-null and belongs to the
    authenticated runner — a repo-A runner never even holds a claim
    on a repo-B task. **Identity is proven inside the transaction**
    (round 5 f1): today authentication happens outside and `acquire`
    receives only a runner name, so a takeover between auth and
    claim lets a stale process ride its successor's authority. Every
    acquisition variant re-verifies the token/credential generation
    in the SAME transaction as the repo-membership check and the
    claim CAS, and the same current identity is re-proven
    immediately before setup and every provider spawn. Tests race a
    takeover between auth-and-acquire and between acquire-and-spawn.
  - Every runner-authenticated road that takes a repo validates its
    canonical repo against `runner.repos` BEFORE any repo I/O or
    mutation — tick's git access, capability probes, routine firing,
    watch-lease acquisition, and recovery included.
  - The spawn re-check is phase-complete by construction: before
    every provider-process spawn through `invokeAgent`,
    `invokeHeldAgent`, and any setup gateway — build, plan, repair,
    review, and held sessions alike; no enumerated-phase list to
    fall out of date.
- **Repo-null tasks stop dispatching** — no repo-scoped runner can
  authorize null. Existing repo-null queued tasks surface as visibly
  unplaceable. Recovery preserves the original task and its history:
  file a new task with `task add <title> --repo <path>` (or select the
  repository when creating it in the console), restate its scope, and
  obtain fresh approval. Once a scope exists, `placeTask` refuses a
  repository change; do not move an existing approval, copy its grants,
  or rewrite its evidence. The refusal names this replacement road.
- Existing runners (`repos = []`): **deny-all at the gate**, refusal
  naming the one-time authenticated ceremony `runner bind <name>
  --repo <path>... --as <approver>`. No wildcard interpretation
  exists. `up` performs the bind on its next verified login.
- Tests: `up` (incl. the verified=false refusal), standalone `build`
  with a mismatched `--repo`, `tick`, register/retire/bind, the
  worktree≠task_ref mismatch, and the repo-null refusal — each
  proves the gate, not a CLI wrapper.

Store opening (round 2 finding 5):

- The MCP server opens in **no-migration mode**: schema
  newer/older/absent → refuse in words; it never creates directories
  or migrates.
- **The migration race is closed by an epoch, not by re-reading**
  (round 3 f3 — today's migrator alters schema first and bumps
  `schema_version` last, so a version re-read can pass mid-DDL). The
  migrator commits a `migration_epoch` marker in its OWN transaction
  BEFORE any DDL and clears it with the final version bump. The
  marker is a reserved sentinel row in the EXISTING `schema_version`
  table — representable before this migration's own DDL exists;
  protection covers this arc's and all future migrators (a
  pre-this-arc binary migrating the same live db is already outside
  the version contract, and an older binary seeing the newer schema
  refuses on version alone). Every
  MCP call runs its version+epoch check and its data reads in ONE
  transaction/snapshot; the filing transaction is `BEGIN IMMEDIATE`.
  Epoch set or version moved → the call refuses in words and the
  server exits cleanly. The concurrency test pauses a migrator
  after its first DDL, before the version bump — and proves the MCP
  call refuses.
- db/WAL/SHM and their directory 0700/0600. WAL/SHM are recreated by
  ANY writer, including this server: the MCP process opens with umask
  0077 and verifies/repairs the modes of db-adjacent files after its
  first write. Threat boundary stated in DESIGN.md words: stdio is a
  transport, not an authority sandbox; same-UID direct SQLite access
  is out of scope and said so.

## Dismissal (round 2 f3, round 3 f5)

There is no general task-event table today and `task state <id>
cancelled` bypasses `cancelTask` entirely — so the road is made
singular and durable: a new `coordinator_event` table (additive)
records filing, dismissal, and revocation rows — the durable audit
behind the People screen and task provenance words.

**One genuinely lowest cancellation transition** (round 4 f3 +
round 5 f2 — `setTaskState` was not actually the floor: mirror
latching (store.ts:5120) and fenced disowned completion
(claim.ts:878) write `cancelled` directly, and a coordinator task is
ordinary after approval so it can reach both). A single private
transition function is THE only writer of `state = 'cancelled'`,
used by `setTaskState`, human dismissal, mirror latching, and
disowned completion alike. It atomically records the reason —
a validated bounded human reason for operator dismissal, a TYPED
machine reason for machine roads (`mirror-latched`,
`disowned-completion`) — and, for `coordinator_cid` tasks, the
`coordinator_event` row, in the same transaction as the state
change. It does not refuse live claims (the disowned-completion road
requires that); the human-dismissal wrapper keeps today's
live-claim refusal. An architecture test forbids any other
`'cancelled'` state write; tests cover coordinator mirror-latch and
in-flight disown producing typed events. Ordinary tasks are
untouched in behavior — they simply share the floor.

For coordinator-filed tasks, the private transition rejects missing,
blank, over-500-character, control-bearing, or disguised human reasons
before changing state or audit rows. `task state <id> cancelled
--reason <text>` and the console's armed cancellation form pass the
operator's reason to that transition. A refusal does not consume an
idempotency key; the operator can correct the reason and retry. Machine
reasons remain typed, and ordinary-task cancellation keeps its existing
behavior.

## Demo mode

`toolroll mcp` against a demo db refuses at startup. No partial
mode.

## Console surfaces

- MCP-filed tasks are ordinary unapproved tasks plus: filer
  provenance in mono (`filed by mcp:planner-bot#a3f2 · 2m ago`) on
  the task page AND inside the approval ceremony form — the operator
  sees who asked before signing. The quarantine renders as words on
  the task page ("waiting for your approval — a coordinator filed
  this; nothing runs or plans until you sign").
- People screen: coordinators (name, cid fingerprint, allowlist,
  limit, last filing, revoke).

## Testing

- Protocol fixtures per revision: discover / initialize+initialized,
  list, call, parse error, unknown method, bad params, oversize,
  depth bomb, array rejection, cancelled-suppresses-response, EOF,
  version negotiation (legacy answers-with-supported and never
  counter-offers the modern era; modern unsupported-version error),
  `resultType: "complete"` present on every modern success and
  absent from legacy responses.
- Credential: mint ceremony, name rules + live-uniqueness,
  cid immutability across remint, token-file matrix (symlink, mode,
  owner, fifo, oversize), env XOR file, startup death, txn-time
  revocation.
- Filing: repo required + ceiling at tool AND door (empty-repo
  bypass closed), idempotency replay/conflict keyed by cid, rate
  window (injected clock), caps predicate (unsealed+non-terminal),
  demo refusal.
- **Quarantine at the primitives**: `sealScopeApproval` mode-kind
  refuses coordinator-filed tasks when called from the console path,
  the CLI `task scope` path, and directly; the shared acquisition
  primitive excludes them for raw acquire, planner, and attended
  claims. Post-seal ordinariness proven.
- Schema epoch: migrator paused after first DDL, before version
  bump → MCP call refuses; `coordinator_event` rows written for
  filing/dismissal/revocation; `failed` counts toward the
  outstanding cap.
- Reads: allowlist in SQL (foreign-repo and repo-null rows never
  appear, counts match), get_task not-found on foreign refs.
- Brand: VerifiedCoordinator constructor private; steering never
  accepts it.
- Runner gate: all roads (`up`, `build`, `tick`); `[]` denies with
  the bind road named; bind ceremony authenticated.
- Schema: no-migration open matrix + mid-session migration refusal.
- e2e: mint → serve → discover → file_proposal → board shows
  provenance + quarantine words → password approval (form shows
  filer) → ordinary dispatch runs it → status reflects; revoked
  credential dies at startup and refuses in-txn.

## Explicitly out of scope (designed doors, not drift)

Auto-admission mode term · public-read mode ·
evidence bodies (`get_evidence` later, bounded + hash-verified) ·
routine filing via MCP · any second write verb.

These exclusions describe the baseline; the reviewed mate extensions
linked above separately authorize their proposal-row write verbs.
