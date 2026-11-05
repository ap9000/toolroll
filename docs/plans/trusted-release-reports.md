# Trusted release reports: one-tap release approval now, a separate gate later

Status: plan v2, 2026-11-05. Branch `trusted-release-reports`, off main at `5b5681d7`. Docs only.

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

**What proves the person today** (`approve`, scope.ts:1517 onward). Slice A keeps all of this unchanged:
- a password typed now;
- with Passwordless on, the person's live signed-in browser session (scope.ts:1382-1383);
- at this computer's CLI, its remembered login (`cli-login`, scope.ts:1376-1377);
- a remembered password only for everyday terms (`freshlyApprovable`, scope.ts:1640). Escalated, protected or
  coordinator-filed terms take a password typed now (scope.ts:1584-1587);
- project rules, the organisation policy, CI holds and the release-terms seal checks are all re-checked at the seal
  (scope.ts:1573-1581).

**Carrying later test-only commits** (`toolroll release carry`, release-cli.ts:60-63) needs release terms. Terms need
a sandboxed check, or "unsandboxed carry", which stays off (release-carry.ts:161). So on Toolroll today **every new
commit asks again**. Carrying becomes available with H3.

**Automatic approval stays refused for three independent reasons.** All three stay in place.
1. The `reportsProtected: false` constant (release-adapters.ts:399-402, :920-948).
2. Automatic seals are refused on scopes wider than sandboxed (store.ts:9168-9180).
3. There are no release terms without a sandboxed check (release-carry.ts:161; operate.ts:10553-10561).

## Slice A: one push, one screen, one proof (ships first, alone)

**When.** At the gate step, right after the release task is filed (release.ts:954-962). That is the moment a person's
yes becomes possible. One notification is sent per task and digest (dedupe key `release-ready:<task>:<digest>`).
- No reminder follows.
- A refusal or failure later sends the existing attention push.
- A new commit files a new task, so it gets its own notification.
- With automatic approval on and working (not today), this notification is skipped.

**What the push says.**
- A new closed class, `release`, with one fixed phrase: "A release is ready for your approval."
- Its link is the task's approval sheet, `/tasks/<id>/approve`, added to the push link patterns.
- Nothing about the release itself travels through the push service.
- The in-app notification and the Needs you item carry the words that depend on the state:
  - CI still running: "Release 0.9.x (abc1234) is ready to approve. You can approve now and walk away: Toolroll runs
    the release check after your yes, and deploys, merges and publishes only once GitHub CI and the check pass. You're
    told only if something fails."
  - CI already green: "GitHub CI passed on abc1234. Approve to run the release check, deploy, merge and publish."

**The sheet** (`/tasks/<id>/approve`, one screen, also the target of the Needs you item for a release task):
- **What:** version, pull request, branch, the exact commit, the check access line ("Checks: not sandboxed"), and
  whether later test-only commits carry the approval ("No: every new commit asks again" on Toolroll today). All of it
  comes from `releaseCardOf`.
- **What changed:** the change list since the last verified release (`releaseChangeList`). Commits and files are
  folded, with a link to the full terms.
- **Checks:** PR CI right now (passed / running, with the count / failed, with names), read by the plane. The release
  check: "runs after your yes".
- **Approve:** the existing approval ceremony, bound to `cardDigest`. If anything shown changed, Approve refuses and
  the sheet reloads. Proof is as today (above). Under Passwordless a live session is one tap; otherwise one typed
  password. Nothing here widens what any proof can approve.
- **Refused states are shown, not hidden:** CI failed, a check already failed, the scope changed, or a CI hold from an
  older coordinator.

**CLI parity: `toolroll release approve [<branch>] [--repo <path>]`.**
- It finds the release's own journal for the branch (the running or saved release), reads the task id and scope
  digest from it, and checks them again against the plane (`toolroll.gate`: same candidate, same digest, not yet
  approved).
- It prints the same card in the terminal: version, PR, commit, CI right now, the change list, the check access.
- It asks for the password without echoing it (`askCredentials`), or uses the remembered login where Passwordless
  already allows it. It never needs `--token` on the command line.
- It then calls the same `approve` path with the card digest.
- If more than one release could match, it names them and asks for the branch.
- `--json` answers with one envelope, and never prompts.

**Tests (Slice A).**
- Filing sends exactly one `release` notification. The push payload holds only the fixed phrase and the sheet link.
  The inbox body names the CI state.
- A refile after a resume sends nothing new; a new candidate sends a new one.
- The sheet's Approve with a stale `cardDigest` refuses.
- Each proof case gives the same answer as today's task page:
  - a typed password approves;
  - under Passwordless, a live session approves;
  - a remembered password on escalated terms is refused with `password-now`;
  - a lead token, an API token or chat are refused here.
- Approving while CI runs: nothing deploys until CI passes (existing release tests, extended to the sheet).
- `release approve`:
  - finds the task for a branch;
  - refuses when the journal's digest differs from the plane's;
  - refuses `--json` without a credential;
  - with two releases open, names both;
  - does not echo the password.

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

1. **One push per release at filing, no reminder.** Recommend yes. The attention push still covers every failure.
2. **New push class `release`, or reuse `decision`.** Recommend a new class: a fixed phrase that says "release" makes
   one tap obvious on the lock screen and still leaks nothing.
