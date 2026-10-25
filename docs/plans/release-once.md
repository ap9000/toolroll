# One approval per release, and re-running only what failed — plan

Status: plan, revision 1, 2026-10-25. Branch `release-once` (worktree `so-releaseonce`), based on `release-0.9.70`; it
will be rebased on main. Not reviewed yet. Nothing here is built.

## Why

Shipping 0.9.70 needed four approvals from Alex. `src/release.ts` names the gate task by commit
(`gateTaskId(version, sha)`), so every fix commit filed a new task with a new scope. Each one needed a person's
approval, a full release check (about 11 minutes, `scripts/release-check.mjs`) and GitHub CI (about 15 minutes). Six
release checks failed on the way (runs 3234–3241). Most failures were in one place: one unit file (3238
`src/live-terminal.test.ts`), one journey group (3237 `app/pages`, 3240 `app/console`), or the unit part (3241). Every
retry still ran everything.

Alex: "I can't keep approving the same thing over and over."

## Goals

1. **One approval per release.** A person approves a release once: version, branch, pull request, base, and the
   approved commit. Later commits on that same pull request get a new gate task and a new full release check (and CI)
   without asking again, as long as they stay inside the rules below.
2. **Re-ask when it matters.** These always need a person again: changes to release, deploy, approval/authority,
   fence/sandbox, credential, or upgrade/migration code; a large diff; any change to the release check command or its
   scripts; a different pull request, base or version; rewritten history.
3. **Show what landed after the approval.** The release summary and the console list every commit and file that
   landed after the person's approval.
4. **Re-run only what failed.** When a release check fails and everything changed since that run is test-only, the
   next check runs only the failed parts and files, the changed tests, and a quick sanity pass. The gate accepts
   "complete run at A + targeted pass at B, where B−A is test-only" as a pass on B. Any non-test change needs the
   full check.

## Non-goals

- No change to who may approve a release. Releases and deploys always need a person (approval-policy decision 1).
  The lead never approves, carries or widens a release.
- No change to CI. Every required pull-request check must still pass on the exact final commit (`REQUIRED_PR_CHECKS`),
  and the merge still pins the head.
- No partial checks for ordinary tasks. Targeted re-runs apply only to the release gate.
- No re-running a failure without a change. A flaky failure is not retried until it passes (decision 6).
- No dependency graph between tests and source. Test-only is proven by path classes, not by import tracing.

## How this fits the approval-policy branch

`docs/plans/approval-policy.md` (branch `approval-policy`, 20 commits, not on main yet) closes the lead-token hole and
adds what this plan needs:

- `personApprovalOf(store, taskId)` and `sealOriginOf` (`src/scope.ts`): a seal counts as a person's only with a
  person's proof row recorded at that seal's instant, for those exact bytes.
- Allowlist authority readers (`src/approval-authority.ts`, `dispatch.ts`, `work-index.ts`, `modeApprovalLive`). On
  main these are still deny-lists, so a new basis would stand by default. This plan adds a basis, so it needs the
  allowlists.
- `src/person-proof.ts`, and `ownerApproval` reading the plane's `person` answer.
- `src/deploy-gate.ts` and `src/commit-extract.ts`: the release proves the candidate in its own runtime, and reads Git
  objects it has hashed itself. This plan reuses that verified object reader for ancestry and tree diffs.

**Build on it.** Recommendation: wait for approval-policy phase 1 to merge, then rebase `release-once` on main. If it
hasn't merged when work starts, stack this branch on `approval-policy` and merge in that order. Building on main
alone would mean re-doing the allowlists and the verified Git reader, or adding a basis that the deny-list readers
would accept by default. (Decision 1.)

## Part 1 — one approval per release

### The model

- **Release approval (the anchor).** The first gate task of a release is filed and approved as today, by a person,
  with one change: its scope carries **release terms**. These are part of the scope text and the scope digest, so the
  person sees them and approves those exact bytes:
  - version, branch, pull request number, base (`main`), repository;
  - the approved commit and its tree;
  - the carry policy version (path rules, size limit, check harness list; these live in the installed runtime, not in
    the scope, see below);
  - the approved release check command (grant id and digest) and the check access the scope seals.

  The person sees this as plain words on the approval sheet, for example:
  "Release 0.9.71 from pull request #240 (`release-0.9.71` → main) at `abc1234`. Later commits on this pull request
  are checked and released without asking you again, unless they change release, deploy, approval, sandbox,
  credential or upgrade code, the release check, more than 300 added lines, or the pull request, base or version.
  Every later commit is listed in the release summary."

- **Carried gate task.** A later commit B gets its own gate task, as today: `gateTaskId(version, sha)`, one task per
  commit, its own full check, receipt and completion. All of the deploy machinery (`deploymentCandidate`,
  `deploymentGate`, completion, readiness) keeps working per task. The difference is how its scope is sealed: not by a
  person's ceremony, but by **one store transaction that proves B against the anchor** and seals it with a new basis,
  `carried`.

