# Changelog

## 0.9.56 — 2026-10-09

- **One lead.** Your assistant in the console, on your phone, in chat and in
  the CLI is the same lead. Teammates are now its subagents, with their
  personalities and rules: "ask Rosa to…", or from a flow step.
- **Retiring soon.** The central team service and native coding sessions are
  hidden and warn when used; they are removed next release.
- **Fresh baseline.** New installs start from a baseline schema. Databases
  older than 0.5.0 are asked to update through 0.9.x first.

## 0.9.55 — 2026-10-09

- **One door per route.** Every page's access comes from one table with one
  handler each; pages escape automatically and forms carry CSRF protection.
- **One live stream.** It re-checks your session and project access before
  every update.
- **One-command release.** `toolroll release <branch>` runs a whole release
  after your scope approval and never merges on pending or failed CI.

## 0.9.54 — 2026-10-09

- **One chat core.** Telegram, Slack, Discord and Teams now share one chat
  core, and 70 old chat tables are gone.
- **Nothing to redo.** Chat history and pairings carry over on upgrade.
- **Consent stays put.** An existing approval consent still covers only the
  chat providers it named.

## 0.9.53 — 2026-10-08

- **Fewer features to learn.** Contests, held sessions and fallback chains
  are gone. Routines are now scheduled flows; existing routines migrate,
  paused, and `toolroll routine` points you to flows.
- **Schedule limits hold.** Moving a flow card can't reset its spending or
  single-flight limits.

## 0.9.52 — 2026-10-07

- **Smaller database.** Process logs are compacted after each run, so the
  database file shrinks (one install went from about 116 MB to 26 MB), and
  backups shrink with it. The action ledger is checkpointed automatically.
- **Lighter under the hood.** Update checks read history with bounded memory,
  and live views update without database triggers.
- **Honest release check.** It runs every unit test on 8 workers, and its
  tests check behaviour at runtime instead of reading source text.
- **Webhook alerts keep working.** Legacy Slack and Discord webhooks still
  send this release, with a notice pointing to Chat settings.

## 0.9.51 — 2026-10-07

- **No lockout by username.** Wrong passwords slow the source that sent them,
  not the account. A device you've signed in on always gets through.
- **Guessing stays bounded.** Rotating addresses can't buy more guesses at an
  account, and IPv6 addresses count per /64.
- **Usernames stay private.** Real and made-up names answer the same way,
  even after a flood.

## 0.9.50 — 2026-10-07

- **One route policy table.** Every route's access rules live in one table,
  checked before any handler runs. Undeclared routes are refused, approvals
  are browser-only, and read tokens can't change anything.
- **Server split by area.** The server code now lives in smaller modules.
  No behaviour change for users.

## 0.9.49 — 2026-10-07

- **Tokens keep their limits.** A token's scope and project limits now hold
  on every remote route.
- **Browser login for step-ups.** Approvals and other password step-ups need
  a browser login. OAuth refuses plain HTTP off loopback or your tailnet.
- **Request budgets everywhere.** Budgets cover every remote route, and fake
  account names can't lock anyone out.

## 0.9.48 — 2026-10-07

- **Instant live views.** Changes reach open pages in about 2 ms (was about
  half a second). Idle pages cost the server nothing. A slow connection is
  told to reload instead of freezing.
- **Faster under load.** With 20 people and 50 agents busy, the slowest 1%
  of requests drop from about 17 s to 0.3 s, with no dropped requests. The
  task list now builds off the main thread.
- **`toolroll health`** shows response times, server delay, database waits
  and open live views. Operators get a team load benchmark
  (`scripts/bench-team.mjs`).

## 0.9.47 — 2026-10-07

- **Live tasks.** Task pages update live and show who else is viewing.
- **Last activity.** Running tasks say what the agent did last and when
  ("Ran the tests · 40 s ago"). After 5 minutes of silence they turn amber,
  and they say "Worker offline" when it is.
- **Flow cards** show their task's state: "Building · step 3 of 6",
  "Stuck: …", "Waiting on you".
- **Teammates.** People limited to some projects now get live flows and
  presence.
- **Refresh.** The task list, task pages and home refresh on their own,
  with or without the chat open.
- **One badge.** The Needs-you count is the same everywhere, and says which
  projects it covers.

## 0.9.46 — 2026-10-07

- **Tokens from the terminal.** `toolroll tokens create|list|revoke|rotate`.
  Creating or rotating asks for your password and shows the secret once.
  Tokens can be limited to projects and always expire; rotating never
  extends one. You're warned 7 days and 1 day before expiry.
- **Request limits per token.** Too many requests get a 429 with
  Retry-After. Owners change the limits in the console.
- **`toolroll audit`** and the People page show who did what remotely, with
  which token, and how it went. People see only their own.
- **A real domain, safely.** HSTS only on the https public host. Tokens are
  refused over plain HTTP from outside this machine or your tailnet.
  `toolroll serve check-public` checks the setup; see docs/team-server.md.
- **Agents sign in instead of pasting a token.** OAuth with PKCE and a
  consent screen, short-lived tokens, and reuse detection. Pasted tokens
  still work.
- Still to come: `brief` and `spend` remotely for limited access.

## 0.9.45 — 2026-10-07

- **Your projects, your lists.** People with access to some projects can now
  run `status`, `task list` and `ready` remotely, and their agents' list
  tools, and see and count only those projects. A task waiting on one in
  another project says "waits for a task in another project", with no id,
  and queue position counts only your projects. Owners see exactly what they
  did before.
- Still unavailable remotely for limited access: `brief`, `spend` and
  choosing a task's `--id`.

## 0.9.44 — 2026-10-07

- **Work from your own laptop.** `toolroll connect https://… --token so_…`
  and allowed commands run on the server as you, with the same output and
  exit codes. Approvals, people, policy and anything touching the server's
  files stay in the console and chat.
- **Agents connect over HTTPS.** `claude mcp add --transport http toolroll
  https://<host>/mcp --header "Authorization: Bearer so_…"`. Tools cover only
  that person's projects.
- **Every remote action is on the record**: who, whether it came from the CLI
  or an agent, and the token's name. A revoked token stops on its next call.
  Other projects' tasks and runs answer "not found".
- **For now, people limited to some projects** can't run the commands that
  list across projects (`status`, `task list`) or choose a task's `--id`;
  they're refused rather than shown a partial list. Filtered views are next.
- Still to come: token management in the CLI, rate limits, an audit view, a
  real domain with TLS, and sign-in for agents.

## 0.9.43 — 2026-10-06

- **Approve from chat and the CLI.** A plan waiting on you and a flow's
  approval or choose step get **Approve** and **Send back** buttons in your
  paired Telegram chat, two taps each, recorded like a console decision. Ask
  the lead to "approve X" and it answers with those buttons; your tap is
  still the approval. `toolroll flows card approve <flow> <card>` and
  `toolroll flows card send-back <flow> <card> --note …` do the same from the
  terminal with your login.
- **Chat approval can stay on.** `toolroll chat-approval on|off [--repo <p>]`
  turns approving from chat on for one project or all of them, with your
  password to turn it on; off is instant and off for all really is all. It no
  longer lapses with a weekly mode. Plans that widen permissions, go over a
  cap or touch protected paths still go to the console.
- **Old cards point onward.** A card in a past conversation says where the
  item went and links to it when you can open it.
- Still to come: Slack, Discord and Teams buttons, a Settings screen for chat
  approval, and sending a plan back from chat.

## 0.9.42 — 2026-10-06

- **Zod revamp, waves 3 and 4.** What comes into Toolroll from outside and
  what it reads back from disk now goes through one schema each in
  `src/contracts/`: console forms and JSON, CLI `--json` output, webhook,
  GitHub, Linear, email and form payloads, OAuth replies and tool specs,
  settings, every JSON column in the database, update and recovery journals,
  and evidence files. All of it is read as leniently as before. Replayed
  against real data with 0 differences: 655 runs and 984 evidence folders,
  5,158 database rows, 7 tool connections. Console JSON and CLI `--json` bytes
  are unchanged. Console API and CLI input are partly done; what remains is
  listed in `docs/plans/zod-revamp.md`.
