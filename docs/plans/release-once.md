# One approval per release, re-running only what failed, and a nightly full check — plan

Status: plan, revision 2, 2026-10-25. Branch `release-once` (worktree `so-releaseonce`), rebased on main at
`7a896d39` (0.9.70). Revision 1 got NO-GO from Codex (12 findings). This revision takes Alex's and the coordinator's
decisions on those findings. The map is at the end. Nothing here is built.

## Why

Shipping 0.9.70 needed four approvals from Alex. `src/release.ts` names the gate task by commit
(`gateTaskId(version, sha)`). Each fix commit therefore filed a new task with a new scope, and each needed a person's
approval, a full release check (about 11 minutes, `scripts/release-check.mjs`) and GitHub CI (about 15 minutes). Six
release checks failed on the way (runs 3234–3241). Most failures were in one place:

- one unit file: 3238, `src/live-terminal.test.ts`;
- one journey group: 3237 `app/pages`, 3240 `app/console`;
- the unit part: 3241.

Every retry still ran everything. Alex: "I can't keep approving the same thing over and over."

## Goals

1. **One approval per release, for test fixes.** A person approves a release once. Later commits on the same pull
   request carry that approval only when every change since the approved commit is tests, docs or CHANGELOG, and the
   production build is byte-for-byte the same. Anything else asks again.
2. **Show what landed after the approval**, in the release summary and the console.
3. **Re-run only what failed, at the level of single files.** On the second and later checks of a release, re-run the
   failed tests (file by file), journey groups and upgrade versions, plus the changed tests and a sanity pass. Do not
   re-run the whole suite.
4. **A nightly full check as the safety net.** Every night at 03:00, the full release check runs on main and on open
   release heads. A failure notifies Alex, and the next release must run the full check.

## Non-goals

- No change to who may approve. Releases and deploys always need a person (approval-policy decision 1). The lead may
  ask for a carry. It can never make one stand on its own authority, and it can never widen one.
- No carrying of production code, harness, dependencies or build inputs. Any of these asks again.
- No carrying after deployment starts. The candidate freezes at deploy.
- No carrying while the release project's checks run outside the sandbox.
- No change to CI. Every required pull-request check passes on the exact final commit before merge.
- No targeted checks for ordinary tasks. They apply only to release gates.
- No reuse of GitHub CI results inside a composed check (cut from revision 1).
- No mechanical proof that a changed test still asserts the same thing. See "What stays trusted".

## Prerequisites

### Approval policy

This plan builds on `approval-policy` (branch, 20 commits, not on main yet). It needs:

- `personApprovalOf` and `sealOriginOf` (`src/scope.ts`), unchanged;
- the allowlist authority readers (`src/approval-authority.ts`, `dispatch.ts`, `work-index.ts`, `modeApprovalLive`);
- `src/person-proof.ts`;
- the two deployment boundaries, `src/deploy-gate.ts deploymentGate` and `scripts/deploy-candidate.mjs`;
- the verified Git object reader, `src/commit-extract.ts`.

Order: approval-policy phase 1 merges first, then `release-once` rebases on main. If it hasn't merged when work
starts, stack this branch on it.

**Schema version.** Main is at v133. The approval-policy branch also says v133, so it must take v134 when it rebases.
This plan takes **v135**. The implementation re-checks the numbers at rebase time. Migrations stay additive (new
tables, nullable columns), so `toolroll update` runs them in place.

### 0.9.71: release checks run sandboxed again

0.9.70 ran the release project's checks "Not sandboxed" because the browser checks need it on macOS (CHANGELOG).
0.9.71 ships three changes:

- sandbox-runtime `allowPty`;
- the Chromium mach-register rule;
- a decision on Keychain access.

With these, release checks run inside the fence again. Carrying, targeted re-runs and the nightly check are turned on
only after 0.9.71 is deployed. Carrying refuses whenever the release project's check access is wider than the fence,
both the access the anchor sealed and the live setting.

## Part 1 — one approval per release

### The model

