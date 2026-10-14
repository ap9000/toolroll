# Tasks, results and revisions

Tell Toolroll what outcome you want. Its planner reads the repository,
drafts the scope and proof rubric, and asks only when an answer would materially
change the work. You approve the exact contract once; long-running agents can
build it while the control plane handles queues, dependencies,
crashes, and decisions. The result comes back with the diff, checks, screenshots,
and a criterion-by-criterion verdict.

## Hand off in one prompt; approve exactly what will run

Project and quality stay close to the prompt; expert fields appear only when
you open them. Before execution, the approval card restates the goal,
boundaries, evidence requirements, model, and permissions.

<div align="center">
  <img src="../media/ui/tasks-mobile.png" alt="The Tasks view on a phone: each task with its status and the one action that settles it." width="260">
  &nbsp;
  <img src="../media/ui/scope-approval.png" alt="The scope you approve: goal, what is out of bounds, the files it may touch, acceptance criteria with their evidence, quality, permissions and the agents that will build it." width="640">
</div>

## One lead, durable crew work

Start in **Chat**, inspect work in **Tasks**, and manage guidance in **Projects**.
Browser and CLI chat share the lead conversation. A local database catch-up shows
current decisions and results before you authorize any model usage.

Crew work ends at **Ready**. Open the result, mark it **Complete**, or request a
specific revision of the same task. Actual checks remain visible; there is no
separate model reviewer or automatic evidence resubmission loop. Deployment is
reported separately and still requires the exact passing native machine check.

Enable **Automatic crew updates** in a conversation, or use `toolroll chat
--follow`. Meaningful updates (a result, a question, completion or cancellation)
reach the same lead within its saved permissions and limits, through the same
acknowledged inbox an external coordinator reads. Idle scanning uses no model.
Restart recovery reuses saved responses; a failed response does not rerun a task. `--no-follow` pauses automatic responses.
This wakes Toolroll's own lead, not an unrelated external agent session.

`toolroll brief` reads the local database. `knowledge search`, `knowledge
impact`, and `knowledge refresh` add bounded source retrieval; see
[repository context](../REPOSITORY_CONTEXT.md). Curated knowledge stays in the
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

## What is in the current build

- **Guided workflow recipes.** Choose a starter, customize its outcome and
  success checks, and preview the steps before creating one-time or scheduled
  work. Save project recipes for teammates, reuse a task's scope, or share a
  portable JSON definition. Creation retries return the same work; existing
  approval and recovery rules apply. [Get started](../WORKFLOW_RECIPES.md).
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
  (see [Webhooks](flows.md#webhooks-through-a-reverse-proxy)). A button can also be
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