- **Changed on purpose.** Recipe refusals start with the field's path. An
  unknown provider is refused as `provider: unknown provider`, without
  repeating what was typed. A sign-in that answers with an empty token says
  it couldn't be reached instead of crashing. An update journal missing its
  core fields (no release since 0.8.0 writes one) is refused rather than read.

## 0.9.41 — 2026-10-06

- **A read-only PostHog connection works for research.** PostHog adds
  `introspection` to every connection it grants, asked for or not; it only
  lets a connection be checked and reaches no data. Toolroll counted it as
  write access, so research skipped PostHog even after **Reconnect read-only**.
  It now counts as read-only alongside the reads it came with. Nothing is
  requested differently, and a connection that already reconnected read-only
  works without signing in again.

## 0.9.40 — 2026-10-06

- **Confirming a proposal checks the same things the card does, everywhere.**
  The console, a direct request, Telegram and the CLI all ask one check: you
  can act on this chat (with the current provider, model and price), and no
  reply is still running. If the terms changed, the card says to turn chat on
  again and every other way of confirming refuses too, with the same reason.
  A teammate reply that stalls before it starts stops blocking confirms after
  a short limit instead of until a restart.

## 0.9.39 — 2026-10-06

- **Chat is the conversation.** The Chat tab is your conversation with the
  lead, with the box to write in ready. Home (what's running, the counts,
  Catch up) moves to the panel beside it, and behind **Work** on a phone.
  When the projects the lead can reach change and a new conversation starts,
  the previous one stays readable above a line saying so; the lead doesn't
  see it, and its old cards can't be confirmed. Pairing your phone is a
  one-line notice in chat, with the full card in Settings → Chat apps.
- **Team chat shows proposals where they were made.** A teammate's proposed
  action, flow or decision sits under the message that made it, using the
  same card as lead chat, with the same rules about who can act and when.
  Older proposals still show.
- **The release check runs app journeys side by side when there's room.**
  With normal memory pressure the app journeys split into lanes; under
  pressure, or when memory can't be read, they use one lane, and the check
  log says how many and why. `TOOLROLL_E2E_LANES` sets the number.

## 0.9.38 — 2026-10-06

- **The release check is faster.** Its app journeys run in about 8 minutes
  instead of about 12, with no journey or coverage dropped.
- **Lead chat tool steps tell the truth.** A step shows done only when it
  succeeded. A failed step says why in plain words.
- **Telegram decision cards lead with the action.** Decisions, plans, lead
  proposals, flow approvals and flow choices say what to do and what it does
  first. "Nothing changes until you confirm." stays on every proposal, and
  buttons on cards already sent still work.
- **Crew rows say why.** A task that is waiting, failed or needs you shows the
  reason in one line; tap it to read the rest. The whole row still opens the
  task.
- **Dependency updates.** @slack/socket-mode 3.1.0, imapflow 2.2.5,
  nodemailer 10.0.15, mailparser 3.9.36, lucide-react 1.52.0, @xyflow/react
  12.12.0, happy-dom 20.14.5 and tsx 4.23.15. Vitest takes the 4.1.11 security
  patch and stays on 4; version 5 waits for its own migration. `npm audit`
  reports no vulnerabilities.

## 0.9.37 — 2026-10-06

- **Zod revamp, waves 1 and 2 finished.** Every handoff between a model and
  Toolroll, and the context passed between steps, is now one schema each in
  `src/contracts/`: the lead's 51 tools and the 25 MCP gateway tools, the
  scout report, task sizing, reviewer findings, decisions, teammate turns and
  sort answers, the lead's context bundle, project knowledge, memory and
  skills, chat actions and channel callbacks, and the desktop coding handoff,
  context and session record. A model gets the schema as `--json-schema`
  where its harness takes one; a refusal names the field
  (`steps[0].routes[0].goesTo: required`). Everything that was accepted before
  is still accepted: tool calls with extra or loose arguments, model answers
  with nulls or overlong text (clipped as before), saved reports, rows,
  sessions, chat buttons and proposals. Replayed against real saved data
  (scout reports, findings, decisions, 410 scopes and 796 routes, 279 chat
  buttons, every saved flow and card), all of it reads the same.
- **Research can read PostHog.** A research run gets a connected service's
  query tool (PostHog's `exec`) only when the access the service actually
  granted is read-only. Otherwise it skips it and says why on the run and the
  integration, with a **Reconnect read-only** action. Connecting PostHog as
  usual is unchanged, and builds keep every tool. Connections made before this
  release didn't record what was granted, so research skips them until you
  reconnect read-only.
- **A question's recommendation can carry its reason.** `connect: because…`
  now counts as recommending `connect`, instead of failing the question.
- **A Telegram update Toolroll can't read** is logged and answered OK, so
  Telegram doesn't keep resending it. A Slack, Discord or Teams message part
  that can't be read is dropped with its reason instead of retried forever.
- **Rolling back:** flow cards written by 0.9.37 read as empty in 0.9.36, so a
  rollback loses the step outputs of cards still in progress.
- **Scopes, acceptance criteria and sealed routes have one contract.** A task's
  scope (goal, exclusions, touch paths, rubric) and an acceptance criterion are
  described once from the plan contract's own fields (`src/contracts/scope.ts`);
  a sealed agent route, in both versions it has been saved in, with its
  overrides and task size, is one schema (`src/contracts/route.ts`). The shared
  rubric input schema is ready for the lead-tool migration. Every saved scope,
  standing order and sealed route reads and digests exactly as before, so no
  approval changes.
  Nothing new is refused: a scope still names up to 50 paths and a criterion
  still ignores keys it doesn't use. Rubric and route refusals are now
  field-named lines (`acceptance[0].statement over 1,000 bytes`), and a route
  made by a newer Toolroll says so.
- **What a flow's steps hand on has one contract.** A finished zone's
  `{{stage.…}}` words, a card's saved outputs, and what Send to me and Person
  chooses send are each described once (`src/contracts/stage-output.ts`,
  `flow-send.ts`, `flow-card.ts`). Saved cards and sends read exactly as
  before. A build or research task filed after a step whose output was too
  long to pass on now gets that output whole, not just a link to it.
- **Tightened, on purpose.** Saving a flow with a new `{{stage.…}}` that its
  zone doesn't hand on is refused, naming where:
  `stages[2].instructions: stage.research.unknown is not available (Research
  hands on {{stage.research}}, {{stage.research.items}} and
  {{stage.research.report}})`. This covers the canvas, `toolroll flows
  create/edit/import`, the lead and templates. A reference a flow already had
  is never refused, and nothing changes for flows that are only read or run.
  Card outputs and kept sends are saved with a version; ones a newer Toolroll
  wrote are refused rather than misread or overwritten.

## 0.9.36 — 2026-10-06

- **Flows have one contract.** Every kind of zone, step, route, answer,
  option, trigger and the flow file is described once
  (`src/contracts/flow.ts`), and that description is what the lead's
  `propose_flow` is told, what `toolroll flows create/edit/import` and the
  console check, and what `docs/flow-file.schema.json` publishes (now
  generated, so it includes Send to me, Person chooses and `ifReplied`, which
  the hand-written one had missed). A refusal names the field and suggests the
  one meant: `steps[0].routes[0]: unknown key 'to' (did you mean goesTo?)`,
  `zones[2]: unknown key 'onFail' (did you mean ifFails?)`, instead of
  "there's no step called ." Every saved flow, template, starter, kit and
  gallery flow reads exactly as before: the same saved bytes and digests, and
  the same exported files.
- **Tightened, on purpose.** A step, flow file zone, trigger setting or
  `propose_flow` argument with a key its kind doesn't take is refused by name
  rather than silently ignored: `planning` on a Holding step, `remindAfter` on
  a Wait step, `ifFails` on a Sort step (use `ifNotSure`, which it meant) or
  `next` on a Sort or Person chooses step. A sort's `sureAt` is 0.5–99. A flow
  file's zones keep only the words their kind uses when exported, and a file
  or drawing made by a newer Toolroll is refused as such. Messages for flows
  and triggers changed from "Zone Build: …" sentences to path-named lines.

- **Builder handoffs and proofs have one contract.** The handoff a builder
  leaves, its proof and the verification receipt are versioned schemas. Fifteen
  real past runs replay with identical verdicts, receipt bytes and digests.
- **One compact review packet.** `toolroll task review <id> --brief` (or
  `--json`) shows a build's conclusion, changed files, check result, review
  findings by severity, screenshot paths and what to do next, in about 40
  lines and without logs or diffs.
- **PostHog connects in one short step.** Its sign-in now uses PostHog's own
  MCP permission preset instead of listing every permission, which showed a
  75-group permission screen. Sign-in returns are now logged.
- **Tests can't mistake a real process for a fake one.** Fake process IDs in
  tests sit above every platform's limit, and a guard refuses new low ones (a
  Brave tab and a GitHub runner process had made tests fail at random).