- **The anchor.** The first gate task of a release is filed and approved as today, by a person. Its scope carries
  **release terms**, which are part of the scope digest and shown on the approval sheet:
  - repository (from Toolroll's records), version, head branch, pull request number, base `main`;
  - the approved commit, its tree, and the approved production-artifact digest;
  - the **effective carry policy**: the runtime rules and this project's protected paths, written out in full;
  - the release check grant (id and digest), and the sealed check access, which must be fenced;
  - the expiry.

  The sheet says, in two lines: "Release 0.9.71 from pull request #240 at `abc1234`. Later commits on this pull
  request that only change tests, docs or the changelog ship without asking you again, until it merges or for 3 days.
  You'll see each one in the release summary." The full terms sit behind **What asks again**.

- **The release authority record.** When a person seals an anchor, the same transaction creates one
  `release_authority` row. That row is the single source of truth for the release:
  - its generation;
  - the anchor and the current tip;
  - its state: `open`, then `deploying`, `merge-reserved`, and finally `merged`, `revoked`, `expired` or `superseded`;
  - the coordinator lease;
  - a revision number, so every change is a compare-and-swap.

  The JSON journal becomes recovery and display data only. Authority is never read from the journal.

- **A carried gate task.** A later commit B still gets its own gate task (`gateTaskId(version, sha)`), its own check,
  receipt and completion. Its scope is written and sealed **only by the carry transaction**, with the new basis
  `carried`. That makes it a copy of the anchor's approved scope, with only the candidate changed.

- **Asking again.** When a carry is refused, nothing is sealed. The coordinator files B's gate the ordinary way and
  stops at `approval`, naming the commit, the path and the rule. The person's yes creates a **new generation**: a new
  `release_authority` row whose `previous` points at the old one, which becomes `superseded`. Old rows are never
  revived, so their carries stop standing.

### Which changes carry

A change carries only when **both** of these hold.

**1. Every changed path is in an eligible class** (`src/release-carry.ts CARRY_RULES`, version 1):

| Class | Paths |
| --- | --- |
| Unit tests | `src/**/*.test.ts` (including `*.slow.test.ts` and browser tests) |
| Journey scripts | `scripts/app-e2e.mjs`, `scripts/flows-e2e.mjs` |
| Docs | `docs/**`, other `*.md` files |
| Changelog | `CHANGELOG.md` |

These are **never** eligible, even when they match a class above:

- `AGENTS.md` and `SECURITY.md`;
- `test/attacks/**`, the attack suite;
- every harness file and its executable dependencies:
  - `scripts/release-check*.mjs`, `scripts/suite-lifecycle.mjs`, `scripts/provider-gate.mjs`;
  - `scripts/e2e-parallel.mjs`, `scripts/e2e-kit.mjs`, `scripts/upgrade-path.mjs`;
  - `vitest.config.ts`, `test/attacks/vitest.config.ts`;
  - `test/setup-state.ts`, `test/fresh-store.ts`, `test/temp-root.ts`, `test/ensure-build.ts`;
  - every `test/**` and `scripts/**` file those import;
- fixtures and helpers (`test/**` other than test files, `scripts/fixtures/**`);
- every path in the project's own `approval_policy.protected_paths`.

Each commit is checked against its parent, and the whole range is checked from the approved commit to the tip.
These also ask again: a deleted or renamed file; a mode change; a binary file, symlink or submodule; an unnormalized
path.

**2. The production artifacts are identical.** File names can't prove that shipped code is unchanged. Tailwind scans
`src/browser/` (`src/browser/tailwind.css`, `@source "./"`), so a class name in a browser test can change the shipped
CSS. So the plane builds both commits and compares what ships:

- **Inputs.** It extracts the approved commit and the tip itself (`extractCommit`, verified objects, regular files
  only) into fresh folders.
- **Install.** It installs from the lockfile with `--ignore-scripts`, from the dependency cache, with no network. The
  lockfile isn't eligible, so it is the approved one.
- **Build.** It runs `npm run build` inside the fence. The build scripts aren't eligible either, so the code that runs
  is code the person approved. No test runs.
- **Digest.** It digests every file under `dist/` (path, mode, sha256), plus every file `npm pack --dry-run --json
  --ignore-scripts` would ship. `CHANGELOG.md` and `README.md` are left out of the digest and listed as doc changes.

The approved commit's digest is computed once and sealed in the authority record. A different digest asks again. The
build stamp is printed, not written to `dist` (`scripts/postbuild.mjs`), so builds of the same inputs match. If
implementation finds anything non-deterministic, it is fixed or listed in the sealed policy. It is never silently
ignored.

**Limits** (Codex: not a security boundary; they keep a carried change reviewable):

- at most 400 changed lines (added plus deleted) and 20 files, from the approved commit to the tip;
- at most 800 changed lines in total across all carried commits, so churn counts too.

### The effective policy, sealed

- **Policy.** The effective policy is the runtime rules plus this project's `protected_paths` and limits. It is
  written into the release terms and into `release_authority.policy_json`, and its digest is part of the scope digest.
- **At carry time** the transaction applies the **stricter** of the sealed policy and the current one. A path either
  of them protects asks again, and the lower of the two limits applies. Tightening a policy can stop carrying.
  Relaxing one never widens an approval.
- **Unknown versions.** A runtime that doesn't know the sealed policy version refuses to carry.

### The carry proof

`src/release-carry.ts proveCarry(authorityId, to)` gathers facts. `Store.carryReleaseApproval(authorityId, rev,
facts)` decides, in one transaction.

**Gathered first.** These are facts about fixed, hashed commits:

1. **Ancestry**, from commit objects read from the project's own Git directory (as Toolroll records it) and hashed by
   Toolroll (`commit-extract.ts`, new `readVerifiedCommit` and `verifiedFirstParentWalk`). Replace refs, grafts,
   shallow files and lazy fetch are ignored. The walk is limited to 200 commits. A merge commit refuses.
2. **Each commit's own changes** against its parent, from verified trees (`verifiedTreeDiff`, no rename detection): the
   path, old and new mode, and lines added and deleted.
3. **The production-artifact digest of the tip**, built as described above.

**Inside one `BEGIN IMMEDIATE` transaction:**

1. The authority row is at the caller's `rev`, in state `open`, not expired, and the caller holds the lease. A
   `deploying` or `merge-reserved` release refuses.
2. `personApprovalOf(anchor)` holds now: the approver is still an active approver with access to the project.
3. The walk starts at the approved commit and passes through the **current tip**. A force-push, a dropped carried
   commit or rewritten history refuses.
4. The eligible-class rules and limits pass under the stricter policy.
5. The production-artifact digest equals the sealed one.
6. The live release check grant has the sealed id and digest. The project's check access, live and sealed, is fenced.
7. **Idempotence.** If a carry for this authority and `to` already exists and still proves, its task is returned. The
   lost-answer retry case makes no new row and doesn't refuse.
8. Write:
   - the carried task and its scope, copied from the anchor (approved profile, route, check access and acceptance
     verbatim, candidate `to`);
   - the seal, with basis `carried` and authority reference `<authority id>:<carry id>`;
   - the `release_carry` row, with the facts and the scope digest;
   - the authority's new tip, and `rev + 1`;
   - a ledger row, `release carried`.

GitHub state can change, so it is never treated as a fixed fact. It is re-read at each step (below).

### Who can make a `carried` seal stand

- `sealScopeApproval` refuses basis `carried` from every caller. Only the carry transaction writes it, with its own
  statement.
- The allowlist readers (`authorityStandsSql`, `modeApprovalLive`, dispatch, work index) let a `carried` seal stand
  only when **all** of these hold:
  - a `release_carry` row exists for this exact task, scope digest, candidate and authority generation;
  - the authority is `open` or `deploying` and not expired;
  - the anchor's seal is still a person's (`personSealSql`);
  - the release check grant and the check access still match what was sealed.
- `personApprovalOf` is **unchanged**, and it refuses `carried`.
- New: `releaseApprovalOf(store, taskId)` accepts a person approval of this task, **or** a `carried` seal that the
  rules above accept, and returns the anchor's approver.

### Both deployment boundaries

`src/deploy-gate.ts deploymentGate` and `scripts/deploy-candidate.mjs deploymentCandidate` use
`releaseApprovalOf` instead of `personApprovalOf`. This covers every resumed phase of `deploy-browser.mjs` (stage,
prepare, rehearse, swap, finish). Both take the reader from the installed runtime, never from the candidate.

The fallback for an older runtime (`personApprovalFromRecords`) does **not** learn about `carried`. It refuses a
carried candidate: "This release continued from an earlier approval; update Toolroll first." Nothing reinterprets a
carried seal as a person's.

### The coordinator

`src/release.ts`:

- **Lease.** `runRelease` takes the authority's coordinator lease with a compare-and-swap (owner id, expiry, renewed
  while waiting). A second coordinator refuses: "Another `toolroll release` is running this release." Every
  transition below is a compare-and-swap on `rev` while holding the lease.
