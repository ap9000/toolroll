# App journeys: timing and overlap, 2026-10-06

The scripted app journeys (`scripts/app-e2e.mjs`) set the release check's wait: a full check gives them one browser slot
(6 slots shared by 4 journey runs), so their time is the sum of their groups. This records what they took before and after
the change on this machine (macOS, 64 GB, headless Chromium, Docker running), and where every journey's coverage lives.

## How it was measured

`node scripts/e2e-parallel.mjs scripts/app-e2e.mjs --skip-build --journeys scripted --at-once 1`, three times before and
three times after, on the same build. Each run went in consecutive chunks of groups (`--run-groups`), because one command
here may run for at most 10 minutes; at one slot the groups run one after another anyway, so a run's total is the sum of
its chunks. Group minutes come from the runner's summary; journey seconds come from each group's `report.json` (the kit
already records them, so no timing code was added). Logs and reports: `evidence/baseline/r1`–`r3`, `evidence/final/s1`–`s3`
(ignored by Git).

**Same failure before and after, in this sandbox only.** "One-click connections" fails in every run: the console can't
create `~/.standing-orders/tool-secrets/…` (EPERM; the agent sandbox blocks writes to the home folder), so it times out
after 30 s and the runner retries the flows group once (`flows-retry`). It costs about 1.3 minutes per run: the 30 s
timeout, plus a fresh world for the retry. The same journey passes where the home folder is writable.

## Totals

| | run 1 | run 2 | run 3 | median |
|---|---|---|---|---|
| Before (min) | 11.9 | 11.8 | 12.1 | 11.9 |
| After (min) | 7.6 | 7.6 | 7.6 | 7.6 |
| After, without the sandbox-only flows retry (min) | 7.0 | 7.0 | 7.0 | 7.0 |

The pass rate is unchanged: in every run before and after, every journey passed except One-click connections (above). No
journey was flaky and no other retry ran.

## Before

| Total wall (min, sum of serial chunks) | r1 | r2 | r3 |
|---|---|---|---|
| total | 11.9 | 11.8 | 12.1 |

| Group (min) | r1 | r2 | r3 |
|---|---|---|---|
| console | 0.8 | 0.7 | 0.8 |
| pages | 1.6 | 1.6 | 1.6 |
| task | 0.7 | 0.7 | 0.7 |
| stop | 0.4 | 0.4 | 0.4 |
| maya | 0.5 | 0.5 | 0.5 |
| rosa | 0.6 | 0.6 | 0.6 |
| memory | 0.6 | 0.6 | 0.7 |
| mail | 3.5 | 3.5 | 3.6 |
| flows | 0.8 ✗ | 0.8 ✗ | 0.9 ✗ |
| onboarding | 1.2 | 1.1 | 1.2 |
| flows-retry | 0.8 (retry) | 0.8 (retry) | 0.9 (retry) |

