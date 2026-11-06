# Trusted release reports: one-tap release approval now, a separate gate later

Status: plan v3, 2026-11-05. Slice A revised after Codex round 2 (NO-GO as written; every finding folded in below). Built on branch `one-tap-release`, off main at `5b5681d7`.

v1 proposed letting releases approve themselves by turning `reportsProtected` into a proof. Codex round 1 was NO-GO,
with 2 Critical and 7 High/Medium findings, all checked against the code below.

**Alex's decision (2026-11-05):** one-tap approval now, a separate release gate later.

## Alex's goal, and what this plan does about it

Alex shouldn't have to babysit a green release. This plan does not make releases approve themselves; it makes the
person's approval as cheap as it can safely be:
- **one push**, at the moment the approval becomes possible;
- **one screen**, showing what is being approved;
- **one proof**, unchanged;
- **CLI parity**, with no copying of task ids or digests.

## What is true today (with file:line)

**When the approval happens.**
- The person's yes comes **before** the release check. The check is the release task's build, and a build runs only
  on an approved scope (release.ts:964-1011, then `check` at :1012).
- A release filed while PR CI is still running asks the person **at once**. It says "GitHub's checks are still running;
  nothing deploys until they pass" (release.ts:940-950, :998-1001; release-ci-hold.ts:40). Deploy, merge, tag and
  publish each re-read exact-head CI.
- Once the person has said yes, nothing else needs them unless something fails. Failures already send an attention
  push.
- So "approve early and walk away" already works. What is missing is being told at the right moment, and a fast way
  to do it.

**Why the approval can't wait until after the Full check on Toolroll.** Toolroll's own project runs its checks
unsandboxed (check-access.md:27, :114). An unsandboxed check runs the candidate's code with Alex's full access to the
machine. That is exactly what a person's yes authorizes, so the check stays after the yes. "Check first, then one
tap" becomes possible only with H3 (a sandboxed check, measured first).

**How Toolroll tells people today.**
- **Push.** Notifications enter through `store.enqueueNotification` (store.ts:2588). The push carries a **fixed phrase
  per closed class** (`decision`, `pick`, `merge`, `attention`, `progress`) and a link that is checked against a
  pattern (push.ts:223-243). No version, branch or title ever reaches Apple's or Google's servers.
- **Needs you.** A task awaiting its scope approval is "Needs your approval", action `approve-scope`
  (dispatch.ts:412; needs-you.ts).
- **The release card.** `releaseCardOf` already turns a release's terms and its change list since the last release
  into one card, with a `cardDigest` that a tap must match (release-card.ts:1-16, :267). Chat approves releases from
  it (chat-decide.ts:859-881).
- **CLI.** It prints `toolroll task approve <id> --digest <digest>` (release.ts:989), which has to be copied by hand.
  The CLI can already ask for a password without echoing it (operate.ts:11096-11110 `askCredentials`/`askHidden`).

**What proves the person today** (`approve`, scope.ts:1517 onward; Codex round 2 corrected this list). Slice A keeps
all of it unchanged and adds no proof:
- a password typed now (`password-now`);
- an explicit, unconsumed identity-provider re-check made on request (`sso-now`, one step-up, five minutes,
  scope.ts:1250-1330);
- with Passwordless on, the person's live signed-in browser session (`session`), under its existing conditions;
- at this computer's CLI, its remembered login (`cli-login`, under Passwordless only), read through `askCredentials`
  and its command context (operate.ts:11096), never reconstructed;
- a remembered password or re-check (`fresh-password`, `fresh-sso`): local, time-limited, and only where
  `freshlyApprovable` says so (scope.ts:1640). Escalated, protected or coordinator-filed terms take a password typed now;
- project rules, the organisation policy, CI holds and the release seal checks are all re-checked at the seal
  (scope.ts:1573-1581).

What does **not** approve a release, and stays so:
- **the local owner** of a laptop install, even typing a password into that session: releases need the existing
  full-sign-in transition (`localApprovalEligible` refuses `release`, scope.ts:2127; the local-owner prover decides
  first, scope.ts:1345);
- machine credentials (a lead token, a remote API token): `machine-proof`;
- paired chat stays its own ceremony (the release card with Continue then Approve), unchanged.

**Carrying later test-only commits** (`toolroll release carry`, release-cli.ts:60-63) needs release terms. Terms need
a sandboxed check, or "unsandboxed carry", which stays off (release-carry.ts:161). So on Toolroll today **every new
commit asks again**. Carrying becomes available with H3.