- **Identity, before every step that can't be undone.** Before `complete`, `deploy` and `merge`, `identity()` re-reads
  and requires the following. Any mismatch stops the release.
  - The authority is `open` (for `complete` and `deploy`), not expired or revoked, and the anchor's person approval
    still holds.
  - The repository matches Toolroll's record. The pull request is the sealed number and **open**, its base is
    `main`, its head branch is the sealed branch, and its head is the authority's tip.
  - The gate task is the tip's task, and `releaseApprovalOf` holds for it.
- **The branch moves.** When `identity()` sees a new head while the authority is `open`, it doesn't patch the current
  step. It throws `Restart`:
  1. The outer loop catches it and releases nothing it was holding.
  2. It asks the plane for a carry: `toolroll release carry <authority> --to <sha> --json`.
  3. On success it writes the journal for the new tip (clearing `check`, `completion` and `ci`) and starts the state
     machine again from `check`.
  4. On refusal it files the new head's gate the ordinary way, and stops at `approval` with the reason.

  No step goes on holding a variable captured before the restart. Before approval nothing is carried: the gate is
  refiled for the newest head.
- **Freeze at deploy.** `deploy` first moves the authority from `open` to `deploying` (compare-and-swap). From then
  on, carrying refuses. A moved branch stops the release with today's `drift` words, and a new commit then needs
  `--new` and a person's approval. A CI failure found after deploy also needs that approval: this is the cost of the
  freeze.
- **Merge reservation.** `merge` moves `deploying` to `merge-reserved` in one compare-and-swap. The same
  compare-and-swap re-checks that the authority isn't revoked or expired, that the anchor's person approval holds and
  that the tip is the gated candidate. Only then does it call `gh pr merge --match-head-commit`. Once reserved, a
  revoke is refused with "the merge already started". After the merge the state is `merged`. Tag, publish and
  Homebrew follow the merge commit as today.
- **Revoke while deploying.** The deploy gate re-checks `releaseApprovalOf` at every phase. A revoke during deploy
  stops it at the next phase boundary, and `--phase recover` puts the previous build back.
- **Expiry.** At the merge, or 3 days after the approval, whichever comes first. Expiry stops new carries and any
  action not yet taken. Facts already recorded (receipts, carries, completions) stay true.
- **Journal.** `version: 1`, with optional fields so older journals still read:
  - `authority?: { id: number; generation: number }`;
  - `landed?: { sha; task; subject; files: { path; added; deleted }[]; carriedAt }[]`, built from `release_carry`
    rows.

### What people see

- **Release summary.** The final lines of `toolroll release`, the journal and the squash-merge message list each
  commit that landed after the approval, with its files and line counts.
- **Console.**
  - The anchor task page shows **Approved for release 0.9.71**, with a **Later commits** disclosure (commit, subject,
    files, +/−, the check that ran) and **Stop carrying later commits**.
  - Stop carrying is one click by any active approver, or `toolroll release revoke <authority>`. In the same
    transaction it sets the state to `revoked` and withdraws carried seals that have no live claim.
  - A carried task page says **Carried from Alex's release approval**, with a link. It never says "Approved by alex"
    on its own.
  - The approval sheet shows the two lines above. Terms and the full path rules sit behind **What asks again**.
- **Words.** `render-tasks.ts approvalProofWords`, `noteLifecycle` and `evidence-pack.ts` get a `carried` wording.
- **Notifications.** A carry posts one quiet task notification, without a push.

