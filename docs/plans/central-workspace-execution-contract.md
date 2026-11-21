# Central workspace execution and candidate contract

Status: Sprint 0 proposed contract, 20 November 2026. Source baseline is 0.9.116 (`94542be4`); branch input is `3088ac68`. This document specifies Sprints 3–5 of `central-workspace.md`. It implements no endpoint, migration, grant or execution feature. Exact security diff and native evidence require an independent reviewer before enablement.

## Source audit and reuse boundary

| Existing source | What it provides | What it does not prove |
| --- | --- | --- |
| `src/project-identity.ts`, `src/project.ts`; `project.path` in `src/store.ts` | Canonical real-path identity, strict/vouched resolution, recheck generation | Portable project identity or permission on a different machine |
| `src/runner.ts`; `runner`, `claim`, `worktree`, `run` tables | Hashed runner credentials, repository bindings, capacity, atomic heartbeat, claim generation and worktree occupancy epoch | A safe off-host registration/dispatch/settlement protocol |
| `registerRunnerIfIdle`, `register`, `recoverDead` in `src/runner.ts`; `Store.releaseClaimsOf`, `recoverRunnerWork` | Local runner restart/recovery with liveness and optional local process-exit proof | Silence, retirement or re-registration with a display name is not proof that a disconnected laptop stopped |
| `src/process-custody.ts:witnessedRunner`, `src/runner-process.ts`, `src/sandbox-launch.ts`, `src/stop-proof.ts` | Spawn reservations, unknown witnesses, native custody and owned-process closeout | The central server cannot inspect another host's process table. `stop-proof.ts` explicitly refuses to vouch for another computer |
| `src/checkout-proof.ts:localCheckoutOf` | Current lease, runner, task and pool-root proof before revealing a local running checkout | Remote project mapping, downloading code or opening another person's checkout |
| `src/teardown-git.ts`, `src/commit-extract.ts` | Hardened Git readers, self-verified Git objects, normalized paths, collision checks, bounded regular-file extraction | An arbitrary uploaded pack/bundle is not safe merely because Git accepts it |
| `src/contracts/handoff.ts`, `src/contracts/proof.ts`, `src/evidence.ts` | Typed machine handoff, labelled agent claims, evidence caps and bounded output | A copied handoff is not a remote execution receipt or a passing machine check |
| `src/verification-evidence.ts`, `src/proof.ts`, `src/result-evidence-readers.ts` | Trusted check receipts and readers | Device-authenticated output is not automatically trusted verification |
| `src/backup.ts:restoreDatabase`, `src/live-backup.ts` | Offline restore checks, ledger/schema validation, backup handling; restored Flexible sign-ins are retired | A general recovery generation invalidating every proposed device/session/grant is not currently present |

`runner.name` and canonical paths currently carry identity in multiple tables. Add a separate portable mapping; do not rewrite existing task references or pretend a laptop path is a server path. Audit every call to the existing reclaim/reaper helpers before dispatching off-host work. In particular, `register()` releases claims/worktrees of a previous holder before saving the new registration, and dead-runner recovery can make work available again. Neither behavior may become remote stop evidence.

## Identity and trusted records

Use opaque, immutable IDs minted by the authoritative service. Pin workspace, project and device IDs to lowercase UUID v4. Pin `recoveryGeneration` to a fresh opaque 32-character lowercase hexadecimal value, distinct from stable identity and never a client-chosen counter. These spellings are encoding contracts, not permission checks. A protected singleton workspace identity record is created only by the additive migration or reviewed service initialization. Missing, duplicate or damaged identity at the current schema fails closed; a request must not repair it by inventing a new workspace.

```ts
type TaskRef = { workspaceId: string; projectId: string; taskId: string };
type AttemptRef = TaskRef & { attemptId: number };
type PublicProject = {
  workspaceId: string;
  projectId: string;
  // canonical server path and admitted Git destination are server-private records
};
type LocalBinding = {
  workspaceId: string;
  projectId: string;
  localRoot: string;       // locally proved real directory; never sent as server authority
  bindingGeneration: number;
};
```

The project registry only maps IDs to records. Existing account/project grants still authorize access. Task IDs remain unchanged within their workspace. Handoffs, cache keys and routes include workspace identity, so the active profile cannot accidentally resolve a task in another installation.

Proposed additive tables: `workspace_identity` (stable ID and recovery generation), `project_public_identity` (public ID to existing canonical project key), `execution_device`, `device_project_grant`, `device_attempt_authority`, and `candidate_transfer`. Exact schema version is assigned at integration, not pre-reserved here. Preserve original rows and all existing path-based authorization until an explicitly reviewed migration replaces it.