**Automatic approval stays refused for three independent reasons.** All three stay in place.
1. The `reportsProtected: false` constant (release-adapters.ts:399-402, :920-948).
2. Automatic seals are refused on scopes wider than sandboxed (store.ts:9168-9180).
3. There are no release terms without a sandboxed check (release-carry.ts:161; operate.ts:10553-10561).

## Slice A: one push, one screen, one proof (ships first, alone)

Slice A v3 (after Codex round 2: NO-GO as written, 7 findings plus the proof inventory above, all checked against the
code; see the table at the end of this section).

**A1. One card, both sealed forms.** Toolroll's own releases seal the release-check *purpose* (`releaseCheck`), not
release terms: its checks run unsandboxed, so terms can't be made (operate.ts:10553-10561, release-carry.ts:161).
- The card reads whichever the scope sealed (`releaseTerms` or `releaseCheck`); the identity both share is the
  repository, version, branch, pull request, base, approved commit and tree, grant and check access.
- The full terms list every field of the sealed form, each with a label (a contract test holds both schemas' leaves
  to the labels), never "none" for a purpose that is there.
- Before consent the card says what an unsandboxed check means: "The release check runs this commit's code with full
  access to this computer." (sign-ins: "with your sign-ins").
- **Verified release history is defined apart from carrying.** The baseline is the newest of: a merged release
  authority's succeeded merge (today's record, for terms), or a *verified release* row the coordinator records once
  the merged tree was proved equal to the approved one (the tree step). The plane re-reads the merge commit as a
  verified Git object from the project's own Git directory and requires its tree to equal the sealed approved tree
  before writing the row. Nothing else (a tag, a ref, a journal) counts.

**A2. The change list is complete and bound to the candidate, or says it isn't.**
- With a verified baseline: every commit from the baseline to the approved commit, as verified Git objects (as today).
- With none: the pull request's commits from GitHub, **paginated**, accepted only when GitHub's pull request head is the
  approved commit, the newest listed commit is the approved commit, and the count equals the pull request's own commit
  count (GitHub lists at most 250: more is "incomplete").
- Anything short of that is said: "couldn't be read" or "incomplete (N of M)". Never a shortened list.
- Commits only. The file list is dropped (`ChangeList` has no source for it that is bound to the candidate).

**A3. Subjects are display text, made safe.** Commit subjects are cleaned once, at ingestion, by the terminal
sanitizer (src/terminal-text.ts: escape sequences, C0/C1 controls, carriage returns, bidi and format characters,
OSC-8 hyperlinks) and bounded. The digest binds the cleaned text, so every surface shows what was bound. Browsers also
escape it as text.

**A4. The card snapshot and one shared approval wrapper.**
- The card snapshot binds the scope digest, the plan form digest, the baseline and change list, **the CI snapshot**
  (state; each check run's id, status and conclusion: a new attempt is a new id), and **the refusal state** (CI failed,
  a check already failed, a CI hold, already approved, the scope changed). Its digest is the card digest.
- `approveReleaseCard` is the one wrapper the sheet and the CLI call: rebuild the authoritative card; compare the
  submitted card digest; then, in one transaction, re-read the store parts (scope digest, CI snapshot, refusal state)
  and refuse on any change; then pass **that snapshot's scope digest** into the unchanged transactional `approve()`.
  The digest is never swapped after prompting: a change refuses and the person reads the new card.
- Proofs are `approve()`'s, unchanged (above).

**A5. When the person hears, and the notification's whole life.**
- **Asked:** on entering the approval step (fresh filing *or* a resumed gate), the coordinator asks the plane to file
  one notification keyed by the task and the **stable scope digest** (`release-ready:<task ref>:<scope digest>`). A
  crash between filing and asking is healed on the next run, which enters the approval step again. The automatic road
  (off today) skips it.
- **Retired:** the seal resolves the task's `release-ready` rows (any road: sheet, task page, CLI, chat), so a push
  not yet delivered is never sent after the approval; asking for a new task or digest resolves every older
  `release-ready` row of the project; and the push pass re-proves the row (below) and resolves an obsolete one
  instead of sending it.
- **Stops:** a manual release that stops (CI failed, the check failed, the deploy, merge, tag or publication failed,
  or it stopped waiting) files one deduplicated attention notification (`release-stopped:<task>:<step>:<reason>`) with
  the stop's words in the app and the fixed attention phrase in the push. The automatic road keeps its own notices.

**A6. The push.**
- Push words: the fixed phrase "A release is ready for your approval". The row is stored with the existing
  `decision` class (no schema change). The `release` class and its link are **derived at send time from the plane's
  own state**: the row is a `release-ready` row, its task ref is a release scope (terms or purpose, with a candidate),
  not approved, and its scope digest is the row's. Never from a title, a task id prefix or the stored link. Anything
  else is sent as `decision` to `/next`, or retired when obsolete.