## Part 2 — re-run only what failed, by file

### What can be trusted, and from where

Revision 1 read results from files that tests can write, such as Vitest's JSON output and the journeys'
`report.json`. A hostile test could change those files so that a real failure looked like a pass (Codex finding 1).
Revision 2 changes where results come from:

- **Over pipes, never from files.** The orchestrator (`release-check.mjs`) gives each child **one extra pipe, fd 3**,
  and reads results only from it:
  - the Vitest main process gets a small reporter (`test/release-reporter.ts`, a harness file) that writes one JSON
    line per finished test to fd 3;
  - `e2e-parallel.mjs` and `upgrade-path.mjs` write one JSON line per journey or upgrade version to their fd 3.

  Node opens extra fds close-on-exec. The fork and spawn calls name their stdio exactly, so worker processes and test
  code don't inherit fd 3 and can't write to it directly. Nothing reads results from a file on disk.
- **Nonce.** The plane writes one line to the check's stdin, `{"nonce": "<random>", "mode": …, "plan": …}`, and
  closes it. The orchestrator reads the line first and gives every child `stdin: "ignore"`. The nonce is never in the
  environment or argv, where `ps` could read it. The orchestrator's report, its last stdout line
  (`TOOLROLL_CHECK_REPORT <json>`, at most 256 KiB), carries the nonce. The plane takes only the last line.
- **What stays trusted.** Test code runs as the same user as the orchestrator. Inside a Vitest worker it can
  misreport its own results through Vitest's channel. Outside the sandbox it could also change `node_modules` or
  other processes. Fixing that would need a boundary between test code and the check harness, which Toolroll doesn't
  have. The mitigations:
  - release checks run inside the fence (0.9.71), so test code can't reach the plane's state, credentials or other
    projects;
  - carried changes are limited to tests and docs, with identical production artifacts;
  - the **nightly full check** runs everything again on main and release heads within a day;
  - every changed test file is listed in the release summary.

  The full check trusts test code the same way today. Targeted runs add only the risk that a forged result in run A
  skips a test in run B. The nightly check bounds how long that can last.

### Sealed before run A starts

When the builder launches a release gate check, it first writes a `release_check_attempt` row. The row holds:

- the **intended mode**: `full` or `targeted`;
- the plan digest, for a targeted run;
- the nonce hash;
- the **inventory** (sealed as `check-inventory.json`):
  - **unit files**, from the verified tree, matched with Vitest's include globs. The globs are a harness constant,
    and their digest is checked against `vitest.config.ts` at that tree;
  - **journey groups**, listed by the orchestrator before any test starts (`--groups --json`). They come back on the
    first fd-3 line and are sealed at that point;
  - **upgrade versions**, from the release tags, as `upgrade-path.mjs` selects them;
  - **the parts** `planFor` selects.
- the **execution context**:
  - the Node version, platform and arch;
  - the lockfile digest;
  - the digest of the harness files at the tree;
  - the release check grant (id and digest);
  - the check access;
  - the budget (`checkBudget`).

Writing the mode and the inventory before launch means a run can't decide afterwards what it was supposed to cover
(findings 3 and 11).

### What run A records

Every inventory item gets exactly one outcome:

- **passed**;
- **failed**, with the failed **test identities**. A Vitest identity is the file, the full name path (describe ›
  test) and its index among tests with the same name. A journey identity is the group and the journey name;
- **skipped**, with its identities;
- **flaky**: passed only on the runner's retry (`e2e-parallel.mjs` retries, real-model retries);
- **stopped**: killed by a timeout or a cancel;
- **not run**;
- **unattributed**: a runner error not tied to a test. Examples are Vitest's "Unhandled errors", a worker crash, a
  group that ended without a report, or a browser-error check.

Every item must be accounted for. An item missing from the report counts as not run.

**No fail-fast on release runs.** A failure no longer stops parts that are running. Cancel, the part timeout
(`PART_MS`), the process-exit checks and "a failed build starts no journeys" all stay.

### When run B may be targeted

`src/release-recheck.ts planTargetedRecheck(store, runId)` runs before the builder launches B's check. The check is
**full** unless all of these hold:

1. **Same release.** A and B are both gate tasks of the same authority generation.
2. **A is the base.** A is the newest run in this generation whose intended mode was `full`. It executed (not reused
   from CI), and its report has the run's nonce and agrees with the summary lines. Every inventory item has an
   outcome, and A did **not** reuse CI for units. Targeted runs never become a base.
3. **The changes are test-only.** Everything from A's candidate to B's is test-only: eligible classes and identical
   production artifacts, as in Part 1. Under carrying this holds already; the check is repeated for A and B.
4. **The setup is the same.** The execution context and the inventory at B equal A's, apart from changed unit test
   files. A different harness digest, lockfile, Node version, grant, check access or parts means the full check.
5. **No full-check debt.** If the newest nightly run on main or this release failed, and no full run has passed
   since, B runs the full check (see the nightly section).

### The plan for B

Open **obligations** are recorded as `release_check_obligation` rows:

- every identity that failed at A;
- every identity that failed in a later targeted run of this generation.

An obligation closes only when that identity runs and passes. B's plan, sealed as `targeted-plan.json`:

- **Unit tests, by file.** It includes:
  - every file with an open obligation;
  - every changed unit test file.

  Each of those files runs whole, so every identity in it is accounted for again. If A had unattributed or stopped
  units, B runs **the whole unit part**.
