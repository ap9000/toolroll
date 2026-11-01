# One approval per release, re-running only what failed, and a nightly full check — plan

Status: plan, revision 3, 2026-10-25. Branch `release-once` (worktree `so-releaseonce`), rebased on main at
`7a896d39` (0.9.70). Codex returned NO-GO on revision 1 (12 findings) and on revision 2 (9 findings). This
revision takes Alex's decisions of 2026-10-25 and closes the revision 2 findings the way Codex suggested. Both maps
are at the end.

There is no third plan round: the implementation gets Codex review instead. The build stacks on `approval-policy`,
which is getting its own confirmation first. Nothing here is built.

## Why

Shipping 0.9.70 needed four approvals from Alex. `src/release.ts` names the gate task by commit
(`gateTaskId(version, sha)`), so every fix commit filed a new task with a new scope. Each of those needed a person's
approval, a full release check (about 11 minutes, `scripts/release-check.mjs`) and GitHub CI (about 15 minutes).
Six release checks failed on the way (runs 3234–3241), mostly in one place each: one unit file (3238), one journey
group (3237, 3240), or the unit part (3241). Every retry still ran everything.

Alex: "I can't keep approving the same thing over and over."

## Goals

1. **One approval per release, for test fixes.** A person approves a release once. Later commits on the same pull
   request carry that approval only when two things hold: every change since the approved commit is tests, docs or
   CHANGELOG, and the production build is byte-for-byte the same. Anything else asks again.
2. **Show what landed after the approval**, in the release summary and the console.
3. **Re-run only what failed, by file.** On the second and later checks of a release, re-run only these:
   - the failed unit files;
   - the failed journey groups;
   - the failed upgrade versions;
   - the changed tests;
   - a sanity pass.

   Not the whole suite.
4. **A nightly full check on main** as a safety net for accidental omissions.

## Non-goals

- **No change to who may approve.** Releases and deploys always need a person (approval-policy decision 1). The
  lead may ask for a carry but can never make one stand on its own authority, and can never widen one.
- **No carrying production code, harness, dependencies or build inputs.**
- **No carrying while the release project's checks run outside the sandbox**, unless the project's "Carry release
  approvals when checks aren't sandboxed" was on when the person approved (Alex, 0.9.73, option A: off by default,
  turned on only with a person's proof, sealed into the terms and policy; the stricter of sealed and current applies,
  and checks never reach further than at the approval).
- **No carrying, and no restart, after the deploy reservation.** A head that moves after deploy starts stops the
  release, and the new commit needs a person's approval. This includes a CI failure found after deploy.
