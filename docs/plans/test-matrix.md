# The test matrix: each test once, where it adds something

Status: built for 0.9.80 (branch `test-matrix`). The owner approved the direction 2026-10-30 ("no unnecessary tests");
Codex's critique of the first draft changed it, and this is the revised matrix. One thing is the owner's to do before
it holds: add the required checks listed under "Owner action" to main's branch protection.

## Why

A normal product change ran the full unit suite about seven times: pull-request CI (Linux Node 22/24, macOS Node
22/24), the Mac release check, the tag's Publish workflow (macOS Node 22/24, 43–58 minutes, twice over its 45-minute
limit) and main's push CI again. Running the same tree again proves nothing new. Different Node versions, operating
systems and native facilities do, so those stay — but each once, at the right stage.

## Stages

| Stage | Runs | Doesn't run |
|---|---|---|
| Pull request | Node 24 unit shards on Linux and macOS. Area lanes: Windows Job Object, Linux fence, Linux cgroup, git 2.41 and 2.47 | The area lanes on a documentation-only pull request (see below). Node 22 |
| Release candidate (a `release-*` branch's pull request) | Everything a pull request runs, plus Node 22 unit shards on Linux and macOS, on the exact candidate | — |
| Owner's Mac (release check) | Unchanged: the full unit suite locally, scripted journeys, real-model journeys when model-facing code changed, the upgrade path when its rule says so. Native attacks must run | — |
| Tag / Publish | The release proof (below), then npm publish with provenance and the GitHub release | Any test. The two tag macOS legs are gone |
| Push to main | Typecheck and build; a proof that the merge commit is a tested pull request's head tree | The full CI, unless that proof fails: then it runs whole |
| Nightly (main) | Everything: Node 22 and 24 on Linux and macOS, every area lane | — |

The owner-Mac release check keeps its full unit run. Hosted macOS can't stand in for the owner's machine (its kernel,
Seatbelt, DNS services, file permissions and launch environment); the macOS 26.5 `mach-lookup` failure in
`test/attacks/fence-keychain.test.ts` is the reminder. Nothing reuses CI results for it.

## Documentation-only pull requests

The only change that skips anything: a pull request, from a branch not named `release-*`, whose diff from its merge base
only adds or modifies Markdown files under `docs/`, `CHANGELOG.md` or `README.md`. A rename, copy, deletion or type
change, any other file, an empty diff, or a diff that can't be read whole runs every lane. The trusted base revision's
`scripts/ci-scope.mjs` decides, in the always-running `area lanes · scope` job; each lane runs unless that job succeeded
and said `docs-only`, so a failed decision runs everything.
If the base has no classifier, every lane runs; the candidate never supplies that decision. The classifier reads
through the shared hardened Git view (no repository config or replacement objects) and detects copies from unchanged
files too.

A spared lane reports **skipped**. GitHub's branch protection reads a skipped job as passing, so the pull request can
merge. The release gate never accepts a skipped check (`prChecksVerdict`), so a skipped lane can never count for a
release: a release candidate is a `release-*` branch, which always runs every lane. (A job that "succeeds" saying "not
applicable" would look identical to an executed one in GitHub's check API, so skipped is the honest record.)

## Node 22

Node 22 is the supported floor (`engines`). A product change can use something Node 22 lacks without touching
dependencies, and types come from Node 26, so typecheck doesn't catch it. So Node 22 runs the full suite on Linux and
macOS once per release, on the exact candidate, in `release-candidate.yml`, on a pull request from a `release-*` branch.
On every other pull request its jobs report skipped. To run it on demand, run Nightly by hand on the branch: its checks
carry `nightly floor / ` in front, so they never stand in for the required ones (a run by hand of the release candidate
workflow itself would report the required names from a run the release gate binds to no pull request, which it
refuses, so that workflow has no manual trigger). Its required names (`node 22 · ubuntu-latest`, `node 22 · macos-latest`) stay in `REQUIRED_PR_CHECKS`,
mapped to that workflow, so a release can't proceed without them executed on its exact head.

## Native attacks fail closed

The hosted unit shards run with `TOOLROLL_REQUIRE_NATIVE=darwin` (macOS) and `linux` (Linux, where bubblewrap is
installed), as the Linux fence lane already did: a native attack whose facility is missing fails instead of skipping.
The shards' verifier (`scripts/ci-shards.mjs --native`) agrees: a test file whose base copy can skip only through that
platform's native probe (`needs(ctx, seatbelt())` or `needs(ctx, osFence())` on macOS; `osFence()` on Linux) may not
report a skipped test at all. Checked against 0.9.79's real shard reports: hosted macOS ran every Seatbelt case and
Linux every bubblewrap case, so no file needs an exemption. Codex's sandbox (not installed on hosted runners) and
other-platform cases still skip, as before.

## Publication's release proof

The tag's macOS legs are removed only together with a proof step that gates publication. The `release proof` job in
`publish.yml` reads GitHub's API with its own read-only token and refuses unless:

- the tagged commit is on main, is the recorded merge of exactly one pull request into main, and has the squash
  shape: one parent already in the tested head's history, with exactly one new commit beyond that history;
- that pull request's head commit has the same tree;
- for each required check, the newest GitHub Actions run of its workflow on that head, for that branch in this
  repository, from its pull request (`ci.yml`, and `release-candidate.yml` on the `release-*` branch), is complete and
  shows exactly one job of that name that concluded `success` no later than the merge. The run's PR binding must name
  that exact PR, head and main repository, and its timeline must show no base retargeting. Skipped, failed, cancelled,
  missing, duplicated or unreadable: no publish.

The proof reads every page of PRs, workflow runs, jobs and timeline events, and re-reads the newest runs after reading
their jobs: a changed run or attempt refuses the proof. Jobs come only from the newest run's exact latest attempt;
a partial rerun that omits a required lane is refused, so rerun the full workflow when necessary. A workflow path may
include GitHub's `@ref` suffix. Main-push uses the same proof and runs full CI on any refusal.

Both publishing checkouts explicitly pin the event SHA. The proof checks the current remote tag, and the publisher
checks it again after building, immediately before npm publication and again before creating the GitHub release.
Annotated tags are peeled to their commit; a missing, moved or unreadable tag refuses publication. GitHub and npm
cannot participate in one atomic transaction: immutable release-tag rules are still needed to prevent someone moving
a tag after the last read. The workflow and proof source remain repository policy; an actor allowed to replace those
guards or bypass their review is outside the proof's trust boundary.
This attests the commit graph and tested tree, not which merge button was clicked: a one-commit rebase producing the
same graph cannot be distinguished from a squash by these records. CI and release-candidate tokens explicitly have
only `contents: read`; only the publish job receives write and OIDC permissions.

The list it checks is in `publish.yml` and must equal `REQUIRED_PR_CHECKS` and its workflows (`src/ci-workflow.test.ts`
pins them equal). `RELEASE_TAG_CHECKS` is now `release proof` and `publish`.

This proves what GitHub recorded, not that the tests were honest: test code still runs on the candidate and could write
its own report (isolated-checks stage 3). It also relies on main's branch protection requiring every one of those
checks, so nothing merges without them. `toolroll release` now refuses to merge — and so to tag or publish — while
main's protection doesn't require every `REQUIRED_PR_CHECKS` name (`PROTECTION_REPORT_ONLY_CHECKS` is empty), naming
what's missing.

## Push to main

`main-push.yml` (its own workflow, so its runs never supersede or stand in for `ci.yml`'s) typechecks and builds, and
runs the same proof with `ci.yml`'s part of the list. Proven: done. Not proven (a docs-only pull request's skipped lanes,
a push that wasn't a pull request, GitHub not answering yet) or the proof job failed: it calls `ci.yml` whole. Nothing a
release waits for comes from here.

## Nightly

`nightly.yml` (formerly `macos.yml`) calls `ci.yml` and `release-candidate.yml` on main every night: both Node versions,
Linux and macOS, every area lane. Its checks are named `nightly / …`, so none stands in for a pull request's.

Not built yet (follow-up): carrying a red GitHub nightly into the plane's release debt. Today a red nightly is seen in
Actions; the plane's own 03:00 nightly full check is what holds composed releases. Ingesting GitHub's nightly needs
authenticated, lane-specific failure records and freshness checks at deploy, merge and publish, cleared only by
coverage of the failed lane. Even then a nightly can't stop a regression shipping the same day; it supplements the
pre-release coverage above, never replaces it.

## By kind of change

| Change | Pull request | Release |
|---|---|---|
| Documentation only (as defined above) | Node 24 Linux + macOS; area lanes skipped | Not a release on its own; a `release-*` branch runs everything |
| Tests, product code, dependencies, migrations | Node 24 Linux + macOS, every area lane | Everything above plus Node 22, then the owner-Mac release check |
| CI, release scripts, test infrastructure | Everything, and always a person's approval (auto-approval refuses `scripts/` and workflow changes) | Everything |

## What it saves (0.9.79's measurements)

- Each ordinary pull request: Node 22 no longer runs — about 28 Linux and 29 macOS runner-minutes. Wall time is
  unchanged (the slowest shard is a Node 24 macOS one, about 14 minutes).
- Each push to main: about 135 runner-minutes of repeated CI become a few minutes of build and proof.
- Each release: the tag's publish step drops from 43–58 minutes (two unsharded macOS suites) to a couple of minutes.
  Node 22 now runs once on the release candidate instead of on every pull request.

## Owner action

Main's branch protection must require, from GitHub Actions, every one of:

- `node 24 · ubuntu-latest`, `node 24 · macos-latest`
- `linux native containment · delegated cgroup v2`, `linux fence · sandbox-runtime`, `Windows Job Object containment`
- `git 2.41 · debian trixie`, `git 2.47 · debian trixie`
- `node 22 · ubuntu-latest`, `node 22 · macos-latest`

Until it does, `toolroll release` stops before merging and names the missing ones. The Node 22 names now come from
`release-candidate.yml`; ordinary pull requests report them skipped, which protection accepts.

## Rules that keep it safe

- Exact tested-tree equality everywhere: CI tests the pull request's head commit, the release requires it to contain
  main, the merge commit must have the gated tree, and the release proof checks the tag's tree against the pull
  request's head again from GitHub's record.
- Skipped is never success for a release; only the jobs listed in `src/ci-workflow.test.ts` may carry a condition.
- A required name counts only from its own workflow's pull-request run; the newest run of that workflow on the commit
  decides, and an older run's failure still blocks an automatic approval.
- Changing the path rules, the proof, the verifier or a workflow is a CI change: a person approves it.