| Group | journey (s) | r1 | r2 | r3 |
|---|---|---|---|
| console | A wrong password is refused, and a signed-out visitor is sent to sign in | 0.5 | 0.4 | 0.4 |
| console | Sign-in hardening and the audit trail: five wrong passwords lock a name, and its sign-ins  | 3.6 | 3.7 | 4.8 |
| console | Sessions and API tokens: a read token made in Settings is shown once on a page with no scr | 2.8 | 3.2 | 2.8 |
| console | Approval rules: with 'someone other than the requester' on, the task alex filed can't be a | 6.2 | 6.6 | 6.6 |
| console | Audit: the ledger chain verifies, a checkpoint made on the ledger page verifies from the c | 4.6 | 4.2 | 4.6 |
| console | Monitoring: a webhook set in Settings gets the audit stream, signed with the secret shown  | 5.7 | 4.3 | 4.2 |
| console | Spend: the month's cost shows by project and person; a budget set on the Spend page is lis | 4.2 | 4.2 | 4.3 |
| console | The command line answers: the task list, the approvers, the project's check, and help | 2.2 | 2.3 | 2.6 |
| console | Projects: the project is listed and opens | 0.2 | 0.2 | 0.2 |
| console | Knowledge: instructions saved for a project are kept for future tasks | 0.6 | 0.6 | 1 |
| console | Skills: a pasted skill joins the library and can be turned on | 1.2 | 1.1 | 1.2 |
| console | Tools: a project's own MCP tool is added (with your password) and tested | 0.9 | 1 | 1 |
| console | Models: Check now reads the live model lists | 3 | 2.8 | 3.2 |
| console | Routines: a standing order is filed, approved with your password, and run now files its ta | 1.3 | 1.3 | 1.5 |
| pages | Every main page opens without an error, in the one workspace look, on desktop and on a pho | 40.8 | 41 | 41 |
| pages | Settings: the theme switches to dark and the accent to Emerald, and both stay | 3.2 | 3 | 3.2 |
| pages | Search finds the project and a task | 0.2 | 0.2 | 0.2 |
| pages | Sign-in with an identity provider: turned on in Settings, a person signs in there and gets | 5.4 | 5.3 | 5.5 |
| pages | The demo starts with flows already moving, and opens in a browser | 1.8 | 1.9 | 2.1 |
| pages | The demo lead: type a request, approve, see it build to Ready, complete, at desktop and ph | 35.6 | 35.4 | 34.2 |
| pages | Signing out ends the session: pages ask to sign in again | 1 | 1.1 | 1.2 |
| task | File a task in the console; the planner (Claude) drafts its scope; approve it with your pa | 8.3 | 8.4 | 8.2 |
| task | Claude builds it, the project's checks pass, and the result shows what changed; mark it co | 2.2 | 2.1 | 2 |
| task | Send it back with a note: the revision is approved again and rebuilt with the fix | 11.3 | 11.6 | 11.5 |
| task | Send it back asking for more than the plan allows: the planner adds it, you approve the ch | 13.9 | 14.1 | 14.1 |
| mail | Email inbox: a real email becomes a card, Claude drafts a reply, the owner approves it, an | 11.3 | 11.3 | 11.2 |
| mail | Follow-ups: a card emails someone and waits; their reply moves it on (a stranger's doesn't | 192 | 192.1 | 193.3 |
| maya | Turn the lead chat on (first-run setup, with your password) | 0.9 | 0.9 | 0.8 |
| maya | AI teammates: Maya (a support rep) answers a question card, approves a small refund on its | 20.3 | 20.6 | 20.8 |
| memory | Teammates that act: Rosa uses a real store tool under her rules — looks orders up and refu | 15.3 | 15.2 | 15 |
| memory | Teammates remember and learn: Rosa keeps a customer's preference for later cards, you corr | 14.9 | 16 | 16.3 |
| rosa | Teammates that act: Rosa uses a real store tool under her rules — looks orders up and refu | 15.3 | 15.3 | 15.4 |
| rosa | A teammate's routine: added on its page for weekdays, run now, it looks the order up with  | 6.6 | 6.8 | 6.8 |
| rosa | A teammate's week and undo: its page shows the week with what its turns cost and what you  | 4.6 | 4.8 | 4.9 |
| stop | Stop a build while it runs, then resume it with your password; it finishes | 14.5 | 14.8 | 14.7 |
| flows | Code steps: a Python file and a Node script get the card, pass on what they print, pick th | 12.3 | 12.2 | 11.8 |
| flows | A schedule runs a script and makes a card of each item it prints, once (Run now) | 7.4 | 7.7 | 7.6 |
| flows | Starter kits: the Support desk kit sets up Maya and its flow in one click, its checklist s | 7.2; retry 9.8 | 10; retry 10.2 | 10.4; retry 10.4 |
| flows | One-click connections: Connect Stripe on the kit's checklist, allow it on Stripe's page, a | 33.2 ✗; retry 33.2 ✗ | 33.1 ✗; retry 33.2 ✗ | 33.4 ✗; retry 33.2 ✗ |
| flows | Live canvas: a teammate sees who's here and a card move without reloading | 2.2 | 2.2 | 2.1 |
| onboarding | A fresh install with Claude Code signed in reaches a filed first task without a password o | 9.6 | 9.6 | 10.2 |
| onboarding | The first task's timeline fills in as it moves, and after its first result the phone is of | 43.4 | 43.4 | 43.8 |
| onboarding | With no agent signed in, Chat shows the exact install and sign-in command and turns the le | 7.1 | 7 | 7.5 |
| onboarding | Another address shows what it is, where Toolroll answers, and the exact command | 0.9 | 0.6 | 1 |

Failures:
- r1 flows: One-click connections: Connect Stripe on
- r1 flows-retry: One-click connections: Connect Stripe on
- r2 flows: One-click connections: Connect Stripe on
- r2 flows-retry: One-click connections: Connect Stripe on
- r3 flows: One-click connections: Connect Stripe on
- r3 flows-retry: One-click connections: Connect Stripe on

## After

| Total wall (min, sum of serial chunks) | s1 | s2 | s3 |
|---|---|---|---|
| total | 7.6 | 7.6 | 7.6 |

| Group (min) | s1 | s2 | s3 |
|---|---|---|---|
| console | 0.6 | 0.5 | 0.6 |
| pages | 0.9 | 0.9 | 0.9 |
| task | 0.3 | 0.3 | 0.3 |
| stop | 0.2 | 0.2 | 0.2 |
| maya | 0.2 | 0.2 | 0.2 |
| rosa | 0.3 | 0.3 | 0.3 |
| memory | 0.3 | 0.3 | 0.3 |
| mail | 2.3 | 2.3 | 2.3 |
| flows | 0.7 ✗ | 0.7 ✗ | 0.7 ✗ |
| onboarding | 1.1 | 1.1 | 1.1 |
| flows-retry | 0.6 (retry) | 0.6 (retry) | 0.6 (retry) |

| Group | journey (s) | s1 | s2 | s3 |
|---|---|---|---|
| console | A wrong password is refused, and a signed-out visitor is sent to sign in | 0.4 | 0.4 | 0.4 |
| console | Sign-in hardening and the audit trail: five wrong passwords lock a name, and its sign-ins  | 2.3 | 2.3 | 2.3 |
| console | Sessions and API tokens: a read token made in Settings is shown once on a page with no scr | 1.3 | 1.8 | 1.6 |
| console | Approval rules: with 'someone other than the requester' on, the task alex filed can't be a | 5.3 | 5.4 | 5.4 |
| console | Audit: the ledger chain verifies, a checkpoint made on the ledger page verifies from the c | 2.4 | 2.6 | 2.3 |
| console | Monitoring: a webhook set in Settings gets the audit stream, signed with the secret shown  | 4.3 | 3.9 | 4 |
| console | Spend: the month's cost shows by project and person; a budget set on the Spend page is lis | 2.3 | 2.4 | 2.3 |
| console | The command line answers: the task list, the approvers, the project's check, and help | 2.4 | 2.4 | 2.3 |
| console | Projects: the project is listed and opens | 0.2 | 0.2 | 0.2 |
| console | Knowledge: instructions saved for a project are kept for future tasks | 0.7 | 0.7 | 0.7 |
| console | Skills: a pasted skill joins the library and can be turned on | 1.2 | 1 | 1.4 |
| console | Tools: a project's own MCP tool is added (with your password) and tested | 0.9 | 1.1 | 1 |
| console | Models: Check now reads the live model lists | 3.4 | 3 | 2.9 |
| console | Routines: a standing order is filed, approved with your password, and run now files its ta | 1.5 | 1.2 | 1.7 |
| maya | Turn the lead chat on (first-run setup, with your password) | 0.8 | 0.7 | 0.8 |
| maya | AI teammates: Maya (a support rep) answers a question card, approves a small refund on its | 8.3 | 8.7 | 8.9 |
| memory | Teammates that act: Rosa uses a real store tool under her rules — looks orders up and refu | 8.5 | 7.5 | 7.4 |
| memory | Teammates remember and learn: Rosa keeps a customer's preference for later cards, you corr | 5.9 | 6 | 6.2 |
| pages | Every main page opens without an error, in the one workspace look, on desktop and on a pho | 12.6 | 12.5 | 13.5 |
| pages | Settings: the theme switches to dark and the accent to Emerald, and both stay | 3 | 3 | 3 |
| pages | Search finds the project and a task | 0.2 | 0.2 | 0.2 |
| pages | Sign-in with an identity provider: turned on in Settings, a person signs in there and gets | 3.6 | 3.5 | 3.7 |
| pages | The demo starts with flows already moving, and opens in a browser | 1.9 | 1.9 | 2 |
| pages | The demo lead: type a request, approve, see it build to Ready, complete, at desktop and ph | 29.2 | 30.2 | 29.2 |
| pages | Signing out ends the session: pages ask to sign in again | 1.2 | 1.1 | 1.1 |
| rosa | Teammates that act: Rosa uses a real store tool under her rules — looks orders up and refu | 8.4 | 7.3 | 7 |
| rosa | A teammate's routine: added on its page for weekdays, run now, it looks the order up with  | 2.4 | 1.8 | 2.1 |
| rosa | A teammate's week and undo: its page shows the week with what its turns cost and what you  | 3 | 2.7 | 2.4 |
| stop | Stop a build while it runs, then resume it with your password; it finishes | 7.7 | 7.5 | 6.9 |
| task | File a task in the console; the planner (Claude) drafts its scope; approve it with your pa | 2.3 | 2.2 | 2.3 |
| task | Claude builds it, the project's checks pass, and the result shows what changed; mark it co | 2.2 | 2.2 | 2.2 |
| task | Send it back with a note: the revision is approved again and rebuilt with the fix | 3.1 | 3.1 | 3 |
| task | Send it back asking for more than the plan allows: the planner adds it, you approve the ch | 4.3 | 4.3 | 4.3 |
| flows | Code steps: a Python file and a Node script get the card, pass on what they print, pick th | 4.9 | 4.7 | 4.4 |
| flows | A schedule runs a script and makes a card of each item it prints, once (Run now) | 1.5 | 1.6 | 1.3 |
| flows | Starter kits: the Support desk kit sets up Maya and its flow in one click, its checklist s | 3.3; retry 3.8 | 3.3; retry 3.5 | 3.4; retry 3.5 |
| flows | One-click connections: Connect Stripe on the kit's checklist, allow it on Stripe's page, a | 31.6 ✗; retry 31.4 ✗ | 31.5 ✗; retry 31.1 ✗ | 31.3 ✗; retry 31.7 ✗ |
| flows | Live canvas: a teammate sees who's here and a card move without reloading | 2.3 | 2.2 | 2.3 |
| mail | Email inbox: a real email becomes a card, Claude drafts a reply, the owner approves it, an | 7 | 6.8 | 6.2 |
| mail | Follow-ups: a card emails someone and waits; their reply moves it on (a stranger's doesn't | 125.9 | 125.8 | 125.9 |
| onboarding | A fresh install with Claude Code signed in reaches a filed first task without a password o | 7.1 | 7.4 | 7.5 |
| onboarding | The first task's timeline fills in as it moves, and after its first result the phone is of | 44.4 | 44.6 | 44.2 |
| onboarding | With no agent signed in, Chat shows the exact install and sign-in command and turns the le | 6.3 | 6.3 | 6.2 |
| onboarding | Another address shows what it is, where Toolroll answers, and the exact command | 0.6 | 1 | 0.6 |

Failures:
- s1 flows: One-click connections: Connect Stripe on
- s1 flows-retry: One-click connections: Connect Stripe on
- s2 flows: One-click connections: Connect Stripe on
- s2 flows-retry: One-click connections: Connect Stripe on
- s3 flows: One-click connections: Connect Stripe on
- s3 flows-retry: One-click connections: Connect Stripe on

## What changed

- **Fixed waits became conditions.** "Every main page" slept 700 ms on each of 49 page loads. It now waits for the workspace
  to render and settle (two frames, then any finite animation). Settling ignores the no-script fallback's delayed reveal
  (`so-fallback-in`, 1.2 s, `workspace.css`): once the workspace renders, that only holds back the toasts' empty region.
  The kit's screenshot settle uses the same rule, so every `shot()` after a page load stops waiting 1.2 s for it. Sleeps
  before phone and scrolled screenshots now settle. The schedule's two "Run now" presses wait for each press's answer
  (the server runs the script before it answers), not 3 s each. The real-model "lead changes Rosa's rule" waits for each
  confirmed card to leave pending, not 2 s.
- **Waits look more often in a scripted run.** In a scripted run, `until` looks at least every 500 ms instead of every
  3–5 s (the scripted model answers at once, and the worker wakes on every change). Real-model runs keep their own pace.
- **A scripted world's worker ticks every 500 ms** instead of 2 s (`e2e-kit.mjs`; real-model runs keep 2 s). The tick paces
  timers such as a flow's wait and a teammate's next turn.
- **The world's setup commands run at once** after the first one makes the database (about 6 s → 3 s per group).
- **One signed-in phone page per group.** Journeys that check a page on a phone reuse alex's phone page (made on first
  use, in the colour scheme each journey asks for) and leave it on a blank page. Signed-out, wrong-password, identity
  provider, second-person (sam) and demo contexts stay separate.
- **Follow-ups wait 2 minutes, not 3.** The mailbox is read for replies about once a minute (`flow-replies.ts`). Two
  minutes still give both replies, including the stranger's, a full read while both cards wait, and Sam's card still
  runs out of time and gets its nudge. One minute would race the read. This saves about 66 s.

Tried and reverted: sharing one mail server between the two mail journeys. The first journey's Support inbox trigger then
read the follow-up mail and filed an unscripted card, so each journey keeps its own server.

Not changed: GROUPS, needs, which group each journey is in, and the release check's change scoping
(`scripts/release-check.mjs`).

## Coverage ledger

No journey was removed or folded, so every journey's coverage is where it was. The audit below explains why.

| Candidate overlap | Decision | Where the coverage lives |
|---|---|---|
| "Teammates that act" (Rosa's tool rules) runs in both rosa and memory | Kept in both | Each group needs Rosa, her store tool and her flow. Replacing it with direct setup changes needs/GROUPS, which this task's steering rules out. It now takes about 8 s in each group (was 15 s). |
| "Turn the lead chat on" runs in lead and maya | Kept | 1 s; same reason. |
| "The demo starts" and "The demo lead" each start a demo | Kept separate | The demo start is under 2 s. The demo lead checks a first visit's suggestions, which a shared demo could already have used up. |
| Short settings checks (Projects, Knowledge, Skills, Tools, Models) | Kept | Each 0–3 s, on a different page, with a different assertion; no unit test drives these forms in a browser. |
| Follow-ups' reply path | Kept in the browser | `watchFlowReplies` (the once-a-minute reader) has no unit test; `flow-replies.test.ts` covers `takeReply` only. |
| Approvals, stopping and resuming a build, Needs-you decisions, onboarding, phone layouts | Kept, assertions unchanged | Their own journeys, as before. |
| Fixes from past releases: the lead's project search (afa9e26), the approval-rules evidence pack, the card waited for before the next click (gate run 2059) | Kept, unchanged | Their journeys, as before. |

## Gaps

- After the change, a run here takes 7.6 minutes, above the 7-minute target. The difference is the sandbox-only flows
  retry; without it a run takes about 7.0 minutes.
- Floors this change leaves alone: the 2-minute reply wait (mail), the fresh install's first build in onboarding (about
  41 s of the timeline journey, on the product's default worker pace), and the demo's own 2.5 s beats (about 20 s).
- The real-model journeys weren't run (they need real Claude turns). Their changes are the shared phone page and the Rosa
  confirm wait; the catalogue still validates (`--list --json`) and `src/e2e-scripts.test.ts` passes.
- The scripted flows journeys (`scripts/flows-e2e.mjs`) use the same kit and passed once after the change (2 of 2 groups,
  2.0 min at three slots).
