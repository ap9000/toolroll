# Testing

Standing Orders is tested end to end: the real CLI, the real console and the
real worker, driven through a real browser. Journeys that test the model
integration use real Claude turns and real builds; the rest script the model.
Unit tests are kept only where an end-to-end run can't be the guard.

## End to end (the main suite)

| Run | What it covers |
|---|---|
| `npm run e2e:flows` | Flows: the lead drawing flows and scripts from plain words, Jev sorting, Draft and the owner's decision, web requests, email and MCP tools, a card through a real build and a person's decision, failing scripts and Insights, public forms, webhooks, GitHub and schedule triggers, @mentions. |
| `npm run e2e:app` | Everything else: signing in and out, a name locked after five wrong passwords, sign-in and policy events in the action ledger and its CSV, `/healthz`, sign-in with a stand-in identity provider (turned on in Settings, an account from groups, a step-up confirmed by that sign-in, a group refused), an API token made in Settings (shown once without a script, reads but can't write, revoked), the sessions list, every page on desktop and phone, the CLI, a task filed in the console → planned by Claude → approved with a password → built → checked → marked complete, sent back with a note and rebuilt, sent back asking for more (the planner updates the plan and you approve the change), a build that stops to ask answered on the decision page, stopped and resumed; the lead answering and filing tasks; projects, knowledge, skills, tools, models, routines, theme, search; code steps in Python and Node with answers and secrets, a script schedule; a real email inbox (GreenMail in Docker) through to a threaded reply; follow-ups (a reply moves its card on, a stranger's doesn't, no reply sends a nudge in the same thread) and a stalled decision's reminder; the lead drawing a follow-up flow; an AI teammate deciding and handling cards within its rules and bringing the big one to you, paused and resumed; the lead adding a teammate and changing its rules; a teammate using a real MCP shop tool under per-action rules (a refund within its limit on its own, one over it approved on the card and made exactly as shown) and the lead changing a tool rule; a teammate keeping a customer's preference, its memory corrected, and a looser rule suggested after approvals in a row; a teammate routine run now, answered to its manager; a starter kit set up in one click, its checklist, and its sample card answered by its teammate for you to check; a one-click connection signed in on a stand-in service (registration, consent, PKCE, the sign-in kept out of the database, renewed by the worker, the kit teammate given the tool); two people on a live canvas; the demo. |
| `npm run e2e` | Both. |
| `npm run e2e:app:parallel` | The same journeys as `e2e:app`, in groups that run at once, each in its own world. A group with failed journeys runs once more in a fresh world with just those journeys and what they need; one that passes then is listed as flaky. Prints each group's report and fails if any group still fails. |

Each run makes a throwaway world (`scripts/e2e-kit.mjs`) and writes
`output/e2e/<run>-<time>/report.md`, with screenshots and a picture of every
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

The release gate (`scripts/release-check.mjs`) runs what the change can
break, every chosen group at once: the scripted journeys when a page changed
(just the groups that own the page when that is clear — the flow pages, the
teammate and kit pages, first run, one journey script — and every scripted
group otherwise), and the real-model journeys only when model-facing code
changed (the lead, chat, mate tools, the planner, the builder, teammates, the
provider adapters) or `--real` is given. Its plan line names the groups and
why. It starts typecheck, build and the unit tests together (the tests' setup
waits for that build); the journeys start once the build is done. Its summary
ends with the model calls, how long each part took and the peak memory. The
nightly real-model journeys flow (`scripts/flows/real-model-journeys.mjs`,
see the flows guide) runs every journey of both scripts with real models, so
every journey still meets the real models somewhere.

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
