<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/wordmark-dark.svg">
  <img src="docs/media/wordmark-light.svg" alt="Toolroll — a control plane for unattended coding agents" width="440">
</picture>

### Your agents build. You decide.

Queue the work, approve the exact terms once, and come back to results that
prove themselves — interrupted only for decisions that need a person.

[![CI](https://github.com/ap9000/toolroll/actions/workflows/ci.yml/badge.svg)](https://github.com/ap9000/toolroll/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/toolroll?color=171717)](https://www.npmjs.com/package/toolroll)
[![Homebrew](https://img.shields.io/badge/homebrew-ap9000%2Ftoolroll-171717)](https://github.com/ap9000/homebrew-toolroll)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-171717)
[![license](https://img.shields.io/badge/license-MIT-171717)](LICENSE)

**[Website](https://toolroll.dev)** · [Install](https://toolroll.dev/install) · [Use cases](https://toolroll.dev/use-cases) · [Integrations](https://toolroll.dev/integrations) · [Guides](docs/guide/README.md) · [Contributing](CONTRIBUTING.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/ui/tasks-dark.png">
  <img src="docs/media/ui/tasks-light.png" alt="The Toolroll console's Tasks view: plan windows and budget at the top, then every task with what it needs from you and the one action that settles it." width="920">
</picture>

<sub>Tasks across every project: what's building, what's Ready, and the one thing each needs from you. (Demo workspace.)</sub>

</div>

## Quick start

```sh
npx toolroll up
```

That starts the app and a builder for your projects, then opens the console
at http://127.0.0.1:4180. Runs on macOS or Linux with Node.js 22.13+ and git.
Try the sandbox first with `npx toolroll demo`: ask its scripted lead for a
change in Chat, approve the plan, and watch it land Ready. It never calls a
model, spends or reaches outside.

| Install with | Command |
|---|---|
| npm | `npm install -g toolroll` |
| Homebrew | `brew install ap9000/toolroll/toolroll` |
| bun | `bun add -g toolroll` |
| pnpm | `pnpm add -g toolroll` |
| yarn | `yarn global add toolroll` |
| script | `curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh \| sh` |

## Install with your agent

Paste this into Claude Code or Codex:

> Install Toolroll with `npm install -g toolroll` and start `toolroll up` in
> the background; it keeps running. Then run `toolroll onboard` in this
> repository, and run it again with `--yes` to add it as a project and install
> Toolroll's skill for you. Tell me the console address, where my login is saved (not the
> password), how to pair my phone, and what I can ask you next.

`toolroll onboard --yes` adds the repository (its main checkout) as a project,
says which agent CLIs are signed in, and prints the line that adds Toolroll as
tools (`claude mcp add --scope user toolroll -- toolroll mcp`) without running it.
`toolroll onboard --remove --yes` takes the skill out again.

Then read [Getting started](docs/guide/getting-started.md), [Flows](docs/guide/flows.md)
and [Security](docs/guide/security.md). Coming from Standing Orders? It's the
same product renamed; the `standing-orders` command and your data keep working.

## One command center, the whole loop

Tell Toolroll what outcome you want. Its planner reads the repository,
drafts the scope and proof rubric, and asks only when an answer would materially
change the work. You approve the exact contract once; long-running agents can
build it while the control plane handles queues, dependencies,
crashes, and decisions. The result comes back with the diff, checks, screenshots,
and a criterion-by-criterion verdict.

### Hand off in one prompt; approve exactly what will run

Project and quality stay close to the prompt; expert fields appear only when
you open them. Before execution, the approval card restates the goal,
boundaries, evidence requirements, model, and permissions.

<div align="center">
  <img src="docs/media/ui/tasks-mobile.png" alt="The Tasks view on a phone: each task with its status and the one action that settles it." width="260">
  &nbsp;
  <img src="docs/media/ui/scope-approval.png" alt="The scope you approve: goal, what is out of bounds, the files it may touch, acceptance criteria with their evidence, quality, permissions and the agents that will build it." width="640">
</div>

### One lead, durable crew work

Start in **Chat**, inspect work in **Tasks**, and manage guidance in **Projects**.
Browser and CLI chat share the lead conversation. A local database catch-up shows
current decisions and results before you authorize any model usage.

Crew work ends at **Ready**. Open the result, mark it **Complete**, or request a
specific revision of the same task. Actual checks remain visible; there is no
separate model reviewer or automatic evidence resubmission loop. Deployment is
reported separately and still requires the exact passing native machine check.

Enable **Automatic crew updates** in a conversation, or use `toolroll chat
--follow`. Meaningful updates reach the same lead within its saved permissions
and limits. Idle scanning uses no model. Restart recovery reuses saved responses;
a failed response does not rerun a task. `--no-follow` pauses automatic responses.
This wakes Toolroll's own lead, not an unrelated external agent session.

`toolroll brief` reads the local database. `knowledge search`, `knowledge
impact`, and `knowledge refresh` add bounded source retrieval; see
[repository context](docs/REPOSITORY_CONTEXT.md). Curated knowledge stays in the
database, and crew context stays attached to its original run.

Select a saved checkout once, then use the same task records from the terminal:

```sh
toolroll project use /path/to/project
toolroll project show
toolroll brief
toolroll assignment show <task>
toolroll task review <task> --brief
toolroll task complete <task>
toolroll task revise <task> --feedback "Keep the filter selected after reload."
```

`task review <task> --brief` combines the latest finished build or report's conclusion,
file counts, checks, review findings, screenshot paths, plan and next actions.
Use `--run <id>` for an earlier attempt, `--json` for the same fields, and `--all`
to include LOW findings. Lists stay bounded, with omitted entries counted; missing
fields say `not recorded`. The lead token works through `--token` or `TOOLROLL_LEAD_TOKEN`.

Completion and revisions use the local sign-in already saved by `up`. Completion
reports the exact run, commit and check outcome it handled. Agents use a scoped
credential (`project use /path/to/project --token-file /path/to/credential`) and
complete only with the exact `--digest` from `assignment show`; JSON completion
also requires that digest. The profile stores a file reference, never a secret,
and grants no additional access. It supplies defaults for database briefs,
knowledge commands, assignment commands, and these two task actions.

For an exact revision replay, reuse `--run`, `--source` and `--key` from its JSON
result. A revision keeps the original task history and approval boundaries; a
stale result cannot create another current version. Actual failed checks remain
failed when a result is marked complete.

### What is in the current build

- **Guided workflow recipes.** Choose a starter, customize its outcome and
  success checks, and preview the steps before creating one-time or scheduled
  work. Save project recipes for teammates, reuse a task's scope, or share a
  portable JSON definition. Creation retries return the same work; existing
  approval and recovery rules apply. [Get started](docs/WORKFLOW_RECIPES.md).
- **A creator for your usual work.** Write instructions once and add questions
  for the parts that change, such as a module or feature. Save the recipe,
  then use a short answer form to kick off another run. Saved recipes are
  searchable, show recently used work first, and can be shared with teammates.
- **Flows: your process on a canvas.** Draw zones (triage, a person's
  go-ahead, build, review, tell the team) and drop cards into them. Each zone
  runs its step: build and research zones file ordinary tasks, so every
  approval, check and agent fence still applies; decision zones wait for a
  named person; a send back becomes a revision of the same work. The engine
  is model-free and runs in the worker's pass. Or describe the process in
  chat: the lead drafts the flow, and adds, moves or decides cards, as
  cards you confirm from the console or your phone.
- **Triggers start cards on their own.** A button with a few questions, a
  schedule, GitHub (new issues, a label being added, new pull requests,
  failed checks), Linear (a team, a state, a label), or another flow's cards
  reaching a zone. A schedule can carry a standing order — the exact task to
  file each time, with its own per-run budget and a rolling 7-day cost
  ceiling — and runs one at a time, skipping while the last task is
  unfinished. GitHub is checked through your `gh` login and Linear
  with an API key kept on this computer; neither spends model tokens. Each
  issue or run makes at most one card; text from outside the repository's
  team is left out unless you say anyone. With a public address, GitHub,
  Linear or any service can post to a trigger's secret webhook instead
  (see [Webhooks](#webhooks-through-a-reverse-proxy)). A button can also be
  shared as a secret form link, so someone without an account can report
  something straight into a flow.
- **Steps with no AI, and where flows break.** A project keeps a library of
  scripts — `run-tests`, `lint`, `smoke-staging` — written on a flow's
  Scripts panel or drafted by the lead in chat, and any flow runs one from a
  "Run a script" zone in a fresh copy of the card's work: exit 0 passes,
  anything else takes the failure path with the log kept. A Build whose
  project checks fail takes its failure path too, and an "Update the issue"
  zone comments on and closes the GitHub or Linear issue a card came from.
  Each flow's Insights show, per zone, how many cards passed, failed or were
  sent back and how long they waited, how each script does, and every run's
  log; the lead reads the same numbers to tell you where things break.
- **Sorting with Jev.** A "Sort" zone asks [Jev](https://openrouter.ai/typesafe),
  TypeSafe's decision model, one question about each card through your own
  OpenRouter key: which of the zone's answers fits, how sure it is, and a few
  scores or yes/no notes (how urgent, asking for a refund). It answers in
  well under a second for a fraction of a cent, and can only ever pick one
  of your answers. Cards it's sure about go where their answer leads; the
  rest wait for a person, and every card shows what Jev decided. Insights
  count how often people moved a sorted card elsewhere, by how sure Jev
  was, so you can see when to trust it more. Five templates start from it:
  issue triage, a spam filter for public forms, lead routing, effort routing
  (small changes straight to a build, big ones through a plan) and exception
  routing (orders, invoices, deliveries).
- **Drafts, approved from your phone.** A "Draft" zone has Claude write a
  reply, summary or note from the card in a few seconds, with no repository
  and no tools, through the lead chat's sign-in. Nothing is sent by itself: the
  next "Person decides" zone puts the draft in front of the flow's owner (or
  whoever it names) in their chat app. On Telegram the message carries
  Approve, Edit and Send back: Edit takes your own version as a reply and
  brings it back to approve, and Send back takes a note and has Claude try
  again. In the console the same draft is an editable box on the card. Each
  flow has an owner (whoever made it, until handed on) whom these decisions
  go to.
- **Steps that reach outside.** A "Web request" zone calls an API with the
  card's details (its host is written out, so a card can't redirect it;
  secrets you save on the step go only into its headers). A "Send email" zone
  mails through your own mail server (Settings → Email: Gmail, Outlook,
  Fastmail, Resend, SES or any SMTP), and {{card.email}} is the address a card
  mentions. A "Use a tool" zone calls one of the project's MCP servers from
  the Tools page, like posting to Slack or adding a page to Notion. The Email
  replies template puts it together: Claude drafts, the flow's owner approves
  from their phone, and the reply is emailed.
- **Unified portfolio chat.** Read every project, prioritize queues, answer
  decisions, repair failed or cancelled dependencies, and confirm rich action
  cards from one conversation. The chat proposes; durable workflow state
  remains the source of truth.
- **Chat-first task handoff.** The default form is one outcome prompt. The
  repository-aware planner drafts the goal, boundaries, acceptance criteria,
  likely files, and a concise execution plan with milestones, dependencies,
  risks, and proof. Review or refine that plan before starting; approval locks
  the exact revision the builder receives. Expert controls remain under
  **Edit details**.
- **A plan that adapts without quietly widening what you signed.** While a
  build runs, it checkpoints which milestone is pending, in progress, done,
  or blocked — reported by the agent, never counted as completion proof. When
  the repository shows a stated dependency, risk, or approach was wrong, the
  builder can file one evidence-linked replacement plan and pause at a safe
  point. A plan-only refinement appends an immutable revision and resumes on
  its own; anything that would touch the goal, boundaries, touches,
  acceptance, permissions, quality, budget, or publication authority stays
  paused for your accept or reject. The task page and focused chat always
  show the same live progress, the same revision, and the same pending
  decision.
- **Structured handoffs repair their shape, not their meaning.** A malformed
  planner reply gets conservative syntax normalization, then at
  most two correction turns in the same session with the exact validation
  errors. Corrections cannot invent scope or criteria; every reply is sealed
  for audit, including replies rejected by provider or session checks, and
  workspace integrity is re-proved
  after each turn.
- **Long-running, recoverable execution.** There is no arbitrary task
  countdown. Installed workers survive terminal closure and reboot, recover
  expired claims, and continue until a terminal result, a real decision, or a
  signed no-progress/runaway breaker.
- **Subscription-native agents.** Use the Codex and Claude logins already on
  the machine. Dollar caps are optional; subscription usage is labeled as an
  API-price equivalent, never presented as an API charge.
- **Per-task autonomy with a global default.** Choose **Auto** or **Full
  access** for the installation, then override it on any task. The exact
  provider permission mode is sealed into the approved scope.
- **Explicit quality choices.** Default uses configured everyday agents;
  Strict / release requests stronger configured agents. The repository check
  remains authoritative for checks. Quality never starts a reviewer loop.
- **Revisions retain context.** Feedback, source result and selected project
  context remain attached to the task. Each requested revision receives its
  own scope and approval; earlier results remain available.
- **Honest completion.** Ready results include actual checks and saved work.
  The lead or user marks Complete after inspection. Failed checks stay failed;
  absent optional historical assessments do not block completion.


## Install

Choose your projects folder the first time:

```sh
npx toolroll up --project-root ~/Projects    # or: bunx toolroll up
```

That is the install and the setup. It needs Node 22.13 or newer on the
machine (Bun's runtime has no `node:sqlite`; `bunx` hands the shebang to
Node, so it works too). `npm install -g toolroll` gives you the
bare `toolroll` command for later (`standing-orders`, the older name, still
works).

`up` prints your login once (and saves it beside the database as
`up-login.txt`), opens the app in your browser, and connects this machine as
the builder. Add an existing folder or a GitHub repository from **Projects**;
the builder and unified chat pick it up while the app keeps running. The
projects folder and every added repository are remembered. Later,
`toolroll up` can be run from any directory and reconnects all of them.

To reach it from your phone over a tailnet:
`toolroll up --host 0.0.0.0 --allow-host <your-machine>.ts.net:4180`.

If the inbox says **Builder disconnected**, reopen Toolroll on the
machine where the projects live; queued work resumes automatically. You do not
run `up` separately in each project.

Advanced deployments can start the console alone with
`toolroll serve --repo .`: with no account yet it
prints a six-digit setup code, and the login page offers **create the
first account** — enter the code, pick a username and password, and you are
in. A second person joins by invite link from the people page, never by
another setup code.

```sh
npx toolroll demo               # a seeded sandbox — see it working in 90 seconds, zero spend
npx toolroll                    # what's in flight across your repos — read-only, zero config
```

## Getting started

There is one normal road: keep one `toolroll up` running on the machine.
It is the app and the builder for every saved project. The separate console,
worker, and OS service commands documented later are advanced deployment tools
for people splitting those parts across machines.

### In the console

1. **Sign in** with the login `up` printed. You land on the **inbox**:
   everything that waits on you, and nothing else.
2. **Describe the outcome** with **+ new task**. The normal path is one
   ChatGPT-style prompt: the planner inspects the open repository, drafts the
   goal, boundaries, acceptance rubric, and implementation approach, then asks
   only when a missing answer would materially change the work. Project and
   quality stay in the compact footer; **Edit details** reveals the full
   contract, research-only mode, permissions, dependencies, and expert fields.
3. **Review and approve the proposed scope.** A scope needs at least one
   criterion — a plain outcome statement and the evidence kind (check,
   screenshot, changed-path, or manual review) that will answer it — before it
   can be signed. The task page leads with a concise approval card; the full
   structured, editable execution plan and full contract remain one click
   away. It restates the exact scope AND rubric you are signing, the provider
   and model it will run on, and your password. Nothing spends a token until
   this yes.
4. **Watch it build.** The **board** moves the card to *building*; the
   card's own page shows the stage, the live transcript, and — once the
   agent checkpoints one — which milestone is pending, in progress, done,
   or blocked; **peek** (`/peek`, or *peek at the live ones →* on the builds
   page) shows every live agent at once. If the repository disproves a
   named dependency or risk, the task page shows the replacement plan with
   its evidence; a plan-only fix resumes on its own, while anything that
   would touch what you signed waits for your accept or reject, right
   there next to the plan.
5. **Answer when asked.** An agent that hits a judgement call parks a typed
   decision — question, options, consequences, which are reversible. It
   arrives in the inbox, on `/next`, and on your phone if Telegram is
   paired; one tap answers it and the build resumes.
6. **Collect the result.** A build becomes Ready with its saved diff, checks,
   available screenshots and limitations. Open the result to mark Complete or
   request a specific revision. A scout returns a report. Publication requires
   its own approved grant; task completion alone never publishes or deploys.

   Verification can recover one common environment failure without hiding it.
   Run `toolroll verify set ... --self-heal` without `--yes` first. The
   preview shows the exact approved setup and its digest; confirm only that
   preview by rerunning with `--setup-digest <shown> --yes`. If the project
   check cannot start because a required project executable is missing,
   Toolroll may run that setup once and retry the exact check once. It
   does not recover ordinary test failures, timeouts, or an executable that
   exists but cannot run. Every step stays in the check log. Recovery stops if
   the setup or project check changes, setup fails, files change, the checkout
   moves, unchanged files cannot be confirmed, the worker loses custody, or
   the executable is still missing.
7. **Inspect without the transcript.** Open the task's result for its summary,
   changes and checks. Annotate exact lines and request a revision when needed.
   Saved history and diagnostics remain available without becoming another
   mandatory review step. Older results retain their own links.

Specialized views remain in **Tools** and **Settings**: the activity ledger, the review cockpit,
the fleet,
people (invite a second approver), the operating mode (a signed, expiring
envelope that pre-approves your own filings), and **chat** — the mate, one
conversation across every project, which only ever proposes.

### In the terminal

```sh
toolroll task add "Give outbound webhooks a bounded retry policy" --id retries --repo .
toolroll task scope retries --goal "Exponential backoff, dead-letter after 24h, no payload changes" \
  --acceptance "A failing webhook retries with exponential backoff and dead-letters after 24h.|check"
toolroll task show retries --json          # the scope's digest is what you sign
toolroll task approve retries --as you --digest <digest> --yes   # asks for your password

toolroll peek                               # one pane per live agent; q leaves
toolroll decide <id> --choose <option>      # answer a parked decision
toolroll task show retries                  # attempts, outcome, where the branch is

toolroll task add "Why does the login test flake?" --id flaky --report   # a scout
toolroll chat --say "what is waiting on me across every project?"       # the mate
```

Every command takes `--json` and answers with one envelope; every mutation
takes `--key` so a retry never files twice. `toolroll --help` and
`toolroll skills get console` are the live references — the second
is what your coding agent reads when you ask it how something works.

An agent that hits a judgement call **parks a typed decision instead of
guessing** — answer it from the terminal, the console, or a Telegram tap,
and the freed build resumes in seconds. Built work leaves only as a pushed
branch and a pull request, under a publication grant whose exact terms you
approved.

## Unattended is not auto-accept

Every tool in this category has a mode where the agent stops asking —
usually named something like *auto-accept*, or worse. Here the boundaries
do not loosen when you leave the room:

| An agent here can never | Enforced by |
|---|---|
| touch a default branch | builds land on `toolroll/<task>` in a leased worktree; push + PR happen only under a publication grant naming the exact repo, branch prefix, and base |
| approve its own work | approval nonces are minted only on screens that restate the digest-bound terms, and require your approver token typed again — **no LLM sits in any approval path** — and the [agent fence](#what-an-agent-can-reach) keeps your remembered login, runner tokens and the database out of the agent's reach |
| act on an irreversible option | `reversible` is a schema field; irreversible choices never auto-apply, and answering one from a phone takes a second minted confirmation tap |
| see Toolroll's secrets | the [agent fence](#what-an-agent-can-reach) blocks your login, runner and bot tokens, stored provider keys and project tool secrets at the operating system; other providers' keys are stripped from each agent's environment; secrets live in 0600 files, never in the database, URLs, or logs |
| spend while idle | **an LLM never polls** — the daemon does every no-judgement chore at zero token cost and wakes an agent only on a real event |
| spend without being counted | every provider spawn is stamped *before* it spends, so cost is measured, never asserted |
| guess at a judgement call | it parks a typed decision — recap, options with reversibility, recommendation, evidence — and the other eleven tasks keep going |

The whole claim is executable: one test,
[`src/unattended.test.ts`](src/unattended.test.ts), queues twelve tasks,
walks away, and comes back to pull requests.

The name comes from a captain's night orders — the written standing instructions left for the officer of the watch: *proceed on this course without me, and wake me under exactly these conditions.* That is the product, and it is not about the hour: it is for **long-running work that outlasts your attention** — an afternoon of errands, a weekend, or yes, a night.

Toolroll is a control plane for coding agents, optimized for the stretch where **nobody is watching**. It owns the scheduler, the attention surface — the typed queue of things waiting on a human — and an append-only event log.

It owns a deliberately small local task store, adapts richer trackers when they are already there, and owns no worktree pool, no review gate, and no agents. Those are adapters over [`beads`](https://github.com/gastownhall/beads), [`treehouse`](https://github.com/kunchenguid/treehouse), [`no-mistakes`](https://github.com/kunchenguid/no-mistakes), `claude`, and `codex`.

## Two claims

**Sixty seconds to first value.** No init, no daemon start, no wizard, no OAuth app.

```sh
npx toolroll ~/code     # or: git clone … && npm install && npm run dev -- ~/code
```

It walks the filesystem for `.git` and reads every repo through the `git` credentials already on your machine, then shows what is in flight:

```
10 branches in flight across 24 repositories

vamarketplacenew                   main
  feat/wise-payouts                upstream gone       4d ago
  feature/public-api-v1            ahead 17            1mo ago
  api-pricing-impl                 behind 84           2mo ago

oddcircle                          redesign/instrumentation-cash-flag
  main                             ahead 3, behind 56  23d ago
```

No agent has run. Nothing has been configured, written, or installed. Every other tool in this space starts from an empty database it expects you to fill. `--json` emits the same thing as `{ scannedAt, roots, repos }`, because half the intended audience is an agent.

Reads are priced before they are made. Listing refs is O(refs) and finishes in milliseconds; `git status` is O(working tree) and was measured at over two minutes on a real repo, so it is off by default behind `--dirty`. Computing ahead/behind walks history — 22s cold on a 304MB repo — so it is bounded at 5s and degrades to a branch list that says what it withheld. Every call goes through `--no-optional-locks`, so a scan never takes the index lock from an editor you have open.

`toolroll pulls` answers the narrower question of what is waiting on a person, and `toolroll graph` says which work graph is already here:

```
Work graph — detected in your repos

▸ beads          2 repos · 47 ready · native deps · runtime ok (1.4.0)
  GitHub Issues  112 open · native deps · 2.67.0 too old, needs 2.94.0

Suggested: beads — the only work graph in your repos, and its runtime answers.
Nothing is enrolled, and detection grants nothing.
```

Backends are chosen by looking rather than asking, but **detection is not authorization** — finding a populated tracker says it exists, not that anyone wants an agent scheduling or closing what is in it. Data and runtime are detected separately, so a tracker whose binary is missing is reported as real work this machine cannot dispatch, which is a visible gap at 9am instead of a dead loop at 3am. Two populated trackers means neither is chosen: task count is not authority, and the biggest one may be the abandoned one. Where a fact is not established — Backlog.md's dependency edges, for instance — it is marked unverified and **fails closed**, because a private dependency graph other tools cannot see is shadow data.

**Nothing is ever installed for you.** `bd init` stages files, edits agent integrations, and can create a commit, so Toolroll prints the command and its side effects and lets you run it.

## Queueing work, and taking it

The built-in store is the fallback backend, and the commands over it are written for an agent first — because the agent is what runs them ten thousand times while you are away.

```sh
toolroll task add "migrate the payouts schema" --id schema
toolroll task add "wire the payouts API" --id api
toolroll task block api --on schema     # api waits for schema

toolroll ready --json                   # what could be dispatched now
toolroll claim schema --runner builder-1 --key dispatch-schema
toolroll heartbeat <lease>              # still working
toolroll release <lease>                # done holding it
```

Four properties make that loop safe to run unattended.

**Every outcome is data.** `--json` returns the same envelope from every command, failures included: `{ ok, command, reason, message }`. `reason` is a stable token — `held`, `fenced`, `unknown-task` — because prose gets reworded and anything branching on it breaks silently. The binary teaches its own surface: `contract --commands` dumps the declared command guide, and `skills get <name>` serves version-matched operating guides straight from the exact build an agent is driving — never a stale snapshot.

**Exit codes separate "no" from "broken".** `0` got it · `1` something broke · `2` bad usage · `3` ran fine, the answer is no. Losing a claim race and finding the ready set empty are correct answers, not errors, and a loop that stops on them is as wrong as one that ignores real breakage.

**Every mutation takes `--key`.** An agent whose command succeeded but whose output was lost *will* retry. With a key that retry returns the first answer instead of queueing a second task or taking a second lease. Mutations that changed nothing are never recorded, so a refusal never becomes a permanent no.

**`fenced` means stop.** A runner whose machine slept, whose lease expired, and whose task was reclaimed will be told exactly that at its next heartbeat — long before it finishes work nobody will accept. Dispatch is a compare-and-swap on `(task, lease_generation)`, enforced by the database rather than by anything the caller remembers to check.

## The unattended pass

`toolroll tick` is the loop above with nobody typing it, once per invocation:

```sh
toolroll tick --runner builder-1 --token <t> --repo ~/code/thing --max 1
```

One pass: take the ready set, skip what nobody approved, claim what is left — re-proving readiness inside the same transaction as the claim, because the world moves between a list and a take — build each task in a leased worktree on `toolroll/<task-id>`, and commit. **Tick itself never pushes** and cannot touch the default branch; pushing and opening the pull request happen only under a publication grant whose exact repository, branch prefix, and base you approved — and merging stays yours, on GitHub.

It is deliberately a pass and not a daemon: point cron at it and the fences make repetition safe — a second pass finds the first's work done and converges to `empty` (exit 3) instead of building anything twice. A broken build marks its task `failed` and the pass exits 1 even if other tasks succeeded, because exit 0 has to mean "nothing needs you". Refusals that are really a person's pending decision — a scope nobody approved, or one that changed after approval — leave the task queued and untouched.

## Advanced: a separate background builder

Normal local use does not require this section: `toolroll up` is the
product command. For a remote or split deployment, the builder loop can manage
itself as an OS service — launchd on macOS, systemd on
Linux, Task Scheduler on Windows, chosen automatically — so "set it
running" is one command, and reboots and crashes are the supervisor's
problem:

```sh
toolroll daemon install --runner builder-1 --token <runner-token> --repo ~/code/thing
toolroll daemon status      # running, as which pid, logs where
toolroll daemon logs        # the file to tail
toolroll daemon uninstall   # take it back off
```

The service restarts after a crash and after an unexpected clean exit alike
(launchd `KeepAlive`, systemd `Restart=always`, a restart loop under Task
Scheduler); `daemon install` is idempotent on a healthy running service and
really reloads a changed definition; `daemon uninstall` unloads and disables
it. `--containment observed|preferred|required` chooses how provider, setup
and check processes are bounded: a delegated cgroup v2 on Linux or a Job
Object on Windows when native, the observational tree scan otherwise —
`required` refuses to spawn rather than silently downgrading (macOS has no
native equivalent; the status says so and names the Linux route). The
contract and boundaries are in
[docs/PROCESS_CONTAINMENT.md](docs/PROCESS_CONTAINMENT.md).

Under the hood it runs `toolroll watch`: a work-conserving loop that
composes the same passes cron would call — but wakes on events (a decision
answered from your phone dispatches the next build in seconds), recovers
its own predecessor's mid-flight work after a crash, and spends zero tokens
while idle. The runner token lives in a 0600 file beside the database; the
service unit never carries it. Cron remains first-class if you prefer it —
`reconcile && tick ; bridge telegram` on a schedule does the same jobs at
cron's cadence, and a stray cron tick alongside a watch is safe (ordinary
claims settle the race), it just is not needed.

An honesty note for Windows: every pull request now type-checks, builds, and
runs the native Task Scheduler/link tests plus the core dispatch contract on
Windows with Node 22 and 24. Approved setup and verification commands use
Windows' native command shell. The scheduled-task definition follows the Task
Scheduler XML schema and every `schtasks` interaction is covered by scripted
tests. A physical Windows install has not yet been certified; the exact
real-provider and post-reboot checklist is in the
[Never Stuck release certification](https://github.com/ap9000/toolroll/blob/main/docs/CERTIFICATION.md).

### Unattended permissions

The console's **Settings → unattended permissions** control chooses the
starting policy for new tasks. **Auto** lets routine repository commands and
edits proceed while the provider may stop on a risky permission request.
**Full access** runs Claude with `--dangerously-skip-permissions`, Codex (and
its OpenRouter transport) in its own sandbox widened to write anywhere with
network on, and Gemini with `--approval-mode yolo`, so permission prompts
cannot pause work while you are away. A Full access agent can change files
anywhere on your computer outside the [agent fence](#what-an-agent-can-reach).
Use Full access only for repositories and setup commands you trust.

### What an agent can reach

Agents run as your own user, so Toolroll fences its own secrets off
from them at the operating system, in every permission mode. The fence covers
the state folder beside the database (your remembered login `up-login.txt`,
runner and coordinator tokens, chat bot tokens, the database and its backups,
other runs' evidence) — everything there except the build's own worktree —
and `~/.toolroll` (stored provider keys and project tool secrets).

| | Auto | Full access |
|---|---|---|
| **Codex / OpenRouter** (any OS) | Codex's workspace sandbox (workspace writes, no network) with the fence | Codex's sandbox widened to write anywhere with network, with the fence |
| **Claude** | macOS: the agent runs inside a sandbox that denies the fence. Linux/Windows: Claude's own file tools refuse the fence, but its shell is not fenced yet | same |
| **Gemini** | macOS: fenced like Claude. Linux/Windows: not fenced yet | same |

Each attempt records how it was fenced. Two limits to know: in **API-key
mode** an agent's own provider key is in its environment, so its shell can
read it (subscription mode, the default, puts no key there); and a project's
own tool secrets reach that project's tools. Reviews and the lead chat run
with no tools and are confined to their own files. See [SECURITY.md](SECURITY.md).

Every new-task and task-scope form has the same two-choice control. A task's
choice is durable through planning rewrites and is sealed into the approved
execution profile; changing the installation default never broadens an
existing scope or approval.

### Quality modes

The **quality mode** setting selects routine or stronger configured agents.
**Strict / release** requests the stronger tier; it does not start an isolated
reviewer or automatic repair. The choice is signed into each scope, survives
later global changes, and remains visible in approval and run details.
Repository checks still run through the approved verifier. Publication and
deployment require their own authority and checks.

### Explainable phase routing

Which agent plans, builds, and repairs a task is decided once, from
signed facts, and written down with its reasons. The route reads the task's
**size** (small, medium, large, risky or not), its quality mode, what the
acceptance rubric demands (screenshots, manual review), how far a live
operating mode may carry the result unattended, each provider's plan room, and
the agents you configured for each phase. Strength is never
inferred from a model's name: the ordinary phase row is the routine tier, and
`config set <phase> --tier strong --provider <p> --model <m>` names the agent
large or risky, strict, screenshot-proof, and automerge routes reach for. With no
strong row, a demanding task keeps the default and says so.

```
toolroll task route <id> --size large --as you --token <t>
toolroll task route <id>                     # every leg, its reason, its readiness
toolroll task route <id> --phase build --provider codex --model gpt-5-codex --as you --token <t>
toolroll task route <id> --clear-phase build --as you --token <t>
toolroll providers --report --runner <name> --token <t>   # this machine's readiness
```

Every leg is **exact**: approvals bind a provider *and* a model id for the
planner, builder, and repair alike, so each phase names its model
once (`config set plan --provider claude --model <m>`, and the same for
`build`; repair inherits the build's model unless a same-provider
repair row names another). A phase without an exact model, a repair row on
another provider, or an unknown provider files the scope **unresolved** with
the words to fix it — nothing is guessed or substituted. Every override names
an exact model too, and a plan override becomes the planner pin.

Every override is recorded under the approver's name, in one transaction that
checks the scope you were reading is still the one on file (`--digest`, or the
form's own field). Approval seals the route — routine-shaped routes included —
exactly as it seals the execution profile; a later size change or override
re-files the scope and the old
approval reads stale, while a global configuration change can never rewrite a
sealed route. A row filed before routing existed is recognised by a durable
marker and stays governed by its sealed profile; a routed row whose route data
is missing or unreadable is refused everywhere until re-filed and approved
again. Repairs always stay on the build provider. Runners report provider
readiness without spending — at startup and with `providers --report`, never
on a timer — and the task page, the chat, and `task show` say **ready**,
**unavailable** (with the runner's own words), or **unknown** beside the
agents, outside what the approval signs; an unavailable provider halts before
any claim and is never substituted. When a provider's plan runs out mid-build,
the attempt fails with its reason like any other failure and the task waits
for a retry or for you; nothing switches to another agent or account on its
own. Every run is stamped with its route and the actual provider and model at
admission — set once; a run that would spend as anything else refuses.

Admission proves that stamp before any run row exists: its shape (a known
phase, provenance word, and provider; a digest; an exact, argv-safe model id),
its phase against the run's role, its provider and model against what the run
would spend as, and its provenance against the authority the task actually
holds — the sealed route's digest and that phase's exact leg, or a proven
pre-routing row for `legacy`, whose stamp must name the very sealed profile
(and, for a build or repair, its exact pair) — the bare word `legacy` belongs
only to a task with no scope. A task filed under routing never opens an
unstamped run, and the store dictates nothing: every planner, builder, scout,
reviewer, and repair turn **presents** the exact authority it holds
(`routeAuthorityFor` puts it in the caller's hands, in words), and a missing,
forged, stale, or inexact stamp opens no row — the refusal names what would
have had to be presented. A repair turn mends exactly its same-task parent
under the claim that holds the task now. A run admitted under a route the scope
has since re-sealed away refuses to spend. Malformed authority — corrupt route
or profile JSON, a model id that is not one, a turn bound or clock that is not
a positive whole number — fails closed in words and never shrinks.

Fallback chains and the declared risk level were removed (schema v115). An
unfinished task that was filed or approved with fallback agents asks again
after the update — its scope says so, and saving it once chooses its
agents; finished tasks and routes sealed at elevated or high risk keep their
exact bytes and still verify.

Codex resumes carry their sandbox as a configuration override (`-c
sandbox_mode=…`): `codex exec resume` has no `--sandbox` flag, so a structured
correction or repair-by-resume handed one exited before it initialized. A
resume the harness refuses by its own protocol, or never comes up for, ends
the planning attempt with its typed reason — the recorded session is not
resumed twice — and the next attempt, after the planning backoff, is a fresh
planner root in a fresh session.

A **scheduled flow** with a standing order files an ordinary task each time
it fires: the order's terms (goal, exclusions, touches, requirements, success
checks, per-run budget) are copied into the task's scope unchanged, and the
task waits for approval under the project's approval rules like any other
proposal. A standing order moved over from an old routine keeps that routine's
approval and its frozen agents while they still verify: each firing re-hashes
the frozen snapshot against the approval, holds the build and repair legs to
the sealed profile's exact provider and model, and rolls the whole firing back
unless the task seals under it — a later `config set` cannot re-route it. Once
that approval no longer verifies, each firing says why and waits for approval
as an ordinary proposal. `toolroll flows show` prints a standing order's
terms; `toolroll flows trigger pause|resume` (or **Resume** on the flow canvas)
stops and starts its schedule.

Every approval surface — the task page, the focused chat, and `/next` — shows
the same concise line of exact agents above the password, with why stronger
agents run explained in plain words and the runtime limits one tap away; changing
any agent invalidates the approval every surface signed under. Where no yes
could bind — an unreadable route, a route that cannot run, or a pre-routing
row whose old approval no longer stands — those surfaces mint no nonce and
show no password or approve button, only the reason and the act that opens it
(re-file the scope or change the agents) — the inbox row reads *needs
attention* rather than *review & approve*; an old approval already on a
pre-routing row is grandfathered, but no new yes lands on it. In the demo sandbox, Chat is a
scripted lead that never calls a model; real chat evidence is a subscription-backed plane. The task page's controls offer,
per role, only the agents you configured *for that role* (gemini never
reviews; repairs stay on the build provider), a current agent the
configuration no longer names is shown for what runs today and never offered
again, and each size says what it does — truthfully under strict quality and
screenshot proof too. Chat reads the same route (`get_agents`)
and proposes one confirmation-gated change (`propose_agents`) — a size, one
role switched to a listed agent, or a hand-picked role cleared — which lands,
when you confirm the card, through the same authenticated route edit the page
uses; the chosen agent is re-proved against the role's configured choices
*inside* that transaction, so a card drafted against yesterday's
configuration changes nothing.

## The phone, both directions

The Telegram bridge closes the loop without a terminal: a parked decision
arrives as a message with one button per option, and a tap answers it
through the same authenticated path as the CLI and the web view — the hold
lifts, and the next pass resumes the task with the answer in the agent's
brief. No LLM is anywhere in this path.

Setup, once:

1. In Telegram, message **@BotFather**: `/newbot`, pick a name and a
   username. Copy the token it hands you.
2. `toolroll bridge telegram token <that-token>` — stored in a 0600 file
   beside the database (or set `TOOLROLL_TELEGRAM_TOKEN`, which wins;
   or paste it into `serve`'s settings card from your phone).
3. `toolroll approver add you --password <yours>` if you have no
   sign-in yet — that name and password are the login for the console and
   every approving act. (Omit `--password` and a high-entropy one is
   minted and printed once instead — better for API/bearer use.)
4. `toolroll bridge telegram pair --as you --token <approver-token>` —
   prints a one-time code, good for ten minutes.
5. From your phone, open your bot's chat, press Start, send
   `/pair <that-code>`, then run `toolroll bridge telegram` once to
   complete it. The bot replies with who the chat now answers as.

Then cron the pass next to `tick`:

```sh
toolroll bridge telegram        # sends pending, applies taps, exits
```

Once paired, an ordinary message in that chat talks to the same assistant
as the console's chat page and `toolroll chat`: the same saved
thread, the same proposal cards (Confirm or Dismiss under each one), the
same confirm doors, with the phone recorded as the source. `/status`,
`/task <id>` and `/help` stay cheap, model-free reads. Reply to a result
message to ask for changes to that exact result; approvals that take a
password, cancelling and publishing still happen on the computer. Chat from
the phone uses your configured membership provider only; a direct-API
configuration is never spent from Telegram.

`bridge telegram status` shows the token source, the binding, and what is
waiting. For answers in seconds instead of at the next cron firing,
`toolroll bridge telegram --follow` stays on the wire — one long-poll
actor holding the same poll lease, so a cron pass overlapping it simply
loses the race. `toolroll watch` embeds the same follower automatically
when a bot token is configured: a tap on your phone answers the decision,
the answer wakes the loop, and the freed task resumes — phone to build,
no timer in between.

**Away mode.** `toolroll bridge telegram digest --every 2h` (or
`--off`, or the console's settings card) holds routine facts — merges,
reports, retries, plans ready — and sends them as one digest on that
cadence. A decision, and anything that needs a person now (a stalled
task, a malformed payload, a gap that blocks work), still pages the
moment it lands. `bridge telegram status` says how many facts are held.

**Check work from your phone.** In the paired private chat, send `/status`
for recent work across enrolled projects, `/task <id>` for one task's exact
state, recorded evidence, delivery status and next step, or `/help` for the
available commands. These read existing workflow records without a model call
or task mutation. A saved branch, a pending review, and a merged PR stay
distinct. `/status` covers the newest 60 tasks, explicitly says when older
work is omitted, and shows up to two rows per group; `/task` can look up older
tasks directly. The computer and bridge must be awake and connected. These
commands are not yet free-form task creation or revision chat; use the console
for those. See [phone status and its limits](docs/PHONE_STATUS.md).

A chat is not a person: pairing binds one private chat and one immutable
Telegram user id to one approver credential. Buttons carry opaque one-time
tokens whose meaning lives in the local database — a stolen bot token can
read what was sent and repaint keyboards, but it cannot mint a token,
answer as you, or arm an irreversible choice, which takes a second minted
confirmation tap. Rotating your approver credential strands the chat and
every outstanding button, and the bot token itself is stripped from every
agent's environment.

## Peeking at the agents

```sh
toolroll peek            # one pane per live run: stage, clock, what the agent is saying
toolroll peek 42         # follow one run until it finishes
toolroll peek --tmux     # a real tmux session, one window per run
```

The panes tail each run's live transcript, the same file the console's
run page follows: the text the agent said and the kind of tool it reached
for (editing files, running a command, searching the code), never file
contents or command lines, with credential-shaped lines redacted at
write. Digits focus one pane, `a` shows them all, `q` leaves. Outside a
terminal, or with `--json`, it prints one snapshot and exits.

## The mate, and the gateway

`/chat` in the console (or `toolroll chat` in the terminal) is one
conversation across every project you serve. The mate reads the fleet
and **only proposes**: file a task (or a scout), move one to the front,
reserve it for a worker, hold it, rewrite a scope, retry/replace/unlink a
terminal dependency, guide a task's next attempt, cancel, or suggest an answer to a parked decision. Every
proposal is a card you confirm, with
every consequence and the builder's recommendation shown beside the
mate's pick; a scope the mate wrote never seals under an operating mode.
Absolute paths, internal digests and account names are redacted; source context includes relative file citations. Direct API use spends
against a ceiling you set per conversation. The console keeps a live pulse for every
admitted project beside that shared thread, with one-click fleet questions
and a direct road to each project's board.

Every task has an **Overview / Ask** switch. **Ask** opens a focused companion
to that task without creating another conversation: Toolroll attaches
the current task to each new message, keeps the live status beside the thread,
and offers plain-language starters for status, scope revision, steering, and
result inspection. Proposed guidance is inert until you confirm its card, then it
reaches the next attempt without interrupting work already running.

New work starts the same way: describe the outcome once in ordinary language.
The mate infers a concise title, narrow scope, safe non-goals, and proof
criteria; it asks only when the project or outcome is genuinely ambiguous, or
when an irreversible or compatibility tradeoff changes what should be built.
Questions are grouped, carry a recommended default, and stop for reversible
choices when you say **use your judgment**. The task card says whether Standing
Orders will inspect the repository and draft a plan before asking you to
approve anything.

When a task finishes, both views lead with the same Ready status and result.
Open the work and its actual checks, then mark Complete or request changes.
Historical diagnostics remain available in details; optional missing assessments
do not create another review stage. Chat cannot rewrite the stored result.

The evidence page opens the sealed patch in a clean **View** mode. Switch to
**Annotate** only when you need a change: select the exact line, leave plain-
language feedback, and collect as many notes as needed. Creating a revision is
a separate, optional act that seals the exact annotation batch into one scoped
task for approval; ordinary result review never requires it.

The chat setup screen defaults to **Codex membership · default model**.
Run `codex login` once on the machine serving Toolroll, choose that
provider, and there is no Toolroll dollar maximum. The conversation
stays live until you end it; the daily turn limit and your plan's own upstream
limits still apply. Anthropic
membership works the same way after signing in with the `claude` CLI. Direct
`anthropic-api` and `openrouter-api` modes remain available; only those modes
ask for weekly and per-conversation dollar ceilings.

```sh
codex login
toolroll config set chat --provider codex-subscription --as you --token <password>
toolroll serve --repo /path/to/project-a --repo /path/to/project-b
# Open /chat, type your password once to start the conversation, then talk.
```

Coding agents you run elsewhere reach the same plane through the MCP
gateway: `toolroll mcp` serves a coordinator credential you mint,
bound to named repositories, that can read the fleet, file quarantined
proposals, and propose the same guarded acts — `toolroll proposals`
and the task page are where you confirm them. Both roads keep the one
rule: the plane never acts on a model's word.

## The console

`toolroll serve --repo <path>` is no longer just the decision view — it
is the whole built-in queue, operable from a phone: an inbox of everything
waiting on you, a live activity report (run counts, measured spend,
decisions, incidents, stranded work, gaps), every task with its scope, holds, runs, decisions and
incidents on one screen, run pages with the economics and the agent's
concluding words, and read-only capabilities. Adding a task, holding,
requeuing, cancelling, and editing a scope all happen from the page — each
re-proved server-side, so a stale tab never erases what the world did in
the meantime, and a task a runner is building right now refuses to be
cancelled out from under it.

Approving a scope is deliberately heavier than a click: the form restates
the goal, the exclusions, and the touched paths — exactly the fields the
approval digest binds — and requires your approver token typed again. A
logged-in session alone can read everything and approve nothing.

Plain HTTP, so keep it on localhost or a tailnet and put TLS in front for
anything else.

### Webhooks through a reverse proxy

Flow triggers can take webhooks from GitHub, Linear or any service at a
secret address under `/hooks/`. Keep the console itself private (on your
tailnet or localhost) and expose only that path. With Caddy:

```caddy
hooks.example.com {
	handle /hooks/* {
		reverse_proxy 127.0.0.1:4180 {
			header_up Host {upstream_hostport}
		}
	}
	respond 404
}
```

Then save `https://hooks.example.com` as the public webhook address on a
flow's Triggers panel. GitHub deliveries are proved with the secret the
panel shows once; Linear deliveries with Linear's own signing secret, pasted
on the panel behind your password. Addresses are never stored readable: a
lost one is replaced with **New address**, which retires the old.

## Steering a fleet, not just a task

Everything below ships in 0.4.0:

- **The queue screen** — every worker's up-next list as columns, like a
  music queue: drag to reorder, drag into a worker's column to reserve a
  task for it (each column wears an editable theme note), top is taken
  first. A worker drains its own column, then the shared queue. The
  reservation is enforced in the claim primitive itself — the wrong
  worker's claim gets a typed `reserved` refusal, however it asks.
- **Chains and "this one first"** — `task block/unblock` wires
  dependencies (cycles refused), "starts after" on the filing form,
  `task next` moves work to the front of its own queue. Scheduling,
  never authority: approvals are untouched by any of it.
- **The live peek** — a running build's page shows what is changing in
  its checkout right now (names and counts, never contents), through a
  native reader that executes nothing — no git command ever runs
  against an agent-controlled worktree.
- **External dispatch** — enroll a GitHub repository with an explicit
  dispatch grant and its labeled issues become ordinary local tasks:
  scoped and approved HERE (issue bodies are never imported — a tracker
  anyone can write to is a prompt-injection surface), built unattended,
  answered back with a PR-link comment under exactly the write classes
  you granted. An issue closed mid-build can never publish: the
  completion transaction disowns it, keeps the branch as evidence, and
  says so. Done stays done — remote closure never regresses a completed
  dependency. Revisions ride review comments: mark up the finished
  diff (or let granted reviewers do it from the PR) and seal the batch
  into one new approval-bound task.
- **Operating modes** — a per-repository, password-signed, expiring
  envelope that pre-authorizes the SIGNER'S OWN future acts: your
  filings approve themselves the moment you file them, merges fire themselves when CI
  is seen green on the exact authorized commit (only through a merge
  grant, never around one), and daily run/dollar rails bound the spend.
  Every term renders in words at the signing ceremony — including the
  sentence "your signed-in browser session becomes a spend credential
  for this repository" — and ending it all is one click, for any
  approver, at any moment. No mode signed means nothing changes: every
  act keeps its own ceremony, the default forever.
- **The reviewer** — an agent pass over a finished build's sealed diff,
  and nothing else: no worktree, no repository access — the patch is
  re-verified against its recorded hash, comments are proven
  patch-local, and they land beside your own for YOU to prune and seal
  into a revision task. A revision keeps the source's contract — its
  goal, exclusions, touches, exact rubric, quality,
  permission posture, and budget ceiling — however the installation's
  defaults have changed since, re-resolves its agents for a fresh
  approval, and inherits no approval, session, publication, or merge
  grant (the policy is [docs/REVISION_TERMS.md](docs/REVISION_TERMS.md)).
  One successful review per build, ever; a mode
  can run one on every finished build automatically. A review that
  fails or is interrupted may be retried EXPLICITLY — `task review
  <run>` again, or the task/result page's **Retry review** — at most
  twice (three root attempts in all). Each retry is a fresh request and
  a fresh reviewer admitted under the build's current sealed route with
  every sealed input re-verified; the failed attempts stay on record;
  a review that succeeded, or one still queued or running, is never
  retried; nothing retries by itself, and the source build is never
  rerun. A retry is an operator's act only: the mode's and the Strict /
  release scope's automatic review asks are one shot per build, and a
  replayed one is refused at request and again at admission, before any
  money.
- **People** — invite someone with a single-use link that pins their
  powers at mint (watch everything, or approve and act), see who is
  doing what, and remove access with one ceremony that actually severs:
  sessions, invites, and every mode they signed end together, while
  history stays attributed forever.
- **Scout tasks** — `task add … --report` (or the "scout" checkbox, or
  the mate's `propose_task` with `report: true`) files a task whose
  deliverable is a report, never a branch: once its scope is approved,
  a read-only session investigates the goal as a question and hands
  back a title, a summary, a document, and up to five follow-ups, each
  of which files as a task with one tap. The workspace is proven
  untouched before a byte of the report is read; a scout that changed
  anything gets nothing ingested.

## Writing to a tracker you already have

Detection tells you what is there; a grant is what lets anything be written to it.

```sh
toolroll enroll . --backend github-issues --paths owner/name   # shows the terms
toolroll enroll . --backend github-issues --paths owner/name --yes
toolroll grants          # what has been granted, and to what
toolroll revoke .        # take it back

toolroll ready --backend github-issues     # reads need no grant
toolroll task add "..." --backend beads    # writes do
```

The grant is not a boolean. It records which paths or repositories may be touched, which mutation classes are allowed, which tasks are covered, which credential scope applies, and whether the writes will turn up in `git status` — that last one asked of `git check-ignore` rather than assumed. Two defaults carry weight: only tasks Toolroll created or was given, because enrolling a repo with four hundred open issues is not volunteering all four hundred; and `close` is withheld, because closing what somebody else filed is not the same act as transitioning your own task.

Every backend goes through the same contract, and the authorization wraps it rather than living inside each adapter — an adapter written later inherits the check instead of having to remember it.

**Edges are never emulated.** beads has native dependencies and they are used. This GitHub adapter has not confirmed the dependency endpoint against a live repository, so `addEdge` refuses rather than storing a graph only Toolroll can see — one that would read as ready to every human on the repo. That is the design's rule, and the refusal says so.

The beads adapter is built to beads' own documentation and exercised against a stubbed runner; it has never run against a real installation, because `bd` was not present on the machine it was written on. Commands whose flags could not be established — a general status update, in particular — refuse rather than guess.

The materialised snapshot M0 promised shipped as **external dispatch**: a `sync` pass mirrors a tracker's nominated issues into the queue as ordinary local tasks (titles only, validated; bodies never), so the scheduler's hot path never touches the network — see below.

**It survives the night, cheaply.** Work dispatches itself from a dependency graph, fails safely, and parks a *typed* decision — recap, options with reversibility, a recommendation, evidence — instead of guessing. Parking never stalls the loop; the blocked task steps aside and eleven others keep going.

And it costs nothing while idle. **An LLM never polls.** The daemon handles everything that needs no judgement — ticks, capability probes, lease reaping, CI polling, notifications — at zero token cost, and wakes an agent only on a real event. The target is a testable invariant: an eight-hour run with twelve tasks shows near-zero token spend across idle windows.

## What breaks overnight, and the answer

| Failure | Mechanism |
|---|---|
| Expired key found at 3am after 40k wasted tokens | capabilities probed *before* dispatch; gaps ranked by tasks unblocked |
| A runner dies holding a worktree | `Claim` with an immutable lease id and a fencing generation; late completions rejected |
| A build fails, then fails the same way again | typed strikes with doubling backoff; three strikes stalls the task for a person, who exits it with `task requeue` |
| You wake to five transcripts | one briefing: what ran, what is blocked, what needs deciding |

## Status

**0.4.0 — schema v29, suite 1,369.** The M4 loop plus tournaments, the
live peek and live transcript, chains and queue ordering, per-worker
queue columns, external dispatch, merge grants with observed-green CI
and a fourteen-transition merge machine (per-merge human authorization
by default; a signed automerge mode may substitute for exactly that
yes, re-proved at the moment of firing), the phone PWA with
zero-dependency push, the attended core (governed live sessions:
signed terms, mid-session conversation, crash custody, continuation,
N parallel sessions per worker), the attested runtime (four providers
— Claude, Codex, OpenRouter, Gemini — the last admitted by versioned
conformance, never a registry row), labeled cross-runtime comparisons
with honest per-lane money, operating modes with their daily rails,
the artifact-only reviewer, and multi-user instances with invite
links, roles, and a People screen. Project access now supports viewer/operator
invitations restricted to selected repositories, with an action ledger for
people and unattended work. See [Project access and action ledger v1](docs/PROJECT_ACCESS_LEDGER.md)

[Automatic approvals](docs/AUTO_APPROVAL.md) explains the signed project policy for scope filings, unchanged plans, reviews, repairs, and merges.

for its permissions, history coverage, and migration behavior.
Earlier arcs shipped behind their own adversarial review rounds;
docs/PROGRESS.md records those findings.

**M4 built.** The whole loop runs: `toolroll watch` (or `daemon
install` — no crontab) dispatches approved work, spends nothing while idle,
survives crashes by recovering exactly its own predecessor's claims, and
stops taking work on the first signal. Failures are typed — strikes,
doubling backoff, three-strike stalls a person exits with `task requeue` —
and every provider spawn is stamped before it spends, so cost is measured,
never asserted. CI on published PRs is watched as episodes that never call
silence green. The whole unattended stretch is one test,
[`src/unattended.test.ts`](src/unattended.test.ts): queue twelve, walk
away, come back to PRs. Architecture: [`docs/DESIGN.md`](docs/DESIGN.md);
the item-by-item ledger: [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Milestones

| | | |
|---|---|---|
| M0 | discovery, graph adapters, leases, CLI | `npx toolroll` shows what is in flight — **useful before it is autonomous** |
| M1 | runners, worktrees, first builder | one task goes queued → branch → commit unattended |
| M2 | capability probes, secrets, briefing | fill one gap, three tasks start |
| M3 | decisions, evidence, web view | a park renders as one screen, answerable on a phone — **and it does, executably** |
| M4 | the loop | **queue twelve, sleep, wake to PRs — with near-zero idle spend** |

Deferred until M4 earns them: the spatial board, multiplayer, in-browser terminals, Postgres, RBAC.

M4 is the product. M0 is what makes anyone install it long enough to reach M4.

## Not competing with

[**agor**](https://github.com/preset-io/agor) owns the execution-plane category and does it well — browser UI, six runtimes, multiplayer, a spatial board. It optimizes for a team steering agents *live*; we optimize for nobody being awake. It is BSL 1.1; this is MIT.

[**firstmate**](https://github.com/kunchenguid/firstmate) proves the orchestrator role works as conventions plus tmux, with no UI and no schema. Its event-driven bash watcher is where the zero-token supervision rule came from. Our bet is that the same role is better with a typed decision record and a browser you can answer from.

## Contributing

The most useful surface is a **provider adapter** — `src/provider.ts` is
the only module that names an agent binary, and
[CONTRIBUTING.md](CONTRIBUTING.md) walks the contract. Bug reports want
`--json` output; the issue forms say what else. Every behavior lands with
a test — the suite is the specification.

`npm run e2e:flows` checks flows end to end with nothing stubbed: a throwaway
instance (the real CLI, console and worker) on a scratch repository, driven
through a real browser, with real Claude turns for the lead and one real
build. It needs `claude` and `gh` logged in and Playwright's Chromium, takes
about seven minutes, and writes `report.md`, screenshots and both logs to
`output/e2e/`.

## Credits

The workflow this formalizes comes from [Jason Ku's agentic engineering session](https://youtu.be/Ukju3maxbEQ) and his [`agents-md-snippets`](https://github.com/jasonku09/agents-md-snippets), plus Kun Chen's `treehouse`, `no-mistakes`, `gnhf`, `tasks-axi`, and `axi`. The design was reviewed adversarially by Codex; the appendix in `docs/DESIGN.md` lists every claim that review falsified, because the corrections are more useful than a clean spec would have been.

## License

[MIT](LICENSE).

### Desktop app and project setup

A local macOS shell, guided project setup, provider/model discovery, and weekly
schedules with timezones use the same controller and approval flow as the CLI.
The local native build also includes **File → Install app update** and
**Update status**: same-schema updates drain current work, verify a private
backup, atomically swap the app, and restore the previous app on failed health
checks without replacing newer task data. An independent temporary macOS job
automatically recovers an interrupted updater without reopening the window;
bounded retries and a persistent Stop request prevent endless recovery or
restarting work you stopped. Signed-release permission persistence
and physical reboot acceptance remain release gates, not claims from unit tests.
See [build and usage instructions](docs/control-app.md) and
[the integration assessment](docs/CONTROL_APP_INTEGRATION.md).
