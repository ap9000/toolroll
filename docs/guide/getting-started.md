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

## Install with your agent

Paste this into Claude Code or Codex:

> Install Toolroll with `npm install -g toolroll` and start `toolroll up` in
> the background; it keeps running. Then run `toolroll onboard` in this
> repository, and run it again with `--yes` to install Toolroll's skill for
> you. Tell me the console address, where my login is saved (not the
> password), how to pair my phone, and what I can ask you next.

`toolroll onboard` adds the repository as a project, says which agent CLIs are
signed in, and prints the line that adds Toolroll as tools
(`claude mcp add toolroll -- toolroll mcp`) without running it.
`toolroll onboard --remove --yes` takes the skill out again.

## Your first project

Open **Projects** and add a folder or a GitHub repository. Any repository you
put in the projects folder later connects by itself.

Agents need a coding CLI signed in on this computer: Claude Code (`claude`),
Codex (`codex`) or Gemini. Settings → AI providers shows which are connected.

## Your first task

Open **Chat** and say what you want in plain words. The lead drafts a task
with a goal, boundaries and checks for you to approve. Nothing is built until
you approve it, and every result waits for you to accept it.

## Change requests from youiyoux

If a project uses youiyoux, the design-system tool (it has a
`youi.project.json` or a `.youi/requests` folder), a change you ask for in the
youiyoux hub becomes a Toolroll task by itself, within a minute, with no setup.
The task keeps the request's goal, what it must not change, the files it
touches (when youiyoux knew them all) and its requirements.

- **It always waits for you.** No hands-off mode, flow grant or schedule
  approves it. You approve it in Toolroll, where you see every word, or in
  your paired chat.
- **Approve from chat, one at a time or all at once.** Each pass that files
  requests sends one card to your paired chat. It lists every new task with
  every word of its terms: the goal, what it must not change, its files (or
  "any file (no file list)"), its requirements, and what the agent may do and
  spend. **Approve all** and each task's own **Approve** ask once more before
  they act. A task whose terms changed since the card was sent is named and
  left out. A task too long for one message (or one that names a folder on
  your computer) gets only its **Open** link. This needs approving from chat
  turned on (in Settings, or `toolroll chat-approval on`); without it the card
  still comes, with each task's link. Teams shows the links only.
- **Each request is filed once.** Editing or reopening it later files nothing
  new. Comments and closed requests are left alone, and text that looks like
  a key or password is never filed.
- **The task says where it came from.** Its page names the request, the page
  and component you pointed at, and the file and line that draw it.
- **youiyoux sees how it's going.** Beside each request Toolroll writes
  `<id>.task.json` with the task and its status: queued, needs-you,
  building, ready, done, failed or stopped. It also links to the task and to
  what needs you in Toolroll, using the console address you set, or else this
  computer's own console. Beside an options request's options (below), it is
  the only file Toolroll writes in your checkout, and never through a link.
- **Options come back to youiyoux's canvas.** When you ask youiyoux for
  options on a component, the request becomes a task the same way, and waits
  for your approval the same way. Its agent may write one file,
  `.youi/proposals/p-<id>.json`, with two to four options. Once the result is
  ready for review, Toolroll copies that file from the result's commit into
  your project, and youiyoux's hub shows the options on the Screens canvas.
  It never copies a file that is a link, over 64 KB, not youiyoux's options
  format, already decided or holding a key, and never replaces a file already
  there; the request's status says why instead. Keep `.youi/proposals` out of
  `.gitignore`, so the agent's file is part of its result.
- **Pick in youiyoux, done in Toolroll.** When you pick an option or dismiss
  them in the hub, Toolroll marks the task complete without merging or
  publishing its branch, and its history says who decided what. If the task
  would need someone else to complete it (it changed protected files), has a
  failing check, or has a newer result, it stays ready for review and says
  why.

Settings → Integrations shows each project's **youiyoux** row: Connected with
how many requests are queued, Broken when a request file can't be read (a link,
over 64 KB, or not a request), and **Turn off** to stop it for that project.

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