- **Journeys, by whole group.** It includes:
  - every group that failed, was flaky, stopped, didn't run or was unattributed at A;
  - a group with an open obligation;
  - for a changed journey script, every one of its groups.
- **Upgrades, by whole version.** Every version that failed, stopped or didn't run at A.
- **Typecheck or build failed at A** means the full check. Test changes can't fix them, because `tsconfig.json`
  excludes tests.
- **Sanity pass, always:**
  - `npm run typecheck` and `npm run build`;
  - `SANITY_UNITS`, a fixed list of fast unit files in `release-check.mjs` (store open and migrate, CLI envelopes,
    scope digest, release state machine), under a minute.
- **Carried from A:** every other item that passed at A.

### What B must show

The plane checks B's fd-3 results against the sealed plan:

- Every planned item has an outcome.
- Every identity that A or an earlier run in this generation had **failed** **ran and passed**.
- In every re-run file or group, every identity that existed at A still exists. It is not removed, renamed or newly
  skipped. Any of those means the targeted result is **not a pass**, and the next check is full.
- The sanity pass passed.

### How it is recorded

- **Receipt.** Version 3 of `contracts/verification-receipt.ts` follows the version 2 `reusedFrom` pattern. It keeps
  the raw exit (`result`) separate from a new `coverage` field: `full`, `composed` or `partial`. A composed receipt
  names A's run, receipt digest, report digest and candidate tree, the test-only proof (paths and artifact digest),
  the plan digest and B's report digest.
- **Mode decides the result.** The receipt is sealed according to the **intended mode** in `release_check_attempt`:
  - **full:** today's rule. Exit 0, with every inventory item accounted for, is coverage `full`. A full run that
    exits 0 but has no valid report is still a pass, because today's trust in a full run is unchanged. It just can't
    be a base for a targeted run.
  - **targeted:** the coverage is `composed` only when every condition above holds. Otherwise it is `partial`. A
    `partial` receipt **is never a passing check**, whatever the exit code. It reads as failed, with words such as
    "A targeted check couldn't be combined with run 3241; the next check runs in full."
- **The reader re-proves everything.** `verificationEvidence()` reads version 3 by re-proving every link from the
  store:
  - A's sealed receipt and report artifacts;
  - the same authority generation;
  - the grant and the inventory context;
  - the test-only proof and the artifact digests;
  - the plan, derived again from A's report and the open obligations;
  - B's report against that plan.

  Only then does the result read `passed`, level `full`, with `composedFrom: A`. `gateStateOf`, `fullCheck`,
  `deploymentCandidate`, `deploymentGate` and `release-coverage.ts` all read the result through this reader.
- **Composition stops at merge.** A composed result never takes the place of the nightly check, and it never counts as
  the "full pass" that clears a nightly failure.

### Relatedness

Revision 1 required the change to be "related" to the failure. That is now only a **hint**: the release summary says
"the change didn't touch the failing test" when it didn't. It doesn't block anything. What blocks is the obligation
list. A failure stays open until that exact test runs and passes, and the console lists open obligations on the
anchor page. A test that fails and then passes with no change to its file is marked **passed without a change** in
the summary and gets a follow-up note, so a flaky test stays visible.

## Part 3 — the nightly full check

- **What runs.** At 03:00 local, the full release check (`node scripts/release-check.mjs --full`, the approved
  grant) runs on:
  - **main's head**;
  - **each open release head** whose release authority is `open` or `deploying`.

  No other branches run, so nightly never runs code that no person approved or carried.
- **Where it lives.** It is a Toolroll **flow with a schedule trigger** (`flow-schedule.ts`). Alex approves the flow
  once with a password. Each firing files a check-only task, `nightly-<date>-<sha7>`:
  - the candidate is the head, checks are `full`, and the acceptance is "The approved release check passes";
  - it is sealed with basis `schedule` (approval-policy 1.6);
  - it never deploys, merges or completes anything;
  - it runs inside the fence. It is turned on after 0.9.71 is deployed.
- **On failure.** It sends one notification with push class `attention`, which goes to web push and the Telegram
  task updates channel: "Nightly full check failed on main at `abc1234`: 2 unit files, `app/pages`." It also writes a
  `full_check_debt` row for the repository.
- **The debt.** While the debt is open, every release gate check runs **full**, and `planTargetedRecheck` refuses with
  "a nightly full check failed". The debt clears when a later nightly run or a full release check, on a commit that
  contains the failed one, passes.
- **Records.** A table, `nightly_check`, holds the repo, sha, run, outcome and time. The anchor page and
  `toolroll status` show the last nightly result.

## Data and schema (v135)

