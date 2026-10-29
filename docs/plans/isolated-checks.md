# Isolated release checks and a separate worker

Status: plan, 2026-10-29. Claude and Codex (Astra) wrote recommendations independently; this merges them. Follows
eval-harness.md, pipeline-speed.md and the research summary below.

## Why

- The release check, the step that decides deploys, runs **unsandboxed** with full access to the owner's Mac
  (src/invoke.ts:1090 bypasses the fence), inside the same `toolroll up` process as the console and the watch loop
  (src/operate.ts:7668, :7782). A heavy check stalls the console, and anything that escapes a check sits beside the
  approval authority.
- Because the release projects' check access is unsandboxed and unsandboxed carry is off, release terms are never
  attached (src/release-carry.ts:161): auto-approve, carrying and targeted rechecks have never worked in production.
- Settings can't fix it: policy v2 lets checks read home and sibling projects, sandboxed checks get no restricted
  network, `sign-ins` injects real credentials (src/agent-fence.ts:281, src/builder.ts:559, src/invoke.ts:1258), and
  Toolroll's own tests create sandboxes, which macOS refuses inside a sandbox (test/inside-fence.ts:8).
- Industry practice (2026): untrusted code and checks in throwaway VMs, egress default-deny and enforced outside the
  guest, secrets kept out and injected by a host-side proxy, egress monitored, and the allowed services themselves
  tested as escape routes (OpenAI's October 2026 containment report).

## Where Claude and Codex agreed
- Split execution out of the console process first.
- A VM boundary, not more Seatbelt settings. Throwaway per run, no host mounts, no owner home or keychain.
- Credentials stay in a host-side broker; the guest gets a short-lived, run-scoped capability, never a token.
- Egress default-deny, enforced outside the guest, monitored; canaries prove the boundary before the plane trusts it.
- The plane still seals obligations and verifies the nonce'd report; unsandboxed carry stays off.

## Where they differed, and the decision
| Question | Claude | Codex | Decision |
|---|---|---|---|
| Where the check runs | Linux VM (OrbStack) for most parts + macOS VM for macOS-only parts and real-model journeys | **One** disposable macOS VM (Tart) for the whole check; GitHub keeps Linux CI | **Codex.** One environment keeps today's full macOS coverage and halves the work |
| OrbStack | Linux VM for candidate code | Not a microVM boundary (shared kernel across OrbStack workloads); only for the plane-provisioned GreenMail fixture | **Codex** |
| How "isolated" is recorded | A new check-access level | Keep `checkAccess: "sandboxed"`, add a separately sealed **execution profile** (backend, image digest, versions, network policy, broker capabilities, mounts) | **Codex** |
| Console responsiveness | Process split | Process split plus coalescing progress writes and moving heavy HTTP reads off the loop | **Both.** Today's stall was also a 0.9.76 query regression (fixed separately in `console-perf`) |

## Stages

0. **Ship the console fix (0.9.78):** `console-perf` (approval-setting read through the existing index; checkout sizing
   off the event loop) with the pipeline-speed work. Pages 2.0–2.3 s → 0.33–0.42 s on the owner's DB copy.
1. **Separate worker process** (2–4 days). `toolroll up` supervises a console process and a worker process
   (reuse src/controller-supervisor.ts); builds, checks, batch checks and follow-ups move to the worker with existing
   custody, leases and recovery. Coalesce `saveCheckProgress` display writes; heavy HTTP reads through ReadExecutor.
2. **Credential broker spike** (2–3 days, feasibility gate). Host broker keeps provider credentials and refresh;
   guest gets a run-scoped capability (provider, models, concurrency, spend). Prove real Claude/Codex CLIs work through
   it (streaming, tools, resume, cancel) with today's subscription sign-ins; fallback is dedicated API keys held only
   by the broker (owner decision).
3. **Isolated release runner** (6–10 days). Tart VM cloned from a pinned image per run, destroyed after. Candidate
   and needed history copied from verified objects; no mounts, no Docker socket, no shared `.git`. GreenMail provided
   by the plane in OrbStack, per-run endpoint, required (no silent skip). One heavy reservation per Mac; same
   isolation for carry-proof builds (release-carry.ts fencedBuildRunner).
4. **Seal and enable** (3–5 days). Execution profile sealed into the scope and verified at admission; evidence names
   what actually ran; `releaseTermsFor`, `checkLaunchOf`, `liveReleaseOf`, release-auto.ts accept it. Egress gateway
   outside the guest (broker, artifact transport, fixture ports, npm read-only for approved package/version paths;
   no DNS, LAN, Tailscale, metadata, GitHub sign-in). Attack and canary suite: native fence tests with no skips,
   synthetic secrets for ~/.ssh, plane DB/WAL, keychain, other projects; cross-run isolation; DNS/redirect/CONNECT/
   IPv6/allowed-endpoint attacks; broker revocation; forged reports; worker crash and orphan cleanup; console latency
   during a full check. Then auto-approve, carrying and targeted rechecks work for new scopes.

Total: about 3–5 focused weeks. The release that ships stages 3–4 needs a person (harness and policy changes are
excluded from automatic approval by design).

## Stage 1 build notes (2026-10-29, branch `isolated-checks`)

**What was built.** `toolroll up` keeps the identities it mints (the approver's login, the runner and its token) and
supervises two role processes with controller-supervisor (IPC channel, `[console]` / `[worker]` labelled output):
- **console** (`up-role-child.js console`): `startConsole` (HTTP, sign-in, ceremonies, the console's own background
  checks), the attach socket and instance secret, sign-in link minting. It never receives the runner token.
- **worker** (`up-role-child.js worker`): every watch loop (builds, checks, batch checks, follow-ups, reconcilers,
  storage sweep, flows, publishing, push), the project registry, the one Telegram follower, provider readiness. It opens
  no port and mints no console secret.
- `up` itself: identity minting and retirement, the runner heartbeat, the greeting, and relaying the worker's project
  list to the console. Both roles must report `up`'s own build identity (version + hash of operate.js) or `up` stops.
- Each role's whole start goes over the IPC channel (validated, closed shapes in `src/up-processes.ts`): no token in any
  command line or environment. A console start that carries a token, a role/argv mismatch or another build is refused.
- Restart policy: a role that never became ready fails the start (as before); after readiness a crashed role is started
  again with controller-supervisor's backoff. A restarted worker waits for its predecessor's watch lease to lapse (90 s)
  and takes it over with `recoverIncarnation` in the same transaction — exactly the recovery a restarted `up` does; it
  never holds a lease while the dead worker's is live. If the runner credential no longer authenticates, the whole `up`
  stops (a service restart registers again, as before).
- Stop: first signal → the console releases the coding owner record and keeps serving, the worker drains (stop grace,
  then its providers are stopped; a second signal stops them at once), the runner retires, then the console closes.
  Children ignore SIGINT (a terminal's Ctrl-C reaches the whole group; `up` decides) and drain if `up` disappears.
- `toolroll serve` and `toolroll watch` are unchanged. `--single-process`, and any in-memory seam a child can't receive
  (tests' fakes, the desktop host's proof key and store), keep both roles in one process with the same messages.
- Check progress: display snapshots are coalesced to at most one write a second (newest wins); the final snapshot is
  written at once and nothing older is written after it (`coalescedProgressWriter`, check-progress.ts).

**What each process holds.** Both are the same user on the same database folder, so files beside the database (saved
login, tool secrets, Telegram token) are reachable from either; the split keeps secrets out of each other's memory and
messages, not out of the folder. Isolation from build code is stages 2–4.

**Latency** (`scripts/isolated-checks-latency.mjs`: temp HOME, sandbox-exec fence — no writes under the owner's home, no
network but localhost, no signals outside the run — a settled copy of the owner's database (760 tasks, 1,300 runs), a
scripted provider, and a check printing ~114,000 test-runner lines over 30 s; each route read in turn every ~50 ms;
milliseconds):

| Build | Busy window | /healthz p50 / p95 / max | /board p50 / p95 / max | task page p50 / p95 / max |
|---|---|---|---|---|
| before (0.9.77 + pipeline-speed, one process) | 58.9 s | 1 / 1 / **5,009** | 35 / 37 / **5,688** | 51 / 207 / **4,706** |
| after, `--single-process` (coalescing only) | 44.6 s | 1 / 1 / 82 | 35 / 38 / 45 | 51 / 240 / 668 |
| after (two processes + coalescing) | 38.8 s | 1 / 1 / **1** | 35 / 37 / **252** | 50 / 57 / **265** |

Idle (the first 8 s after start, reconcile running): before /board p95 147 ms, max 391; after 53 / 92. On a fresh
database the same check: before /healthz max 6,892 ms and /board 7,537 ms; after 182 and 28. The multi-second stalls
were the per-line progress writes on the shared event loop; the remaining task-page time is the console's own render.

**Residual.** Heavy HTTP reads beyond the work index are not yet routed through ReadExecutor.

### Codex review round 1 fixes (2026-10-29)

Round 1 was NO-GO with six findings and one inherited limitation; each fix has a test that failed before it.
1. **CI join.** Shards upload Vitest's own report; the join installs nothing and runs the trusted base revision's
   `scripts/ci-shards.mjs` (inventory and skip policy on the trusted side), refusing reports that executed nothing,
   whose counts disagree with their results, or that skip in a file the base always ran. Residual: the candidate's
   test code still writes the report it's judged by.
2. **Removal, then a worker crash.** A replacement worker takes over, from the store, every watch a predecessor left
   live or holding open work on a project still bound to the runner (one being removed), recovering its incarnation
   before any new work; the console's list is untouched. A removed project whose lease can't be taken over stays
   bound and the worker stops.
3. **Deploy process exit.** The service identity records `up`'s console and worker (verified by command); shutdown,
   the recovery stop proof and the stale coding-owner release cover them, a failed new service stops as its whole
   tree, and no `up` or role child of the runtime may be left whatever its pid.
4. **Approval before CI.** A release filed while CI runs is held in the plane (recorded before filing); every seal but
   the automatic road's is refused until the plane's own reading of exact-head CI passes lifts it, and only then is a
   person asked.
5. **Role restarts.** Readiness is per generation: a replacement's refusal (another build or database), or three
   replacements ending before readiness, stops the whole `up`; a crash after readiness still restarts.
6. **Final progress write.** The final snapshot is kept until saved, flush retries it, and a display failure never
   keeps the outcome from being sealed.
- **Inherited CI limitation.** A required check counts only from `.github/workflows/ci.yml`.

### Final review: CI report provenance remains unverified (2026-10-29)

A consistent forged shard report still passes the join without executing tests. Production automatic check
authorization and release approval now refuse this reporting mode and require a person, including when resuming an
already authorized automatic check. The fallback still waits for exact-head CI before asking for approval. The
executor policy is fixed by the plane, never supplied by a candidate report or project setting; unknown also refuses.
This contains the automatic approval risk. It does not authenticate CI execution: an isolated reporting channel is
still required before automatic approval can be enabled for this executor.

## Decisions for the owner
| Decision | Recommendation |
|---|---|
| Install Tart and keep a pinned macOS 26 VM image (~30–50 GB; 108 GB free today) | Yes |
| Real-model journeys through the broker: keep subscription sign-ins if the spike proves them | Yes; API keys held only by the broker are the fallback (billing decision) |
| Never enable unsandboxed carry as a shortcut meanwhile | Yes |

## Not doing
No cluster, no unsandboxed carry, no Docker socket in checks, no credentials copied into VMs, no dropping macOS
coverage, no weakening checks to get green.