## 0.9.35 — 2026-10-05

- **One-click sign-ins ask for every permission a service lists.** Toolroll
  asked for only the first 20, so a service needing one later in its list
  issued a token it then refused (PostHog needs `user:read`, its 140th).
  Reconnect a service that failed its test after signing in.

## 0.9.34 — 2026-10-05

- **Plans have one contract.** The first step of making every handoff robust:
  a plan is described once, and that description is both what the planner is
  told to return and what Toolroll checks. Limits come from one place, so the
  2,000-versus-8,000 mismatch from 0.9.30 can't happen again, and a malformed
  plan's retry quotes the exact field that was wrong.
- **Projects added from the command line show in the console.** `toolroll
  repos add` (you or the lead) admits a project the same way the console's Add
  a project does, and it appears within seconds without a restart. Removing
  works the same way. Every addition is recorded with who made it.
- **Crew rows show when they last changed** ("4m", "2h", "3d").

## 0.9.33 — 2026-10-05

- **A restart never breaks a project's builds.** A project's identity no
  longer includes the disk's device number, which macOS can change at restart.
  Saved project knowledge from before such a change no longer stops a build:
  the build runs without it, and one notice offers to apply it again (Knowledge
  page, or `toolroll knowledge apply`). When it is provably the same repository,
  it carries over by itself.

## 0.9.32 — 2026-10-04

- **Lighter on your computer.** A version bump no longer reinstalls every
  dependency (about 22,000 files each time); it reuses the install. Tests and
  checks remove their temp folders and stop what they started however they
  end, and Toolroll sweeps what's left once a day by itself: old test folders,
  processes a finished run left behind, finished release checkouts, extra
  staged versions and unused installs. Spotlight skips Toolroll's folders.
- **The release check fits the machine.** Each part waits for memory and a
  free model slot (4 real turns at once by default) instead of starting
  everything at once, so a busy computer makes it slower, not failed. Most
  browser journeys now run against a scripted model; real models run when
  model-facing code changes and nightly. A UI-only check went from 9.3 to 5.8
  minutes and from 95 real model turns to none.
- **The lead never goes silent.** A reply that runs past its time ends, says
  it took too long, keeps any proposal it made, and frees the chat for your
  next message.
- **Batch checks.** Projects that check every build can check results that
  finish together once, on a temporary combined commit, and split the batch if
  it fails. Off unless you turn it on for a project.

## 0.9.31 — 2026-10-04

- **Flow templates for your integrations.** Nine new templates put connected
  tools to work: UI inspiration (Mobbin), Metrics digest and Fix the biggest
  drop-off (PostHog), Outage to cause (Better Stack), Figma frame to pull
  request, Worker errors to fix (Cloudflare), Failed deploy to fix (Vercel),
  Linear issues to PRs, and Support to bug fix (Intercom). Error to fix now
  reads stack traces through Sentry. Each card shows its tool's logo and
  whether it's connected; one that isn't offers Connect first. Research steps
  only read, and nothing merges.
- **Templates show their steps.** The unlabeled boxes on each template are
  now a named step strip, like "Find the drop-off → You choose → Build the fix
  → Pull request → Sent to you", with your steps marked.

## 0.9.30 — 2026-10-04

- **Long tasks can be planned.** 0.9.28 let task goals run to 8,000
  characters, but plans still had to fit the goal in 2,000, so every plan for a
  longer task was refused. Plans now take the same limit as the task.

## 0.9.29 — 2026-10-04

- **Tasks filed from the command line get sized too.** `task scope` now sizes
  the task from its goal before the plan is sealed, so work the lead files
  gets the same fast-or-strong model choice as work filed in the console.
- **A reused process ID no longer blocks finishing a release.** Once
  Toolroll has recorded that a process exited, a new program taking its
  number doesn't count as the old one. Leftover process records close when the
  run ends, and a wait that clears by itself says so instead of asking you to
  confirm.
- **Status shows each task once.** A task that is building appears only under
  Building, an approved plan no longer reads as waiting for review, and risky
  routes say "Risky" instead of "routine".

## 0.9.28 — 2026-10-04

- **Each task gets the right model.** When a task is filed, a fast
  classifier on your own subscription sizes it as small, medium or large and
  flags risky work. Small changes build on a fast model with no plan. Large or
  risky ones get your strong models for planning and building. The choice is
  sealed into the plan you approve, with the reason, and you can override it.
  Where a tier has both Claude and Codex, it picks the one with more of its
  plan left. `toolroll spend` shows what each tier took.
- **Nothing gets cut off.** Task goals hold 8,000 characters (up from 2,000),
  notes 4,000 (up from 500) and flow instructions 8,000. Agents are told each
  limit before they write and get one chance to shorten. Anything still over
  is kept whole and linked. Chat messages split instead of cutting.

## 0.9.27 — 2026-10-04

- **Integrations show their real logos.** Every integration has its own mark
  in one style and size, ink when connected and muted otherwise, across Tools,
  Integrations and the Settings home. The marks come from Simple Icons and
  svgl and ship inside Toolroll. Services with no open logo keep a letter
  tile.
- **Research messages explain each example.** After a research step, the chat
  message lists every example: the pattern, why it fits, how it would plug
  in, and its link. Screenshots are numbered to match.

## 0.9.26 — 2026-10-04

- **Connecting a tool goes to the project you see.** On Settings → Tools,
  changing the project switches the page at once. Every button names its
  project ("Connect Mobbin to standing-orders"), and a post from a page that
  showed another project is refused. You can also add a connected service to
  another project in one step.
- **Figma connects through its desktop app.** Figma doesn't let other apps
  sign in to its online server, so Toolroll uses the desktop app's Dev Mode
  server instead, with no key. A Connect that fails now says why right at the
  button.
- **Flow cards move on while builds run.** Moves, triggers and steps run on
  their own 15-second beat, and a finished step moves its card at once.

## 0.9.25 — 2026-10-04

- **Connect by signing in: Mobbin, Figma, PostHog and Better Stack.** Settings
  → Tools has a Connect button for each. You sign in once in the browser; no
  keys.
- **Research can read your connected tools.** A research step gets only their
  reading actions (list, get, search and the like), never anything that
  changes something. With Mobbin connected, UI research looks there first for
  real app screens. Codex research runs are held to the same rule.

## 0.9.24 — 2026-10-04

- **Settings, grouped.** The Settings home puts its tiles under five headings
  (Agents, Automation, Chat apps, Access and rules, System), every tile has an
  icon, and each chat app says how it stands: Gets alerts, Connected, Not set
  up, or Has a problem. The first change from the UI inspiration flow.

## 0.9.23 — 2026-10-04

- After a research step, a flow's message to you now carries that research's
  screenshots. Before, it only looked for a build's.

## 0.9.22 — 2026-10-04

- **Research takes screenshots again.** The research step's browser now runs
  outside the agent's sandbox with Chrome's own sandbox on, reached on a
  private local port. It still opens public pages only. A short check before
  research starts says once, in plain words, if the browser can't start.

## 0.9.21 — 2026-10-03

- **Flows send you what was done.** A new "Send to me" step sends the last
  step's summary, links and pictures to your chat apps. Every template can
  end with one.
- **Flows ask with your own buttons.** A "Choose" step offers 2-4 options you
  name, for example Implement, Remix or Ignore, on Telegram, Slack, Discord,
  Teams and the console. Reply instead to give a note.