```sql
CREATE TABLE release_authority (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo          TEXT NOT NULL,
  generation    INTEGER NOT NULL,                  -- 1, 2, … per (repo, version, pr)
  previous      INTEGER REFERENCES release_authority(id),
  version       TEXT NOT NULL, pr INTEGER NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL,
  anchor_task   TEXT NOT NULL, anchor_digest TEXT NOT NULL,
  approved_sha  TEXT NOT NULL, approved_tree TEXT NOT NULL, artifact_digest TEXT NOT NULL,
  tip_sha       TEXT NOT NULL, tip_task TEXT NOT NULL,
  policy_json   TEXT NOT NULL, policy_digest TEXT NOT NULL,
  verify_command INTEGER NOT NULL, verify_digest TEXT NOT NULL, access_digest TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','deploying','merge-reserved','merged','revoked','expired','superseded')),
  rev           INTEGER NOT NULL DEFAULT 0,
  lease_owner   TEXT, lease_expires TEXT,
  expires_at    TEXT NOT NULL, created_at TEXT NOT NULL,
  ended_at      TEXT, ended_by TEXT,
  UNIQUE (repo, version, pr, generation)
);
-- At most one live authority per release.
CREATE UNIQUE INDEX release_authority_live ON release_authority(repo, version, pr)
  WHERE state IN ('open','deploying','merge-reserved');

CREATE TABLE release_carry (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  authority     INTEGER NOT NULL REFERENCES release_authority(id),
  task_id       TEXT NOT NULL UNIQUE,
  scope_digest  TEXT NOT NULL,
  from_sha      TEXT NOT NULL, to_sha TEXT NOT NULL, to_tree TEXT NOT NULL, artifact_digest TEXT NOT NULL,
  commits_json  TEXT NOT NULL,                      -- [{sha, parent, subject, files:[{path, oldMode, newMode, added, deleted}]}]
  changed_lines INTEGER NOT NULL, files INTEGER NOT NULL, churn INTEGER NOT NULL,
  runtime       TEXT NOT NULL, proved_at TEXT NOT NULL,
  UNIQUE (authority, to_sha)
);

CREATE TABLE release_check_attempt (
  run           INTEGER PRIMARY KEY REFERENCES run(id),
  authority     INTEGER REFERENCES release_authority(id),
  mode          TEXT NOT NULL CHECK (mode IN ('full','targeted')),
  base_run      INTEGER REFERENCES run(id),         -- A, for a targeted run
  plan_digest   TEXT, inventory_digest TEXT NOT NULL, context_digest TEXT NOT NULL,
  nonce_hash    TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE release_check_obligation (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  authority     INTEGER NOT NULL REFERENCES release_authority(id),
  identity      TEXT NOT NULL,                      -- unit: file › names #n; journey: part/group › name
  failed_run    INTEGER NOT NULL, closed_run INTEGER, closed_without_change INTEGER NOT NULL DEFAULT 0,
  UNIQUE (authority, identity, failed_run)
);

CREATE TABLE nightly_check (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, sha TEXT NOT NULL, run INTEGER, outcome TEXT, at TEXT NOT NULL
);
CREATE TABLE full_check_debt (
  repo TEXT PRIMARY KEY, sha TEXT NOT NULL, run INTEGER NOT NULL, opened_at TEXT NOT NULL, cleared_by_run INTEGER, cleared_at TEXT
);
```

Other changes:

- `task_scope.release_terms_json`, nullable. When present it is part of the digest, and it is read strictly (known
  keys, known policy version).
- The `approval_basis` allowlist gains `carried`.
- New artifacts sealed per run: `check-inventory.json`, `check-report.json` and `targeted-plan.json`.
- Receipt version 3.

## Files and functions

| File | Change |
| --- | --- |
| `src/release-carry.ts` (new) | `CARRY_RULES`, `effectivePolicy(store, repo)`, `stricterOf()`, `artifactDigest(gitDir, sha)` (extract, install, build in the fence, digest), `proveCarry()`, refusal words |
| `src/commit-extract.ts` | `readVerifiedCommit`, `verifiedFirstParentWalk`, `verifiedTreeDiff` |
| `src/store.ts` | v135 tables; `sealScopeApproval` creates the authority on a person's seal of release terms and refuses `carried`; `carryReleaseApproval`, `reserveRelease(rev, from, to)`, `leaseRelease`, `revokeRelease`; obligations; nightly and debt |
| `src/scope.ts` | release terms in the scope; `releaseApprovalOf`. `personApprovalOf` unchanged |
| `src/approval-authority.ts`, `dispatch.ts`, `work-index.ts`, `modeApprovalLive` | the `carried` standing rule |
| `src/deploy-gate.ts`, `scripts/deploy-candidate.mjs` | `releaseApprovalOf` at every phase; the older-runtime fallback refuses `carried` |
| `src/release.ts` | lease; `identity()` before `complete`, `deploy` and `merge`; `Restart` and the outer loop; freeze at deploy; merge reservation; journal `authority` and `landed`; summary |
| `src/release-adapters.ts` | `carry`, `lease`, `reserve`, `revoke`; `fileGate` with release terms; `gateStateOf` reads `scope.release` and `checks.coverage`; the PR adapter returns repo, head branch and base; the merge message lists landed commits |
| `src/release-cli.ts` | `release carry`, `release revoke`; help |
| `src/release-recheck.ts` (new) | `planTargetedRecheck`, `obligationsOf`, `planDigest`, `composeCheck` |
| `scripts/release-check.mjs` | stdin handshake, fd-3 result pipes, inventory line, last-line report, no fail-fast on release runs, executing a plan, `SANITY_UNITS` |
| `test/release-reporter.ts` (new, harness) | the Vitest reporter that writes to fd 3 |
| `scripts/e2e-parallel.mjs`, `scripts/upgrade-path.mjs` | per-journey and per-version lines to fd 3 |
| `src/builder.ts` | the attempt row before spawn; the stdin line; fd 3 and the last line; sealing inventory, report and plan; receipt v3 by intended mode |
| `src/verification-evidence.ts`, `src/contracts/verification-receipt.ts`, `src/assignment.ts` | receipt v3, `coverage`, `composedFrom` |
| `src/flow-schedule.ts` + a flow definition | the nightly flow; the check-only task; notification and debt on failure |
| `src/server/render-tasks.ts`, approval sheet, anchor page | terms, Later commits, obligations, last nightly, Stop carrying |
| `AGENTS.md`, `SECURITY.md`, `docs/testing.md` | the targeted-release exception; what stays trusted; the nightly check |

