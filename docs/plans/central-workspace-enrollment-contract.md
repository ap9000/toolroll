# Central recovery enrollment and discovery

Status: proposed contract for independent review, 20 November 2026. Documentation only. No implementation, credentials, service definitions, startup or restore behavior changed. This narrows the recovery contract's unresolved expectation-root boundary. Existing personal installations are not automatically enrolled; all central capabilities remain disabled.

## Initial supported boundary

Support a local POSIX installation owned by one OS UID on macOS or Linux. Trusted console, worker, MCP and direct CLI processes may coexist; enrollment does not turn SQLite into a single-process service. Windows, network filesystems, unattended initial enrollment, arbitrary remote restore and SSO-only recovery are outside the initial admitted central-recovery configuration. Their existing personal behavior remains unchanged.

The registry and root protect against database rollback, copied databases, accidental state loss, crashes and fenced project agents. They cannot prevent the OS owner from deliberately destroying all product records, removing every bound service and launching an old binary. Such destruction is a new trust installation, never authenticated continuity of the old central plane. A separately running old plane/clone is not assumed gone.

## Fixed discovery, independent of the selected database

Proposed registry directory: **`<OS-account-home>/.toolroll-central/`**. Obtain the home from an OS account lookup for the actual effective UID, not `HOME`, `XDG_*`, cwd, checkout metadata, selected database, request fields or CLI settings. A small platform adapter must verify the UID/home association, including real/effective UID disagreement; unsupported or ambiguous service accounts refuse central enrollment. `os.userInfo()` is an implementation candidate to validate, not an existing repository trust primitive. No `--registry-dir` or environment override exists on the production path. Tests inject explicit captured filesystem facts into pure code, never redirect live discovery using process environment.

Avoid one mutable global JSON index: use one expectation file per canonical database path, named `sha256(UTF8(canonicalDatabasePath)).json`, under a fixed `expectations/` directory. Its contents repeat that full path and digest; disagreement refuses. Entries are never garbage-collected or cleared by ordinary restore, service uninstall or personal startup. A path move requires a separately reviewed explicit migration and tombstone for the old path. The per-path shape limits damage from a malformed unrelated entry; an unreadable/unsafe registry ancestor still cannot establish absence.

Minimum versioned entry: `version`, `installationId` (lowercase UUIDv4), `workspaceId` (lowercase UUIDv4), `ownerUid`, canonical database and state paths, canonical state-directory identity, protocol/retirement-manifest versions, lifecycle (`enrolling | enrolled | recovery-blocked`), enrollment transaction ID, and admitted launcher/service identities. No password, token, provider secret or authority-expanding project grant. `enrolled → never-enrolled` is not a normal transition. The registry is outside database backup/restore.

A **protected launcher/service binding** independently pins installation ID, canonical database/path digest, required registry version and `centralRecoveryRequired: true`. It uses the fixed discovery rule; it does not point at an arbitrary root. Existing absolute service command and definition-digest machinery is a seam for a proposed typed central launcher/binding, not evidence that today's `--db` or digest creates this guarantee. A caller-supplied flag may demand stricter central admission; it cannot assert enrollment or weaken a protected binding. Service/profile binding readback must be part of installation/upgrade review; an edited command must not silently launch a personal service for the enrolled path.

The recovery root remains `<canonical state>/.toolroll-secrets/central-recovery.json`, binding the same installation/workspace/path, committed generation and transaction/manifest state. An additive database receipt repeats installation ID and enrollment protocol. Root/receipt presence is evidence requiring reconciliation, not self-issued enrollment authority. Root/receipt absence cannot cancel a registry or service expectation. Workspace identity metadata alone remains neutral.

## Filesystem and race contract

Existing `login-secrets.ts` is a useful starting point: private directory ownership/modes, `O_NOFOLLOW | O_NONBLOCK`, descriptor `fstat`, bounded reads and exclusive temp publication. It also explicitly leaves stale files rather than risk an `unlinkat` race, and its folder fsync is best-effort. Do not copy those limitations into a claim of durable enrollment.

Required new read rules:

- Resolve the OS account-home anchor from trusted OS facts. Verify traversed directories below it using no-follow descriptors; final registry/state secret directories must be owner UID, actual directories, mode 0700, and not symlinks. Reject group/other writable ancestor substitutions. A legitimate symlink alias for the **selected state parent** may canonicalize once under the existing path convention, but protected directories and the database file cannot themselves be symlinks; recheck the canonical target at use.
- Read expectations, roots and bindings as owner UID regular files, mode 0600, link count one, no symlink/FIFO/device/socket, bounded to 64 KiB, strictly parsed with version/field limits. Open nonblocking and no-follow; compare descriptor identity/type/size with the admitted name and read length. Unknown fields/versions fail central admission rather than being ignored.
- Missing is only a proved `ENOENT` at the expected protected name under proved parents. Permission failure, broken links, special files, oversize, malformed bytes and identity races are errors, never absence. Do not create a registry/root merely to classify a personal invocation.
- Canonical database path uses resolved existing parent plus basename, then actual no-follow database-file identity at admission. DB inode cannot be permanent identity because restore intentionally replaces it; the shared exclusion/root protocol admits a specific replacement. A path hash is a lookup key, not ownership proof.

Writes create owner-private files exclusively, flush file bytes, publish without clobbering an unrelated existing name, and durably sync parent changes. Updating an admitted record requires exclusive enrollment/recovery coordination, expected-version/transaction comparison and safe same-directory replacement. No recursive permission repair, following links, implicit ownership fix or unsafe deletion. A detected race fails without granting admission. Publishing `enrolling` must be durable before any dependent root, DB receipt or central service becomes active.

**Implementation question blocking filesystem integration:** Node path-based checks do not by themselves provide descriptor-relative rename/open/unlink safety against parent replacement. Choose and review a small native descriptor-relative adapter, or prove the protected ancestor/fence/exclusion assumptions sufficient for the admitted adversary. Until then, a pure classifier can test captured facts but cannot establish filesystem safety. Strict directory fsync failure must refuse central enrollment rather than be silently swallowed. Network/multi-host filesystems are initially refused; demonstrate the supported local-filesystem lock/durability assumptions natively.

Registry, bindings and all temporary/lock paths must be denied to agents **before launch**, including ancestors that would let an agent replace the protected name. Existing `.toolroll-secrets` deny does not cover a new independent registry. Audit `agent-fence.ts` and every supported provider fence, including already running agents: enrollment waits for old fences/processes to end rather than assuming a new deny retroactively applies. Trusted co-located Toolroll writers retain intended access.

## Classification and missing-record behavior

Classification consumes independently proved facts, not booleans from a request:

| Observed facts | Result |
| --- | --- |
| Registry absence proved; no protected central launcher binding; no root/DB enrollment receipt; ordinary personal invocation | `personal`: existing startup/restore policy unchanged; no central capability |
| Exact expectation is `enrolling`/`recovery-blocked` | `blocked`: matching DB metadata does not repair it |
| Expectation enrolled; root/DB receipt and admitted launcher binding match committed state | Eligible for central admission **only after** exclusion and retirement/startup checks; classifier alone returns no permission |
| Central protected binding exists; registry missing, corrupt or inaccessible | `blocked`, never personal. Instruction: local enrollment-state repair/reproof |
| Registry entry exists; root missing/invalid or DB predates enrollment/identity | `blocked`; preserve current files, no root initialization or migration-driven adoption |
| Root/receipt exists without an expectation, foreign IDs, copied DB at registered path, path/digest mismatch | `blocked`; explicit import/migration procedure required |
| Registry/name/parent cannot be inspected safely | `blocked/indeterminate`, never inferred absent. Unrelated malformed per-path record does not reclassify a proved different personal path |
| Reinstall preserves expectation or central service binding | Requirement survives; missing root remains blocked; reinstall does not auto-enroll or erase standing |

A copy of a pre-enrollment personal backup at an unrelated unregistered path is indistinguishable from an ordinary personal backup; this design makes no central-continuity claim for it. Removing all independent expectation/binding evidence is outside rollback safety, not a condition the DB can detect. Document that limit rather than invent an immutable marker.

## First enrollment and interruption order

Enrollment is an explicit local operator action, not a schema migration. First implementation must refuse unless the complete central recovery verifier/standing-authority manifest and shared writer protocol are supported. Current password-capable operator proof is the initial proposed recovery-compatible ceremony; no password changes or SSO policy changes occur merely to inspect personal state. A personal SSO-only/passwordless installation continues normally if it cannot yet enroll.