- **Research brings back pictures.** A research step can screenshot the
  public pages it visits (and your project's demo, if you set one) and return
  up to 6 examples with links. Later steps can use them all. Its browser and
  web reads reach public addresses only.
- A Build step can work in another project you have access to.

## 0.9.20 — 2026-10-03

- **Scouts deliver again.** Claude scouts hand back their report, or a
  question for you, as structured output. Plan mode no longer swallows the
  report.
- **The morning review stops filing work for things only you can do.**
  Unopened results, questions, plan approvals and holds no longer start an
  investigate-and-fix flow. Anything waiting over 3 days gets one line in the
  review's summary, with a link to Needs you.

## 0.9.19 — 2026-10-03

- A release candidate whose check was rerun on the same commit can be
  deployed; no fresh gate needed.
- Screenshots with results follow their result message and thread under it on
  Slack and Discord, never sent twice.
- A process-cleanup test no longer flakes under load.

## 0.9.18 — 2026-10-03

- **Decide in Telegram.** A ready result's Accept and finish, Request changes
  and Retry now work right in the chat, each confirmed with a second tap. With
  `toolroll mode set … --chat-approve` signed once, you can also approve plans
  and merge pull requests from Telegram. Anything outside the mode's terms
  still links to the console.
- **Screenshots with results, if you want them.** Settings → Notifications →
  Screenshots with results: Off, First one, or Up to 4. On Telegram they
  arrive as photos with a plain caption.

## 0.9.17 — 2026-10-03

- **The lead checks before it promises.** One check covers agents (signed in
  or not), workers, tools and skills, integrations and checks. It won't
  propose work that needs one until it has looked. If something isn't ready,
  it says so with the next step and a link.
- **Replies read like a person wrote them.** On every channel: no headers,
  links with plain labels, no internal ids, and little bold. A reply that
  says it's attaching something has to attach it. Errors are in plain words,
  and you see a 👍 and typing while it works.
- **It knows you and your people.** "What your lead knows about you" is a
  short list you confirm line by line, editable in Settings → Lead. The lead
  also keeps an index of the people, teammates and team chats you work with,
  and looks a person up before answering about them.
- Promises made on Slack, Discord and Teams are delivered there. Long
  Telegram replies split safely.

## 0.9.16 — 2026-10-03

- **Name your lead.** Settings → Lead takes a name and a short persona. The
  lead uses them wherever it speaks.
- **The lead knows who it's talking to.** Every turn it sees your first name,
  today's date, the channel it's on, what needs you, and your projects by name
  with their decisions.
- **It checks before it speaks.** It says what it checked and marks guesses.
  It searches project memory before recommending anything, and it checks an
  integration before promising work that needs it.
- **Questions with buttons.** When it needs an answer, it asks one question
  with tap-to-answer options in the console, Telegram, Slack, Discord and
  Teams.
- **It keeps its promises.** "I'll tell you when the checks pass" is recorded
  and reported once, on the chat where you asked. Corrections become a card
  you confirm, and it remembers them from the next reply.
- Accepting a result that doesn't match its report needs a reason, enforced by
  the server. Every time on a page shows in your time zone.

## 0.9.15 — 2026-10-02

- **Accept finishes the task.** One step, Accept and finish, after the
  evidence. Your own checks come first, and the count updates as you answer.
- **Failures say what failed.** A failed task names the requirement or check
  it missed and suggests what to change, prefilled in Retry. Failed builds get
  a real result page. Builds show "Step 2 of 6" and say when they're stuck.
- **One set of words.** The same state names in the list, task page, result
  page and Crew. Project checks and PR CI are labelled apart, and every time
  shows in your own time zone.
- **Approving says what you allow.** A plain "You're allowing" line sits above
  Approve, your password says what it signs, and Edit plan edits in place.
- **Safer deploys.** An interrupted deploy puts the old service and its coding
  store back.

## 0.9.14 — 2026-10-02

- **Results and failures say what went wrong.** A result whose report doesn't
  match its saved changes says so in its headline and lists each mismatch,
  with its requirements shown as unverified; accepting it asks for a reason. A
  failed task shows its latest attempt's reason in one plain line (or that
  none was recorded), linked to the log, with Retry as its one action.

## 0.9.13 — 2026-10-02

- **One page per result.** Every build's result has one page, titled with its
  task, with exactly one main action: Accept, Run checks, or Request changes.
  A result that can't be accepted says why in one line.

## 0.9.12 — 2026-10-02

- **Approving a plan fits one phone screen.** The plan shows up front in plain
  rows (Goal, Changes, Won't touch, Done when) with one Approve & start, pinned
  to the bottom on phones, and a line saying what happens next. The fine print
  sits under Details.
- **Tasks puts what needs you first.** Waiting work is grouped as Decide,
  Review and Unblock, each with a solid ink chip, and usage folds to one line.
- **Reviewing a result shows the change before Accept.** Each thing you check
  comes with its evidence and Looks right / Not right; Accept says "Accept
  without checks" when they didn't run, and what accepting does.
- **Your lead tells you what it's doing.** A task your lead is handling says
  "Your lead is on it" instead of waiting on you, and short updates from your
  lead arrive in chat.
- **Updates over 0.9.11 work.** Stopping the service no longer leaves the
  coding server's record behind, and a deploy or update that fails after
  stopping it puts the previous version back on its own.

## 0.9.11 — 2026-10-02

- **The Telegram bot always answers.** Replies and notifications go out from
  the service itself, never from inside a build. If it can't answer, it says
  why in plain words, and a session mix-up starts a fresh conversation instead
  of refusing.

## 0.9.10 — 2026-10-02

- **Chat reads like a teammate.** Short messages, outcome first, with real
  choices: Merge or Mark complete, and Look first. Updates within two minutes
  arrive as one message. You're never told about your own actions, release
  checks and replaced tasks stay quiet, and a release sends one "is live" line.
  The Telegram bot is named Toolroll.

## 0.9.9 — 2026-10-02

- **Faster, lighter tests.** The unit suite runs about three times faster
  (the biggest test files are split by area), tests use at most 4 workers,
  and a project's Quick check can be a typecheck plus the tests for the
  changed files.
- **Toolroll cleans up after itself.** When a run ends, it stops what the run
  left running. Tests delete their temp folders, and `toolroll storage clean`
  removes leftovers. Replaced release checks give up their checkouts, and
  kept checkouts drop their dependencies until they're needed.
- **Checkouts share dependencies.** One install per lockfile, linked into
  each checkout: about 1,900 files instead of 20,000, set up in under a second.
- **Every "Needs you" says what it needs, with the button that does it.**
  Anything you can't act on shows as Waiting instead.
- **Finished tasks read Complete everywhere.** Status, the console and chat
  agree, and old "process exit not recorded" entries clear themselves.
- **Updates never hang.** The updater settles leftover records itself, stops
  waiting after 2 minutes otherwise, and says the one command that clears it.
  Release checks now test upgrading from the last three releases.
- **Screenshots stay out of the repository.** Images under `evidence/` are
  left out of commits and show as one line in the review.

## 0.9.8 — 2026-10-01

- **One automatic review per build.** When a build's checks pass (or it
  finishes, with checks Off) in a project with review on, one read-only
  reviewer reads the scope, acceptance and diff and grades each finding HIGH,
  MEDIUM or LOW. Any HIGH sends the task back once, with the findings as its
  note; a HIGH on that revision comes to you. MEDIUM and LOW never block: they
  show on the result as suggested follow-ups. A review that fails or times
  out never blocks: the result reaches you marked Not reviewed. Turn it on or
  off per project in Settings or with `toolroll review on|off --repo <path>`;
  it's on by default under a hands-off mode. Release candidate checks are
  never reviewed.
- **Evidence is kept 1, 7, 14 or 28 days, or forever.** Settings →
  Retention and `toolroll retention set evidence 1d` take any of them. Until
  someone chooses, evidence is kept 28 days: **after upgrading, the daily
  sweep starts removing finished tasks' evidence older than 28 days.** A
  period chosen before stays as it was; one the page no longer offers shows
  as "30 days (custom)".
  Nothing a task still needs is removed: unfinished tasks, results Ready for
  review, anything on hold, live runs and release candidates.
- **A run whose process never started no longer blocks updates.** A spawn
  that fails now settles its own record, and Toolroll settles a finished run's
  leftover record once its processes are provably gone, noting it in the
  ledger. For the rare record that can't be proven either way, an approver
  can run `toolroll run settle <run> --why "<reason>"`; it refuses while
  anything of the run is alive.

