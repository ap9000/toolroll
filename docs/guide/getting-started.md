# Getting started

## Install

On macOS or Linux, with Node.js 22.13 or newer and git:

```sh
curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh
```

It installs the `toolroll` command and starts it with your projects in
`~/Projects`. `standing-orders`, the older name, still works. You can also run
it without installing: `npx toolroll up`.

The first start prints your login and saves it in
`~/.config/toolroll/up-login.txt`, then opens the console at
http://127.0.0.1:4180.

To look around first, `npx toolroll demo` opens a throwaway sandbox
with tasks and two flows already mid-flight. It never spends and never
reaches outside.

### Other ways to install

| Install with | Command |
|---|---|
| npm | `npm install -g toolroll` |
| Homebrew | `brew install ap9000/toolroll/toolroll` |
| bun | `bun add -g toolroll` |
| pnpm | `pnpm add -g toolroll` |
| yarn | `yarn global add toolroll` |
| script | `curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh \| sh` |

Bun's runtime has no `node:sqlite`, so Toolroll always runs on Node; `bunx`
hands the shebang to Node, so `bunx toolroll up` works too. Coming from
Standing Orders? It's the same product renamed; the `standing-orders` command
and your data keep working.

### More about `up`

Choose your projects folder the first time:

```sh
npx toolroll up --project-root ~/Projects
```

`up` prints your login once (and saves it beside the database as
`up-login.txt`), opens the app in your browser, and connects this machine as
the builder. Add an existing folder or a GitHub repository from **Projects**;
the builder and unified chat pick it up while the app keeps running. The
projects folder and every added repository are remembered. Later,
`toolroll up` can be run from any directory and reconnects all of them. You
do not run `up` separately in each project.

To reach it from your phone over a tailnet:
`toolroll up --host 0.0.0.0 --allow-host <your-machine>.ts.net:4180`.

If the inbox says **Builder disconnected**, reopen Toolroll on the machine
where the projects live; queued work resumes automatically.

```sh
npx toolroll demo               # a seeded sandbox: see it working in 90 seconds, zero spend
npx toolroll                    # what's in flight across your repos: read-only, zero config
```

## Install with your agent

Paste this into Claude Code or Codex:

> Install Toolroll with `npm install -g toolroll` and start `toolroll up` in
> the background; it keeps running. Then run `toolroll onboard` in this
> repository, and run it again with `--yes` to install Toolroll's skill for
> you. Tell me the console address, where my login is saved (not the
> password), how to pair my phone, and what I can ask you next.

`toolroll onboard --yes` adds the repository (its main checkout) as a
project, says which agent CLIs are signed in, and prints the line that adds
Toolroll as tools (`claude mcp add --scope user toolroll -- toolroll mcp`)
without running it. `toolroll onboard --remove --yes` takes the skill out
again. How an agent then drives Toolroll is in [Toolroll for agents](../agents.md).

## Your first project

Open **Projects** and add a folder or a GitHub repository. Any repository you
put in the projects folder later connects by itself.

Agents need a coding CLI signed in on this computer: Claude Code (`claude`),
Codex (`codex`) or Gemini. Settings → AI providers shows which are connected.

## Your first task

Open **Chat** and say what you want in plain words. The lead drafts a task
with a goal, boundaries and checks for you to approve. Nothing is built until
you approve it, and every result waits for you to accept it.

## Start from a kit

**Starter kits** (linked from an empty chat, Flows and Settings → Lead) set up a
working team in one click: a subagent, the flow it works, and its
buttons. Each kit's page is a checklist of what's left, with the next step on
each line: connect email, connect the tools the subagent uses, and **Try it**,
which puts a sample card in front of the subagent so you see it work.

- **Support desk:** Maya drafts a reply to each customer email and you approve
  it before it goes out; anything it can't answer comes to you.
- **Bug triage:** Theo sorts each new issue into bug, question or noise,
  answers questions, and turns real bugs into fix tasks you approve. It can
  bring in your GitHub issues.
- **Sales follow-up:** Leo writes back to each new lead, you approve the
  email, and it follows up when there's no answer in three days.
- **Ops requests:** Ada approves routine requests under $200 without you and
  brings you everything else.

Setting a kit up twice changes nothing; its page opens instead. You can
also ask the lead: "Set up the support desk kit in shop".

## Your first flow

Open **Flows**. With no flows yet, **Try an example** makes one: Claude
drafts a reply to a sample customer question, and you approve or edit it. Or
pick a template under **New flow**, or ask the lead: "Make a flow where Jev
sorts new support emails into billing, bugs and questions".