- **No change to CI.** Every required pull-request check still passes on the exact final commit before merge.
- **No reuse of GitHub CI results inside a composed check.**
- **No protection against a hostile test author** (Alex's trust decision; see "Trust decision" below).
- **No nightly runs on release branches.** Main only.

## Prerequisites

- **approval-policy phase 1**, confirmed and merged first. This plan uses:
  - `personApprovalOf` and `sealOriginOf`, unchanged;
  - the allowlist authority readers;
  - `src/person-proof.ts`;
  - both deployment boundaries (`src/deploy-gate.ts deploymentGate`, `scripts/deploy-candidate.mjs`);
  - the verified Git reader, `src/commit-extract.ts`.

  `release-once` is rebased onto main after it merges, or stacked on it if building starts first.
- **Schema version.** Main is at v133, and approval-policy also reads v133, so it takes v134 when it rebases. This plan
  takes **v135**; the implementation confirms the number at rebase time. All migrations are additive.
- **0.9.71** brings back sandboxed release checks: sandbox-runtime `allowPty`, the Chromium mach-register rule, and a
  Keychain decision.
  - Before any feature here is switched on, the release project's checks must run with the fence in a verified
    release-check run. The sandbox, read and network terms of that run are recorded.
  - Carrying refuses whenever the sealed or the live check access is wider than the fence.
  - The fence limits **writes** and network access. It does not stop reads: the v2 boundary deliberately lets a run
    read the home folder and the repositories beside it (`src/agent-fence.ts v2Boundary`). Within its own checkout and
    temp folders, a run can still change its own harness copy and `node_modules`. This plan claims nothing more than
    that.

## Part 1 — one approval per release

### The model

- **Anchor.** The first gate task of a release is filed and approved by a person, as today. Its scope also carries
  **release terms**, which are part of the scope digest and shown to the person:
  - repository (from Toolroll's records), version, head branch, pull request, base `main`;
  - the approved commit and its tree;
  - the **effective carry policy**: the runtime rules, this project's protected paths, and the limits;
  - the release check grant (id and digest);
  - the sealed check access, which must be fenced;
  - the expiry.

  The approval sheet says: "Release 0.9.71 from pull request #240 at `abc1234`. Later commits on this pull request
  that only change tests, docs or the changelog ship without asking you again, until it merges or for 3 days. You'll
  see each one in the release summary." The full terms are behind **What asks again**.
- **Release authority.** The person's seal of a scope that has release terms creates one `release_authority` row, in
  the same transaction. That row is the single source of truth for the release. It holds:
  - the generation;
  - the anchor and the current tip;
  - the state: `open` → `deploying` → `merge-reserved` → `merged`, or `revoked`, `expired`, `superseded`;
  - a **lease** with an **epoch**;
  - a revision number `rev`, so every change is a compare-and-swap.

  The JSON journal is only recovery and display data. Authority is never read from it.
- **Carried gate task.** A later commit B gets its own gate task, check, receipt and completion. Its scope is written
  and sealed **only by the carry transaction**: a copy of the anchor's approved scope with the candidate changed,
  sealed with basis `carried`.
- **Asking again.** A refused carry seals nothing. The coordinator files B's gate the ordinary way and stops at
  `approval`, naming the commit, path and rule. The person's yes creates a new generation (`previous` → old row,
  which becomes `superseded`). Old generations are never revived.

### Which changes carry

**1. Path classes** (`src/release-carry.ts CARRY_RULES`, version 1):

| Class | Paths |
| --- | --- |
| Unit tests | `src/**/*.test.ts` (including `*.slow.test.ts` and browser tests) |
| Journey scripts | `scripts/app-e2e.mjs`, `scripts/flows-e2e.mjs` |
| Docs | `docs/**`, other `*.md` |
| Changelog | `CHANGELOG.md` |

These never carry, even when a class above matches them:

- `AGENTS.md` and `SECURITY.md`;
- `test/attacks/**`;
- every harness file, and every `test/**` or `scripts/**` file a harness file imports:
  - `scripts/release-check*.mjs`, `suite-lifecycle.mjs`, `provider-gate.mjs`, `e2e-parallel.mjs`, `e2e-kit.mjs`,
    `upgrade-path.mjs`;
  - `vitest.config.ts`, `test/attacks/vitest.config.ts`;
  - `test/setup-state.ts`, `test/fresh-store.ts`, `test/temp-root.ts`, `test/ensure-build.ts`,
    `test/release-reporter.ts`;
- other test helpers and fixtures;
- the project's `approval_policy.protected_paths`.

These also ask again:

- a deleted or renamed file;
- a mode change;
- a binary file, a symlink or a submodule;
- a path that isn't normalized.

The rules apply to each commit against its parent, and to the whole range from the approved commit to the tip.

**2. Identical production artifacts.** File classes can't prove that shipped code is unchanged. For example,
Tailwind scans `src/browser/`, tests included. So the plane builds both commits and compares digests of `dist/` plus
every file that `npm pack` would ship. `CHANGELOG.md` and `README.md` are left out of the digest and listed as doc
changes.

**3. Limits**, which keep a carried change small enough to review. They are not a security boundary:

- at most 400 changed lines (added plus deleted) and 20 files, from the approved commit to the tip;
- at most 800 lines of churn across all carried commits.

### The effective policy, sealed

The effective policy is the runtime rules plus the project's protected paths plus the limits. It goes into the
release terms and into `release_authority.policy_json`, and its digest is part of the scope digest.

A carry applies the **stricter** of the sealed policy and the current one: a path either one protects asks again,
and the lower limit wins. Relaxing a policy never widens an approval that already exists. A runtime that doesn't know
the sealed policy version refuses to carry.

### The carry proof, in order

`proveCarry(authorityId, to, requestId)` in `src/release-carry.ts`. **Nothing from the candidate runs until step 2
has passed.**

1. **Idempotent retry first.** If a `release_carry` row already exists for (authority, `to`) and the live-release
   predicate (below) still accepts its task, return that task. This check comes before any compare-and-swap. A lost
   answer is retried without a refusal and without a second row. A request that differs (another `to`, or a stale
   `rev` for a new carry) goes on to the compare-and-swap.
2. **Read-only preflight. Nothing executes here.**
   - **Verified objects.** Commit objects are read from the project's own Git directory, as Toolroll records it,
     and hashed by Toolroll: `readVerifiedCommit`, `verifiedFirstParentWalk`, `verifiedTreeDiff` in
     `commit-extract.ts`. Replace refs, grafts, shallow files and lazy fetch are ignored.
   - **Ancestry.** The walk goes from `to` back through the authority's **current tip** to the approved commit, at
     most 200 commits.
   - **Commit shape.** Any merge commit refuses.
   - **Rules.** Per-commit and cumulative diffs are checked against the class rules and the limits, under the
     stricter policy.
   - **Live authority.** The authority's state, expiry, generation, current tip, lease and epoch, and the full
     live-release predicate for the anchor.
   - **Grant and access.** The release check grant and the check access, live and sealed.

   Any refusal stops here, before anything is installed or built. A rejected candidate's `package.json` or build
   script is never run.
3. **Build both sides, fenced, treating the output as untrusted.**
   - **Extraction.** `extractCommit` (verified objects, regular files only) into fresh folders.
   - **Install.** From the lockfile with `--ignore-scripts`, from the dependency cache, with no network. Each package
     is checked against the lockfile's `integrity` hash before it is linked. A mismatch refuses.
   - **Build.** `npm run build` inside the fence, with no network. Only approved build inputs run, because the
     preflight proved the lockfile, `package.json`, build scripts and production sources are unchanged since the
     approved commit.
   - **Digest.** The digest starts after the build's process group has fully exited, so nothing is still writing.
     Files are walked with `lstat` and opened with `O_NOFOLLOW`. Only regular files inside the extraction count. A
     symlink, a special file, or a path that escapes the extraction refuses. Each entry records path, mode and
     sha256.

   The anchor's own artifact digest is built the same way right after the person's seal, which authorizes running
   that approved commit. It is sealed into the authority record, and until it exists nothing carries. A difference
   in the digest asks again. If any part of the build turns out not to be deterministic, it is fixed or named in the
   sealed policy, never ignored silently.
4. **One `BEGIN IMMEDIATE` transaction.**
   - Repeat every mutable check from step 2: `rev`, state, lease epoch, expiry, live-release predicate, current tip,
     grant, access and policy.
   - Write the carried task and scope: the anchor's approved profile, route, check access and acceptance verbatim,
     with candidate `to`.
   - Write the seal: basis `carried`, reference `<authority>:<carry>`.
   - Write the `release_carry` row: the facts, the scope digest and `requestId`.
   - Set the new tip and `rev + 1`.
   - Write the ledger row.

`sealScopeApproval` refuses basis `carried` from any caller. Only this transaction writes it.

### One live-release predicate

`liveReleaseOf(store, taskId, action)` in `src/scope.ts` is the only reader of release authority. `action` is
`dispatch`, `deploy`, `merge` or `complete`. It applies to **every task that belongs to a release authority**, whether
its basis is a person's seal or `carried`. All of these must hold:

- **Generation.** The task belongs to the authority's **current** generation, and that generation is not
  `superseded`, `revoked` or `expired`.
- **State.** The state fits the action:
  - `dispatch` and `complete`: `open`;
  - `deploy`: `open` (it reserves) or `deploying` (resume of the same operation);
  - `merge`: `deploying` (it reserves) or `merge-reserved` (resume of the same operation).
- **Tip.** For `deploy` and `merge`, the task is the authority's current tip. For `dispatch`, the task is the tip or a
  carry still being checked.
- **Anchor.** The anchor's seal is a person's (`personApprovalOf`, unchanged) with the exact sealed anchor digest.
- **Approver.** The anchor's approver is **currently** an active approver with access to this project. This is the
  live check that `personApprovalOf` doesn't make.
- **Carry binding.** For `carried`: a carry row for exactly this task, scope digest, candidate and generation.
- **Grant, access, policy.** The release check grant and check access match the sealed ones, and the effective policy
  is still at least as strict as the sealed one.
- **Main debt.** For `deploy` and `merge` only: no open main-check failure blocks this result (see Part 3).

Where it is enforced:

- the dispatch, claim and build readers (`authorityStandsSql`, `modeApprovalLive`, `dispatch.ts`, `work-index.ts`),
  for `dispatch`;
- `release.ts`, before `complete`, `deploy` and `merge`;
- **every deployment entry point**: `deploymentGate`, `deploymentCandidate`, and each phase of `deploy-browser.mjs`
  (stage, prepare, rehearse, swap, finish), including a **direct** `deploy-browser.mjs` run by a person.

The deployment freeze happens in the store, not in `runRelease`. The first deployment entry of a release task calls
`reserveRelease(authority, 'deploy', operation)`, which moves `open` to `deploying` atomically. A direct deploy can't
skip the freeze. The fallback for an older runtime (`personApprovalFromRecords`) refuses any task that belongs to a
release authority with "update Toolroll first", so nothing reinterprets authority it can't read.

### Operations, leases and recovery

- **Lease.** `runRelease` takes the lease by compare-and-swap: owner, expiry and an **epoch** that goes up on every
  takeover. It renews the lease while it waits. Every transition needs the current epoch.
- **Operation identity.** Each external action that can't be undone (deploy, merge) gets one `release_operation`
  row: `id`, `kind`, authority, the epoch that reserved it, and `state` (`reserved`, `running`, `succeeded`, `failed`
  or `unknown`).
- **Epoch fencing.** The external call starts only after a compare-and-swap from `reserved` to `running` with the
  current epoch. A coordinator that paused, lost its lease and woke up can't start the call. Deploy also holds
  `acquireDeploymentLock`, and merge uses `gh pr merge --match-head-commit`.
- **Takeover.** A new coordinator, or a new generation, must reconcile every operation that is still `reserved`,
  `running` or `unknown` before starting any new work. Supersession waits for that reconciliation.

How each outcome is recovered:

| Outcome | Deploy | Merge |
| --- | --- | --- |
| Reserved, the call never started (crash) | The deploy journal shows no stage launched: mark `failed`; the same candidate may reserve again | The PR is still open at the same head: mark `failed`; state goes back to `deploying` |
| Definite failure | `--phase recover` restores the previous build; `failed`; state stays `deploying` (the candidate is frozen), and a retry reserves a new operation | `failed`; state goes back to `deploying`; checks are re-read before any new reservation |
| Outcome unknown (killed, timeout) | `unknown`: nothing new starts. Reconcile from the deployment journal (`recoverDeploy`) and the runtime's recorded commit | `unknown`: reconcile from the PR state, merge commit and head |
| Success, answer lost | Reconcile finds the services on the candidate's runtime: `succeeded` | The PR is merged from the gated head: `succeeded`, state `merged` |

A revoke while `deploying` stops the deploy at its next phase boundary, then recovers. Once the merge is reserved, a
revoke is refused with "the merge already started". Expiry stops anything that hasn't started yet. Recorded facts
(receipts, carries, completions) stay true after expiry.

### The coordinator

`src/release.ts`:

- **`identity()`** re-reads the release and requires a match on all of these:
  - repository, PR number, PR open, base `main`;
  - head branch and head equal the authority's tip;
  - the live-release predicate for the coming action.

  It runs during every wait **before the deploy reservation**: the approval wait, the check wait (before acting on
  an old candidate's failure), `complete` and `quiet`. It runs again immediately before `deploy` and `merge`.
- **Restart, before the deploy reservation only.** When the head moved and the state is `open`, `identity()` throws
  `Restart`, and the outer loop does this:
  1. It asks for a carry (`toolroll release carry <authority> --to <sha> --json`).
  2. If the carry succeeds, it rewrites the journal for the new tip and runs the state machine again from `check`.
  3. If the carry is refused, it files the new head's gate the ordinary way and stops at `approval`.

  No step keeps a variable captured before the restart.
- **After the deploy reservation** (from `deploy` on, including CI after deploy): a moved head, a CI failure or any
  identity change **stops** the release. The fix commit needs a person's approval (Alex, 2026-10-25).
- **Journal.** It gets optional `authority { id, generation }` and `landed[]` (commits with their files and line
  counts, from `release_carry`). `version: 1` stays.

### What people see

- **Release summary.** The summary, the journal and the squash-merge message list every commit that landed after the
  approval, with its files and line counts.
- **Anchor task page.**
  - **Approved for release 0.9.71**;
  - a **Later commits** disclosure;
  - open check obligations;
  - the last nightly result for main;
  - **Stop carrying later commits**: one click, any active approver, or `toolroll release revoke <authority>`.
- **Carried task page.** **Carried from Alex's release approval**, with a link to the anchor. It never says "Approved
  by alex" on its own.
- **Wording.** `approvalProofWords`, `noteLifecycle` and `evidence-pack.ts` each get a `carried` wording.
- **Notifications.** A carry posts one quiet task notification, with no push.

## Part 2 — re-run only what failed, by file

### Trust decision (Alex, 2026-10-25)

**Coverage trusts test code, as the full check already does.** Test authors are trusted. A test runs as the same user
as the check harness, inside the same checkout. It can misreport its own results, or change its own harness copy and
`node_modules`. The fence limits writes outside the run and network access. It does not stop reads of the home folder
or the repositories beside it, and it does not separate test code from the harness.

The measures below protect results from **accidental** damage: stray processes, leftover files, and test output that
happens to look like a report line. They are not proof against a hostile test. The nightly full check catches some
accidental omissions on main, with no guaranteed time to detect them. It is not independent evidence against
deliberate falsification. Releases accept this. The AGENTS.md adversarial-evidence rule ("never make a security
decision from build-writable data") is set aside **only** for this coverage decision, by this explicit decision. It
still applies to every authority decision in Part 1, which reads only Toolroll's own records and verified objects.

### How results travel

- **No result files.** The orchestrator (`release-check.mjs`) reads results only from **fd 3 pipes** of the harness
  processes it starts:
  - the Vitest main process, through `test/release-reporter.ts`: one JSON line per test;
  - `e2e-parallel.mjs`: one line per journey;
  - `upgrade-path.mjs`: one line per version.

  Workers don't inherit fd 3. Results are never read from a file on disk.
- **Nonce on stdin.** The plane writes `{"nonce", "mode", "plan"}` on the check's stdin and closes it. Children get
  `stdin: "ignore"`. The report is the orchestrator's **last** stdout line, `TOOLROLL_CHECK_REPORT <json>`, with the
  nonce, at most 256 KiB.

### Sealed before run A starts

The builder writes a `release_check_attempt` row **before it spawns the check**. The row holds:

- the **intended mode**;
- the nonce hash;
- the inventory;
- the execution context;
- for a targeted run, the plan and the obligation snapshot.

**Inventory** (`check-inventory.json`):

- unit files, from the verified tree and Vitest's include globs;
- journey groups, reported by the orchestrator on its first fd-3 line before any test starts;
- upgrade versions;
- the selected parts.

**Execution context:**

- Node version, platform and arch;
- lockfile digest;
- digest of the harness files;
- grant;
- check access;
- budget.

### Every outcome has a disposition

Every inventory item at A gets exactly one outcome. An item with no outcome is **not run**.

| Outcome at A | Unit file | Journey group | Upgrade version | Part-level |
| --- | --- | --- | --- | --- |
| passed, file unchanged A→B | carried from A | carried | carried | — |
| passed, test file changed | re-run the file | the script changed: re-run all its groups | — | — |
| failed | re-run the file; each failed identity must pass | re-run the whole group; failed journeys must pass | re-run the version | — |
| skipped identity | allowed to stay skipped (it was skipped in the full check too); newly skipped asks again | same | — | — |
| flaky (passed on a runner retry) | re-run the file | re-run the whole group | re-run the version | — |
| stopped / not run | — | — | — | re-run the whole part |
| unattributed (runner error, worker crash, no result line, browser-error check) | — | — | — | re-run the whole part |
| typecheck or build failed | — | — | — | full check |

**Coverage conservation.** A composed result covers every item in B's inventory. Each item must have **either** an
eligible pass at A **and** be unchanged between A and B, **or** a qualifying pass at B. B's inventory must contain all
of A's identities. Any new test in B runs in B.

### Obligations are immutable

- **From A's sealed evidence.** The required re-run set R(A) is derived only from A's sealed evidence, by the table
  above. It never changes.
- **Snapshot per attempt.** Every targeted attempt seals an **obligation snapshot** with its attempt row. The snapshot
  lists the earlier targeted runs of this generation it took into account and their sealed report digests, plus the
  identities that failed in them.
- **What a targeted plan is.** A targeted attempt C runs, in full:
  - R(A);
  - every identity that failed in the snapshot's earlier runs;
  - every test changed between A and C;
  - the sanity pass.

  C never borrows coverage from an earlier targeted run. If B passed X without changing X's file, C still re-runs X,
  because X is in R(A).
- **Revalidation.** The receipt reader re-derives the plan from A's sealed evidence and the sealed snapshot, never
  from current tables. Later rows can't change an attempt that was already sealed.
- **Removed or skipped identities.** A **required identity** is any identity in R(A) or in a snapshot. If one is
  deleted, renamed or newly skipped at any later commit of this generation, the release **always asks again**. That
  holds in targeted mode, and it holds when the next check is a full one. The check's coverage is recorded as
  `identity-removed`. The seals carried to that commit stop standing, and the coordinator files the gate for a
  person. Changing the mode doesn't forgive it.

### When a check may be targeted

`planTargetedRecheck(store, runId)` returns a targeted plan only when all of these hold. Otherwise the check runs in
full.

1. A and the new run are gate tasks of the same current generation.
2. A is the newest run in that generation with intended mode `full`:
   - it executed, and its report has the nonce and agrees with the summary lines;
   - every item of its inventory has an outcome;
   - none of its unit results were reused from CI.
3. Everything from A to the new candidate is test-only: Part 1's class rules, with the read-only preflight first, then
   identical artifacts.
4. The execution context and inventory match A's, apart from changed test files.
5. No open main-check failure applies (Part 3).

### How it is recorded

- **Receipt version 3** (`contracts/verification-receipt.ts`) keeps the raw exit (`result`) apart from a
  **`coverage`** field: `full`, `composed`, `partial` or `identity-removed`. A composed receipt names:
  - A's run, and the digests of A's receipt and report;
  - the test-only proof;
  - the artifact digests;
  - the plan digest;
  - the obligation snapshot digest;
  - B's report digest.
- **Intended mode decides.**
  - **Full:** today's rule. A run that exits 0 with every item accounted for has coverage `full`. A full run without a
    valid report still passes, but it can't be a base for a targeted run. The rule on removed or skipped required
    identities applies to full runs too.
  - **Targeted:** coverage is `composed` only when every rule above holds. Otherwise it is `partial`, which never
    passes, whatever the exit code.
- **The reader proves each link from the store.** `verificationEvidence()` re-proves each link of a version 3 receipt
  from sealed artifacts and the store. Only then does the check read `passed`, level `full`, `composedFrom: A`.
  `deploymentCandidate`, `deploymentGate`, `release.ts` and `release-coverage.ts` all read it through this one reader.
- **No fail-fast on release runs.** Cancel, the part timeout, the process-exit checks and "a failed build starts no
  journeys" all stay.
- **"Related change" is a hint only.** A test that passes with no change to its file is marked **passed without a
  change** in the summary, so flaky tests stay visible.

## Part 3 — the nightly full check (main only)

- **What and when.** At 03:00 local, the full release check (`node scripts/release-check.mjs --full`) runs on
  **main's head**. Release branches are never run by the nightly.
- **Where it lives.** It is a Toolroll flow with a schedule trigger (`flow-schedule.ts`). Alex approves the flow once,
  with a password. That approval authorizes checking future main commits. Main only moves when a reviewed release is
  merged.

  The flow's approved terms bind:
  - the release check grant (id and digest);
  - the fenced check access, with the read and network terms recorded in the 0.9.71 verification;
  - a **check-only** capability: each firing files `nightly-<date>-<sha7>` with basis `schedule`. That task can't
    deploy, merge or complete.
- **When it starts.** It is turned on after 0.9.71's fenced release check is verified.
- **Failures are separate obligations.** A failing nightly writes one `main_check_failure` row per failed item:
  - each failed identity;
  - each group or version, or the whole part for a part-level outcome.

  It also sends one `attention` notification (web push and Telegram): "Nightly full check failed on main at
  `abc1234`: 2 unit files, `app/pages`."
- **Clearing.** A row clears only when a **qualifying full pass** covers that exact item:
  - the pass is a full run (intended mode `full`, coverage `full`);
  - it ran on a commit that contains the failed main commit (verified ancestry; a release branch must contain main
    before it can merge);
  - the item, or its whole part, ran and passed there.

  A pass that covers one failure never clears another. A composed result never clears anything.
- **What open failures block.**
  - Targeted planning refuses while any row is open.
  - The live-release predicate re-checks open rows at the `deploy` and `merge` reservations. A release whose gate
    check is `composed` can't deploy or merge while a main failure is open. A full pass is needed first, then the
    release continues.

  Historical receipts are never rewritten.
- **No freshness guarantee.** Targeted eligibility does not depend on a recent nightly, only on recorded failures. A
  missed, stalled or disabled nightly gives no signal of its own, except a notice in the flow's own health ("the
  nightly check hasn't run since …") after 26 hours. The nightly is a safety net for accidental omissions, not a
  deadline.

## Data and schema (v135)

```sql
CREATE TABLE release_authority (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, generation INTEGER NOT NULL, previous INTEGER REFERENCES release_authority(id),
  version TEXT NOT NULL, pr INTEGER NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL,
  anchor_task TEXT NOT NULL, anchor_digest TEXT NOT NULL,
  approved_sha TEXT NOT NULL, approved_tree TEXT NOT NULL, artifact_digest TEXT,   -- NULL until the anchor build is sealed
  tip_sha TEXT NOT NULL, tip_task TEXT NOT NULL,
  policy_json TEXT NOT NULL, policy_digest TEXT NOT NULL,
  verify_command INTEGER NOT NULL, verify_digest TEXT NOT NULL, access_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','deploying','merge-reserved','merged','revoked','expired','superseded')),
  rev INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expires TEXT,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT, ended_by TEXT,
  UNIQUE (repo, version, pr, generation)
);
CREATE UNIQUE INDEX release_authority_live ON release_authority(repo, version, pr)
  WHERE state IN ('open','deploying','merge-reserved');

CREATE TABLE release_carry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  authority INTEGER NOT NULL REFERENCES release_authority(id),
  task_id TEXT NOT NULL UNIQUE, scope_digest TEXT NOT NULL, request_id TEXT NOT NULL,
  from_sha TEXT NOT NULL, to_sha TEXT NOT NULL, to_tree TEXT NOT NULL, artifact_digest TEXT NOT NULL,
  commits_json TEXT NOT NULL, changed_lines INTEGER NOT NULL, files INTEGER NOT NULL, churn INTEGER NOT NULL,
  runtime TEXT NOT NULL, proved_at TEXT NOT NULL,
  UNIQUE (authority, to_sha)
);

CREATE TABLE release_operation (
  id TEXT PRIMARY KEY,                                   -- random, minted at reservation
  authority INTEGER NOT NULL REFERENCES release_authority(id),
  kind TEXT NOT NULL CHECK (kind IN ('deploy','merge')),
  task_id TEXT NOT NULL, candidate TEXT NOT NULL, epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','running','succeeded','failed','unknown')),
  external_ref TEXT,                                     -- deploy stage path, or merge commit
  reserved_at TEXT NOT NULL, finished_at TEXT, detail TEXT
);

CREATE TABLE release_check_attempt (
  run INTEGER PRIMARY KEY REFERENCES run(id),
  authority INTEGER REFERENCES release_authority(id),
  mode TEXT NOT NULL CHECK (mode IN ('full','targeted')),
  base_run INTEGER REFERENCES run(id),
  plan_digest TEXT, snapshot_digest TEXT,               -- the sealed obligation snapshot (targeted)
  inventory_digest TEXT NOT NULL, context_digest TEXT NOT NULL, nonce_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE main_check_failure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, sha TEXT NOT NULL, run INTEGER NOT NULL,
  item TEXT NOT NULL,                                    -- identity, group, version, or part
  opened_at TEXT NOT NULL, cleared_by_run INTEGER, cleared_at TEXT,
  UNIQUE (repo, run, item)
);
CREATE TABLE nightly_check (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, sha TEXT NOT NULL, run INTEGER, outcome TEXT, at TEXT NOT NULL
);
```

Other changes:

- `task_scope.release_terms_json`: nullable, part of the digest when present, read strictly.
- `approval_basis` gains `carried`.
- The obligation snapshot of each targeted attempt is sealed as the artifact `obligation-snapshot.json`, beside
  `check-inventory.json`, `check-report.json` and `targeted-plan.json`. It is not kept in a mutable table.
- Receipt version 3.

## Files and functions

| File | Change |
| --- | --- |
| `src/release-carry.ts` (new) | `CARRY_RULES`, `effectivePolicy`, `stricterOf`, `preflightCarry` (read-only), `artifactDigest` (fenced build, integrity-checked install, contained digest), `proveCarry`, refusal words |
| `src/commit-extract.ts` | `readVerifiedCommit`, `verifiedFirstParentWalk`, `verifiedTreeDiff` |
| `src/store.ts` | v135 tables; authority created on a person's seal of release terms; `carryReleaseApproval` (idempotent retry first); `reserveRelease`, `runOperation`, `finishOperation`, `reconcileOperations`; lease with epoch; `revokeRelease`; main failures |
| `src/scope.ts` | release terms; `liveReleaseOf(store, taskId, action)`; `personApprovalOf` unchanged |
| `src/approval-authority.ts`, `dispatch.ts`, `work-index.ts`, `modeApprovalLive` | `liveReleaseOf(…, 'dispatch')` for release tasks |
| `src/deploy-gate.ts`, `scripts/deploy-candidate.mjs`, `scripts/deploy-browser.mjs` | `liveReleaseOf(…, 'deploy')` and the reservation at every entry and phase, direct runs included; the older-runtime fallback refuses release tasks |
| `src/release.ts` | lease and epoch; `identity()` in the waits before deploy; `Restart` only before the reservation; stop after it; operation recovery on resume; journal `authority` and `landed` |
| `src/release-adapters.ts`, `src/release-cli.ts` | `carry`, `lease`, `reserve`, `revoke`, `reconcile`; PR identity (repo, head branch, base); merge message |
| `src/release-recheck.ts` (new) | dispositions, `requiredSet(A)`, `obligationSnapshot`, `planTargetedRecheck`, `composeCheck`, required-identity check |
| `scripts/release-check.mjs`, `test/release-reporter.ts`, `scripts/e2e-parallel.mjs`, `scripts/upgrade-path.mjs` | stdin handshake, fd-3 results, inventory line, last-line report, no fail-fast on release runs, plan execution, `SANITY_UNITS` |
| `src/builder.ts` | attempt row before spawn; seal inventory, report, plan and snapshot; receipt v3 by intended mode |
| `src/verification-evidence.ts`, `contracts/verification-receipt.ts`, `src/assignment.ts` | receipt v3 and its reader |
| `src/flow-schedule.ts` + nightly flow | main only, check-only task, failure rows, notification, health notice |
| `src/server/render-tasks.ts`, approval sheet, anchor page | terms, Later commits, obligations, nightly status, Stop carrying |
| `AGENTS.md`, `SECURITY.md`, `docs/testing.md` | the coverage trust decision; the fence's real read terms; the nightly check |

## Tests

Only what `docs/testing.md` keeps: security rules, data integrity, contracts. Every case goes through the real road:
real Git, store, CLI and child processes. Attack cases go in `test/attacks/`. Run the AGENTS.md safety self-review
before each security commit.

**Carry rules table** (`release-carry.test.ts`):

- each eligible class carries;
- each excluded file refuses: AGENTS.md, an attack test, each harness file, a harness import, a helper, a fixture, a
  project protected path;
- `src/serve.ts` refuses;
- a deleted or renamed test refuses;
- a binary, a symlink, a submodule and a mode change each refuse;
- limits: 401 lines, 21 files, churn of 801, each refuses.

**Carry attacks** (`test/attacks/release-carry.test.ts`):

1. **Preflight before execution.** A candidate that changes `package.json` or a build script, or adds a postinstall
   that writes a marker file, is refused, and the marker never appears. Each preflight refusal (state, lease, access,
   grant, ancestry) is also checked to run nothing.
2. **Untrusted output.** The build leaves a symlink out of `dist` and a background writer after it exits. The digest
   refuses both. A package in the dependency cache that doesn't match the lockfile integrity hash refuses.
3. A browser test that adds a Tailwind class: the artifact differs, so it asks again.
4. A lead token carrying an allowed commit is carried. A lead token carrying a production change is refused, with no
   seal and no row.
5. A direct `carried` seal, or a carry row that doesn't match the task, digest, candidate or generation: never stands
   at dispatch, at `deploymentGate`, or at any phase of `deploymentCandidate`.
6. A force-push with the same tree, a rewritten carried commit, a merge commit, planted replace refs, grafts or a
   shallow file, a corrupted object: all refused.
7. Policy: removing a project protected path still asks again; adding one asks again.
8. **Live predicate.** In each of these cases, deploy and merge are refused, a direct `deploy-browser.mjs` run is
   refused, and a resumed phase is refused:
   - the approver is demoted, or **loses access to the project**;
   - the generation is superseded;
   - the task is not the tip;
   - the authority is revoked or expired;
   - the grant or check access changed.
9. A **direct deploy** of the release tip reserves `open` → `deploying`. A carry after that is refused.
10. **Lease and epoch.** Coordinator 1 reserves a merge, pauses, and loses its lease. Coordinator 2 takes over and
    reconciles. When coordinator 1 wakes, its compare-and-swap from `reserved` to `running` fails, and its call never
    starts.
11. **Recovery table.** Each row has a test for deploy and for merge: a crash before the call, a definite failure, an
    unknown outcome, and a success whose answer was lost.
12. **Idempotent retry.** A carry whose answer was lost, retried with a stale `rev`, returns the existing task. A
    different `to` with a stale `rev` is refused.
13. A new generation leaves the old carries, and the old anchor, without standing.
14. **PR identity.** These stop the release at the next identity check:
    - the PR is retargeted to another base;
    - the PR is closed and reopened as a new one;
    - the head branch is renamed.

**Coordinator** (`release.slow.test.ts`):

- **Restart before deploy.** A head move during the approval wait, the check wait (including while an old candidate's
  failure is being handled), `complete` and `quiet` restarts from `check` for the new tip. Nothing from the old step
  runs afterwards.
- **After the deploy reservation.** A head move during deploy or during the CI poll stops the release, and the new
  commit needs a person's approval. A is never merged.
- **Revoke during the CI wait.** The merge reservation refuses.
- The summary and the merge message list every commit that landed after the approval.

**Targeted re-runs** (`test/attacks/release-recheck.test.ts`):

15. **Accidental damage.** Each of these is ignored:
    - a stale Vitest JSON or journey `report.json` file;
    - a test that prints a fake report line;
    - a leftover process that writes after the orchestrator ends.

    Hostile tests are out of scope, by Alex's trust decision.
16. **Every disposition.** One case per row of the table, including unit not-run, flaky, unattributed and skipped, and
    the same for journeys and upgrades.
17. **Immutable obligations.** A fails X. B passes X without changing it. C changes another file: C runs X again.
    Rows added after B was sealed don't change B's revalidation.
18. **Removed or skipped identities.** A required identity that is deleted, renamed or newly skipped asks again, in
    targeted mode and also in the full check that follows a `partial` attempt.
19. **Coverage conservation.** An item in B's inventory that has neither an eligible pass at A nor a pass at B
    leaves the result `partial`.
20. **Partial never passes.** Intended mode targeted, exit 0, report lost: the coverage is `partial`, and the check
    reads failed.
21. **Receipt version 3.** Break each link in turn: A's receipt, the report, the plan, the snapshot, the artifacts,
    the generation, the grant. Every reader refuses.
22. **No borrowed coverage.** A targeted run can't be a base. A base whose unit results were reused from CI is
    refused.
23. **Contracts.** Schemas for the inventory, the fd-3 lines, the report, the plan, the snapshot and receipt version 3.

**Nightly**:

24. It fires on main only.
25. Its task can't deploy, merge or complete.
26. Failures become separate rows. A full pass that covers item 1 clears item 1 but not item 2. A composed pass
    clears nothing.
27. An open row refuses targeted planning, and the deploy and merge reservations of a composed release. After a
    qualifying full pass, the release continues.
28. A nightly that misses 26 hours shows the health notice.

## Rollout

1. **0.9.71.** It ships, and a fenced release-check run is verified, with its read and network terms recorded.
2. **approval-policy phase 1.** It is confirmed and merged, then `release-once` is rebased onto it.
3. **Phase A, the check report.** There is no behaviour change. It adds:
   - the stdin handshake and fd-3 results;
   - the inventory and the attempt row;
   - sealed report artifacts;
   - no fail-fast on release runs.

   It is released through the normal gate.
4. **Phase B, the nightly on main.** It adds failure rows, notifications and the health notice.
5. **Phase C, one approval per release.** It adds:
   - the authority record, operations and leases;
   - preflight, carrying and the live-release predicate at every deploy entry;
   - the coordinator changes and the console.

   It gets Codex implementation review until GO. Its own release is approved the old way.
6. **Phase D, targeted re-runs by file.** It adds dispositions, immutable obligations and receipt version 3. It gets
   Codex implementation review until GO.
7. **Docs.** AGENTS.md (Lean verification, and the coverage trust decision), SECURITY.md and docs/testing.md. They are
   protected, so a person approves them.

**Off switches**, which only make things stricter:

- `toolroll release --no-carry`;
- the project setting "Ask for every release commit".

## Decisions (all settled by Alex, 2026-10-25)

1. **Build on approval-policy.** Yes, after its own confirmation.
2. **What carries.** Only tests, docs and CHANGELOG, with identical production artifacts, and never while checks are
   unsandboxed.
3. **Limits.** 400 changed lines and 20 files after the approval, plus 800 lines of churn.
4. **Journey scripts.** They carry.
5. **Duration.** Until the merge or 3 days.
6. **After deploy.** A CI failure needs a new approval, because the candidate freezes at deploy.
7. **Re-runs.** File-level for units; whole groups for journeys; whole versions for upgrades. No fail-fast on release
   runs.
8. **Coverage trusts test authors.** The nightly is a safety net for accidental omissions, with no guaranteed time to
   detect them.
9. **Nightly scope.** Main only.
10. **Review.** No further plan round; Codex reviews the implementation.

## Codex round 2 → revision 3

Revision 2 status of the original findings, as Codex reported it:

- **Closed:** 4, 5, 10, 11.
- **Partial:** 1, 2, 3, 6, 7, 8, 9, 12.

The partial ones are answered through the new findings below.

| # | Finding (round 2) | Revision 3 |
| --- | --- | --- |
| 1 | "The nightly bounds it" is not an acceptable answer to finding 1; the fence claim is too broad | **Accepted as an explicit trust decision by Alex:** coverage trusts test code, as the full check does, and the nightly only catches some accidental omissions, with no deadline. The fence claim is corrected: v2 allows reads of the home folder and sibling repositories, and doesn't separate a run from its own harness. The AGENTS.md evidence rule is set aside for coverage only. Authority decisions still read only trusted records and verified objects. |
| 2 | The carry proof executes the candidate before deciding it may | A read-only preflight over verified objects and live authority comes before any install, build or pack. Every mutable check repeats in the final transaction. The anchor's build is authorized by the person's seal. The install is integrity-checked and fenced. Generated output is untrusted: process group exited, `lstat` and `O_NOFOLLOW`, regular files only, contained paths. |
| 3 | A full fallback can erase failed coverage; outcomes lack dispositions | A table gives every outcome a disposition. There is a coverage-conservation rule. A deleted, renamed or newly skipped required identity asks again in every mode, the full fallback included. |
| 4 | Mutable open obligations can't define immutable evidence | R(A) is derived only from A's sealed evidence. Each attempt seals an obligation snapshot. Revalidation uses the sealed snapshot. Coverage is never borrowed from earlier targeted runs. |
| 5 | The release reader allows stale authority at deploy boundaries | One `liveReleaseOf` predicate covers current approver and project access, exact anchor digest, policy, grant and access, generation, state per action and current tip. It applies to every release task whatever its basis, at every deploy entry point, direct deploys included. The freeze is an atomic store reservation that a direct deploy can't skip. |
| 6 | A CAS with a renewable lease needs external-operation recovery | Operation ids, a lease epoch, and the `reserved` → `running` compare-and-swap fence stale coordinators. Takeover and supersession reconcile outstanding operations first. A recovery table covers reserve-before-call, definite failure, unknown outcome and lost answer. An idempotent carry retry is checked before the stale-`rev` rejection. |
| 7 | Nightly branch selection doesn't establish candidate authorization | **Removed:** the nightly runs on main only (Alex). The schedule's approval binds the grant, the fenced access and check-only capability for future main commits. |
| 8 | Nightly debt can lose failures, stay uncleared after a squash, or arrive too late | One row per failed item on main. A row clears only by a qualifying full pass that covers that exact item, on a commit containing the failed sha. A squash merge onto main contains it, and with no release-branch debt there is no correspondence problem. Open rows are re-checked at the deploy and merge reservations. Freshness is not required, and a missed nightly shows a health notice. |
| 9 | Restart tests contradict the order of steps | Restart happens only before the deploy reservation, in every pre-deploy wait, before an old failure is handled. After the reservation, including CI, a moved head stops the release. The tests are corrected. |

## Codex round 1 → revision 2 (kept for history)

| # | Finding | Answer (revision 2, carried into revision 3) |
| --- | --- | --- |
| 1 | The nonce doesn't authenticate coverage | Results travel over fd-3 pipes and the nonce over stdin. The rest is the trust decision above. |
| 2 | Deleting or swapping skips passes | Identities are bound, and removed or skipped required identities ask again. |
| 3 | No coverage contract | A sealed inventory and context, dispositions, and conservation. |
| 4 | Filename classes ≠ unchanged shipping code | Artifact digests (closed). |
| 5 | Protected list incomplete; carried production code | Allowlist of tests, docs and CHANGELOG only (closed). |
| 6 | Policy not bound; weak standing readers | Sealed effective policy, the stricter one wins, and `liveReleaseOf`. |
| 7 | Carry and merge not serialized | One authority record with compare-and-swap, a lease with an epoch, and operations. |
| 8 | `pinned()` mutated in place | Restart before deploy only; stop after. |
| 9 | Revocation and PR identity missed | `identity()` and `liveReleaseOf` before every action that can't be undone, with cutoffs defined. |
| 10 | Deploy integration contradicted approval-policy | Both boundaries use the live predicate, and `personApprovalOf` is unchanged (closed). |
| 11 | Missing report vs v1 receipts | Intended mode persisted, and `partial` never passes (closed). |
| 12 | Limits and retries | Deletions and churn count, idempotent retry first, explicit generations. |