- **Re-ask.** When the proof fails, nothing is sealed. The coordinator files B's gate task normally and stops at
  `approval` with the reason in words ("`def5678` changes `src/release.ts` (release code), so this release needs your
  approval again"). When the person approves it, B becomes the new anchor. The earlier anchor and its carried commits
  stay in history.

### What a person approved, and what can't widen it

- The terms are fixed when the anchor is filed. The **carry policy itself** (protected paths, harness files, size
  limit) is a constant in the runtime doing the proof (`src/release-carry.ts`), with a version and a digest. The
  anchor's release terms store the policy version and digest. A runtime whose policy digest differs from the anchor's
  refuses to carry. A newer runtime can't quietly loosen an older approval. Tightening also re-asks, which is fine.
- The caller of a carry passes only the anchor task and the target commit. It cannot pass terms, paths, a limit or a
  scope. The carried task's scope is written **by the carry transaction itself**, copied from the anchor's approved
  scope with only the candidate and its words changed. The approved profile, route, check access and acceptance are
  copied verbatim from `approved_profile_json` / `approved_route_json`. Nobody edits the carried text, so nobody can
  widen it.
- The carry can be requested by a machine (the coordinator usually runs as the lead). Its authority is the proof and
  the anchor's person approval, never the caller. The anchor must pass `personApprovalOf`. A `lead`, `mode`,
  `schedule`, `grant` or unproven seal is never an anchor.
- `carried` is never a person. `personApprovalOf` refuses it. Release and deploy use a new reader,
  `releaseApprovalOf(store, taskId)`: a person approval of this task, **or** a `carried` seal whose carry row still
  proves against an anchor whose `personApprovalOf` still holds now.

### The carry proof (one transaction)

`Store.carryReleaseApproval({ anchorTaskId, to, facts })` in `src/store.ts`, called from
`src/release-carry.ts proveCarry()`.

**Before the transaction (facts about fixed commits, gathered with no store lock):**

1. **Verified ancestry.** Walk from B back to the anchor's approved commit A0 using commit objects that Toolroll reads
   from the project's own Git directory (as Toolroll records it, never a worktree `.git` pointer) and **hashes
   itself** (`commit-extract.ts` reader, extended with `readVerifiedCommit`). Parents come from the verified bytes.
   Replacement refs, grafts, shallow files and lazy fetch are not consulted. The walk is bounded: 200 commits and
   only first parents. **Any merge commit in the range refuses.**
2. **Chain.** The previous carried commit for this anchor (if any) must be on that walk. Dropping, reordering or
   rewriting an already-carried commit refuses, even when A0 is still an ancestor.
3. **Per-commit paths.** For each commit in A0..B, its own diff against its parent, from verified trees
   (`parseTree`): path, old and new mode, old and new blob, added and deleted lines. No rename detection, so a move
   lists both its old and its new path.
4. **Cumulative size.** Added and deleted lines and the file count for tree(A0) → tree(B).
5. **GitHub agrees.** `gh api repos/{repo}/compare/{A0}...{B}`: `status` is `ahead`, `behind_by` is 0, and the
   commit list equals the verified walk. The pull request is the anchor's number, still open, base `main`, head B.
   If GitHub and the local objects disagree, the carry refuses.
6. **Version.** `package.json` at B has the anchor's version. Any change to `package.json` re-asks anyway.

**Inside one `BEGIN IMMEDIATE` transaction:**

1. Re-read the anchor's scope and seal. `personApprovalOf(anchor)` must hold now. The approved digest must still be
   the digest, the release approval must not be revoked or expired, and the approver must be an active approver with
   access to the project.
2. The facts must name the anchor's approved commit as A0, and their tree must equal the anchor's sealed tree.
3. The runtime's carry policy digest must equal the anchor's.
4. The live release check grant (`liveVerifyCommand(repo)`) must have the anchor's id and digest, and the project's
   check access must equal what the anchor sealed.
5. Apply the rules (below) to the per-commit paths and the cumulative size. Any hit refuses, and the refusal names
   the commit, path and rule.
6. There must be no carry row for (anchor, B) yet. The unique index makes a race lose cleanly.
7. Create the carried gate task and its scope from the anchor (candidate B). Seal it with basis `carried`, with the
   authority reference set to the carry row id. Write the `release_carry` row with the facts, and a ledger row
   (`release carried`, actor = the trusted caller, outcome = B).

The facts describe fixed, content-addressed commits, so gathering them outside the transaction is safe. The
transaction binds them by commit id and re-checks everything that can change (approval, revocation, grant, policy,
earlier carries). The coordinator still re-checks the branch and pull request at every step (`pinned()`).

### The rules (carry policy v1)

A carry refuses (and the release re-asks) when any commit in A0..B does one of these:

**Touches a protected path.** Concrete set for this repository, as globs in `src/release-carry.ts`:

| Area | Paths |
| --- | --- |
| Release | `src/release*.ts`, `src/releases.ts`, `src/deploy-*.ts`, `src/commit-extract.ts`, `scripts/deploy-*.mjs`, `scripts/upgrade-path.mjs`, `.github/workflows/**` |
| Approval and authority | `src/scope.ts`, `src/approval-*.ts`, `src/person-proof.ts`, `src/chat-approval.ts`, `src/chat-decide.ts`, `src/grant.ts`, `src/modes.ts`, `src/policy.ts`, `src/batch-policy.ts`, `src/writes-mode.ts`, `src/dispatch.ts`, `src/claim.ts`, `src/work-index.ts`, `src/pull-request-flow.ts`, `src/flow-pull-request.ts`, `src/publish.ts`, `src/result-completion.ts`, `src/dispose.ts`, `src/team-chat-authorization.ts`, `src/action-ledger.ts`, `src/ledger-chain.ts`, `src/operate.ts`, `src/operate-remote*.ts` |
| The check and its receipt | `src/builder.ts`, `src/verification-evidence.ts`, `src/check-levels.ts`, `src/check-access.ts`, `src/assignment.ts`, `src/evidence.ts`, `src/contracts/verification-receipt.ts`, `src/contracts/verification-view.ts` |
| Fence and sandbox | `src/agent-fence*.ts`, `src/brief-fence.ts`, `src/containment*.ts`, `src/sandbox-*.ts`, `src/project-sandbox.ts`, `src/teardown-git.ts`, `src/git.ts`, `src/job-object-helper.ps1`, `test/attacks/**` (the attack suite guards these) |
| Credentials | `src/api-tokens.ts`, `src/tokens-cli.ts`, `src/token-notices.ts`, `src/password-bearer.ts`, `src/passwordless.ts`, `src/provider-auth.ts`, `src/oauth-run-token.ts`, `src/mcp-oauth.ts`, `src/mcp-person.ts`, `src/tool-secret-store.ts`, `src/flow-secrets.ts`, `src/envelope.ts` |
| Upgrade and migration | `src/store.ts`, `src/store-baseline.ts`, `src/*migration*.ts`, `src/toolroll-update*.ts`, `src/desktop-update*.ts`, `src/coding-update.ts`, `src/deploy-lock.ts`, `src/database-reclaim.ts` |
| Dependencies and build | `package.json`, `package-lock.json`, `tsconfig*.json`, `scripts/browser-build.mjs`, `scripts/postbuild.mjs`, `.gitattributes`, `.gitmodules`, `.npmrc` |
| Policy text | `AGENTS.md`, `SECURITY.md` |

The project's own `approval_policy.protected_paths` (Settings → Approval rules) are added to this set.
`release-carry.test.ts` checks that each listed glob matches at least one file, so a rename can't silently empty a
row. A new file whose name fits one of these areas (for example `src/approval-foo.ts`) matches the glob.

**Changes the release check or its harness.** `scripts/release-check.mjs`, `scripts/release-check-ci.mjs`,
`scripts/suite-lifecycle.mjs`, `scripts/provider-gate.mjs`, `scripts/e2e-parallel.mjs`, `scripts/e2e-kit.mjs`,
`scripts/upgrade-path.mjs`, `vitest.config.ts`, `test/attacks/vitest.config.ts`, `test/setup-state.ts`,
`test/temp-root.ts`, `test/ensure-build.ts`. Also re-asks when the live check grant changed (step 4 above).

**Is too large.** Cumulative from A0, not per commit, so splitting a change into small commits doesn't help:
more than **300 added lines** or more than **20 files** changed since the approval (decision 2). Deleted lines don't
count toward the limit.

**Changes the file kinds.** A binary file, a symlink, a submodule (gitlink), a mode change, an unnormalized path, or
a **deleted or renamed test file**. Removing a test is never carried (AGENTS.md: never delete tests to save time).

**Changes the identity.** A different pull request number, base other than `main`, version in `package.json`, a merge
commit, a force-push (A0 or an earlier carried commit is no longer an ancestor), or GitHub disagreeing with the local
objects.

**Is after merging started.** No carry once the journal has a merge intent.

**Runs under widened check access** (decision 3). If the anchor sealed check access beyond the fence ("Not
sandboxed", sign-ins), a carry refuses unless the person also approved "later commits may run their checks with this
access" as part of the release terms. That consent is a separate, visible line on the approval sheet, off by default.

### Honest limit: paths are an attention filter, not a wall

Every file in `src/` runs in the same process as the plane after deploy. A carried change to an unprotected file (say
`src/serve.ts`) could still do anything the plane can. The path rules route the code that decides authority, checks
and installs back to a person. The rest is trust in the follow-up commits on a pull request the person already
approved, bounded by size, listed in full afterwards, and reviewed by CI. That is the trade Alex asked for. It must
be said on the approval sheet ("later commits are not shown to you before they ship") and in SECURITY.md.

### When the carry applies (coordinator)

`src/release.ts`:

- `pinned()` today throws `drift` when the branch moves. It now calls `carryOrStop(newHead)` when the step is before
  `merge` and the journal has an anchor:
  - **Not approved yet** (step `gate` or `approval`): nothing to carry. The coordinator files the gate for the new
    head and asks for approval of that one. The old task's scope is withdrawn, with words.
  - **Approved:** `adapters.toolroll.carry(anchorTask, newHead)` → plane CLI `toolroll release carry <anchor-task>
    --to <sha> --json`. On success the journal records the commit list, switches `candidate`, `task` and `pr` checks
    to B, clears `check`, `completion`, `ci` (and `deploy`/`links` when A had been deployed, so B is deployed in turn),
    and goes back to `check`. On refusal it files B's gate normally and stops at `approval` with the reason.
- `begin()` writes `release: { anchorTask, approvedSha, approvalId }` once the anchor is approved.
- `ownerApproval()` gives way to `releaseApproval(gate, digest)`, which reads the plane's `release` answer:
  `{ ok: true, by, at, anchor, carriedFrom? } | { ok: false, why }`. It is computed by `releaseApprovalOf` in the
  plane (`task show --json` gains `scope.release`). The coordinator never decides carry validity itself.
- `--new` stays for "start over".
- Journal (`ReleaseJournal`, still `version: 1`, new optional fields so older journals read):
  `release?: { anchorTask: string; approvedSha: string; approvalId: number }`,
  `landed?: { sha: string; task: string; subject: string; files: { path: string; added: number; deleted: number }[]; carriedAt: string }[]`.

### What people see

- **Release summary.** The final lines of `toolroll release` and the journal list: "Approved by alex at `abc1234`
  (pull request #240). Landed after approval: `def5678` Fix the terminal test (`src/live-terminal.test.ts` +3 −1);
  `0aa1b2c` …". The same list goes into the release's GitHub merge commit body (`merge()` adapter, squash message),
  so it stays with the history.
- **Console.** The anchor task page shows **Approved for release 0.9.71** with a **Later commits** disclosure (commit,
  subject, files, +/−, and which check ran on it). A carried task page shows **Approved with release 0.9.71** with a
  link to the anchor, never as a person's own approval ("Approved by alex" alone would be false). Words come from
  `render-tasks.ts approvalProofWords` and `noteLifecycle` (one wording per basis: `carried` → "Carried from Alex's
  release approval"). A carry posts one quiet task notification (no push).
- **Stop carrying.** The anchor page has **Stop carrying later commits**: one click, any active approver,
  `toolroll release revoke <anchor-task>`. In the same transaction it sets `revoked_at` and withdraws carried seals on
  tasks with no live claim. The builder's final authority check refuses a claimed one, the same cutoff as approval-policy 2.4.
- Simplicity pass: one heading, one disclosure, one action. The approval sheet shows the terms in two short lines plus
  the risk line. The path list sits behind "What re-asks".

### Data and schema

Schema version: the next after approval-policy's migration.

```sql
CREATE TABLE release_approval (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  anchor_task     TEXT NOT NULL UNIQUE,      -- the person-approved gate task
  anchor_digest   TEXT NOT NULL,             -- its approved scope digest
  version         TEXT NOT NULL,
  pr              INTEGER NOT NULL,
  branch          TEXT NOT NULL,
  base            TEXT NOT NULL,             -- 'main'
  approved_sha    TEXT NOT NULL,
  approved_tree   TEXT NOT NULL,
  policy_version  INTEGER NOT NULL,
  policy_digest   TEXT NOT NULL,
  verify_command  INTEGER NOT NULL,          -- grant id
  verify_digest   TEXT NOT NULL,
  access_digest   TEXT NOT NULL,             -- sealed check access
  carry_wide_access INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT, revoked_by TEXT
);
CREATE TABLE release_carry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  approval        INTEGER NOT NULL REFERENCES release_approval(id),
  task_id         TEXT NOT NULL UNIQUE,      -- the carried gate task
  from_sha        TEXT NOT NULL,             -- previous carried commit, or approved_sha
  to_sha          TEXT NOT NULL,
  to_tree         TEXT NOT NULL,
  commits_json    TEXT NOT NULL,             -- [{sha, parent, subject, files:[{path, oldMode, newMode, added, deleted}]}]
  added           INTEGER NOT NULL, deleted INTEGER NOT NULL, files INTEGER NOT NULL,  -- cumulative from approved_sha
  github_json     TEXT NOT NULL,             -- compare status, ahead/behind, PR number/base/head
  runtime         TEXT NOT NULL,             -- version and commit of the runtime that proved it
  proved_at       TEXT NOT NULL,
  UNIQUE (approval, to_sha)
);
```

- `task_scope` gains `release_terms_json` (nullable). It is part of the digest when present, rendered on the approval
  sheet and validated strictly (`readScope`): known keys only, and a known policy version. The `release_approval`
  row is written by `sealScopeApproval` in the **same transaction** as a person's seal of a scope with release terms.
  No other road writes it.
- `approval_basis` gains `carried`; `mode_digest` (the authority reference column) holds the carry row id. Readers:
  `authorityStandsSql` / `modeApprovalLive` (claim and build) / dispatch / work index: `carried` stands only while
  the carry row exists, its approval is not revoked or expired, and the anchor's seal is still a person's
  (`personSealSql` on the anchor). `evidence-pack.ts`: `carried`. `personApprovalOf`: refuses `carried` (unchanged
  allowlist).
- `fileGate` (`release-adapters.ts`) passes `--release-terms` to `task scope`. The plane fills the terms from the
  pull request and the runtime policy; the coordinator can't choose them.

## Part 2 — re-run only what failed

### What a release check records today, and why it isn't enough

`evidence/<run>/` holds `verification-receipt.json` (command, exit code, log binding), `check-log.txt`, `handoff.json`,
`terminal-diff-stat.json` and others. The log is truncated: run 3238 stored 25 KB of 803 KB. It keeps the summary,
which prints only the last five matching lines per part. The first failure also stops the other parts ("stopping
other parts"): in 3237 and 3241 the unit and upgrade parts were killed (exit 143), so they never finished. Neither the
log nor the receipt can say which files failed and which parts really passed.

### A structured check report

`scripts/release-check.mjs` writes one report and prints it as its **last stdout line**:
`TOOLROLL_CHECK_REPORT <json>`, capped at 256 KiB.

```json
{ "v": 1, "nonce": "…", "head": "<sha>", "mode": "full" | "targeted", "planDigest": "<sha256>" | null,
  "selected": ["typecheck", "build", "unit", "flows", "app", "flows-real", "app-real", "upgrade"],
  "parts": [{ "label": "unit", "state": "passed" | "failed" | "stopped" | "held" | "not-run", "exit": 0, "ms": 431000 }],
  "units": [{ "file": "src/live-terminal.test.ts", "state": "passed" | "failed" | "skipped", "tests": 41, "failed": 4, "skipped": 0 }],
  "journeys": [{ "part": "app", "group": "pages", "state": "passed" | "failed" | "flaky", "journeys": [{ "name": "…", "state": "…" }] }],
  "upgrades": [{ "from": "0.9.65", "state": "passed" | "failed" }] }
```

- **Units:** vitest's JSON reporter (`--reporter=dot --reporter=json --outputFile.json=<part dir>/unit.json`). When
  units are reused from CI (`passedCandidateCI`), the report says so, with the run id.
- **Journeys:** each group's `report.json` that `e2e-parallel.mjs` already writes, read from the folder the release
  check created for this run, plus `lanes.json`.
- **Upgrades:** `upgrade-path.mjs` adds one JSON line per version (today it prints `✓`/`✗` lines).
- `state` comes from the orchestrator's own view of each part's exit (`partRunner`). `stopped` is a part killed by
  the fail-fast abort. `held` is a part not started because the build failed.

**The plane captures it** (`builder.ts`, `runVerification`) from the full stream, before the log is truncated. It
takes only the final line, parses it strictly, and stores it as a sealed artifact `check-report.json` (kind
`structured-output`, capture `machine check report v1`). The receipt binds it by digest. Belts:

- **Nonce on stdin.** For a release gate, the plane writes `{"nonce": "<random>", "plan": …}` as one line on the
  check's stdin and closes it. `release-check.mjs` reads it first and gives every child `stdin: "ignore"`, so test
  code never sees the nonce (it is not in the environment or argv, where `ps` could read it). A report without the
  run's nonce is no report.
- **Last line only.** If anything prints after the orchestrator's last line, there's no report.
- **Consistency.** Each part's `exit` must match the `<label>: exit <n>` summary line the plane also sees in the
  stream. Overall `exit 0` must agree with every part passed.
- **No report → no shortcut.** A missing, malformed or inconsistent report never fails a check that otherwise
  passed. It only means the next check is full.

Trust: the report is exactly as trustworthy as the check's exit code, which already comes from this script and the
candidate's tests. Test code in the candidate could tamper with `node_modules` and fake results today. The nonce and
last-line rules stop a stray test process from forging a report later. They don't make hostile test code safe. That
is why carried test code is limited by Part 1 (and decision 3 for unsandboxed checks).

### When a targeted re-run applies

`src/release-recheck.ts planTargetedRecheck(store, runId)`, called by the builder before it starts the check of a
release gate task. All of these must hold, or the check runs in full:

1. **Same release.** B's gate task and the earlier run A's task belong to the same `release_approval` (anchor or
   carried).
2. **A is a complete-run result.** A's receipt verifies (`verificationEvidence`), it ran under the same check grant
   (id and digest) as B, it executed (not reused), it exited non-zero, and its `check-report.json` verifies, has
   A's nonce, and is consistent. A is the newest such run for this release, and A itself is **not** targeted.
   Targeted runs never stack: C is always composed against the last full run, never against B.
3. **B−A is test-only.** From verified trees, tree(A's candidate) → tree(B's candidate), no renames. Every changed path
   is in one of these classes, decided by the **installed runtime's** rules (`src/release-recheck.ts TEST_CLASSES`):

   | Class | Paths | What re-runs |
   | --- | --- | --- |
   | unit test | `src/**/*.test.ts`, `src/**/*.slow.test.ts`, `test/attacks/**/*.test.ts` (attack tests re-ask under Part 1 anyway) | that file |
   | unit helper | `test/**/*.ts` that isn't a test or a harness file, `test/fixtures/**` | the whole unit part |
   | journey | `scripts/app-e2e.mjs`, `scripts/flows-e2e.mjs`, `scripts/flows/**` | every selected part of that script (scripted and real) |
   | journey fixture | `scripts/fixtures/**` **not** listed in `package.json` `files` at A | the unit part and every journey part |

   Anything else (any non-test file, a harness file, a shipped fixture, a deletion of a test file, a mode change, a
   binary) means the full check.
4. **A related change** (decision 6). At least one changed path is a failed unit file at A, a unit helper (when units
   failed), the journey script of a failed journey part, or a journey fixture. An empty diff, or a change unrelated to
   what failed, runs the full check. Nothing re-runs an unchanged failure until it passes.
5. **Same selection.** `planFor` at B (from B's own base tag) selects the same parts as A's report `selected`. Test-only
   changes can't move the selection (`MODEL` and `needsUpgrade` already ignore tests), so a difference means
   something is off, and the check runs in full.

### The targeted plan

The plane writes the plan, seals it as `targeted-plan.json` in B's evidence, and sends it on stdin with the nonce:

- **Re-run:** every part whose state at A is `failed`, `stopped`, `held` or `not-run` (while selected).
  - unit, failed with a complete file list → only the failed files, plus the changed unit test files, plus the whole
    unit part when a unit helper changed;
  - unit, stopped or without a file list → the whole unit part;
  - journeys → the failed or stopped **groups** (`--run-groups`), whole groups, never single journeys (decision 7);
    a changed journey script re-runs all of that script's selected parts;
  - upgrade, failed or stopped → the whole upgrade part;
  - typecheck or build failed at A → the full check (tests can't fix these: `tsconfig.json` excludes them).
- **Changed tests:** every changed unit test file, even when it passed at A.
- **Sanity pass**, always: `npm run typecheck`, `npm run build`, and a fixed list of fast unit files that open the
  store and migrate, read the CLI envelopes, compute a scope digest and run the release state machine
  (`SANITY_UNITS` in `release-check.mjs`, under a minute). The release check is a harness file, so changing that list
  re-asks. GitHub CI on B is still required before merge and runs the whole unit suite on Linux and Windows.
- **Carried forward:** every part that `passed` at A and is not in the re-run set.

`release-check.mjs` validates the plan strictly. Anything unknown makes it run the full check, which is still a valid
pass. It runs the plan's items with the same budget and fail rules, and reports `mode: "targeted"` with the plan's
digest.

### What the gate accepts

The builder seals B's receipt as **version 3** (`contracts/verification-receipt.ts`), following the version 2
`reusedFrom` pattern:

```json
{ "version": 3, "run": B, "head": "...", "base": "...", "scopeDigest": "...", "command": {…}, "result": {"configured": true, "ran": true, "exitCode": 0}, "log": {…},
  "composed": { "from": { "run": A, "receiptDigest": "…", "reportDigest": "…", "candidateTree": "…" },
                "testOnly": { "toTree": "…", "paths": ["src/live-terminal.test.ts"], "rulesVersion": 1 },
                "plan": { "digest": "…" }, "report": { "digest": "…" } } }
```

It is sealed as version 3 only when B's report has `mode: "targeted"`, the plan's digest, B's nonce, and every
planned item `passed`. Each failed unit file at A must exist at B, pass, and skip no more tests than it did at A, so
adding `.skip` doesn't pass. Otherwise it's sealed as an ordinary version 1 receipt with its real exit code. A
targeted run that exits 0 but can't be composed is recorded as **failed**, never as passed.

`verificationEvidence()` reads version 3 by re-proving everything from the store, not from the receipt's claims:

- A's receipt and report artifacts verify against their sealed bytes and digests;
- A and B are in the same release approval, and the approval still stands (`releaseApprovalOf`);
- the same check grant, unrevoked, approved before both runs started;
- the test-only proof re-derived from verified trees;
- the plan re-derived from A's report and the path list, equal to the sealed plan;
- B's report covers the plan.

Then the result's check reads `passed`, level `full`, with `composedFrom: A`. `gateStateOf` and `fullCheck`
(`release.ts`) accept it, and the summary says "full check: run A plus a targeted re-run on B (2 files)".
`deploymentCandidate` (`scripts/deploy-candidate.mjs`) and `deploymentGate` need no new rule: they already go
through `verificationEvidence`, require `exitCode 0` under the live command, and that path now validates the
composition. `release-coverage.ts` treats a composed pass like a full one.

A non-test change always gets the full check. The plane decides that before the run, from verified trees, and the
reader decides it again after the run.

### Fail-fast on release runs

Today the first failure stops every other part, so a failed run tells us little about the rest (decision 4).
Proposal: when the check runs as a release gate (the plane says so on stdin), a failure doesn't stop parts that have
already started. Parts not started yet still don't start after a failed build. A failing run takes up to the full
~11 minutes instead of stopping early. In exchange, the next run re-runs one file instead of everything.

## Files and functions to touch

| File | Change |
| --- | --- |
| `src/release-carry.ts` (new) | `CARRY_POLICY` (version, globs, harness list, limits) and `carryPolicyDigest()`; `proveCarry(store, gitDir, github, anchorTask, to)` gathers facts; `carryRefusalWords()` |
| `src/commit-extract.ts` | `readVerifiedCommit(gitDir, sha)`; `verifiedFirstParentWalk(gitDir, from, to, limit)`; `verifiedTreeDiff(gitDir, treeA, treeB)` with modes and line counts |
| `src/store.ts` | the two tables, `task_scope.release_terms_json`; `sealScopeApproval` writes `release_approval` for a person's seal of release terms; `carryReleaseApproval()` (one transaction); `revokeReleaseApproval()`; `releaseCarryOf(taskId)`; migration |
| `src/scope.ts` | release terms in the scope draft, digest and `readScope`; `releaseApprovalOf(store, taskId)`; scope words for the terms |
| `src/approval-authority.ts`, `src/dispatch.ts`, `src/work-index.ts`, `modeApprovalLive` | `carried` in the allowlist with its standing rule |
| `src/release.ts` | `carryOrStop` in `pinned()`; `releaseApproval()` replaces `ownerApproval()` for the gate; journal `release`/`landed`; summary lines |
| `src/release-adapters.ts` | `toolroll.carry()`, `fileGate` with release terms, `gateStateOf` reads `scope.release` and `checks.composedFrom`; merge body lists landed commits |
| `src/release-cli.ts` | `toolroll release carry <task> --to <sha>`, `toolroll release revoke <task>`; help text |
| `src/server/render-tasks.ts`, approval sheet | release terms, risk line, "Later commits" disclosure, carried wording, Stop carrying |
| `src/evidence-pack.ts`, `noteLifecycle` | `carried` words |
| `scripts/release-check.mjs` | stdin handshake, report, `--reporter=json`, run-to-end on release runs, plan execution, `SANITY_UNITS` |
| `scripts/upgrade-path.mjs` | one JSON line per version |
| `src/release-recheck.ts` (new) | `TEST_CLASSES`, `testOnlyDiff()`, `planTargetedRecheck()`, `planDigest()` |
| `src/builder.ts` | stdin handshake for release gates; capture the last line; seal `check-report.json` and `targeted-plan.json`; seal receipt v3 |
| `src/verification-evidence.ts`, `src/contracts/verification-receipt.ts` | receipt v3 and its reader |
| `src/assignment.ts` | `composedFrom` in the checks view |
| `AGENTS.md` (Lean verification), `SECURITY.md`, `docs/testing.md` | the targeted-release exception; the carry trust limit |

## Tests

Only what `docs/testing.md` keeps: security rules, data integrity, contracts. Attack cases go in `test/attacks/`.
Every case goes through the real road (real Git repositories, the real store, the real CLI), not a hand-made gate.
Run the AGENTS.md safety self-review before each security commit.

**Carry rules** — one table test (`release-carry.test.ts`), one row per rule: each protected area (one file from each
row), each harness file, 301 added lines, 21 files, binary, symlink, submodule, mode change, a deleted test, a renamed
test, `package.json` version bump, a protected file renamed to an unprotected path (both paths listed, refused),
a new `src/approval-x.ts` (matched), an allowed `src/serve.ts` change (carried), and each glob matching a real file.

**Attacks** (`test/attacks/release-carry.test.ts`):

1. A lead token runs `toolroll release carry` for a commit touching `src/release.ts`: refused, no seal, no row.
2. A lead token runs it for an allowed commit: carried. Proof that a machine can request but not widen. Then the same
   token tries `task scope` on the carried task: the edit unseals it (digest change) and it doesn't re-carry.
3. Force-push with the same tree on a new history: A0 isn't an ancestor, refused.
4. Force-push that keeps A0 but rewrites an already-carried commit: refused (chain).
5. A merge from main into the branch: refused.
6. Slicing: ten commits of 40 lines; the one that crosses 300 cumulative is refused.
7. Planted `refs/replace/*`, `info/grafts` and `shallow` in the shared Git directory that fake ancestry: the verified
   walk ignores them and refuses. A corrupted object refuses.
8. GitHub compare says `diverged` or lists other commits: refused.
9. Pull request closed and a new one opened from the same branch; base changed: refused.
10. The release check grant changed after the approval; check access widened in project settings: refused.
11. Anchor approved by a mode, by the lead (`lead` basis), or a legacy unproven `password` row: no anchor, refused.
12. Approver demoted, account revoked, release approval revoked, or expired: carried seals stop standing at
    dispatch, claim, build, release and deploy. Revoke while a carried build is claimed: the builder refuses.
13. Two carries for the same commit at once: one row, one task. A carry racing a revoke: one wins, never both.
14. Carry after the journal's merge intent: refused.
15. A runtime with a different policy digest: refused.
16. A carry under unsandboxed check access without the person's consent line: refused; with it: carried.

**Targeted re-run** (`release-recheck.test.ts` table plus `test/attacks/release-recheck.test.ts`):

17. B−A touches `src/foo.ts`: full check.
18. A's report missing, truncated, without the nonce, not the last line, or contradicting the summary: full check.
19. A's report claims a part passed that the summary shows `exit 1`: full check.
20. A test forges `TOOLROLL_CHECK_REPORT` lines during its run: ignored (not last, no nonce).
21. A plan file planted in the worktree's `evidence/`: ignored. The plan comes only from the plane's stdin.
22. B deletes the failed test file, or adds `.skip` to its failed test: not passed.
23. B's report leaves out a planned file or group: not passed (recorded as failed).
24. A from another release approval, or A itself targeted: not composed.
25. Empty diff, or a change unrelated to the failure: full check.
26. A unit helper changed: the whole unit part runs. A journey fixture shipped in `package.json` `files`: full check.
27. A typecheck or build failure at A: full check.
28. Receipt v3 reader: each binding broken in turn (A's receipt bytes, report digest, plan digest, tree, grant):
    `verificationEvidence` refuses, and `deploymentCandidate` refuses through it.
29. Contract: the report, plan and receipt v3 schemas (`contracts/`).

**Coordinator** (`release.slow.test.ts`, adapters faked as today): a moved branch with an allowed commit carries and
returns to `check`; a refused carry stops at `approval` with the reason; carry after deploy redeploys B; the final
summary and merge body list every landed commit and file.

## Rollout

1. **After approval-policy phase 1 merges:** rebase `release-once` on main.
2. **Phase A — the check report** (no behaviour change): `release-check.mjs` report and stdin handshake,
   `upgrade-path.mjs` JSON lines, the plane captures and seals `check-report.json`. Released through the normal gate.
   One or two real releases then produce real reports to test the planner against.
3. **Phase B — one approval per release:** schema, release terms, carry proof, coordinator, console. Codex review
   rounds until GO. Its own release is approved the old way. The first release after it is deployed uses it.
4. **Phase C — targeted re-runs:** plan, receipt v3, reader, run-to-end on release runs. Codex review rounds until GO.
5. After each phase: update AGENTS.md (Lean verification: the targeted-release exception) and SECURITY.md (the carry
   trust limit), both protected, so a person approves them.

Off switch: `toolroll release --no-carry` (per run), and a project setting "Ask for every release commit" (default
off, lowering is one click). Both only make things stricter, so a machine may set them.

## Decisions for Alex

1. **Build on approval-policy?** It provides person proofs, allowlist readers and the verified Git reader. *Recommend
   yes: rebase on main after its phase 1 merges; stack on its branch if it hasn't merged when work starts.*
2. **Size limit.** *Recommend 300 added lines or 20 files, cumulative since the approval.* (0.9.70's fix commits were
   mostly well under this; larger needs a look anyway.)
3. **Unsandboxed checks.** Carried commits run unseen test code on this Mac. With "Not sandboxed" check access that
   code runs outside the fence. *Recommend: carry under widened check access only with a separate consent line in the
   release approval, off by default. Landing the Chromium fence rule makes this moot.*
4. **Fail-fast on release runs.** *Recommend: a failure stops nothing already running on a release gate run.* Failing
   runs take longer; the next run re-runs only what failed.
5. **How long a release approval lasts.** *Recommend: until the merge, or 3 days after the approval, whichever comes
   first; Stop carrying at any time.*
6. **Targeted re-run needs a related change.** *Recommend yes:* an empty or unrelated change gets the full check, so a
   flaky failure is never retried until green.
7. **Journey granularity.** *Recommend whole groups*, not single journeys: journeys in a group depend on each other,
   and a lone retry can pass for the wrong reason (docs/testing.md).
8. **Merging main into the branch.** *Recommend re-ask* (simple, and the release needs the branch to contain main
   anyway). The alternative, allowing merges whose other parent is already on main, adds proof work for little gain.
9. **`src/builder.ts` and `src/store.ts` are protected.** They change often, so this means more re-asks. *Recommend
   keep:* they run and seal the check and hold migrations.
10. **Say it on the approval sheet.** "Later commits are not shown to you before they ship; you'll see them in the
    release summary." *Recommend yes*, plus the Later commits list on the task page.
