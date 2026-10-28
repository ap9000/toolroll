# Releases that approve themselves when green — plan

Status: plan, revision 1, 2026-10-28. Branch `auto-approve-green`, on main at `ddd8d001` (0.9.75).

## Alex's decision

Releases should not block on him. Per project, off by default: **Release approval: Ask me / Approve automatically
when checks pass**. Turned on only with a person's typed password; turned off with one click. When on, a release task
approves itself once the pull request's GitHub CI and the release check both passed on the exact candidate. He is
told ("Release 0.9.x approved automatically", then "Released 0.9.x automatically"), not asked. A red PR CI, a failed
release check, or a CI failure after the deploy still stops, tells him, and needs a person. Merges and deploys outside
`toolroll release`, and everyday work approval, are unchanged: they stay a person's.

## The setting

- Ledger row per change, newest wins (like Passwordless and batch checks): action `release approval changed`, repo,
  outcome `auto` | `ask`, actor, `before → after`. Reader `releaseAutoApproves(store, repo)`; missing, unreadable or
  any other word is `ask`. SQL twin `releaseAutoSql(repo)` for the dispatch belts.
- Turning it on is a credential act (passwordless.md closed list): an approver of that project, in a browser with a
  password typed now (or a one-use provider re-check), or `toolroll release auto-approve on --repo <p> --as --token`
  with a typed password. Never a session, a remembered login, a lead token, an API token, a mode or chat.
- Turning it off needs no password. In the same transaction it withdraws every automatic seal in the project whose
  release hasn't merged and stops (revokes) their releases — including one whose merge was reserved but never issued —
  so nothing approves on the old setting, even after it is turned on again. A merge already issued is in flight: its
  seal is withdrawn too, and it reconciles on its own — merged finishes; failed never regains the automatic approval.

## Two automatic seals, in order

Today: gate → approval → check. The check is the release task's build, which only runs on an approved scope. So with
the setting on there are two seals, both written only by the plane inside `toolroll release`, never by a command:

1. **`auto-check`** (at the approval step): "Checking automatically". It lets the release task's build run its check,
   and nothing else: it is no approval of release terms, opens no release authority, and is never a person's. It
   stands at dispatch, claim and build only while the setting is on, on a release task (candidate and release terms
   signed in), on exactly the sealed digest, with its own evidence row, and while its approver (the person who turned
   the setting on) can still approve in the project. It records the **comparison base**: GitHub's own merge base of the
   candidate with the release's base branch (`compare/main...<sha>`, read by the plane), which must be a commit in the
   project's own Git directory. Every later attempt is judged against this one base — never a task branch or a build's
   recorded base, which a preseeded branch could choose.
2. **`auto-green`** (after the check passed): "Approved automatically". Sealed in one transaction that proves
   everything again from the plane's own records and observations, records what proved it, and opens the release's
   authority exactly as a person's seal of release terms does. The coordinator then continues as after a person's yes:
   complete → quiet → deploy → link → ci → merge → tag → publish → homebrew.

The person path is untouched: with the setting off, or after any automatic refusal, the approval step waits for a
person exactly as today, and `ownerApproval` still refuses every basis that isn't a person's (`auto-*` included).

### What `auto-green` proves (all inside one write transaction)

- the setting is on, read now;
- the task is a release task: candidate and release terms in its signed scope; its digest is the one the coordinator
  filed, the scope is sealed `auto-check` on it with its evidence row, and the candidate is unchanged;
- the release check: the run is the task's builder run on that digest, its result receipt is the one the coordinator
  read, the native receipt says it ran the live approved command on that head with exit 0 and full coverage, the run's
  level is Full, and at most **two** earlier builds of the task were unsuccessful — any build that didn't finish built
  with a passed check (a failed check, no check, a failed or interrupted build) — each on this same digest (a flake
  rerun through `task regate`; the candidate and digest are pinned, so only nondeterminism differs);
- GitHub CI, read by the plane's own `gh` (system folders only, `--hostname github.com`, no caller PATH, host or config
  override) with **every attempt** (`filter=all`, all pages): every run filed under exactly the candidate, every run
  GitHub Actions, attempts grouped by job (app, check suite — one workflow run, whose re-runs stay in it — and name),
  each job judged by its **latest attempt**, which must be a completed `success` (skipped is not success, as today),
  every required check present, earlier attempts finished and at most **two** failed per job; under five minutes old;
- the change from the comparison base, read from verified objects in the project's own Git directory
  (commit-extract.ts), is confined to an **allowlist**: `src/**` (its tests included; never its test helpers or
  fixtures — `src/fixtures/`, `test-*`, `*-test-support*`, `*fixture*` — nor build or type configuration), test files
  under `test/` (`*.test.ts` only, added or modified — never a helper, fixture, setup or config file there, nor one in a
  fixtures folder; test authors are trusted, the machinery around them isn't), docs
  (`docs/**.md`, README), CHANGELOG, and a **version-only** change of `package.json` and `package-lock.json`. Every
  other path — `scripts/` (the check, the build, the journeys), the rest of `test/`, `.github/`, agent and security policy files,
  `docs/testing.md`, `docs/plans/`, configuration, dependencies — and every path the carry rules never carry needs a
  person, as do symlinks and submodules and deleting any test file (under `src/` or `test/`). Deny rules run first, so
  a test file can't carry a CI or policy path through (`test/attacks/.github/a.test.ts`). **Test infrastructure** is found
  structurally (src/test-infra.ts), at the base and at the candidate: every non-test source file the tests, the vitest
  configs or their `setupFiles`/`globalSetup` import (transitively), that the product's entry points (the CLI, the
  processes it starts by file name, the browser bundles) never reach. Imports are read with the TypeScript compiler
  (`preProcessFile`; comments never count) and the syntax tree for computed `import()`/`require()`, resolved like the
  build (relative paths, tsconfig `paths`, package.json `imports`); an import reached from the tests that resolves to no
  file and no known package refuses any change it might name (a computed one: any changed source file that is neither a
  test nor product code);