## On your phone

Settings → Telegram connects a Telegram bot you make with @BotFather. Pair
your chat with the `/pair` code it shows, and decisions arrive with buttons.
See [Chat and your phone](chat-and-phone.md).

## Updating

`npm install -g toolroll@latest`, then start it again. Your database
upgrades itself on the first start; back it up first if you like:
`sqlite3 ~/.config/toolroll/orders.db ".backup orders-backup.db"`.

## Step by step in the console

There is one normal road: keep one `toolroll up` running on the machine. It
is the app and the builder for every saved project. The separate console,
worker and OS service commands are advanced deployment tools for people
splitting those parts across machines (see [Running unattended](unattended.md)).

1. **Sign in** with the login `up` printed. You land on the **inbox**:
   everything that waits on you, and nothing else.
2. **Describe the outcome** with **+ new task**. The normal path is one
   ChatGPT-style prompt: the planner inspects the open repository, drafts the
   goal, boundaries, acceptance rubric, and implementation approach, then asks
   only when a missing answer would materially change the work. Project and
   quality stay in the compact footer; **Edit details** reveals the full
   contract, research-only mode, permissions, dependencies, and expert fields.
3. **Review and approve the proposed scope.** A scope needs at least one
   criterion (a plain outcome statement and the evidence kind that will
   answer it: check, screenshot, changed-path, or manual review) before it
   can be signed. The task page leads with a concise approval card; the full
   structured, editable execution plan and full contract remain one click
   away. It restates the exact scope and rubric you are signing, the provider
   and model it will run on, and asks for your password. Nothing spends a
   token until this yes.
4. **Watch it build.** The **board** moves the card to *building*; the
   card's own page shows the stage, the live transcript, and, once the
   agent checkpoints one, which milestone is pending, in progress, done,
   or blocked. **Peek** (`/peek`, or *peek at the live ones* on the builds
   page) shows every live agent at once. If the repository disproves a
   named dependency or risk, the task page shows the replacement plan with
   its evidence; a plan-only fix resumes on its own, while anything that
   would touch what you signed waits for your accept or reject.
5. **Answer when asked.** An agent that hits a judgement call parks a typed
   decision: question, options, consequences, which are reversible. It
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

Specialized views remain in **Tools** and **Settings**: the activity ledger,
the review cockpit, the fleet, people (invite a second approver), the
operating mode (a signed, expiring envelope that pre-approves your own
filings), and **chat**: your lead, one conversation across every project,
which only ever proposes.

## From the terminal

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
toolroll chat --say "what is waiting on me across every project?"       # your lead
```

Every command takes `--json` and answers with one envelope; every mutation
takes `--key` so a retry never files twice. `toolroll --help` and
`toolroll skills get console` are the live references; the second is what
your coding agent reads when you ask it how something works.

An agent that hits a judgement call **parks a typed decision instead of
guessing**: answer it from the terminal, the console, or a Telegram tap, and
the freed build resumes in seconds. Built work leaves only as a pushed branch
and a pull request, under a publication grant whose exact terms you approved.

## Running only the console

Advanced deployments can start the console alone with
`toolroll serve --repo .`: with no account yet it prints a six-digit setup
code, and the login page offers **create the first account**. Enter the
code, pick a username and password, and you are in. A second person joins by
invite link from the people page, never by another setup code.

`toolroll serve --repo <path>` is the whole built-in queue, operable from a
phone: an inbox of everything waiting on you, a live activity report (run
counts, measured spend, decisions, incidents, stranded work, gaps), every
task with its scope, holds, runs, decisions and incidents on one screen, run
pages with the economics and the agent's concluding words, and read-only
capabilities. Adding a task, holding, requeuing, cancelling, and editing a
scope all happen from the page, each re-proved server-side, so a stale tab
never erases what the world did in the meantime, and a task a runner is
building right now refuses to be cancelled out from under it.

Approving a scope is deliberately heavier than a click: the form restates
the goal, the exclusions, and the touched paths (exactly the fields the
approval digest binds) and requires your approver token typed again. A
logged-in session alone can read everything and approve nothing.

Plain HTTP, so keep it on localhost or a tailnet and put TLS in front for
anything else. For a whole team on one host, see
[A team server on a real domain](../team-server.md).

## Desktop app (macOS)

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
See [build and usage instructions](../control-app.md) and
[the integration assessment](../CONTROL_APP_INTEGRATION.md).