## Tests

Only what `docs/testing.md` keeps: security rules, data integrity, contracts. Every case goes through the real road
(real Git, real store, real CLI and real child processes). Attack cases go in `test/attacks/`. Run the AGENTS.md
safety self-review before each security commit.

**Carry rules table** (`release-carry.test.ts`), one row per rule:

- each eligible class carries;
- each excluded file refuses: AGENTS.md, an attack test, each harness file and `test/fresh-store.ts`, a `test/`
  helper, a fixture, a project protected path;
- `src/serve.ts` refuses (production);
- deleted and renamed tests refuse;
- binary, symlink, submodule and mode change refuse;
- 401 changed lines (deletions counted) refuses, 21 files refuses, churn 801 refuses.

**Carry attacks** (`test/attacks/release-carry.test.ts`):

1. A browser test that adds a Tailwind class name: the artifact digest differs, so it asks again.
2. A lead token asks to carry an allowed commit: carried. It asks to carry a commit touching `src/release.ts`:
   refused, no seal, no row.
3. A direct `sealScopeApproval` with basis `carried`: refused. A hand-written `carried` row with no carry row, or a
   carry row for another task, digest or candidate: doesn't stand at dispatch, claim, build, release or either deploy
   boundary.
4. A force-push with the same tree on a new history: refused. A history that keeps the approved commit but rewrites a
   carried one: refused. A merge commit: refused.
5. Planted `refs/replace/*`, `info/grafts` or `shallow` files, or a corrupted object: refused.
6. Removing a project protected path after approval: the stricter rule still asks again. Adding one: asks again.
7. The release check grant changes, or the check access goes beyond the fence (sealed or live): refused.
8. Anchor by `lead`, `mode`, `schedule` or an unproven `password` seal: no authority is created.
9. The approver is demoted, the authority is revoked, or it expires: carried seals stop standing at every reader and
   at both deploy boundaries, including a resumed `deploy-browser.mjs` phase. An older-runtime fallback refuses a
   carried candidate.
10. Two coordinators: the second refuses on the lease. A carry racing a merge reservation: exactly one wins. A carry
    after `deploying`: refused.
11. A carry whose answer was lost, retried: the same task is returned, with no second row and no refusal.
12. A new generation after a revoke: the old carries don't stand, and the old generation can't be revived.
13. Pull request retargeted to another base with the same head; PR closed and a new one opened; head branch renamed:
    stop before `complete`, `deploy` and `merge`.

**Coordinator** (`release.slow.test.ts`, faked adapters):

- a branch move during the `check` wait, the CI poll and deploy preparation: the move during check and CI restarts at
  `check` for the tip. Nothing from the old step runs afterwards, A is never deployed, and the old step never advances
  to `merge`;
- a move after `deploying`: the release stops;
- revoke during the CI wait: `merge` refuses;
- the summary and the merge message list every landed commit.

**Targeted re-run attacks** (`test/attacks/release-recheck.test.ts`):

14. A test rewrites a Vitest JSON or journey `report.json` file: ignored, because results come only from fd 3.
15. A test prints `TOOLROLL_CHECK_REPORT` or writes to fd 1 with a forged line: not the last line, and no nonce.
16. A test tries to write to fd 3: it isn't open in the worker.
17. At A, X and Y both fail. B fixes X. Y is still an open obligation, so B runs Y. A forged A that hides Y is the
    stated residual (see "What stays trusted"); the nightly check covers it.
18. B deletes a failing `test(...)` from a file that still exists: an identity is missing, so it's not a pass. B skips
    a failing test and un-skips another: a newly skipped identity, not a pass. B renames a failing test: not a pass.
19. A journey group passes only on retry at A: the whole group runs at B. A Vitest "Unhandled errors" at A: the whole
    unit part runs at B. A group with no result line: the whole group.
20. Inventory: a unit file added to the tree but missing from the report counts as not run. The context changes
    (lockfile, Node, harness digest): full check.
21. Intended mode `targeted`, exit 0, report lost: coverage `partial`, read as failed, never a pass.
22. Receipt v3 reader: break each link in turn (A's receipt bytes, report digest, plan digest, artifact digest,
    generation, grant). `verificationEvidence`, `deploymentCandidate` and `deploymentGate` refuse.
23. A targeted run used as a base: refused. A base with CI-reused units: refused.
24. Open full-check debt: full check. After a passing full run: targeted allowed again.
25. Contracts: the schemas for the inventory, the fd-3 lines, the report, the plan and receipt v3.

**Nightly** (`flow-schedule` table): it fires at 03:00 on main and on live release heads only, never on other
branches. A failure notifies (push and Telegram) and opens the debt. A later full pass on a containing commit clears
it. The firing task can't deploy, merge or complete.

## Rollout

1. **0.9.71** ships with the sandbox fixes (`allowPty`, the Chromium mach-register rule, the Keychain decision).
   Release checks run inside the fence again.
2. **Approval-policy phase 1 merges.** Rebase `release-once`.
3. **Phase A, the check report.** This changes no behaviour:
   - the stdin handshake;
   - the fd-3 pipes and the reporter;
   - the inventory and the attempt row;
   - the last-line report, sealed as artifacts;
   - no fail-fast on release runs.

   It is released through the normal gate, and a few real releases produce real reports.