- The link is an opaque locator, `/approve/<task ref>` (a machine number: no version, commit or branch). Both
  allowlists take it (push.ts `LINK_SHAPES`, the service worker in pages-assets.ts). An older installed worker sends it
  to `/next`, as today.
- `/approve/<n>` resolves the task ref through the console's project admission (a new `task-ref` resolver) and the
  person's project access, proves it is a release scope from the plane's state, and only redirects (303) to the sheet.
  A push GET never approves.

**A7. The sheet** (`/t/<id>/release`, one screen):
- **Status:** "Release 0.9.x is ready for your approval", or why it can't be approved now (shown, not hidden).
- **CI:** GitHub CI as the coordinator last read it on the exact commit: passed / running (n of m finished) / failed
  (names) / not read yet.
- **What approving does:** "Approving runs the release check on abc1234, then deploys, merges, tags and publishes once
  GitHub CI and the check pass." Then the unsandboxed sentence, and whether later commits carry (on Toolroll today:
  "Every later commit asks again"). When the release isn't running: "The release isn't running: after you approve, run
  `toolroll release <branch>`."
- **What changed** (folded) and **every term** (open, before the button).
- **Approve release:** one button; the existing approval POST (`/t/<id>/approve`, cookie only, step-up, project and
  role checks, CSRF, the browser mutation key, the single-use person/task/digest nonce) with `sheet=release`, bound to
  the card digest. A changed card refuses and the sheet shows the new one.
- Proof as today. Under Passwordless a live session is one tap; otherwise one typed password.

**A8. CLI parity: `toolroll release approve [<branch>] [--repo <path>]`.**
- Journals are discovery only, read strictly (exact fields and shapes; the file name must be the one the journal's own
  branch maps to), at the approval step.
- The requested branch must equal the journal's branch **exactly** and the plane's sealed release identity (branch,
  version, pull request, candidate, scope digest), and the journal's checkout, the task's project and the sealed
  repository must be the same real path (`realpath`), and `--repo` too when given. `feature/foo` and `feature_foo`
  never match each other. Two candidates name both and ask for the branch.
- It prints the card (control-free), asks through `askCredentials` (or its remembered login, under its existing
  conditions), then **rebuilds the card after the password prompt** and refuses if it changed; then the shared wrapper.
  It never re-reads a changed journal to approve another target.
- `--json` never prompts: without a credential it refuses with the card; with one it needs `--digest <card digest>`.

**Tests (Slice A).** Unit and attack tests for: both sealed forms on the card (every field labelled, the unsandboxed
sentence); verified history; pagination, head mismatch, count mismatch, more than 250; ANSI, `\r`, bidi and OSC-8
subjects in the terminal and browser output; the wrapper refusing a changed scope, CI attempt, refusal state and a
stale card, and approving with the snapshot's scope digest; the proof matrix (password, sso-now, Passwordless session,
remembered password on escalated terms → `password-now`, local owner refused, lead and API tokens refused); the
notification lifecycle (one per task and digest, the crash boundary between filing and asking, approval before
delivery sends nothing, supersession, stops); the push payload (fixed phrase, `/approve/<n>`, a fake release-named task
gets `decision` and `/next`, an existing worker's allowlist); the locator (another project's task, a non-release
task); `release approve` (finds the task, digest mismatch refuses, `--json` without a credential refuses, two releases
named, the slash/underscore collision, a changed card after the prompt refuses). One scripted journey opens the sheet
at desktop and phone: long changes, CI not read, a stale approval, an expired sign-in, reconnecting, the password
keyboard.

**Codex round 2 findings, checked and where each lands.**

| # | Finding | Checked | Where |
|---|---|---|---|
| 1 H | The card omits the purpose Toolroll uses; baseline only from authorities | yes: operate.ts:10553, release-card.ts:143, :267, store.ts:9261 | A1 |
| 2 H | `cardDigest` doesn't bind CI or refusal state; `approve()` takes a scope digest | yes: release-card.ts:254, scope.ts:1555, tasks.ts:2503 | A4 |
| 3 M | Push link carries version and SHA; the worker rejects it | yes: release.ts:456, push.ts:245, pages-assets.ts:48 | A6 |
| 4 M | Journal names collide; `readJournal` checks little | yes: release.ts:431, :448 | A8 |
| 5 M | No lifecycle: crash between filing and asking, obsolete sends, stops | yes: release.ts:933, store.ts:15352, release.ts:1313 | A5 |
| 6 M | Fallback change list unpaginated, not bound to the candidate; no file source | yes: release-card.ts:212, :234 | A2 |
| 7 M | Terminal spoofing through commit subjects | yes: release-card.ts:208, :263 | A3 |
| P | Proof inventory: sso-now, session/CLI conditions, local owner, machines, chat | yes: scope.ts:1250, :1345, :2127 | Proof list above |