## 0.9.7 — 2026-10-01

- **Onboarding without a password or a form.** `toolroll up` prints three
  lines and opens the console already signed in, through a one-time link that
  works once, for ten minutes, from this computer only. The lead turns on by
  itself with the agent that's signed in (Claude Code, else Codex); the old
  setup form moved to Settings → Lead → Advanced. With no agent signed in,
  Chat shows the command to install and sign in, and checks again on its own.
  A short "how it works", a live Plan → Ready timeline on your first task, a
  card for pairing your phone, and a "wrong host" page that says what to run.
- **The task page is one conversation.** The status stays on top; below it
  the plan, the agent's notes and results, questions and your replies, in
  order, ending in a box to message the agent (Build, Plan only, or Just
  answer). Details (scope, attempts, audit) moved to a side panel, or a sheet
  on phones. The Chat home shows who is working now and four counts, and
  Catch up and the Inbox have tabs: Needs you, Ready, Running, All.
- **Checks: quick while building, easy to turn off.** Each project has a
  check level: Quick (the default for new projects), Full or Off, and a task
  can override it ("skip the tests"). With checks Off a result is still
  Ready for review, and says no check ran. Any result can run its checks again or file a task to add tests.
- **A flow gallery, and flows as files.** Flows → New is a gallery of
  templates grouped by what they're for, with new ones for developers
  (Overnight bug bash, Flaky test hunter, Release notes writer, Docs follow
  the code, Error to fix, PR second opinion and more). Export any flow as a
  `.toolroll-flow.json` file and import one from a file or a link, with a
  preview; secrets never leave, and imported triggers start switched off.
- **Several builds at once on one project.** The service builds up to two
  tasks of a project at a time (Settings → Projects, `toolroll project
  concurrency`), within the machine's limit. Stopping the service mid-build
  saves the work and resumes it next time.
- **The lead's housekeeping stays quiet.** An agent acting as your lead gets
  its own credential (`toolroll lead token`); its work pings nobody unless it
  hands something to you. Your own actions never ping you, a replaced task
  reads "Replaced by", and a whole project can be muted.
- **A faster release check.** Flow journeys run in parallel groups, browser
  journeys are rebalanced, and a version-only bump no longer forces every
  test.

## 0.9.6 — 2026-10-01

- **Every task's status, clear at a glance.** One headline from a fixed set
  (Queued, Planning, Needs you, Building, Ready for review, Complete, Failed,
  Stopped) and one plain sentence, the same words on the Tasks list, the task
  page, the result, Crew, the Telegram/Slack/Discord/Teams card and
  `toolroll status`. Checks, the pull request, requirements and saved
  evidence sit underneath as quiet rows. A pull request that couldn't open
  is an amber note with one action, never a red chip beside Complete: red
  now means only Failed. The exact technical reason stays under Details.

## 0.9.5 — 2026-10-01

- **A demo you can feel in 90 seconds.** In `npx toolroll demo`, Chat has a
  scripted lead: ask for anything and it answers with a short plan in a
  sample project; Approve builds it live to Ready with a diff, a passing
  check and a screenshot, then Complete or Request changes. It never calls a
  model, reaches outside or spends. The sandbox folder is now `toolroll-demo-*`.
- **Calmer first impressions.** A result in Chat shows each fact once, in
  plain words ("You check this one: …" instead of criterion and evidence
  terms), and a first start on Linux without process containment says so in
  one sentence instead of a cgroup error.
- **Pull requests open reliably.** Each project's worker now publishes only
  its own project's pull requests, under one permission lookup shared by
  Complete, flows and the publisher. Before, another project's worker could
  give up on a pull request that was actually opened, and a flow could file a
  needless rebuild.

## 0.9.4 — 2026-10-01

- **Flow steps act exactly once.** However many workers advance a
  project's flows at the same time, a card files its task, runs its script
  and posts its update once; a retried card takes the same guarded path.
- **Pull requests from the terminal.** `toolroll task complete <id>
  --pull-request` completes a result and opens its pull request, and
  `toolroll task merge <id>` merges it once checks pass, behind your password.

## 0.9.3 — 2026-10-01

- **Flows never get stuck on a long step output.** A research or build step's
  goal keeps its instructions whole and trims only what was filled in from
  earlier steps (start and end kept, with the full text on the card and given
  to the agent as untrusted context). Instructions too long to fit are refused
  when the flow is saved. A card that couldn't file its work tries again on
  the next pass.

## 0.9.2 — 2026-10-01

- **Flows from a terminal.** `toolroll flows` lists and shows flows (zones
  with their next and failure paths, triggers, recent cards) and sets them
  up under the console's own rules: `create` from a template, a starter flow
  or the lead's step format, `edit`, `trigger add|pause|resume|remove|check`,
  `script save`, `card add` and `archive`. Writes take an approver's
  password (`--as/--token` or the remembered login) and land in the ledger;
  create, edit, archive and trigger add preview until `--yes`. It is in
  `contract --commands` and `skills get operating`.
- **Toolroll reviews its own last day, every morning.** A new plane review
  trigger reads the last 24 hours from the store at 07:30 and makes one card
  per problem worth fixing — failed runs by cause, tasks waiting on a person,
  sign-in and plan-limit pauses, chat delivery failures, Broken integrations,
  failed release checks and worker breakages — with counts, run ids and
  redacted excerpts. A problem that comes back joins its card; a clean day
  adds nothing. The **Morning plane review** starter (Settings → Flows, or
  `toolroll onboard --starter plane-review`) researches each one, builds a fix
  under the usual approvals and opens a pull request; failures wait in
  **Needs a look**. Flow insights show which problems recur.
- **Flows that test Toolroll.** `scripts/flows/real-model-journeys.mjs` runs
  the journeys that use real models (unit tests and CI never do), retrying a
  failure once before calling it real, and `scripts/flows/weekly-upkeep.mjs`
  reports outdated or vulnerable dependencies and new agent CLI versions.
  Both run in a flow's check zone. A Toolroll started inside the agents'
  fence now runs its agents inside that outer fence instead of failing to
  nest a second one.

## 0.9.1 — 2026-09-30

- **Phones show more on a screen.** On a phone the console is about a third
  denser: a row's action sits on its title line, status chips beside the
  name, facts on one line, and times shorten to "16:39", "Yesterday 16:39"
  or "Sep 28" (the full time stays on desktop and on hover). Every tap target
  is still at least 44px and text fields 16px; nothing scrolls sideways at
  320px, and the desktop layout is unchanged.
- **Flows open pull requests, and starter flows are one yes away.** A new
  Pull request zone opens a PR for a card's built result under the project's
  pull request setup, waits for CI, moves on when it passes and takes the
  failure path (naming the failing check) when it fails; it can merge, squash
  by default, only after a person approved the card. The Issues to PRs
  template runs labelled GitHub issues through build, approval, pull request
  and a closing comment. Settings → Flows and `toolroll onboard --starter`
  switch on Fix failing CI, Issues become tasks and Overnight queue; a task's
  "Do this every time…" and chat offer the matching one.

## 0.9.0 — 2026-09-30

- **Chat pings only when you're needed.** In Telegram, Slack, Discord and
  Teams each task is one message, updated in place from filed to Ready (and
  tasks filed within a minute share one). A new message arrives only when
  something needs you: a result Ready for review, a question or approval, a
  failure that needs a decision, a sign-in or plan-limit pause, or a security
  alert. Choose Only when I'm needed (the default) or Every step, and an
  optional evening digest, in Settings → Notifications or with
  `toolroll notifications quiet|all|digest <HH:MM>|digest off`. Delivery
  receipts and the console's activity are unchanged.
- **Complete opens a pull request, and Merge is one step.** Turn on pull
  requests once per project (Projects → Pull requests, or
  `toolroll publish setup`): Toolroll checks the GitHub remote, the default
  branch, `gh` sign-in and push rights, and says what to fix. Complete then
  offers "Complete and open a pull request" beside "Complete only"; the pull
  request opens from the exact completed commit. The task shows the PR link
  and its CI. Green reads Ready to merge with one Merge (behind your
  password; Telegram and Slack link to it), which squashes by default,
  deletes the branch and records the merge commit in the ledger. Red files
  one revision with the failing check's name and a fenced log excerpt, at
  most twice per task, then asks you. "Merge when checks pass" is an
  opt-in project setting.
