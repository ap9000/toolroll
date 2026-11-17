# Testing

Toolroll is tested end to end: the real CLI, the real console and the
real worker, driven through a real browser. Journeys that test the model
integration use real Claude turns and real builds; the rest script the model.
Unit tests are kept only where an end-to-end run can't be the guard.

## End to end (the main suite)

| Run | What it covers |
|---|---|
| `npm run e2e:flows` | Flows: the lead drawing flows and scripts from plain words, Jev sorting, Draft and the owner's decision, web requests, email and MCP tools, a card through a real build and a person's decision, failing scripts and Insights, public forms, webhooks, GitHub and schedule triggers, @mentions. |
| `npm run e2e:app` | Everything else: signing in and out, a name locked after five wrong passwords, sign-in and policy events in the action ledger and its CSV, `/healthz`, sign-in with a stand-in identity provider (turned on in Settings, an account from groups, a step-up confirmed by that sign-in, a group refused), an API token made in Settings (shown once without a script, reads but can't write, revoked), the sessions list, every page on desktop and phone, the CLI, a task filed in the console → planned by Claude → approved with a password → built → checked → marked complete, sent back with a note and rebuilt, sent back asking for more (the planner updates the plan and you approve the change), a build that stops to ask answered on the decision page, stopped and resumed; the lead answering and filing tasks; projects, knowledge, skills, tools, models, old routine links landing on Flows, theme, search; code steps in Python and Node with answers and secrets, a script schedule; a real email inbox (GreenMail in Docker) through to a threaded reply; follow-ups (a reply moves its card on, a stranger's doesn't, no reply sends a nudge in the same thread) and a stalled decision's reminder; the lead drawing a follow-up flow; an AI teammate deciding and handling cards within its rules and bringing the big one to you, paused and resumed; the lead adding a teammate and changing its rules; a teammate using a real MCP shop tool under per-action rules (a refund within its limit on its own, one over it approved on the card and made exactly as shown) and the lead changing a tool rule; a teammate keeping a customer's preference, its memory corrected, and a looser rule suggested after approvals in a row; a teammate routine run now, answered to its manager; a starter kit set up in one click, its checklist, and its sample card answered by its teammate for you to check; a one-click connection signed in on a stand-in service (registration, consent, PKCE, the sign-in kept out of the database, renewed by the worker, the kit teammate given the tool); two people on a live canvas; the demo. |
| `npm run e2e` | Both. |
| `node scripts/first-result-e2e.mjs` | The first-result clock (run by hand, not in CI): a newcomer's first run at a real terminal, bare `toolroll` to an accepted result, recorded as a trace (decisions, interactions, waits, what was on screen) with split timings in `evidence/first-result/`. Scripted by default: the driver, the counts, and the failure paths (no agent, signed out, not a repository, a model error, a restart mid-build). `--journeys real --package toolroll@<version> --confirm-real-run [--install npx\|npm\|brew]` times it with real models and the published package. |
| `npm run e2e:app:parallel` | The same journeys as `e2e:app`, in groups that run at once, each in its own world. A group with failed journeys runs once more in a fresh world with just those journeys and what they need; one that passes then is listed as flaky. Prints each group's report and fails if any group still fails. |

Each run makes a throwaway world (`scripts/e2e-kit.mjs`) and writes
`output/e2e/<name>-<time>/report.md`, with screenshots and a picture of every
open page when a check fails. `--only <pattern>` runs just some checks;
`--keep` keeps the world to look at.

`e2e:app` and `e2e:flows` journeys are in groups (`--groups` lists them);
`--group <name>` runs one, and `node scripts/e2e-parallel.mjs <script>` runs
them all at once. A journey that needs an earlier one is in that one's group;
one that others build on (Rosa's first tool journey, turning the lead chat on)
is in each of their groups and runs in each. Every flows group starts with its
own first-run setup and ends with the browser-error check. Both mail journeys
stay in one group: the mail server has fixed ports (IMAP is read over TLS only
on 993).
A journey retried alone in a fresh world can pass when it failed from state an
earlier journey left, so a flaky retry is a follow-up to look at, not proof.

### Scripted and real-model journeys

Every journey says which it is, and `--groups` counts both:

- **Scripted** journeys test Toolroll's own behaviour: approvals, results,
  revisions, flows moving cards, chat buttons, teammates' rules, storage. They
  run against `scripts/fixtures/scripted-provider.mjs`, a stand-in `claude`
  and `codex` first on the world's PATH that speaks the same CLI protocol
  (json and stream-json output, structured output, resumed sessions, codex
  JSONL, the planner's and builder's nonce-bound files, MCP tool calls) and
  answers at once from what the journey scripted (`w.script(...)`). The CLI,
  console, worker, git and browser stay real. A model call nothing scripted
  fails the run ("Every model call was scripted"), and a scripted run needs no
  sign-in.
- **Real-model** journeys test the model integration: the lead's real turns,
  the planner and builder protocols (a real plan and build, a build that
  parks a question), Jev's sorting. They use the computer's real CLIs.

`--journeys scripted` runs the scripted ones, `--journeys real` the
real-model ones and the journeys they need, and `--journeys all` (the default)
every journey with real models. `--list --json` lists every journey with its
mode, needs and groups without starting a world; a run fails when a journey
isn't tagged, needs one that isn't before it in its group, or a scripted one
needs a real-model one, or when the counts in GROUPS are wrong. Each report
counts the model calls (scripted, and real turns) and keeps them in
`model-calls.jsonl`.

Needs: `npm run build`, `gh` signed in, git, sqlite3, Playwright's Chromium
(`npx playwright install chromium`), Docker for the mail server, python3; for
real-model journeys `claude` signed in, and an OpenRouter key in Settings → AI
providers for Jev. A real run spends a few Claude turns and a few real builds
(about 45 minutes for both); a scripted one spends none.

The release gate (`scripts/release-check.mjs`) selects the unit suite and
every scripted browser journey for changes beyond docs,
evidence, design notes or a version-only bump, compared with the latest `v*`
release tag reachable from the candidate (`HEAD`, including lightweight tags).
A version-only release PR therefore includes code merged since that release.
Without a reachable release tag, or with no difference from it, the unit and
journey suites run; upgrades use the separate comparison below. Tags come from the checkout; `--base <ref>` overrides the comparison.
`node scripts/release-check.mjs --plan` shows the baseline and selected checks.
Units normally run in full. Before starting, the check queries GitHub through
`gh api` for `ci.yml` on the exact candidate SHA. Only a clean checkout and
the latest completed successful push-event run, with every workflow job
concluded `success` on that SHA, can replace the unit suite; `ci.yml` no longer
runs on a push, so a release check runs its own units.
Skipped, pending, missing, failed, unreadable or unknown results run it locally.
The latest run attempt is used; an older green attempt cannot hide a failure.
All test files mentioning macOS, Darwin, sandbox-exec or launchctl still run
on macOS, including native sandbox, boot identity and browser tests. An
unreadable local selection falls back to all units. `--full` never reuses CI.

Typecheck, build and local units start together; unit setup waits
for the build, and browser journeys and the upgrade path start after it passes.
Browser journeys also stay held if typecheck has already failed.

The upgrade path uses `git diff <last reachable release tag>` (including local
tracked edits), plus new untracked files. It skips only when every changed
path is clearly unrelated: docs/evidence/design, browser code/CSS, tests,
standalone app/flow journey runners, or a verified version-only package bump.
All other paths run upgrades, including store imports, SQL-bearing modules,
chat tables and migrations, updater code, and unknown scripts. Unreadable
history or untracked-file discovery runs upgrades. `--base` does not
override this migration safety comparison. The normal sample
is the last five stable reachable release tags, a release with schema equal
to `BASELINE_SCHEMA_VERSION`, and 0.5.0, deduplicated. The baseline is found
from the tagged store source with a 64 MB Git read buffer, not a hard-coded schema number. Unknown tag or
baseline history falls back to every published version from 0.5.0.
`--full` runs every published version, regardless of the diff. Each version
runs in a separate process and temporary home with all existing update, npm,
completion-preservation and rollback checks. Workers default to four, bounded
by available CPUs minus one (minimum one); `TOOLROLL_UPGRADE_WORKERS` may lower
or raise the requested count within that CPU bound.

Scripted release journeys cap build/settle polling at 90 seconds;
`TOOLROLL_CHECK_SCRIPTED_TIMEOUT_SECONDS` changes that limit. A timeout is a
failure. Run by hand, the first hard failure in a journey, upgrade worker, build,
typecheck or units stops the other parts and queued work. Run by the plane, the
check reads a handshake on stdin and keeps going instead, so every part reports
(docs/plans/release-once.md): results come only from the fd-3 pipes of the
harness processes it starts (`test/release-reporter.ts`, `scripts/check-results.mjs`),
never from a file, and its last stdout line is `TOOLROLL_CHECK_REPORT <json>`
with the plane's nonce. A failed build still starts no journeys. Scripted journeys never retry;
real-model journeys retain their existing retry and report-validation policy,
and a failure after that policy is exhausted stops the check.
The failure is printed immediately; cleanup is awaited before the normal
per-part timing summary. Release journey reports are under
`evidence/release-<pid>/<part>/`. Standalone app/flow scripts use
`output/e2e/<name>-<time>/`; the parallel wrapper defaults to `evidence/<script>-parallel-<time>/`.
Standalone runners retain their retry policy.
On the second and later checks of a release, the plane may hand the check a
targeted plan (docs/plans/release-once.md): only the unit files, journey groups
and upgrade versions that failed at the release's last full check, every test
changed since, and a sanity pass. Such a result is `composed` with that full
check, or `partial` (never a pass). A nightly full check of main
(`toolroll release nightly`) runs at 03:00; each item it finds failing stays
open until a full check covering it passes on a commit that contains it.

The target is 6–8 minutes for a passing small check and under three minutes to
report a scripted failure; actual wall time remains visible in the summary.

Browser concurrency is fixed at two flow lanes and four app lanes per runner.
Unit workers default to `min(8, max(2, cores - 1))`, using Node's available
parallelism; `VITEST_MAX_WORKERS` overrides that default. There is no memory
admission gate or memory-based lane sizing.

Real-model journeys run when model-facing code changes (the lead, chat,
planner, builder or provider adapters), with `--real`, or for a full check.
`--full` (or `TOOLROLL_FULL_CHECK=1`) runs every unit test and every scripted
and real-model journey, and every published upgrade path. The plan names what runs and why; the summary reports
results, model calls and time for each part. The nightly real-model journeys
flow (`scripts/flows/real-model-journeys.mjs`) runs both scripts with real models.

Only real provider turns use `scripts/provider-gate.mjs`. Release checks share
four reserved real-turn slots across both runners; `TOOLROLL_CHECK_PROVIDERS`
configures that check's cap. Other local sessions are recorded but do not
reduce this release-only allowance to one. Scripted journeys take no slots.
Standalone runners retain the shared-computer cap of four (configurable by
the same variable), with other sessions leaving at least one check slot.
The summary reports observed concurrency and waits.

## CI

The matrix is in `docs/plans/test-matrix.md`. Every pull request runs
`.github/workflows/ci.yml`: the suite on Ubuntu with Node 24 in six
shards, and on macOS its macOS lane (every file that can behave differently on
a Mac, plus a smoke set; `scripts/ci-shards.mjs` LANES) in three, joined by the
required `node 24 · ubuntu-latest` and `node 24 · macos-latest` checks (the
nightly runs every file on macOS too). On an ordinary pull request the shards
run only the test files its diff can reach plus everything that always runs
(the attack suite, the gate tests, tests that walk the repository), chosen by
the base revision's `scripts/ci-select.mjs`; anything it can't decide runs
every file, and so do `release-*` branches, main and the nightly. A run that
selected reports `unit suite · every file ran` skipped, so its merge commit
gets the full CI on main (`docs/plans/test-selection.md`). Shards are balanced by each file's
measured time (`test/timings.json`; refresh it with `node scripts/ci-timings.mjs
refresh --run <ci run id> [--run <id>]...`, each file's median over the runs,
see what each shard would take with `node
scripts/ci-timings.mjs plan`), and a newer push to a pull request cancels the
older run (never a `release-*` branch's). `journeys.yml` runs the scripted
journeys on every pull request, advisory (see `docs/plans/ci-speed.md`).
`install-smoke.yml` (advisory too, on Ubuntu and macOS) runs on a pull request
that changes what gets packed or installed (package.json, install.sh, the bin,
the demo; every `release-*` pull request) and by hand: it packs the build,
installs the tarball with `npm i -g` and with install.sh into scratch prefixes
under a throwaway HOME, and runs `toolroll --version`, `toolroll help` and
`toolroll demo` start to stop. Run it locally with
`node scripts/install-smoke.mjs --port <n>`. The
area lanes: Linux cgroup
containment, the Linux fence, Windows Job Object containment and the git
2.41/2.47 lanes. A documentation-only pull request (only Markdown under
`docs/`, `CHANGELOG.md` or `README.md`, added or modified; see
`scripts/ci-scope.mjs`) skips the area lanes. Node 22, the engines floor,
runs in `release-candidate.yml` on a pull request from a `release-*` branch
(and in the nightly); on any other pull request its jobs are skipped. Main's
protection reads a skipped job as passing, so ordinary pull requests merge;
`toolroll release` never accepts a skipped check, so a release needs every
lane executed on its exact head, and main's protection must require every
one of `REQUIRED_PR_CHECKS`. The hosted unit shards run with
`TOOLROLL_REQUIRE_NATIVE` (linux or darwin), so a native fence attack runs or
fails, and the shards' verifier refuses a skip that only a native probe
allows. A push to main (`main-push.yml`) typechecks and builds, and runs
`ci.yml` whole only when it can't prove the merge commit is a tested pull
request's head tree. Release tags run no tests: `publish.yml`'s release proof
(`scripts/release-proof.mjs`) reads GitHub's record that the tagged tree
passed every required check on its pull request before npm publication.
`nightly.yml` runs everything on main every night. Only the jobs listed in
`src/ci-workflow.test.ts` carry an `if:`, and that test holds the workflows
to the check names `toolroll release` waits for.

Files that judge other changes (the check lists above, the wire and click-path
ceilings, `test/destinations.json`, the password inventories, the workflows
themselves; `scripts/gate-files.json` lists them) are protected by
`gate-changes.yml`, an advisory check on every pull request: a pull request
that changes one fails unless one of its own commits (merges aside) discloses
it with `Gate-change: <file or glob> — <reason>` in its trailer block (the
last paragraph). A trailer is a disclosure for the reviewer, not an approval.
The check runs the base revision's `scripts/gate-changes.mjs`, which reads the
list with `git show <base>:scripts/gate-files.json`, so a pull request can't
loosen its own judge. Snapshots and `test/timings.json` are reported, never
failed.

## Wire budgets

`npm run test:perf:wire` (`test/perf/wire.wire.test.ts`, slice 0 of the fluid pages plan) measures what the browser
receives today for Home, Tasks (the default list, a state filter and the board), a result page and Chat, on a seeded
world (`test/wire-world.ts`): 10,000 tasks in eight projects with revision families, real diffs and check logs on disk
for every finished attempt, an operator, an approver, a project-limited viewer, and a few conversations, all at a fixed
clock and seed. For each page it records the document load (the HTML page and the workspace JSON inside it) and the
in-place read (`?format=workspace`), with their bytes and row counts, the SQL statements and projection calls each
request runs after a change and again at once, and what one live-room change costs: the frames every open page's
stream receives and the whole-workspace re-read each page then makes. Bytes are before compression.

Bytes, rows, statements and calls are deterministic, so they are gated: the test fails when one goes over its
ceiling in `test/perf/wire-ceilings.json` (today's value plus a small margin), or when a new row has no ceiling.
Server time and memory are printed, never gated. The run writes `evidence/wire-budgets.json` (or `WIRE_OUT`) and prints
the table; `node scripts/wire-report.mjs <report> [<main's report>]` prints it again, with what changed against main.

To raise a ceiling, do it on purpose: rerun with `WIRE_WRITE_CEILINGS=1 npm run test:perf:wire` to rewrite every
ceiling from this run, or edit the one number by hand, then commit the file with a line in the pull request saying
why. A change that makes a page smaller can lower its ceilings the same way. `wire-budgets.yml` runs the test on pull
requests that touch the server, the browser app, the work index or the store, and on every push to main (called from
`main-push.yml`). Its job summary lists every row, the rows that changed against main's latest report and each ceiling
the pull request raises, and it uploads the report as the `wire-budgets` artifact. It is advisory: not one of
`REQUIRED_PR_CHECKS`, and the release verdict leaves it out (`ADVISORY_PR_CHECKS`).

What each account sees is exactly what the plain reads give. `src/fast-reads.slow.test.ts` renders, on a smaller wire
world, Work (list, Needs you, second page, failed filter, completed, archived, one project, board), two result pages, a task
page, Projects and Chat for four browser sessions (the operator, an approver on every project, an approver on two, a
viewer on one; some answers are refusals, compared too), sequentially at a fixed clock, and serves each read twice on
the same code: with the request's work reads and without them (the plain path, with the workspace revision moved
before each read so no per-revision cache answers it). The bodies must match byte for byte; nothing is frozen, so a UI
change needs no golden. The test also proves the plain side opened no work reads, and that a divergence seeded on the
fast side alone is caught. `FAST_READS_OUT=<folder>` keeps both bodies of a pair that differs.
`src/fast-reads-boundaries.slow.test.ts` serves each read with and without the request's work reads and requires the
same answer for an API token, a token that expires between reads, a local owner, an account narrowed then revoked, an
account deleted outright, overlapping requests, another process's commit, results' check lines and the live summary
room's snapshot; `src/work-reads.test.ts` covers writes, revocations, rollbacks (including through prepared
statements) and other processes' commits in the middle of a request, a write while the projection is built, a
projection built after another process committed, a lead-filtered list and a hold ending across the reuse window. A
page read's work projection and its rows' saved facts are read once per request (`src/work-reads.ts`): every reuse is
proved against the database first (this process's writes at once; another process's commit from the next turn of the
event loop, a bounded staleness of one synchronous turn), and nothing outlives the request.

## Destinations and click paths

Slice S0 of the one-workspace plan measures how many places a person can land on and how many clicks the common jobs
take, so each later slice proves it made the app smaller and shorter.

`test/destinations.json` declares every address a signed-in browser can land on: each GET row of
`src/server/route-table.ts` that admits a cookie at the console stage, keyed by route id, as a **page** (a destination),
an **alias** (only redirects, with its target), a **ceremony** (a password, sign-in or one-time-secret step that stays
its own document), **data** (JSON, files, sockets, a catch-all's not-found), or **mixed** (a page or an alias, with the
conditions written down). `src/server/destinations.test.ts`, part of the unit suite, fails when a route row has no
entry (so a new page is declared on purpose), when an entry names no row, when pages plus mixed rows go over
`ceiling.destinations`, or when a ceremony is a page that changes in place. It then requests every entry from the demo
(signed in through its one-time link) and from an empty console with an instance operator (for the rows the demo
account may not open) and checks each answers as its kind: a page is a full document, an alias redirects to its
target, data is never a page. Rows neither console has the object for are held to the status they answer instead,
with the reason in the test. On main at 4f6cda50: 77 pages, 3 mixed (`/review`, `/r/<n>`, `/welcome`), 3 ceremonies,
25 aliases and 24 data rows, so 80 destinations. A slice that removes pages lowers the ceiling in the same change.

`npm run e2e:click-paths` (`scripts/click-paths-journey.mjs`; run by hand, not in CI) drives the demo in a browser at
1440x900 and counts, from Home, the clicks, the fields typed into, the full document loads and the ceremony loads
(a page with a password field, or a ceremony route) for: approve a plan, review and accept a result, send a result back,
watch a running agent, start a task and add a project, with Passwordless on; and the same approval with it off, up to
the password field (nothing is typed). Each job runs on a fresh demo and ends when the console shows it done. Every
number is held to its ceiling in `test/click-path-ceilings.json`, and a run over any of them fails. Shorten a path and
lower its numbers in the same change (`--write-ceilings` rewrites them from a run). The report is
`output/click-paths/report.json`. `--port <n>` serves the demo on that port (default: one the system picks),
`--only <pattern>` runs some jobs, and `--playwright`/`--chromium` name a Playwright copy and its browser.

| Job (main at 4f6cda50) | Clicks | Typed | Loads | Ceremony loads |
|---|---|---|---|---|
| Approve a plan | 1 | 0 | 0 | 0 |
| Review and accept a result | 3 | 0 | 2 | 0 |
| Send a result back | 4 | 1 | 2 | 0 |
| Watch a running agent | 3 | 0 | 0 | 0 |
| Start a task | 2 | 1 | 2 | 0 |
| Add a project | 3 | 1 | 1 | 0 |
| Approve a plan, password on (to the password field) | 2 | 0 | 0 | 1 |

The baseline screenshots for this plan (every page at 1440x900 light and the main ones at 390x844, demo data, main at
4f6cda50) are kept with the plan's notes, outside the repository; none are committed.

## Releasing

To drain the built-in worker, use `toolroll runner list --json` to find its name
and save its current capacity, then run `toolroll runner capacity <name> 0`.
This requires an instance operator's login (`toolroll login`). Running tasks
keep their claims and finish; the worker takes no new builds, even after it
restarts. Wait until Settings → Workers shows nothing running before
stopping the service. Restore the saved capacity with
`toolroll runner capacity <name> <previous-capacity>` to resume. The release
command still performs its deployment pause, backup, compatibility and health
checks.

`toolroll release <branch> --repo <gate checkout>` runs the whole release:
gate the exact commit with Full checks, wait for an active approver's approval
(the only human step), require a passing Full result, complete and deploy it.
The service and both CLI names must record that commit; a matching version
is insufficient. After PR checks pass, squash merge, delete the matching
remote branch, verify the merged tree and tag. Both macOS legs gate npm and
GitHub publication. The release is published once npm and the GitHub release
are verified; Homebrew is finished apart (pending, failed or current in the
journal): the same command later waits for the tap change's checks to register
and all pass, then merges it, and never moves a newer formula back.

Stops retain their step. Rerunning reconciles any completed merge, tag or
publication. Interrupted deployments recover the saved staging directory
before retrying; failed recovery stops the release. Both CLI names move to
the deployer's runtime in their own step, put back together on failure. A
deployment that fails before its swap lifts its own pause, including while
installing it. One killed outright with new work still paused is lifted
through `toolroll release --release-gate <id>`, which proves the swap never
began first; add `--yes` to lift that pause. Deploy, resume, recovery and
confirmed gate release share an exclusive lock beside the staging journal.
It stays held through proof, gate removal and the saved release record, and
the OS releases it when the process dies. Do not delete its `.lock.sqlite`
file: it is reused for later attempts. Signals let an in-flight backup close
its SQLite writer before recovery runs. Lock acquisition waits at most five
seconds, then refuses without changing the pause. `toolroll skills get release`
has the details.

## Unit tests

Unit tests guard what an end-to-end run can't. A test earns its place when deleting it would let a promise break
unnoticed; the suite is not a log of every fix.

- `npm test` is the fast tier, run while working, with a target under two minutes.
- `npm run test:slow` runs the `*.slow.test.ts` files: real git repositories, processes, SQLite writers and
  updaters, each file taking more than about ten seconds.
- `npm run test:all` runs both, and CI and the release check run it. `npm test` skips slow files even when named,
  so run one with `npx vitest run src/foo.slow.test.ts` (the quick check does).

Keep overrides cut, and each assertion is judged on its own: one test can hold a guarantee beside disposable
presentation checks. Only these kinds are kept, and only these kinds are added:

- **Migrations** (`migration-*.test.ts`): an upgrade never loses or bends what is already in someone's database.
- **Security rules**: secrets never reaching a card, a log or a page; the fence around agents and scripts;
  approvals, custody, claims and leases, sealed scopes and routes, spend and budgets, pairing and who may decide;
  sign-in, sessions and webhook signatures; protected branches and never pushing; proof and evidence. Every guard
  keeps a test that tries to get around it, and `test/attacks/` keeps every reproduced bypass.
- **Data integrity**: store transactions, crash recovery, idempotency and races, where losing work is the failure.
- **Contracts other code or people depend on**: CLI JSON envelopes and exit codes, HTTP status codes, refusal
  reason codes, the argv sent to each provider, file formats, and the `data-*` hooks scripts and journeys use.
- **What a person sees before deciding, and what must never show**: approval and scope terms on the page that
  signs them, escaping of untrusted text, redaction, and honest failure, evidence and warning text.
- **Boundaries and lifecycle**: a route acting as the signed-in identity, cancellation and liveness, and counts
  that are the safety property (nothing runs after a refusal, exactly one run per admission).
- **A bug that was fixed**, as one case in the table test of the rule it broke. It is not a new test per finding
  or version ("(v69)", "review finding 4", "arc 2").

These are cut and not added:

- **Wording**: exact sentences, labels, help text and copy, unless a keep rule above covers them.
- **Markup and CSS**: exact HTML, class lists, CSS declarations and utility names. Presentation keeps at most one
  render check a page: it renders, its landmarks and the `data-*` hooks code relies on are present, and nothing
  throws. Boundary, escaping and attack cases on the same page stay.
- **Duplicates**: a behaviour proven at the store, route and page layers keeps the lowest layer that proves it,
  plus each layer that can fail on its own: the route's identity and authorisation, and the page showing what is
  signed. A deletion names the retained test that still proves it.
- **Private helpers** that the caller's tests already prove, and **implementation checks** such as mock call
  counts and internal ordering, unless the order is the safety property.

Property tests (`*.property.test.ts` with fast-check, `tui/crates/toolroll-tui/tests/properties.rs` with
proptest) attack the pure code agents most often get wrong at the edges: the agent's last words, the outbound
privacy rule, a route's sealed bytes, tui.toml, view.json and search. Each runs 200 cases and prints the seed of a
failure; replay it with `{ ...PROPERTY, seed, path }` (proptest saves its own under `proptest-regressions/`).

A flaky test is never fixed by a longer timeout, an added sleep or a rerun: it waits on a fact (a state, an event, a
file; a background pass says when it finished through `onBackgroundPass`), or it goes, with the reason in the commit.

Prefer `test.each` tables to near-identical tests, and assert outcomes, not steps. A new feature gets an
end-to-end check, not a unit test. A wording, layout or styling change gets no test.

## Runtime verification: scripts/verify.mjs

The reusable stranger-test driver runs the real terminal workbench with stand-in
agent CLIs. It never calls a model. Build agents and release checks can use the
same command and [feature map](feature-map.md), without making another install,
PATH, PTY driver or outbound privacy probe.

Requires Node, Git, Python 3, sqlite3, mkfifo and ps on the approved tools PATH.
After the checkout and native workbench have been built:

```sh
node scripts/verify.mjs --features welcome,new-task,help
node scripts/verify.mjs --scenario agent-error --scenario never-initialized
node scripts/verify.mjs --tarball /tmp/toolroll-candidate.tgz --out evidence/runtime-candidate
node scripts/verify.mjs --scenario narrow --keep
```

Without `--tarball`, the command uses `dist/bin.js` and
`tui/target/release/toolroll-tui`; it does not build. A tarball is installed with
scripts disabled into a temporary global prefix and its own npm cache and
npmrc files. The package must carry this platform's native workbench. There is
no fallback to the person's installed Toolroll.

The command reuses `isolated-env.mjs`, the scripted-provider fixture, the PTY
host and the screen reader used by `tui-e2e.mjs`. Each scenario gets a short
throwaway HOME, all XDG folders, a file secret store, a fixture repository,
stand-in browser openers/editor, and a system-assigned port other than 4180.
Every spawn checks the isolation environment. Preflight asks `command -v` for
every known agent CLI using the world's profile-free shell and refuses a real
CLI. No login shell, real home, keychain, browser or service supervisor is used.
This is accident prevention, with the same interpreter limitation documented in
`isolated-env.mjs`; it is not a sandbox against hostile test code.

With no selectors it exercises all mapped features. Repeat `--scenario` to
select scenarios; `--features` is a comma-separated list. When both are given,
the intersection runs. Unknown selectors and empty selections fail. Readiness
waits use screen, process, file or database facts, with bounded deadlines; no
fixed delay counts as verification.

Features may declare world preparation with `needs` in the feature map. Only
`threads`, `jumps` and `unread` currently need `threads-on` (including when run
as dependencies). Those runs start and stop the workbench to initialize the
laptop install, discover its local owner from read-only console records, then
use the same PTY host to type a fresh random password twice into
`toolroll password set` and answer the password prompt for
`toolroll config set flexible on --as <owner>`. The password never enters argv
or the environment. `toolroll config show flexible --json` must report on before
the workbench is relaunched. Missing owner/operator or product refusals fail
preparation; the driver never writes the switch directly. Captured text and
reports redact the password; raw preparation logs stay in the throwaway world
until redacted evidence is copied. Other selections keep their existing startup.
The project is then opted in with `toolroll project flexible enable` (password,
then the terms confirm). No product step yet gives Toolroll a Claude sign-in for
threads (a later slice), so the world holds a stand-in one, as the slow tests
do: a random setup-token-shaped value in the files store at
`<state>/flexible/claude-relay.json`, redacted like the password. The stand-in
agent never calls through the relay, and every session's report checks that the
relay answered no call (`thread_relay_call` is empty); one call fails the run.

`accept` accepts a fresh task's result. A sent-back revision waits for its
person's yes; `send-back` approves it in the workbench, and waits for its build,
only when the workbench's keymap says Accept also approves (branch
revision-approve); otherwise it records that the revision waits. A workbench
fatal dialog fails the waiting step at once, with its words.

Reports default to `evidence/verify-<time>-<pid>/`: `report.json`, `report.md`,
`screens.txt` and each PTY's raw screen log and recorded process ids. Keep these
out of Git. Output inside the checkout must be under `evidence/`. Every selected
feature gets PASS or FAIL with its screen excerpt. Reports also include time to
first text and workbench, and a read-only scan of every column in notification,
delivery, push, chat, lead, team, mail and coordinator tables for stand-in words.
Missing database/schema, leaks, failed prerequisites and cleanup errors fail the
run. Exit 0 means all selected checks passed; otherwise exit 1.

All recorded processes are stopped; the temporary world is removed unless
`--keep` is given. Evidence always remains. If cleanup fails, the world remains
for diagnosis and the report fails. `--keep` retains files, never running agents.

Focused checks for this driver:

```sh
npm run typecheck
npx vitest run src/verify-cli.test.ts
# The live PTY run happens in CI's "workbench bundle" job, which has the Rust binary:
node scripts/verify.mjs --features welcome,new-task,help
```

The small PTY contract (welcome, new task and help) is in the slow tier until its
runtime is measured. It requires the built checkout and retains evidence. A
release operator should run the tarball command against the exact packed
candidate after the normal build and native machine checks, and retain its
report with that candidate's release evidence. This slice does not change the
release gate lists or make this new command an automatic release requirement.