4. **Phase B, the nightly full check.** The flow, notifications and debt. Turned on once Phase A is deployed, so
   nightly runs produce reports too.
5. **Phase C, one approval per release.** The authority record, carrying, the coordinator changes, both deploy
   boundaries and the console. Codex review rounds until GO. Its own release is approved the old way.
6. **Phase D, targeted re-runs by file.** Obligations, plans and receipt v3. Codex review rounds until GO.
7. **Docs.** AGENTS.md (Lean verification), SECURITY.md (what stays trusted) and docs/testing.md, updated in the
   phases that need them. They are protected, so a person approves them.

**Off switches.** Both only make things stricter, so a machine may set them:

- `toolroll release --no-carry`, for one run;
- the project setting "Ask for every release commit". Lowering it back is one click.

## Decisions for Alex

Settled in this revision: build on approval-policy; carry only tests, docs and the changelog, with identical artifacts;
no carrying with unsandboxed checks; until merge or 3 days; no fail-fast on release runs; whole journey groups and
upgrade versions; file-level unit re-runs; relatedness as a hint; the nightly full check; freeze at deploy; ask again
on merges from main.

Still open:

1. **Limits.** *Recommend 400 changed lines (added plus deleted) and 20 files from the approved commit, and 800 lines
   of churn across carried commits.* They only keep a carried change reviewable; they are not a security boundary.
2. **Journey scripts carry.** `scripts/app-e2e.mjs` and `scripts/flows-e2e.mjs` are test code, but they are large and
   drive a real install. *Recommend: they carry* (artifacts must still match, and their groups re-run whole).
3. **Nightly on release heads.** *Recommend yes*, for heads with a live authority only, so a carried test-only change
   gets a full check within a day even if the release waits.
4. **A CI failure after deploy needs a new approval** (because of the freeze). *Recommend accepting it for now.*
   Revisit if it happens often. The fix would be a separate, narrow "redeploy for a test-only change" rule with its
   own review.

## Codex round 1 → revision 2

| # | Finding | How revision 2 answers it |
| --- | --- | --- |
| 1 | The nonce authenticates the wrapper, not its coverage; reports come from files tests can write | Results come only over fd-3 pipes from the harness processes. No report file is read. The nonce arrives on stdin and isn't inherited. The residual (same-user test code inside its own worker) is stated, and bounded by the fence (0.9.71), test-only carrying and the nightly full check. **Accepted as a stated residual, not closed.** |
| 2 | Deleting failing cases or swapping skips passes the anti-skip rule | Failed test **identities** are bound. Every identity that failed must run and pass. A removed, renamed or newly skipped identity in a re-run file or group means not a pass, and the next check is full. Weakened assertions can't be detected mechanically; the release summary lists every changed test, and the nightly check runs everything. |
| 3 | "Complete run" has no coverage contract | Inventory and execution context are sealed before A starts. Every item gets exactly one outcome. Flaky, stopped, not-run and unattributed items re-run their whole part or group. CI reuse is excluded from composition. |
| 4 | Filename classes don't prove shipping code is unchanged (Tailwind scans tests) | The plane builds both commits from its own extractions and compares production-artifact digests (`dist` plus packaged files). A difference asks again, and the check runs in full. |
| 5 | The protected list misses authority and harness code; carried production code runs as the plane | Narrowed to an allowlist: only tests, docs and the changelog carry. All production code asks again, so `src/server/guards.ts`, `session.ts`, `request-context.ts` and `project-access.ts` are covered. Harness dependencies (`test/fresh-store.ts`, and everything the harness imports) are excluded by name and by import. |
| 6 | Effective policy not bound; standing readers weaker than the proof | The effective policy (runtime rules plus project protected paths plus limits) is sealed. The stricter of sealed and current applies. `carried` stands only with an exact carry row (task, scope digest, candidate, generation) and the current authority, grant and access. No other road can write `carried`. |
| 7 | Carrying isn't serialized with merging; the journal competes as authority | One `release_authority` record holds the anchor, tip, state and merge reservation, under compare-and-swap on `rev`, with a coordinator lease. The journal is display and recovery only. |
| 8 | Changing `pinned()` in place can continue the old step | A carry throws `Restart`. The outer loop restarts from `check` for the tip. No carrying after deploy starts. Tested during the check wait, the CI poll and deploy preparation. |
| 9 | Revocation and PR identity missed after deploy | `identity()` runs before `complete`, `deploy` and `merge`: authority, repo, PR number, open, base, head branch and head. The merge reservation re-checks in the same compare-and-swap. Cutoffs are defined for deploy (next phase boundary, then recover) and merge (refused once reserved). |
| 10 | The deploy integration contradicts approval-policy | Both `deploymentGate` and `deploymentCandidate` use `releaseApprovalOf` at every phase. `personApprovalOf` is unchanged. The older-runtime fallback refuses `carried`. |
| 11 | "No report means no shortcut" conflicts with accepting v1 receipts | The intended mode is written before launch. A targeted attempt without valid composition is `partial` and never passes. Raw exit and coverage are separate fields. A full-mode run keeps today's rule but can't be a base without a report. |
| 12 | Size limits ignore deletions and churn; retries; generations | Deletions count. Endpoint and churn limits. Carrying is idempotent. Generations are explicit, with `previous` and `superseded`, and old ones are never revived. |