The service takes repository URLs, bases and grants from its own admitted records. The local worker uses the locally admitted binding and existing path/symlink checks. Checkout `.git/config`, a claimed hostname, a submitted URL or a task ID alone cannot choose a project, a destination or a permission.

## Sprint 3 candidate handoff

This is a new transfer/admission slice, not an assumed capability of today's revision form. It is independent of device execution: a person may return deliberate local edits before laptops are allowed to accept queued jobs.

Proposed operations are `beginCandidate`, `putCandidateObject`, `candidateStatus`, `finishCandidate` and `cancelCandidate`. Endpoint names below are provisional under `/api/candidates`; they must pass the normal route/auth classification. Use the existing person authentication and step-up policy, not a device credential or local-owner fallback.

```ts
// Person requests a transfer against a server-recorded task/result revision.
type BeginCandidate = {
  task: TaskRef;
  expectedTaskVersion: string;
  expectedResultId: string | null;
  key: string;                 // existing mutation idempotency convention
};
type CandidateOffer = {
  transferId: string;
  workspaceId: string;
  recoveryGeneration: string;
  baseCommit: string;
  baseTree: string;
  objectFormat: "sha1" | "sha256";
  limits: { totalBytes: number; files: number; objects: number; chunkBytes: number; depth: number };
};
type PutCandidateObject = {
  transferId: string;
  objectId: string;
  objectType: "blob" | "tree" | "commit";
  byteOffset: number;
  byteCount: number;
  sha256: string;
  // bytes in a bounded body, not a path on the server
};
type FinishCandidate = {
  transferId: string;
  expectedTaskVersion: string;
  headCommit: string;
  headTree: string;
  manifestDigest: string;
  key: string;
};
```

The service issues the base, format and bounds from current trusted state. Candidate offer creation rechecks task visibility, relevant action permission and current result/version in the same transaction as the transfer reservation. A transfer grants upload only; it grants no execution, result acceptance, check status or publication.

Initial transport uses raw bounded objects into a service-created private quarantine, not arbitrary archive extraction or a client-selected filesystem path. Object IDs and types are verified against actual bytes; normalized tree paths, `.git` components, case/Unicode collisions, modes, symlinks, submodules, depth and counts pass the existing verified-object/extraction rules before materialization. No compression is needed initially. Reuse already-verified base objects; require every referenced new object before finalization. Do not use checkout-controlled alternates/config, lazy fetch, filters, hooks or replacement refs to fill missing objects.

Proposed first network profile: at most 64 MiB transferred bytes, 10,000 materialized files and 1 MiB per chunk; objects/depth must also be bounded and never exceed `EXTRACTION_LIMITS`. These are proposed new transfer limits, not changes to existing extraction or execution limits. Pin the complete limits in the offer. Bigger projects get a clear unsupported/limit response until a reviewed policy changes them. Do not add a new agent execution deadline.

Chunk replay is accepted only when offset, length and digest match the recorded bytes. Conflicting replay refuses. Status returns acknowledged ranges and current state. Client timeout means unconfirmed; query status before retry. Partial transfers remain quarantined and cannot affect the existing task result. Cancel/retention deletes only transfer-owned staging after verifying no finalization owns it.

`finishCandidate` rechecks current person/account/project standing, recovery generation, task/result revision, exact base/head/tree graph and complete manifest. Finalization atomically changes `open` to `finalizing` and pins the manifest revision; subsequent upload/cancel writes cannot alter those bytes. File verification/movement uses a recoverable intent, followed by another transaction rechecking admission, generation, task revision and immutable staged digests before publishing the candidate reference. Proposed transfer states are `open`, `finalizing`, `stored`, `cancelled` and `refused`; a crash during finalizing is reconciled, not accepted or blindly replayed. Revocation or a changed base refuses admission. The accepted transfer becomes an unverified revision candidate/proposal tied to the original task, not a new Ready result and not a replacement of the old reviewed result. The existing explicit revision/admission/check/review path decides what happens next.

### Open code locally

The service offers its recorded repository/base/result object identities. The local client proves the selected binding, then invokes shared hardened Git helpers to obtain those exact objects and create a separate worktree in an admitted pool. It never rewrites the person's dirty checkout. A missing object/repository, changed binding, unsafe Git config, symlink, mismatched tree or unsupported LFS/submodule/private-dependency requirement produces a precise refusal. Local binding and source/destination proofs are repeated at use; a cached path resolution is insufficient after an await.

## Sprint 4 device enrollment without dispatch