- **Settings → Integrations: what works, what's broken.** One list of
  Telegram, Slack, Discord, Teams, GitHub, Linear, email, each project's MCP
  tools, monitoring destinations, Claude and Codex. Each says Connected, Not
  set up or Broken, with its last success and last error, what uses it, and
  one action: Set up, Send test, or Fix in plain words. Checks are read-only,
  run in the background and never hold up a page; `toolroll integrations`
  shows the same, and `toolroll status` adds a line when something is broken.

## 0.8.2 — 2026-09-30

- **Task checkouts stop using space nobody wants.** A finished task's clean
  checkout now goes when its task is complete or cancelled (Settings →
  Storage or `toolroll storage cleanup` changes that to 2 days, a week or
  never); its branch always stays. Toolroll's own progress file no longer
  keeps a checkout forever. `toolroll storage clean` and the Clean up button
  preview what goes, what it frees and what stays and why, then remove it;
  a checkout kept for its changes can be discarded on purpose. Every removal
  is in the ledger.
- **Safer recovery.** A failed update no longer moves a healthy database aside
  (only one that can't be read), checks the backup and free space first, and
  puts the database back if the restore fails. `toolroll mcp` exits when its
  database is replaced, so an agent's writes never go to a stale file.
  Cancelling re-reads the update under its lock, `toolroll onboard` removes
  only guide copies it wrote, more agents are recognised as agents, and the
  console never waits on npm.

## 0.8.1 — 2026-09-30

- **Safer `toolroll update`.** A release is accepted only when its signing
  certificate names ap9000/toolroll, its publish workflow and GitHub
  Actions, checked with the Sigstore verifier npm already ships (found from
  npm itself, so a custom npm global folder works too). A failed
  update puts the commands back before stopping the service, stops and
  restarts per-project watch workers with it, restores even when the live
  database can't be copied aside, and keeps the last good update so
  `--rollback` still works after a refused attempt, including for the update
  that brought 0.8.1. The console's update job
  finds pnpm, bun and npm where they are installed; the desktop app is never
  offered npm.
- **Safer `toolroll onboard`.** It adds the main checkout rather than a
  temporary worktree, never adds your home folder, and asks before adding a
  project. Run by an agent, `toolroll up` never prints the password. Login
  advice matches how the install actually signs in, and uses the port `up`
  serves on. A skill you have edited is left alone.
- **Chat opens instantly.** First-run suggestions and the agent sign-in check
  refresh in the background, so a slow network never holds up the page.
  Tapping a suggestion adds to what you typed instead of replacing it.

## 0.8.0 — 2026-09-30

- **Install with your agent.** `toolroll onboard`, run by the agent that
  installed Toolroll, adds the repository as a project, says which agent
  CLIs are signed in, and with `--yes` installs a small marked Toolroll
  skill for Claude Code and Codex so the agent knows how to hand work over,
  wait and review (`--remove` takes it out; a skill you wrote yourself is
  never touched). It prints the MCP line rather than running it and ends
  with a handoff for the person: the console address and where the login is
  saved, never the password. `toolroll up` without a terminal prints that
  handoff instead of opening a browser.
- **A first run that leads to a first result.** Chat and the inbox show three
  plain steps (Agent signed in, Project added, Your first task), each done or
  with one action, until the first Ready result. Until a task exists, Chat
  offers three first tasks: the repository's open GitHub issues, else its
  TODO and FIXME notes, else safe generic ones. A tap only drafts the
  message, and text from issues and notes is kept to what a person can see.
  Settings shows how long the first result took.
- **Calmer secret alerts.** The commit secret scan looks only at lines a
  change adds and skips documented placeholders, so pushes no longer warn
  about keys that were already there or never real. A real hit still blocks
  publication; the alert names the file and line, once per commit, and says
  what to do.
- **`toolroll update`: verified, drained, undoable updates.** Installs the
  new release from the npm registry beside the running one, under npm's own
  signature and attestation check; the installed bytes must be the ones
  downloaded and hashed, and their provenance must name ap9000/toolroll and
  its publish workflow. It lets running work finish (`--when-idle`, the
  default; `--now` refuses while work runs and names it; `--at 03:00`
  waits), stops the service and waits for it to exit, backs up the database
  and coding catalog, rehearses, switches the service and every
  `toolroll`/`standing-orders` on PATH, restarts and health-checks. A failed
  check restores the previous version, database and coding catalog on its
  own, keeping what the new version wrote in a named copy;
  `toolroll update --rollback` goes back later. It refuses while a
  foreground `toolroll up` runs, when a command on PATH is a shim it cannot
  switch, and to an older release without `--allow-downgrade`, and keeps two
  release runtimes. Settings → Updates offers Update now, When idle and
  Tonight (03:00) behind your password, shows the steps live, and a one-time
  What's new card afterwards; while update checks are off it asks npm
  nothing until Check now. The console's update job runs once, for that
  update only. Every update, rollback, refusal and failure is in the ledger.

## 0.7.0 — 2026-09-30

- **Know when a newer Toolroll exists.** Once a day Toolroll makes one
  anonymous request to npm, plus one to GitHub for that release's notes, and
  keeps the answer beside the database; offline it says nothing.
  `toolroll status` adds one line when a newer version exists, the console
  shows a quiet notice you can dismiss per version, and Settings → Updates
  shows this version, the latest and its notes, the command for how you
  installed it, each worker's version, and a switch to turn the check off
  (or set `TOOLROLL_NO_UPDATE_CHECK=1`). A security release (notes with a
  "Security" line or heading) also messages each operator once. A plane
  deployed from a checkout reads as a source install.

## 0.6.0 — 2026-09-30

- **Ink instead of magenta.** The accent for what waits on a person is ink
  by default (#171717 light, #ededed dark), the way Vercel, Linear and
  GitHub work: the console is black, white and grey, and colour is kept for
  status (building, complete, warning, danger). Settings → Appearance
  starts its presets with Ink, Violet and Chart magenta; a colour you chose
  stays.

- **The console feels right under a finger.** Hover effects apply only to a
  mouse or trackpad (no stuck hover after a tap), no tap flash or tap delay
  on phones, link-buttons press like buttons, and one stronger ease-out
  curve. The phone navigation drawer slides in and out from the left,
  dialogs and menus get short entrances and exits (menus from their
  trigger), and everything is a plain fade under reduced motion. The ⌘K
  palette opens instantly.

- **Rename leftovers.** Deploy picks the state folder that holds the
  database; a new watch installs before the old-named one is removed; the
  setup guide still offers to update stale or old-folder instructions.

- **Faster, stricter release checks** (for contributors). `scripts/release-check.mjs`
  runs the unit tests related to a change and the browser journeys only
  when something a page shows changed; `e2e-parallel` retries only failed
  journeys (the whole group when the browser-error check failed), and a
  retry passes only if every first-run failure passed in its report.

- **Releases publish themselves.** Pushing a `v*` tag runs
  `.github/workflows/publish.yml`, which publishes to npm through npm's
  trusted publishing (no token, with provenance) and creates the GitHub
  release; the Homebrew tap follows within six hours.

- **An expired sign-in pauses that agent instead of burning retries.** A run
  that fails because its sign-in or API key no longer works (Claude's expired
  OAuth session or "Please run /login", a revoked key, Codex or Gemini not
  logged in, a 401) is `auth-expired`: no strike, no retry, never a paid
  fallback. Its task goes back to the queue and new work for that provider
  waits while the others keep running. `status`, `ready`, `task show` and the
  console say "Claude needs you to sign in again" and what to run, and every
  connected channel gets one message per incident. The pause lifts when a run
  or sign-in check on that provider works, or with **Resume** in the console
  or `toolroll providers resume <provider>`; one short message says how many
  tasks resumed.

- **An agent that stops before its handoff keeps its work.** Every builder,
  revision and repair prompt now says the agent runs headless (foreground
  commands only, no background-and-wait, wakeups or loops; hand off before
  stopping), and claude runs start with `--disallowedTools
  ScheduleWakeup,CronCreate,Monitor`. When an attempt ends with changes but no
  handoff, its own session is resumed in the same worktree with a short turn
  to finish and hand off. Its changes are saved as a patch in the run's
  evidence folder first; when the session cannot be resumed they become a
  work-in-progress commit on the branch the next attempt continues from, and
  a retry never resets that work. The failure reads "The agent stopped before
  handing off; its work was kept and it is being resumed". A handoff and a
  passing check are still required for success.

- **Sign-in pauses and kept work, follow-ups.** Fallback entries, attended
  continuations and resumed race lanes on a paused provider now wait (with the
  same one-trial-every-10-minutes) instead of failing, and the Tasks list
  shows every task the gate holds as waiting for a sign-in — planners and
  tasks on a configured or pinned provider included. A retry now actually
  inherits unhanded work (its admission refused it before); an attempt that
  finds a kept work-in-progress commit already complete and hands off with a
  clean tree succeeds; and once a later attempt fails some other way, the
  saved tree can be reset.

## 0.5.0 on npm as toolroll — 2026-09-30

The first `toolroll` package, published from the rename (PR 105). It carries the 0.5.0 notes below plus:

- **Toolroll under the hood.** The internal names follow the product name;
  every existing install, database, branch and integration keeps working, and
  nothing is moved. The npm package is `toolroll` (both the `toolroll` and
  `standing-orders` commands remain). A fresh install keeps its state in
  `~/.config/toolroll`, `~/.toolroll` and `~/.cache/toolroll`; a folder that
  already exists under `standing-orders` (or `nightorders`) keeps being used
  until one exists under the new name. Every `STANDING_ORDERS_*` variable has
  a `TOOLROLL_*` twin that wins when both are set; the old name still works
  alone, and processes Toolroll starts get both. New task branches are
  `toolroll/<id>`; `standing-orders/<id>` branches stay the plane's own (a
  retry reuses one, project delete, races, publication grants and coding
  handoffs recognise both). Watches install as `com.toolroll.watch.*`, and
  installing, stopping or removing one also finds, stops and removes the same
  repo's `com.standing-orders.watch.*` job. The skill folder is
  `.claude/skills/toolroll`; a managed `standing-orders` copy is replaced on
  install. Slack buttons send `toolroll_*` action ids and still accept
  `standing_orders_*` ones on older messages. Hash and digest inputs, the
  ledger genesis and stored format ids are unchanged, so existing data
  verifies.
  **Breaking for monitoring:** Prometheus metrics are renamed from
  `standing_orders_*` to `toolroll_*` (for example
  `toolroll_ledger_chain_ok`), and OTLP traces report `service.name` and the
  instrumentation scope as `toolroll`; the monitoring webhook `user-agent` is
  `toolroll/<version>`, and the MCP server and client name is `toolroll`.
  Update dashboards, alerts and collector filters. Span attribute keys
  (`standing_orders.*`) and the audit webhook's signature header are unchanged.

- **Retention settings.** An instance operator chooses how long run
  evidence and logs, finished checkout records, chat messages and
  notifications are kept (forever until chosen), on Settings → Retention or
  with `standing-orders retention show|set|preview`. Changes take the
  password and are in the action ledger. The worker sweeps once a day and
  writes one ledger entry saying what it removed and about how much space it
  freed. The ledger, unfinished tasks, results not yet completed and anything
  on hold are never removed; removed evidence says so instead of looking
  damaged.

- **Delete a project.** An instance operator can remove everything Standing
  Orders holds for a project: its tasks and their versions, runs and their
  evidence, the checkouts and `standing-orders/` branches it made, chats,
  flows and cards, teammates, budgets, settings and knowledge. Settings →
  Project asks for the project's name, then shows exactly what goes and
  asks for the password; `standing-orders project delete --repo <path>`
  previews and `--yes` deletes. Nothing is deleted while any of the
  project's work is running. The repository, its working copy and its own
  branches are never touched, other projects keep their rows, and the ledger
  keeps every entry (the chain still verifies) and gains one saying who
  deleted what. No undo; no schema change.

- **Organisation policy.** Settings → Policy (and `standing-orders policy
  show|set`) sets which providers and models may run, which project tools
  agents may use, and the highest permission level anything runs with
  (safe, standard or escalated). Saving takes your password; each change is
  in the action ledger, before → after, and the page shows that history.
  Scope approval, the tick and the last check before a build, fallback
  entries, race lanes, attended sessions, the lead and project chats,
  teammates and flow steps all obey it and say which rule stopped them.
  New filings are lowered to the ceiling; work approved above it runs
  lowered (the ledger says so), attended sessions are refused, and a
  provider with no setting that low (Codex at Safe) is refused.

- **Cost guardrails.** Work on a subscription (a Claude or Codex sign-in)
  counts as $0: what binds it is the plan's usage windows, which Tasks now
  shows as tiles (Claude's 5-hour and weekly windows as Claude reports them
  on every turn, Codex's as its app server answers every five minutes), each
  with when it resets, amber from 80 % and red when used up. How work is
  billed follows what the CLI actually did (Claude's key source on each run,
  Codex's account), not only the setting. Work billed to an API key is
  priced: what the provider reported, or its tokens at the model's price in
  Settings → Models (the provider's highest listed price when the model
  isn't listed), frozen when the run settles; key work that can't be priced
  at all waits under a budget until prices are loaded. The Spend page
  (and `standing-orders spend`) shows each month by project, person,
  teammate and model, with a CSV. Monthly budgets for the whole
  installation, a project, a person or an AI teammate alert at 50, 80 and
  100 % (once each, again after a change; a person's budget to that person,
  on Telegram too) and, unless set to alert only, stop API work at 100 %:
  queued tasks, fallbacks, resumed races, continuations, repair turns, key
  chats and flow sorts wait (the task page says why), and a Claude run's cap
  shrinks to what's left. Budgets and their limits also show as tiles on
  Tasks, are set on the Spend page or with `standing-orders budget`, with a
  step-up, and every change is in the ledger. Schema 105.

- **Stream it out.** Settings → Monitoring sends what Standing Orders does
  to the tools a company already watches. The audit stream delivers every
  sealed ledger entry, in order and at least once (retried, never skipped),
  to a webhook, each request signed with a secret shown once
  (`x-standing-orders-signature: t=…,v1=<HMAC-SHA256 of "t.body">`), and/or
  a folder of JSON Lines files; each batch carries the chain head, so the
  receiver keeps its own copy of the checkpoints. Traces send each run as an
  OpenTelemetry span (OTLP over HTTP) under its task's trace: timings,
  model, tokens and cost, never a prompt or code. `/metrics` serves
  Prometheus metrics to an instance operator's API token.
  `standing-orders monitoring` shows how each destination is doing.
  Schema 104.

- **Storage kept in check.** Standing Orders used to keep every build
  checkout and every staged release forever (78 GB here after a week). Now
  the worker removes a finished task's clean checkout two days after it was
  let go (a result marked complete, or a release candidate, a week after,
  since a deploy installs the build in its checkout). Its branch and commits stay; a checkout with
  anybody's changes, or commits on no branch, is never touched, nor is
  anything an unfinished or unplaced task works on. Each removal is in the
  action ledger. A deploy keeps the release it installed, the one before,
  the newest few and any a service or the CLI runs from; older ones go with
  the database backups they hold. `standing-orders storage` shows where
  the disk goes.

- **Audit you can prove.** The action ledger is now a hash chain: each entry
  is sealed with the one before it, and the ledger page (or `ledger verify`)
  says whether it still verifies, or the first entry that was changed,
  removed or added. Instance operators make checkpoints to copy off the
  machine (`ledger checkpoint`); `ledger verify --checkpoint` compares one,
  and is what proves history before it wasn't rewritten.
  Every task has an evidence pack, as a printable page and JSON: who filed
  it, the approved terms and approvers, the rules in force, agents and
  cost, changed files, checks, completion, publication and its sealed
  ledger entries (`task evidence <id>`). The ledger page's Audit export (or
  `ledger export --from --to`) downloads a date range with a pack for each
  task. AI teammates' tool calls (and who approved or undid them) and new
  coordinators are in the ledger now too. Schema 103.

- **Separation of duties.** Every task records who filed it (the person, or
  the person a coordinator acts for). Settings → Approval rules (or
  `project rules`) lets an instance operator turn on, per project,
  "someone other than the requester approves" and protected work: the whole
  project, or paths like `infra/**`, need two different people to approve
  the same scope ("1 of 2" until the second; a changed scope starts over),
  and never an operating mode, a routine, a watched run or an AI teammate.
  Whoever wrote the scope or made a standing order counts as a requester,
  and a result whose actual diff reaches protected files on a one-person
  approval completes only by someone else. Everything is off until a
  project turns it on. Schema 102.

- **Sessions and API tokens.** Settings → Sessions & tokens lists where
  you're signed in and signs any of it out; sessions now survive a restart.
  API tokens (read, or act as you, never approve) replace passwords on
  requests for scripts and CI, expire in 30 to 365 days, are shown once and
  named in the ledger on every request. Coordinator credentials expire (90
  days unless `--days`), and runner tokens a year after registering.
  Schema 101.

- **Sign in with your identity provider.** Settings → Sign-in connects Okta,
  Microsoft Entra, Google or any OpenID Connect provider. People sign in
  there; their groups make their account and set its role (Operator or
  Viewer) and projects again at each sign-in. Approvals are confirmed by
  that sign-in (within ten minutes, or "Confirm with …"), not a password.
  Passwords can be kept for instance operators only, as a way in if the
  provider is down, and an existing account can be linked. Schema 100.

- **Hardening for teams.** Five wrong passwords lock a name for 15 minutes,
  on every road a password takes (signing in, a request, a step-up), and one
  address guessing across names runs out of tries. The action ledger now
  records sign-ins and policy changes with what changed (the permission
  default "Auto → Full access", a teammate's tool rules, an agent choice, an
  operating mode), and shows installation events to instance operators. A
  person's coordinators end with their standing. `/healthz` answers a probe,
  errors are always logged (`STANDING_ORDERS_LOG_FORMAT=json` for JSON
  lines), and more key shapes (Stripe, Google, GitLab, Telegram and Discord
  tokens, passwords in URLs) are blanked. Schema 99.

- **One look on every page.** Board, Inbox, Next, Done, System, Portfolio,
  Code and Settings → Tools now sit in the same workspace as everything else,
  with the same navigation and search. Live pages (System, Activity) refresh
  themselves inside it without disturbing a form you're filling in. Sign-in,
  invites, error pages and "not found" share the look too, and a one-time
  secret (a worker token, an invite link, a pairing code) gets a focused page
  in the same style, still with no script on it.

- **Connect a service with one click.** Stripe, Notion, Linear, Sentry, Jira,
  Intercom, Attio and ten more connect by signing in on the service's own
  page: no key to copy. The sign-in stays in the tool's secrets file and is
  renewed before it runs out. A starter kit's Connect also lets its teammate
  use the tool. The lead points you to the right tile instead of asking for a
  key.

- **Starter kits.** Support desk, Bug triage, Sales follow-up and Ops
  requests each set up a teammate, the flow it works and its buttons in one
  click. The kit's page lists what's left (email, the tools it uses) and
  **Try it** puts a sample card in front of the teammate so you see it work.
  The lead can set one up too.

- **Smoother page changes.** Moving between pages fades the old one out
  before the new one arrives, so text never overlaps mid-change, and the
  sidebar holds still.

- **Telegram pushes your messages.** With a public hooks address, Telegram
  delivers each message and tap to Standing Orders the moment you send it,
  signed with a secret, instead of Standing Orders asking for them. No other
  program can take your bot's messages meanwhile, and "Conflict" no longer
  fills the log when one tries.

- **A weekly report per teammate, and undo.** Every Monday its manager gets the
  week: what it did, its tool calls, what its turns cost, and what you
  overrode, each linked. Name an action's opposite (remove_label for
  add_label) and its receipts get an Undo that calls it with the same input,
  as you.

- **Message a teammate by name, and give it routines.** "@maya where's order
  2201?" in Telegram, Slack, Discord or Teams lands on Maya's desk, and the
  answer comes back to you there. Routines ("weekdays 09:00: look up
  yesterday's refunds") put a card on its desk on a schedule and report to
  its manager. A code change it's asked for is filed as an ordinary task
  under your approvals.

- **Teammates remember, and learn from you.** Each teammate keeps a memory:
  what you tell it, and short facts it keeps from the cards it works, read
  back when a later card is about the same thing. Search, edit or forget any
  of it. Approve the same kind of call five times in a row and it suggests
  the rule that lets it act alone; one tap accepts.

- **Teammates that act.** Let a teammate use your project's tools (a shop, a
  CRM, a mailbox) with a rule for each action: do it, do it up to a limit,
  ask first, or never. An ask-first call reaches you on the card and in your
  chat app exactly as it would be made; Approve makes that call, Deny doesn't.
  Every call is a receipt on the card and the teammate's page, and the lead
  can change a rule from plain words.

- **AI teammates.** Agents with a soul file you write (who they are, how they
  write, what they decide alone, what they ask first, what they never do)
  decide "Person decides" zones and handle their own zones, write replies,
  move cards on, and bring you what their rules say to ask about, in your chat
  app under their own name. A note for this week, a daily summary, a pause
  button, and templates for support, sales, ops and triage. Answer a
  teammate's question with a tap, or in your own words, in Telegram, Slack,
  Discord or Teams.

- **Wait for replies.** A Wait zone after a Send email zone waits for the
  person to answer. Their reply moves the card on and joins its discussion;
  with none in time, the card takes its no-reply path, like a nudge that stays
  in the same thread. Only replies from people the card wrote to count.

- **Time limits.** Any zone can remind whoever a card is waiting on after a
  while, and Holding and decision zones can move it on. New templates: Reply
  and follow up, and Decisions that don't stall.

- **Send-backs are planned again.** Sending a result back with a note has the
  planner update the plan with it; a note asking for more becomes a change
  you see and approve before anything builds.

## 0.5.0 — 2026-09-25

Flows: your process drawn as zones that cards move through, with agents doing
the work and people deciding.

- **Canvas and chat.** Draw flows on a canvas or describe them to the lead;
  every change is a card you confirm. Templates for coding, research, issue
  triage, spam filtering, lead, effort and exception routing, and email replies.
- **Triggers.** Buttons (and public forms), schedules, GitHub, Linear, other
  flows and webhooks start cards on their own.
- **People.** Owners, followers, @mentions, and a flow owner whom decisions
  go to, in their chat app.
- **Steps with and without AI.** Build and Research tasks; scripts with no AI;
  **Sort** with Jev (TypeSafe's decision model, through OpenRouter); **Draft**
  with Claude; web requests with secrets kept to headers; email through your
  own mail server; any of a project's MCP tools; updates to the GitHub or
  Linear issue a card came from.
- **Decisions from your phone.** Telegram, Slack, Discord and Teams
  messages carry the draft with Approve, Edit and Send back.
- **Email in.** An Email inbox trigger turns new mail into cards (IMAP, or
  a Google account signed in with Google), and replies to the sender stay
  in the thread. Automatic replies and your own mail never become cards.
- **Code in flows.** Scripts in Python, Node or shell (or a file in the
  project) get the card as data; what they print is passed on, a `goto:` line
  picks the next zone, saved secrets arrive as variables, and a schedule can
  run a script to make a card of each item it prints.
- **Chat in.** A Slack, Discord or Teams channel, or a Telegram group, feeds
  a flow after `flow 12` in it: each message is a card, replies in its thread
  join the discussion, and an Update zone answers in that thread.
- **Live canvas.** A flow open in several browsers changes in all of them
  the moment a card moves, and shows who else has it open and which card
  they're looking at.
- **Insights.** Where each flow breaks, how scripts do, how well sorting
  sorts, and every step's log.
- **Linux.** A one-command installer, and Claude and Gemini agents fenced
  with bubblewrap the way Seatbelt fences them on macOS.
- **First look.** `demo` now includes two flows mid-flight, and an empty
  Flows page offers a working example.
- **Settings.** An Email section, and "Check again" that really tests an
  API key.

Schema 90: the database upgrades itself on first start.