## Hardening slices (each justified on its own merits, none enables automatic approval)

**H1. Isolate every phase of GitHub CI that runs candidate code.**
- *Why on its own:* today any pull request's code runs as `runner`, which has passwordless sudo, in every job.
  - It can read the job's runtime token and overwrite another job's artifact (`overwrite: true`, ci.yml:88-97).
  - It can rewrite reports or `node_modules`.
  - It can do this **during the build**, before any test runs. The unchanged build runs Tailwind over
    `src/browser/tailwind.css` (scripts/browser-build.mjs:78), and a CSS `@plugin` loads local JavaScript.
  - `npm ci` lifecycle scripts run as well.
- *What:*
  1. `npm ci` (with `--ignore-scripts` where the lockfile allows), `npm run build`, the typecheck and the tests all run
     as an unprivileged user with no sudo, started by a base-revision runner script. That user has an explicit
     supplementary group list, no access to credential files, and a scratch HOME, cache and temp folder.
  2. Exact ownership exceptions for Git are written down (the git lanes' `runuser -u node` gives the checkout to
     `node`, ci.yml:465; this design doesn't).
  3. Results travel on fd 3, and are converted on the trusted side into the verifier's JSON format.
  4. Every process of that user is killed afterwards, and a failed cleanup fails the job.
  5. **A canary runs inside every hardened job**, not in a separate one. It tries to write the harness, read the
     token, sudo, signal the runner and outlive the step, plus the `@plugin` and lifecycle-script routes.
  6. Jobs that need root (cgroup lane, Linux fence lane, Windows Job Object) run in **separate workflow runs**, not
     just separate files: reusable workflows keep the caller's context.
  7. Artifacts get attempt-specific identities.
  8. The same change goes everywhere the job names are listed: `REQUIRED_PR_CHECKS_WORKFLOW` (release.ts:66),
     scripts/release-proof.mjs:24, publish.yml:44, main-push.yml and nightly.yml (which calls ci.yml and
     release-candidate.yml together, nightly.yml:18-24).
  9. The existing event and SHA checks stay as they are.
- *Order:* demonstrate on both hosted OSes on a branch before the release that ships it. That release needs a person
  (it changes `.github/` and `scripts/`).

**H2. An explicit, versioned execution stamp for every check.**
- *Why on its own:* `runCheckAccess` reads a missing or unreadable stamp as "sandboxed" (store.ts:23773). Nothing
  records which fence policy actually ran, and the fence grants the checkout, Git data and a persistent cache
  (agent-fence.ts:492).
- *What:* each check run records `{ version, level, policyDigest, writable[], readable[], network }` as enforced at
  launch. Anything that relies on how a check ran (carry, the result page, the card's "Checks:" line) requires a
  current-version stamp. A missing or old one reads as "unknown" and refuses where it matters, never as sandboxed.

**H3. A sandboxed local Full check for Toolroll, measured first, with a defined fallback.**
- *Why on its own:* it keeps unreviewed candidate code away from the plane's database, evidence and credentials on
  Alex's Mac. It makes release terms possible, so later test-only commits carry under one approval ("approve this
  release and any later commit that only changes tests, docs or the changelog"). It also allows "check first, then
  one tap": with a fenced check, a check-only seal can run before the person's yes.
- *Measure:*
  1. Write the missing fenced-run harness (check-access.md:154 names `fenced-run.mjs`, which doesn't exist in this
     checkout).
  2. Run Toolroll's Full check at `sandboxed` and at `sign-ins`. Sign-ins is available now (check-access.ts:73
     `SIGN_INS_READY = true`; v1 called it off, which was wrong).
  3. List every skip. Known ones: tests that create sandboxes, and Keychain tests (tool-secret-store.test.ts:33-35).
     PTYs and headless Chromium already have fence allowances (sandbox-runtime.ts:113, :155).
- *Skips:* a case skipped locally counts as covered only if the **same case** passed in the exact macOS CI attempt on
  that commit, matched by case identity, or it is on a short, reviewed exemption list. Being in the same file is not
  enough. A file is present in the Mac lane even when its case is skipped there (ci-shards.mjs:121, :205).
- *Fallback, defined:* if the sandboxed check can't cover everything, the release scope seals the wider level the
  measurement shows it needs. For example, `sign-ins` for real-model journeys, or `unsandboxed` as today. The card
  says so, and that release takes the person's yes as it does today. A fallback never runs wider without that.

**H4. Test-integrity rules that carrying relies on.**
- *Why on its own:* carrying (H3) ships test-only commits under one approval, so those commits must not be able to
  disarm existing tests.
- *What:*
  - **existing test files stay unchanged**; new tests go in new files. This replaces the append-only rule, which
    `vi.mock` hoisting and top-level hooks defeat;
  - no test file imports another test file (test-infra.ts:260 treats test files as never infrastructure);
  - the v1 tamper scan stays as a heuristic over changed expressions (arguments and bindings, not just counts).
    First measure its false-positive rate over the last 30 releases.

## Later: a separate release gate (preconditions only)

Automatic approval can be considered only once the thing that grants approvals is outside what a product release can
change. Codex round 1 (finding 1, Critical) showed that pinning selected files can't do it:
- protected code imports unprotected code (agent-fence.ts:40 → sandbox-runtime.ts; commit-extract.ts:16 →
  teardown-git.ts; scope.ts:1874 re-exports person-proof.ts);
- Store helpers such as `approvalGate` (store.ts:9851) stay changeable;
- other product code can write the approval tables. The SQL tripwire covers routing tables only (route-hooks.ts:93).

Preconditions:
1. **A separate authority process with its own storage.** Approval seals, release authority and the evidence it
   relies on live behind a process and data boundary. The product's code, migrations and database connections can't
   write them.
2. **A separate update path.** The gate's code and configuration are installed and updated on their own, by a
   person, never by a product release. Their whole dependency closure, loaders and migrations included, is pinned by
   digest.
3. **A narrow API.** The gate accepts only facts it reads itself: GitHub over its own credential, verified Git
   objects, and a check receipt carrying an H2 stamp and H1/H3 isolation. It never takes a product-written row.
4. **H1, H2, H3 and H4 shipped and measured.**
5. **Only then** can `reportsProtected` become a derived property, read by the gate and never by the product.

**R1, stated honestly (Codex finding 3).** Even with all of this, test *results* are influenced by the candidate.
- The candidate's code runs inside the processes that produce them.
- An authentic exit status proves the process tree ended with 0. It doesn't prove the assertions ran.
- A forged report that hides a required refusal is an authorization bypass, not a harmless omission.
- Isolation protects the *transport* of results, not the results.
- Automatic approval would therefore mean accepting that agent-written code doesn't deliberately fake its own tests.
  That decision is Alex's, to make when the gate exists, not now.

## Codex round 1 findings: checked and where each lands

| # | Finding | Checked | Where |
|---|---|---|---|
| 1 C | G3 can't protect the dependency closure | yes: agent-fence.ts:40, commit-extract.ts:16, scope.ts:1874, store.ts:9851, route-hooks.ts:93 | Later gate, precondition 1-2; auto stays off |
| 2 C | Candidate code runs during the build (Tailwind `@plugin`) | yes: browser-build.mjs:78 | H1 (build and lifecycle phases, canary) |
| 3 H | "Reports only refuse" isn't a security argument | agreed | R1 wording above |
| 4 H | Weak execution receipt | yes: store.ts:23773, agent-fence.ts:492 | H2 |
| 5 H | Tripwire misses edits; suffix rule doesn't close hoisting | agreed; test-infra.ts:260 | H4 (existing files unchanged, no test-to-test imports) |
| 6 H | Mac lane membership isn't case coverage | yes: ci-shards.mjs:121, :205 | H3 skip rule |
| 7 H | Moving to another file isn't isolation | yes: nightly.yml:18-24, release-proof.mjs:24, publish.yml:44 | H1 (separate runs, every place listed) |
| 8 M | Canary per job, groups, ownership, report conversion | agreed; ci.yml:465 | H1 |
| 9 H | Sign-ins isn't off; fenced-run.mjs is missing; fallback undefined | yes: check-access.ts:73 | H3 |
| 10 L | Ship a one-approval road first | agreed | Slice A |

## Order

**Slice A** comes first, on its own. It is product code only (plane, console, CLI), with no change to proofs or to the
automatic road, and its release takes a person's yes as usual. After it: **H1**, **H2**, **H3** (measurement first),
**H4**, in that order; each one stands alone. The gate is later and unplanned.

## Open decisions

1. **One push per release at filing, no reminder.** Recommend yes. A stop now files its own attention notice (A5).
2. **New push class `release`, or reuse `decision`.** Taken in v3: `release` is a push class derived at send time from
   the plane's state, stored as `decision` (no schema change); the fixed phrase says "release" and leaks nothing.