1. Classify existing state and show exact installation/workspace/path and consequences. Obtain fresh local operator proof, prove legacy processes/fences stopped, and acquire exclusive coordination. Recheck operator generation and current DB identity. No remote/shared-secret request can construct this proof.
2. Prepare inactive service/launcher binding and record exact digest. Durably publish expectation `enrolling` first. A crash now intentionally blocks that path until local reconciliation; do not fall back to personal.
3. Prepare root and additive DB receipt with exact same transaction/IDs/manifest. Initial generation is current admitted generation; enrollment is not a backup restore and must not arbitrarily revoke ordinary personal authority. Any necessary consented conversion is a separately reviewed operation.
4. Verify root, receipt and inactive binding; atomically mark expectation enrolled. Only then install/activate the exact admitted launcher under exclusive authority. Its own startup must recheck all records. No active central listener is created before commitment. Crash between commitment and service activation leaves an enrolled but unavailable plane, not a personal plane.
5. Release exclusion after durable readback. Re-enrollment/recovery never selects whatever record is newest. Local recovery can resume an exact transaction or leave a blocked tombstone; it cannot erase durable expectation while preserving central credentials. The old current DB remains untouched if stage preparation fails.

A registry expectation cannot alone prevent an old unsupported binary ignoring it. Before enrollment, prove those processes stopped; before activation, require schema compatibility and service pinning that refuse unsupported binaries. Preserve custody evidence; no new agent runtime limit or automatic failover follows from silence.

## Live integration inventory — deliberately not this helper

| Seam audited in current source | Required later protection |
| --- | --- |
| `store.ts:openStore`, `openStoreNoMigrate`, `openStoreReadOnly`; `cli.ts` store opens | Admission before live open/migration, including direct CLI and non-migrating MCP door. Branded isolated staged handles are distinct; raw store opens cannot imply readiness |
| `operate.ts:runUpRole`, `runWatchLoop`, serve/up/watch/release/restore command paths; `up-role-child.ts` | Same expectation and shared coordination retained by all live console/worker/CLI participants |
| `serve.ts:createDecisionServer`, `server/guards.ts:identify`, `server/session.ts` | Before listeners/background startup, cover browser/local-owner/password/API/SSO, durable cookies and in-memory sign-in maps; new epoch cannot keep cached connections |
| `mcp.ts:serveMcp`, `mcp-http.ts`, `mcp-oauth.ts` | Stdio and HTTP MCP, authorization codes/access/refresh, registration/token endpoints; existing per-call credential checks still required |
| `serve.ts` handler registry, live handlers, `terminals.ts`, `server/remote-hooks.ts` | SSE/live streams, terminal upgrade, public hooks/forms and chat-platform callbacks cannot bypass admission |
| `runner.ts` register/auth/heartbeat/claim paths and worker loops; triggers/schedules/chat/intake upkeep; approval/mode/release consumers | Dispatch, renewal, settlement, deliveries and publication transactionally check committed authority; registration-only check is insufficient |
| `backup.ts:restoreDatabase`, console/runner process custody, `deploy-lock.ts` | Exclusive stopped restore across stage/publish/root commit and prepared rollback, with actual old-process proof |
| `laptop-service.ts`, `daemon.ts`, controller startup, `agent-fence.ts` and supported provider fences | Independent binding and protected registry/root/lock paths, including supported direct starts and upgrades |

The shared/exclusive protocol must support all trusted co-located writers. The current deployment lock is a design reference, not a reusable universal lock by assertion: POSIX duplicate-descriptor close behavior and inode replacement can break exclusion. One process-wide manager, lifecycle/reentrancy and stopped-restore interaction need independent review/native proof. No heartbeat TTL, metadata comparison or pure function supplies exclusion.

## Smallest next module and acceptance

Propose `src/central-enrollment-contract.ts` and focused tests only: strict bounded record parsers, normalized typed captured filesystem facts, classification table, and a pure enrollment phase/expected-record transition validator. Production discovery/IO, registry writes, service installation, store opens, credentials, restore, listeners and dispatch have **no caller** in that slice. Explicit result `eligibleForIntegration` must never mean `authorized`, `safeToServe` or recovery-ready. It cannot set capabilities true. No current source changes are part of this document task.

Tests cover malformed/versioned records, proven absence versus unreadability, missing roots/bindings, pre-enrollment rollback, foreign/copy/path mismatches, every crash phase and personal compatibility. Later native integration needs isolated OS-account/home/state/service roots, real link/FIFO/parent-swap attacks, sync interruption, competing writer/restore starts and actual verifier retirement tests from the recovery contract. No real installation or credentials.

Remaining engineering choices: trusted OS-home discovery adapter; safe descriptor-relative filesystem operations/durability; concrete protected service-binding format and install/upgrade lifecycle; shared/exclusive manager; complete authority manifest and legacy-process exclusion proof. These block live integration, not the bounded pure parser/classifier slice after policy approval.