A device is not a human principal, runner display name or transferable owner session. Initial registration must prove both host-side participation and the relevant existing operator/person authority through a protected browser ceremony. The server-contract document owns human enrollment/step-up details. Enrollment creates no running attempt and cannot silently add projects.

```ts
type DeviceRecord = {
  workspaceId: string;
  deviceId: string;
  ownerAccount: string;
  credentialGeneration: number;
  recoveryGeneration: string;
  displayName: string;          // display only, not unique authority
  state: "enrolled" | "paused" | "revoked";
};
type DeviceReadiness = {
  deviceId: string;
  protocolVersion: number;
  runtimeVersion: string;
  os: string;
  capabilities: string[];
  providerModels: { provider: string; model: string; available: boolean }[];
  capacity: number;
};
```

Store a credential verifier, not the credential value; the host stores its narrow credential in an owner-only protected location outside project/agent grants. Never reuse a person's API token. Device authority permits only its readiness/poll/attempt/upload roads; it cannot mint people, widen project grants, approve scope, publish, or expose other devices' tasks. Actual probes and provider secrets stay on the host. Readiness is an observation tied to a machine/time/version, not an authorization grant or proof of honest execution.

Project enablement binds current device and project generations, permitted capabilities, capacity and the person's exact consent. Widening requires a fresh admitted operation; narrowing/revoking is transactional. No counterpart of `addRunnerReposAuthed` may let a remote device choose arbitrary additional central projects using its own credential.

Enrollment/pause/retire and capabilities are available through authenticated control surfaces; chat links to the protected control rather than requesting secrets. Use outbound HTTPS/polling first. No inbound SSH, arbitrary remote shell or database access is required.

## Sprint 5 attempt and settlement contract

Every poll is authenticated as a current device and returns only eligible work. Selection/reservation loads the device/project/task/approval records and reserves capacity, attempt and count/budget accounting together. A process is not launched by a response claiming it was approved; the local guardian admits the exact response against its existing authority and current binding.

```ts
type AttemptGrant = {
  authorityId: string;          // server-owned record, not client-asserted authority
  task: AttemptRef;
  deviceId: string;
  recoveryGeneration: string;
  credentialGeneration: number;
  bindingGeneration: number;
  leaseId: string;
  leaseEpoch: number;
  scopeDigest: string;
  contextDigest: string;
  baseCommit: string;
  baseTree: string;
  provider: string;
  model: string;
  permissionsDigest: string;
  accountingReservation: string;
  validUntil: string;
};
```

The server stores this tuple before sending it; request copies are compared to that current record, never trusted as their own grant. A location/provider/model/permission change follows existing approval semantics; task identity does not carry a widened approval. Initial grants use the existing reviewed lease/grant bounds. No new agent execution timeout is introduced.

`poll` may replay a still-valid recorded offer; `ack/start` admits that authority once and records spawn custody before an OS spawn. A lost response is resolved through authority/attempt status, not another execution. Start, progress, renew, request-stop and settle each recheck device state/generations, current project binding, scope and lease epoch. Settlement does not trust a submitted host/process name.

A cooperative worker may not start a model call, tool or child after current grant/lease authority expires. It uses conservative monotonic elapsed validity, refuses stale authority after restart, and attempts to stop only work proved its own. Clock rollback, sleep and reboot cannot extend permission. Continuing beyond current authority requires separate reviewed terms. Server revocation immediately fences central actions; it cannot physically stop an unreachable/hostile machine.

Remote attempt state distinguishes pending admission, running, stop requested, unreachable/outcome unknown, proved stopped and settled. These are protocol facts, not a replacement product status vocabulary. Unknown custody remains unknown. An expired heartbeat does not permit side-effecting work to be requeued on a second machine. A replacement requires the reviewed stop/recovery proof or an explicitly isolated recovery attempt that cannot claim the original result or publish under its authority.

Use `witnessedRunner`, native sandbox objects and owned-closeout helpers on the actual execution machine. Send bounded custody summaries keyed to the authority/attempt. Raw PID numbers and signed device assertions are diagnostic/origin evidence, not central proof of process death or execution honesty. Display uncertainty rather than accepting a remote `stopped: true` bit. The first implementation assumes an explicitly enrolled cooperative execution guardian outside agent write grants, not a mutually hostile host operator. Native evidence from that guardian still has a declared trust origin. If the service cannot establish sufficient stop standing under the reviewed custody policy, it must not automatically retry: an authorized person must choose a separately isolated recovery with its uncertainty and possible side effects disclosed. Host trust/stop-receipt acceptance must be settled in the E4 security review; metadata or a device signature alone cannot settle it.

