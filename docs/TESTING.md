# Testing

Standing Orders is tested end to end: the real CLI, the real console and the
real worker, driven through a real browser. Journeys that test the model
integration use real Claude turns and real builds; the rest script the model.
Unit tests are kept only where an end-to-end run can't be the guard.

## End to end (the main suite)

| Run | What it covers |
|---|---|
| `npm run e2e:flows` | Flows: the lead drawing flows and scripts from plain words, Jev sorting, Draft and the owner's decision, web requests, email and MCP tools, a card through a real build and a person's decision, failing scripts and Insights, public forms, webhooks, GitHub and schedule triggers, @mentions. |
| `npm run e2e:app` | Everything else: signing in and out, a name locked after five wrong passwords, sign-in and policy events in the action ledger and its CSV, `/healthz`, sign-in with a stand-in identity provider (turned on in Settings, an account from groups, a step-up confirmed by that sign-in, a group refused), an API token made in Settings (shown once without a script, reads but can't write, revoked), the sessions list, every page on desktop and phone, the CLI, a task filed in the console → planned by Claude → approved with a password → built → checked → marked complete, sent back with a note and rebuilt, sent back asking for more (the planner updates the plan and you approve the change), a build that stops to ask answered on the decision page, stopped and resumed; the lead answering and filing tasks; projects, knowledge, skills, tools, models, old routine links landing on Flows, theme, search; code steps in Python and Node with answers and secrets, a script schedule; a real email inbox (GreenMail in Docker) through to a threaded reply; follow-ups (a reply moves its card on, a stranger's doesn't, no reply sends a nudge in the same thread) and a stalled decision's reminder; the lead drawing a follow-up flow; an AI teammate deciding and handling cards within its rules and bringing the big one to you, paused and resumed; the lead adding a teammate and changing its rules; a teammate using a real MCP shop tool under per-action rules (a refund within its limit on its own, one over it approved on the card and made exactly as shown) and the lead changing a tool rule; a teammate keeping a customer's preference, its memory corrected, and a looser rule suggested after approvals in a row; a teammate routine run now, answered to its manager; a starter kit set up in one click, its checklist, and its sample card answered by its teammate for you to check; a one-click connection signed in on a stand-in service (registration, consent, PKCE, the sign-in kept out of the database, renewed by the worker, the kit teammate given the tool); two people on a live canvas; the demo. |
| `npm run e2e` | Both. |
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
the latest completed successful push-event run, with every workflow job (including both
unit matrix legs) concluded `success` on that SHA, can replace the unit suite.
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
failure. The first hard failure in a journey, upgrade worker, build, typecheck
or units stops the other parts and queued work. Scripted journeys never retry;
real-model journeys retain their existing retry and report-validation policy,
and a failure after that policy is exhausted stops the check.
The failure is printed immediately; cleanup is awaited before the normal
per-part timing summary. Release journey reports are under
`evidence/release-<pid>/<part>/`. Standalone app/flow scripts use
`output/e2e/<name>-<time>/`; the parallel wrapper defaults to `evidence/<script>-parallel-<time>/`.
Standalone runners retain their retry policy.
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

Every pull request and push to main runs `.github/workflows/ci.yml`: the full
suite on Ubuntu with Node 22 and 24, the Linux cgroup containment job and the
Windows Job Object containment job. macOS Node 22 and 24 run nightly in
`macos.yml` and on release tags in `publish.yml`. The publish job uses
`needs: macos`, so both tag legs must pass before npm publication.
No job runs behind an `if:`, because GitHub reports a
skipped job as passing a required check; `src/ci-workflow.test.ts` holds the
workflows to the check names `toolroll release` waits for.

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
GitHub publication; Homebrew waits for checks to register and all pass.

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

## Unit tests (`npm test`)

Only three kinds are kept, and only these kinds are added:

- **Migrations** (`migration-*.test.ts`): an upgrade never loses or bends
  what is already in someone's database.
- **Security rules**: secrets never reaching a card, a log or a page; the
  fence around agents and scripts; approvals, pairing and who may decide;
  sign-in and webhook signatures; proof and evidence.
- **A bug that was fixed**: the test that would have caught it.

A new feature gets an end-to-end check, not a unit test. A test that only
pins wording or layout doesn't belong in either.
