# Testing

Standing Orders is tested end to end: the real CLI, the real console and the
real worker, driven through a real browser with real Claude turns and real
builds. Unit tests are kept only where an end-to-end run can't be the guard.

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

Needs: `npm run build`, `claude` signed in, `gh` signed in, git, sqlite3,
Playwright's Chromium (`npx playwright install chromium`), Docker for the
mail server, python3. An OpenRouter key in Settings → AI providers for Jev.
A run spends a few Claude turns and a few real builds (about 45 minutes for
both).

The release gate (`scripts/release-check.mjs`) runs both before a build ships.
It starts typecheck, build and the unit tests together (the tests' setup waits
for that build); the journeys start once the build is done, up to 6 groups at
once. Its summary ends with how long each part took.

Every part and group, a retry too, starts only when the machine has room
(`scripts/check-memory.mjs`): enough memory available beyond a reserve (a
larger one once swap is 90% used), and a slot under one cap on real Claude and
Codex turns shared by every suite, counting the sessions already running. A
busy machine makes the check slower, not wrong; an idle one starts everything
as before. The cap is 1 per 5 GB of memory (2 to 12); `TOOLROLL_CHECK_PROVIDERS=<n>`
sets it. The summary says what admission did, above the peak-memory line:

```
admission: ran up to 4 at a time: lowest 3.1 GB free, swap up to 97% used; up to 3 provider turns of ours, 4 other sessions (cap 12, from 64.0 GB memory); 2 starts waited 1.5 min in all for room (longest: app lead, 2.0 GB free, swap 97% used; it needs 6.0 GB)
```

`scripts/e2e-parallel.mjs` run alone does the same for its own groups.
`TOOLROLL_CHECK_MACHINE=<file.json>` (`{ "available", "swapUsed", "swapTotal",
"providers" }`, in bytes) replaces the machine's readings, to rehearse a busy
machine.

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