Result transport extends Sprint 3's quarantine/finalization protocol for progress/artifacts and exact result commit/tree. Progress is bounded and ordered; duplicate/conflicting sequence entries reconcile or refuse. The final settlement transaction checks the current authority before admitting the result reference and releasing reservations. Incomplete, revoked, wrong-epoch or wrong-base results cannot become the current result. Never let a device release capacity/spend merely by declaring itself absent or a transfer cancelled; unresolved actual attempts retain their truthful accounting disposition.

Trust labels stay distinct: agent-reported conclusion; device-observed execution/progress; received immutable artifact; centrally verified object identity; trusted machine check; human acceptance. Preserve actual provider/model, subscription versus API billing, reported usage and unknown cost; absent usage is not zero spend. A local result never imports uploaded `check: passed` as deployment authority. Initial local candidates run the normal central trusted verification before deployment; trusting another check location is a separate owner-approved policy.

## Recovery generation and restore

Stable workspace ID survives restore so task links still name the same installation. Recovery generation does not: restore establishes fresh authority before accepting any old remote credential/grant/lease. Existing Flexible sign-in retirement is useful precedent but not complete device recovery.

Sprint 0 must specify the restore hook and protected recovery root so rolling back the SQLite file cannot restore pre-revocation authority. Restore refuses while known local services are running as today; an offline remote device cannot be proved stopped by that local check. Rotate/invalidate remote device credentials and outstanding attempt authorities, require appropriate human/device re-proof, and quarantine old progress/results. Changing an advertised generation alone does not revoke credentials restored inside the database: the restore path must retire/re-prove those credentials server-side before service admission. A metadata-only identity scaffold must not advertise recovery safety. Restored task/evidence history may be shown as history; it is not live execution permission. Two server processes must not resume the same restored installation authority concurrently.

## Implementation order and focused proof

| Slice | Production areas | Concrete proof before dependent work |
| --- | --- | --- |
| E0: public identity mapping | Additive schema/reader; existing `project`/`task_ref` joins | Stable IDs/backfill, uniqueness, workspace mismatch, registry never grants access; preserve path resolution |
| E1: local candidate transport | New protected transfer module/contract; hardened Git and result admission integration | Complete/wrong/partial/replayed/conflicting uploads, base/tree mismatch, access revoked at finish, symlink/path/object attacks |
| E2: local worktree handoff | Client binding store, `worktree.ts`, hardened Git | Dirty checkout untouched, different machine paths, binding changed during fetch, unsafe config/hooks/refs, exact tree proof |
| E3: device enrollment/readiness | New device authority module/contract and protected control route | Replayed/foreign enrollment, revoked/rotated token, project widening, no jobs started, no owner credential fallback |
| E4: dispatch and custody | Existing admission/build/custody helpers behind new network authority | One start per recorded authority, expired lease/credential/recovery epoch, native stop, lost ack and restart |
| E5: remote results and recovery | Candidate transfer extension, trusted check readers, restore hook | Wrong epoch/base, revoked settle, unknown costs, untrusted check claims, restore cannot revive old authority |

E0 may be additive and unused by execution. E1/E2 can ship before E3/E4. E3 must remain non-dispatching until authority review passes. E4/E5 must be integrated and independently reviewed before any laptop execution is enabled. No separate database or new dependency is required by these slices.

Extend existing relevant tests rather than a broad import-selected suite: `src/runner-process.test.ts`, `src/claim.test.ts`, `src/closed-task-claims.test.ts`, `src/claim-custody-matrix.test.ts`, `src/worktree.slow.test.ts`, `src/checkout-reveal.test.ts`, `src/stop-proof.test.ts`, `src/verification-evidence.test.ts`, `src/backup.test.ts`, and `test/attacks/commit-extract.test.ts`. Add focused contract/migration/authority tables for new modules. Confirm exact test names before dispatch; this list does not claim they ran.

Required attack cases: cross-workspace ID collision; forged Git remote choosing project; `.git`/Unicode/path traversal; compressed/object amplification; raw object hash mismatch; revoked upload finalization; duplicate start after lost response; reused display name while old device runs; heartbeat expiry without stop; wall-clock rollback/sleep/reboot; retired device settling old epoch; untrusted uploaded check success; restored pre-revocation credential; local result requiring broader access than its signed scope. Native custody/isolation proof runs on each supported OS using only isolated fixtures. Preserve failed/incomplete evidence and current gates.

No tests, runtime processes or live settings were changed for this source audit. Unresolved implementation decisions are the exact human/device enrollment ceremony, protected recovery-root mechanism, and policy values for the network transfer profile. These are security ADRs to settle before their source slices, not permissions a builder may infer.