- no earlier generation of this release (repo, version, pull request) was revoked: a revoked release, or one stopped by
  a CI failure after its deploy, asks a person;
- everything a seal already checks (sealScopeApproval): no coordinator or machine-written text, no widened check
  access or sandbox, the project's approval rules for an automatic approver (protected work and the requester rule
  refuse, as they refuse a mode), the organisation policy, an exact route, and the release terms' own seal checks.

The evidence row (`release auto-approved`, outcome `auto-green`) records: candidate sha, digest, run, receipt, the
check-run ids, names and suites observed, when, the comparison base, and the earlier failures it tolerated (`ciFailures`: check-run id,
name, conclusion; `checkFailures`: failed release-check run ids). The seal's `mode_digest` is `auto:<row id>`; both the SQL
belt and the JS reader require the row to match the seal's task, kind, digest and candidate, and that no
`release auto-approval withdrawn` row names it: every automatic seal taken back is withdrawn for good.

### CI at every boundary after the seal

Workflow identity comes from GitHub's workflow-run API (`actions/runs?head_sha=`): a newer run (check suite) of the same
workflow supersedes its older runs on the commit, so a hand-run workflow that failed once and passed on a second run
doesn't veto a release; required checks must be green in their newest run, and the automatic flake cap counts failures
across the superseded runs too. GitHub lists check runs from at most the latest 1000 check suites of a commit: when the
commit has that many (`check-suites` `total_count`), or the count can't be read, an automatic approval fails closed;
a person's release is unaffected.

Every release (a person's too) judges pull-request CI with the same verdict (release.ts `prChecksVerdict`): every attempt,
exact head, required checks only from GitHub Actions, jobs by app, suite and name, each by its latest attempt — so
another app's same-name success can't hide an Actions failure. An automatically approved release also applies the flake
cap, and re-reads complete current CI immediately before the deploy, before the CLI names move, before the merge and
before the tag — on every deploy reservation, whatever the journal saved (a retry after a rollback included): anything
not green (failed, a re-run pending, past the cap, history not whole) stops it, revokes its approval and tells the owner;
the commit then needs a person. After the merge, a red CI holds the release durably in the plane (`release publish
held`): no tag, publication or Homebrew until a person runs `toolroll release publish-ok <task>` with their password
(never the lead or a token).

A failed release check (not a failed build) stops the release and tells the owner, but keeps `auto-check`, so a regate of the same commit
and digest may still approve itself within the cap. Any refusal (including past the cap) unseals `auto-check`, so the task reads "Needs your approval" with its passing check kept; the coordinator
stops at approval, says why and tells the owner. A person's yes then continues the release from the same check.

## Who accepts `auto-green`

Only the release's own readers, only inside the release flow:

- `liveReleaseOf` (dispatch, complete, deploy, merge of a release task): the anchor's approval is a person's or a
  standing `auto-green` (`releaseApprovalOf`), and an automatic one stands only while the setting is on;
- `deploymentGate` (the coordinator's own runtime) and `deploy-candidate.mjs` only with `releaseFlow`: the script
  passes it only for `--operation`, the coordinator's reserved deploy, whose secret it proves before staging. A direct
  `deploy-browser.mjs` run still needs a person's approval;
- never `personApprovalOf`, `ownerApproval`, the vote counters, `mergeAsPerson` or `mergePullRequest` (which also refuses
  any task sealed `auto-*`).

Because `auto-green` anchors a release authority like a person's yes, later test-only commits carry under it by the
unchanged carry rules (release-once.md), and only while the setting stays on.

## Trust boundaries

- The lead runs `toolroll release`, so it can start the flow but not supply its evidence: both seals are written by
  plane functions with no CLI or HTTP road, from the plane's records, its own `gh` call and its own verified Git reads.
- Build-writable data is never read for a decision: the diff is from verified objects in the recorded project Git
  directory; the receipt and level come from the plane's evidence store and ledger.
- Fail closed everywhere: an unreadable setting is `ask`; a missing or mismatched evidence row stands on nothing.

## Attack list (each has a test under `test/attacks/auto-approve-green.test.ts`)

1. A lead token (or a remembered login, an API token, an empty password) turns the setting on: refused.
2. A forged or stale CI observation: another head, a missing required check, a check named alike by another app, a
   pending, skipped or failed latest attempt, a third failed attempt, an observation over five minutes old: refused.
   One or two failed attempts before a green latest one: approved, and recorded.
3. A check on a different sha, another task's run, an earlier failed run on a different digest, or a third failed run:
   refused. One or two failed runs before a pass on the same digest: approved, and recorded.
4. The scope digest changes after the check: refused.
5. The setting is lowered mid-flight: the `auto-check` seal stops standing at dispatch, `auto-green` refuses, and an
   already approved release stops at its next step.
6. `auto-green` on an ordinary task (sealed directly, or a hand-written row): never stands, never merges by hand.
7. A branch that changes `.github/` or the check harness: refused.

## Out of scope / remaining limits

- **Product code runs inside the test process** (Alex's accepted residual): product modules load in the tests and in
  the per-file setup (e.g. `src/tool-secret-store.ts`), so an agent-written change to product code can always tamper
  with the runner. That is inherent to auto-approving agent-written `src/`; the guard is on the infrastructure that
  only tests use, not on product code.

- An OS-level process running as the user (outside Toolroll's fence) can still change `gh`'s own sign-in or the
  database; that is the accepted "remembered login" limit of approval-policy.md.
- `package.json` scripts are not treated as harness (every release bumps the version there).
