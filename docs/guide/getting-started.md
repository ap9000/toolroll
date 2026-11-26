# Getting started

## Install

| Platform | Native terminal workbench | Sandbox requirements | Node / git minimum |
|---|---|---|---|
| macOS | Yes | Built-in Seatbelt (`sandbox-exec`); agent sandbox support | Node 22.20+, git 2.41+ |
| Linux, 64-bit (x86_64, aarch64) | Yes | `bubblewrap`, `socat`, `ripgrep`, `bash`, `which`; working user namespaces (see [Linux](linux.md)). 32-bit Linux (armv7, a 32-bit Raspberry Pi OS) isn't supported | Node 22.20+, git 2.41+ |
| Windows | Not supported: Toolroll can't run agents in a sandbox on Windows itself. Use WSL 2 | | |
| WSL | Linux workbench | Same Linux tools and kernel sandbox requirements | Node 22.20+, git 2.41+ |

Sign in to Claude Code (`claude`) or Codex (`codex`) on the builder.
On Linux/WSL: `sudo apt update && sudo apt install bubblewrap socat ripgrep bash debianutils` (Fedora, Arch, Alpine, openSUSE: [Linux](linux.md#install-the-sandbox-tools)).

```sh
curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh
```

Run it inside one of your projects (a git repository): it installs the
`toolroll` command and opens Toolroll on that project, in this terminal.
Inside a linked git worktree (`.git` is a file), the installer deliberately
does not autostart: use the main checkout and run `toolroll` there. Without a
terminal (a script, CI), or outside a repository, it prints how to start. `standing-orders`, the older
name, still works (the script removes the older `standing-orders` package
first, saying so). With npm instead:

```sh
npm uninstall -g standing-orders && npm i -g toolroll
toolroll
```

The first command removes the older `standing-orders` package if it is there;
npm can't install over it.

To look around first, `npx toolroll demo` opens a throwaway sandbox
with sample tasks already mid-flight. It never spends and never
reaches outside.

## Your first run

Type `toolroll` at your terminal. It starts Toolroll on this computer, or
opens the one already running, and shows it right there: your tasks, what
each agent is doing and what needs you.

- **No password.** A new install on your own computer signs you in as its
  owner. There is no login file to find. You can watch and drive your work,
  approve plans and add projects without one.
- **Ready to start.** With no task selected, the workbench asks
  **What would you like to work on?** and offers **New task n** and
  **Agents A**. If an agent is ready and a project is connected and taking
  work, press `n` and describe your change. The welcome shows the agents'
  readiness and who the first task goes to; if an agent needs sign-in or a
  check, it shows that next action there instead.
- **When setup is missing.** Before the first Ready result, unfinished
  project and worker setup appears under **Needs you**: **Add a project**
  when none is connected, or **Start taking work** when no builder is ready
  for the project. Completed steps and checks still in progress aren't asks.
  Agent sign-in and the first task stay in the workbench's welcome rather
  than becoming separate setup rows. Setup asks are only shown to an
  approver, outside the demo and restricted consoles, and retire after the
  first Ready result.
  For the full **Agent · Project · First task** walkthrough, run
  `toolroll welcome` or open the browser's welcome page. With no project,
  `toolroll welcome sample` makes a tiny sample repository (available while
  no password is set). Or add your own with `toolroll repos add <folder>`.
  Press `A` to open Agents and sign in there; `w` opens the browser.
- **Build and collect.** In the new-task composer, Enter submits **Just code**
  by default. Tab switches to **Plan first**; Enter submits that choice.
  Read any proposed build terms before confirming. Plan first asks you to
  review and approve the scope before it builds. The result comes back **Ready**: press `a` to inspect and accept
  it, or `r` to send it back with a note. On a failed task, `r` reviews and
  retries it. `?` lists the keys in use. See [The terminal workbench](#the-terminal-workbench).
- **The browser.** Press `w`, or run `toolroll --web`. It opens signed in.
  Running `toolroll` again gets you back in from any terminal.
- **Quitting.** `q` asks whether to stop the agents (running work is saved)
  or keep Toolroll running in the background. The first time, Toolroll asks
  once whether to keep running in the background; change it later with
  `toolroll background on` or `off` (see
  [Running unattended](unattended.md#keeping-it-running)).

Toolroll is at `http://127.0.0.1:4180`. If another program already uses that
port when you first start, a new install takes the next free one and keeps
it.

### What survives what

| What you do | What survives / how to return |
|---|---|
| Close the terminal | Saved tasks and results remain. A foreground worker loses its parent and drains; an installed background service keeps running. Run `toolroll` to reopen. |
| Quit → Keep agents running | Toolroll hands work to its background service, which starts when you log in. A failed handoff is reported; it does not promise continued work. Reopen with `toolroll`. |
| Quit → Stop agents and quit | The worker owned by this terminal stops, saving running work. Saved tasks/results remain. Run `toolroll` to start again. A screen attached to an existing server only disconnects. |
| Restart the computer | Live processes end; saved tasks/results remain. An enabled background service starts when you log in; otherwise run `toolroll`. Interrupted work recovers from saved state, not an attached PTY. |

[Coming from herdr](from-herdr.md) walks through two tasks side by side.

### Other ways to install

| Install with | Command |
|---|---|
| npm | `npm uninstall -g standing-orders && npm i -g toolroll` |
| Homebrew | `brew install ap9000/toolroll/toolroll` |
| bun | `bun add -g toolroll` |
| pnpm | `pnpm add -g toolroll` |
| yarn | `yarn global add toolroll` |
| script | `curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh \| sh` |

Bun's runtime has no `node:sqlite`, so Toolroll always runs on Node; `bunx`
hands the shebang to Node, so `bunx toolroll up` works too. Coming from
Standing Orders? It's the same product renamed; the `standing-orders` command
and your data keep working. Remove the older package first
(`npm uninstall -g standing-orders`), or npm stops with `EEXIST`.

Toolroll needs git 2.41 or newer: it reads agent-written checkouts with
`git --attr-source`, which older git refuses, and `toolroll up`, `serve`,
`watch` and `doctor` say so when the installed git is older. Ubuntu 24.04
ships 2.43, which works; Debian 12 ships 2.39: install a newer one there. On
git older than 2.45 (no `git --no-lazy-fetch`), a project that is a partial
clone (`git clone --filter=…`) is refused for Toolroll's protected reads: use
git 2.45 or newer for those, or a full clone. CI runs the git tests on 2.41
and on 2.47.

## Your first project

Open **Projects** and add a folder or a GitHub repository. Any repository you
put in the projects folder later connects by itself.

Agents need a coding CLI signed in on this computer: Claude Code (`claude`)
or Codex (`codex`). Settings → AI providers shows which are connected.

## Your first task

In the terminal: `n` → describe → Enter for **Just code** (Tab for
**Plan first**). Review the result when it is Ready.

Open **Chat** and say what you want in plain words. Toolroll drafts a plan
with a goal, boundaries and checks for you to approve. Nothing is built until
you approve it, and every result waits for you to accept it.

## The terminal workbench

Bare `toolroll` opens the workbench on macOS and Linux. The work list sits
beside the selected task. **Live** shows the agent's output, **Steps** shows
progress and failures, **Diff** shows the result and your notes, and
**Terminal** holds a shell on the build. The top bar shows today's cost.

Click a stage in the progress bar or its row in **Steps** to inspect it.
A running **Build** opens live output. **Ready** opens the diff when a result is available.
In **Steps**, use **j/k** or the arrow keys to select a stage, **Enter** to open it,
and the mouse wheel to read longer details.

When a plan needs your approval, click its **Approval** card in **Steps**, or
press **a**. Read the terms with the wheel, **Read more**, or **Space**.
Choose **Approve build** to start, or **Back** to leave it waiting.

### Keys and layout

These are the default keys from the workbench's keymap. Press `?` for help
generated from the keys you actually use, including your custom bindings.
Press `:` or `Ctrl-K` for the command palette: actions, tasks, projects and
settings. Actions without a key are available there too. **Watch running tasks**
opens up to four running or retry-waiting tasks in a grid. Unfocused headers
show the task title, agent/model, current state or retry wait, and known cost.
This is a local layout action; use the terminal palette to reach it from chat.

| Key | Action |
|---|---|
| `j` / `k`, Down / Up | Move through the list (when List is focused) or scroll / move lines (when the task panel is focused) |
| Left / Right | Focus the task list / focus the task panel. Focusing the list reveals it when hidden or zoomed |
| Enter | Open and focus the changes for a result, otherwise its live output |
| Tab / Shift-Tab | Next / previous tab: Live, Steps, Diff, Terminal |
| `n` | New task (in focused Diff, next note instead) |
| `C` | Central Lead chat (open / focus the Lead conversation shared with `/chat`; also pinned at the top of the Work rail) |
| `Tab` in Message Lead | Browse the choices in the conversation. Click a choice, or select its visible number and press Enter. Up and Down move between choices. |
| `F2` in Lead | Check membership sign-ins, switch Lead to Codex or Claude, or connect a provider. A failed provider reply opens the same dialog. Send the draft again when ready. |
| `D` | Dock Central Lead chat beside the Peeked Task panel (`o` switches focus between Chat and Peek; task links inside Lead cards jump the Peek panel straight to that task's Diff / Steps / Live) |
| `T` | New [interactive agent thread](#interactive-agent-threads-beta) (beta, off by default) |
| `s` / `a` / `x` / `X` on a thread | Reply to it / Ship its work / stop its agent's turn / end it (asks first) |
| `x` / `r` on a thread that is shipping | Stop the Ship for good / send it back with a note |
| `s` | Focus the running agent’s message field. You can also click the field, type, and press Enter to send. |
| `p` | Pause the build; press again to resume |
| `x` | Stop a build or its retries; resume retries on a task you held |
| `X` | Cancel the task |
| `a` | Inspect and accept the result |
| `r` | Send back with a note; on a failed task, review and retry |
| `t` | Open build shell (separate copy of the latest build) |
| `L` | Cycle one panel, two side by side, or a grid of four |
| `o` / `O` | Focus the next / previous pane |
| `<` / `>` | Narrow / widen the list with one panel, or the focused panel in a split |
| `=` | Even the splits and restore the usual list width |
| `b` | Cycle the list: full, slim status rail, hidden |
| `z` | Zoom the focused panel; press again to return |
| `!` / `@` | Cycle through waiting items, oldest first. Click the "need you" chip to go directly to the oldest |
| `'` | Return to where you were before jumping |
| `/` | Filter the task list live (when List is focused) or search the focused pane (when Detail is focused) |
| Ctrl-E | Open the focused pane's text in your editor |
| Page Up / `u`, Page Down / `d` | Scroll up / down |
| End / `G` | Follow the newest output |
| `y` | Copy a hunk or terminal output to the terminal's scrollback |
| `A` | Open Agents |
| `M` | Choose model assignments for new tasks |
| `w` | Open Toolroll in the browser |
| `1`–`9` | Answer the agent's question |
| Esc | Return focus to the list, clear a filter/search, or close a dialog |
| `q` / Ctrl-C | Quit |

In Diff, `j` / `k` move by line, `[` / `]` by hunk, and `{` / `}` by file.
Home or `g` goes to the first line of the file.
`c` adds a note; Backspace or Delete removes it. `n` / `N` move between notes.
`e` / `E` reveal more lines above / below a hunk. `v` switches to a side by
side diff on a wide window. Notes stay with the result until you send them.

Use **Move the list to the other side** in the palette to put it on the
right. Settings → **List side** sets the default. The file setting is
`list-side = "right"` (also accepted as `list_side`; use `"left"` to return).
For `list-side`/`list_side` and `focus-follows-mouse`/`focus_follows_mouse`,
the kebab-case spelling wins when both are present, regardless of order.
An invalid kebab-case value uses the default. Saving writes the kebab-case
key and keeps snake-case entries and their comments untouched.

Below 64 columns, the workbench shows one column. Enter opens a task from
the list, Esc returns to the list, and `b` switches between list and task.
Your wider layout returns when you widen the window.

Finished tasks keep an unread dot until you open them. Toolroll remembers
the selected task and tab, list width, side and visibility, layout, split
ratios and unread tasks per project. This goes in
`$XDG_STATE_HOME/toolroll/view.json` when that variable is an absolute path,
otherwise `~/.local/state/toolroll/view.json`. It is separate from your
settings file and stores no task titles, agent text or credentials.

### Search, editor and shell

Press `/`, type a search, then Enter to keep it. `n` / `N` move through
matches while searching; Esc leaves search. Search covers the focused
Live, Steps, Diff or Terminal pane.

Ctrl-E opens that pane's cleaned text using `$VISUAL`, or `$EDITOR` if
`$VISUAL` is unset or blank. It opens a text snapshot; saving it does not
change the task or build.
Toolroll neutralizes modelines in the text and disables Vim modelines and
Emacs local variables. Agent sign-in and install panes are never searched
or exported to an editor.

On the Terminal tab, `t` starts a real shell in a separate copy of the latest
build. Ctrl-] leaves typing mode and returns to workbench keys. The shell
keeps running. Use Ctrl-] to leave an agent's sign-in pane too.

### Settings and themes

Open **Settings in use** from the palette, or press `?` then `s`. Select a
row and press Enter to change theme, density, glyphs, list side or
notifications. These choices are saved to `tui.toml`; existing comments and
other settings stay in place. A save failure is shown on screen.

The file is `$XDG_CONFIG_HOME/toolroll/tui.toml`, or
`~/.config/toolroll/tui.toml` without that variable. Look settings apply live,
usually within one second of a file edit. Key changes take effect the next
time the workbench starts. For example:

```toml
theme = "terminal"
density = "compact"
glyphs = "unicode"
list_side = "left"
key-bar = true
show-costs = true
columns = ["step"]
bell = true
reduced-motion = false
tmux-passthrough = false

[notifications]
asks = true
finished = false
failed = true

[keys]
preset = "default"
accept = "f2"
```

Themes are `terminal` (your terminal's colours), `light`, `dark` and
`high-contrast`. Density is `compact` or `comfortable`; glyphs are `unicode`,
`ascii` or `nerd`. Optional list columns are `agent`, `step`, `age`, `cost`
and `project`. Key presets are `default`, `vim` and `emacs`; bind an action
by its name under `[keys]` with one key or a list of keys. The help screen
shows the resulting bindings. Unknown settings and invalid values produce
a warning and fall back safely.

Colour follows your terminal: full colour, 256 colours, or its own 16
colours. A nonempty `NO_COLOR` disables colour; `TERM=dumb` does too. Bold,
dimming and reverse video still distinguish states. Optional `[colors]`
overrides are checked for contrast and distinct status colours; unusable
overrides are ignored with a warning. The palette's theme, cost and key-bar
toggles affect only this session. Use Settings to save a theme.

You can also inspect, change or reset the look from a shell:

```sh
toolroll view                    # show the look in use and saved themes
toolroll view theme set dark     # use a built-in or saved theme
toolroll view reset              # default look; keep your keys and back up the old file
```

Reset preserves `[keys]`, including comments, and keeps each previous file
as `tui.toml.bak-<date>T<time>` (UTC) beside `tui.toml`; a file already at the
defaults is left alone, with no backup.
You can also [ask chat to restyle the workbench](chat-and-phone.md#restyle-the-workbench-by-asking-your-agent).

Desktop notifications inside tmux need both `tmux-passthrough = true` and
tmux's `allow-passthrough` enabled.

### Agents

Press `A`. Agents are grouped as **Ready**, **Needs sign-in**, **Needs a
check** and **Not installed**. **Check again** refreshes status without a
model call. A signed-out agent is never started in the background; the
status names the command to sign it in, such as `codex login`.

Choose **Sign in** to run the agent's own login in a pane. Its browser
sign-in works as usual. The agent saves its credentials in its own files;
Toolroll never sees those credentials. Sign-in output is not kept when
the pane closes. Never paste credentials into a task or chat.

**Install** shows the exact npm command and asks you to confirm before it
runs. Toolroll never runs `curl | bash` installers. For agents that only
offer those installers, copy the command and run it yourself if you trust
it. The screen also lets you copy sign-in commands.

For an existing idle task, click **Change builder** beside its model in Work, or press
`m`. If Toolroll asks for your password, open the task in your browser,
then choose **Agents → Change agents → Builder → Use**. In a session that can
save directly, select the model and choose **Use builder**. Review the updated
approval before resuming a held task. The model in the previous attempt stays in
its history. The picker shows configured choices; provider quota can change.

From Work, press `M` or find **Models for new tasks** in the command palette.
Select a role and press Enter. Press `/` to find a model by provider or name,
use the arrows to select it, and press Enter to preview the change. Enter
again saves it. The default-agent row applies a preset across roles.
These installation defaults apply to newly filed tasks. Settings → Models
in the browser also offers per-project overrides and task-size tiers.
Changing models here requires the operator on a solo install; otherwise
open Settings → Models in the browser with `w`.

### Interactive agent threads (beta)

A thread is Claude Code working with you interactively, inside Toolroll's
sandbox, instead of a task that plans, builds and stops. Press `T`, type
your first message, read the thread's terms, then press Enter to start.
Each thread works in its own copy of the project. Your repository changes
only when you **Ship**, and only when the project's required check passes
on that exact commit. A project whose terms let threads start like this is
**Flexible**: people there start threads right away, without a plan
approved first.

Working with a thread, select it in the workbench:

- **Reply** (`s`): its next message, once the agent finished the last one.
  Each reply starts a fresh agent that is given the conversation so far
  (your earlier messages, its earlier replies and which files each turn
  changed); your files are as it left them. Your messages show in the
  thread as yours.
- **Diff** (`Tab`): what the thread changed since it started, file by file
  (its committed work: what Ship would send).
- **Ship** (`a`): its terms are shown whole; read them to the end, then
  Enter. On a laptop install where nobody has a password, that ships it.
  Anywhere else Ship needs your password typed now: Enter puts
  `toolroll thread ship <thread>` in your scrollback, which shows the same
  terms, asks, and takes your password at a hidden prompt. Shipping stops
  the thread's agent first.
- **Stop** (`x`) ends the agent's current turn; the thread stays open.
- **End** (`X`) ends the thread for good: it moves to Recent and can't be
  reopened. Its work can still be shipped for a week; then its copy is
  tidied away.

A thread whose turn finished sits in **Needs you** as Ready. The browser's
Agents → Live lists your threads, read-only. From a terminal,
`toolroll thread list|show|end|remove|ship` work with your own threads.

Three steps, in this order, before a thread can start:

1. **Turn threads on.** They are **off by default**, including after an
   upgrade. An instance operator opens **Settings → General → Interactive
   agent threads (beta)** in the browser, or runs
   `toolroll config set flexible on`, and types their password (on every
   install). Turning them off needs only your signed-in session on a solo
   install. API tokens, the lead and chat apps cannot change it.
2. **Add your own Claude sign-in.** Each person brings their own: threads
   you start run on your Claude plan, never on someone else's sign-in or a
   shared one. In a terminal, run `claude setup-token`, finish signing in,
   then either run `toolroll config set flexible-sign-in` and paste the token
   at the hidden prompt, or paste it in **Settings → General → Your Claude
   sign-in for threads**. Saving asks for your Toolroll password, typed now.
   Toolroll then asks Claude to count the tokens of one word with it and
   tells you what it found ("Token-count check accepted", or why it couldn't
   tell); `--no-check` skips that. Toolroll never takes the token as an
   argument, never shows it again, and never gives it to the agent.
3. **Set up the project's terms.** Each project needs its own Flexible terms
   (Settings → Project, or `toolroll project flexible enable`).

If you press `T` before a step is done, the workbench says which one: `w`
opens its page in the browser and `c` puts its command in your terminal's
scrollback. `toolroll config show flexible` and
`toolroll config show flexible-sign-in` show where you are (on a solo
install, with no password);
`toolroll config show flexible-sign-in --check` checks your sign-in again.

Your sign-in ends when you remove it (Settings, or
`toolroll config clear flexible-sign-in`), when your Toolroll password is
reset, when you are removed from Toolroll, and when a backup is restored. If
Claude refuses it during a thread, the turn ends with Toolroll's own words
and your new threads wait until you save a new one. Removing it, a password
reset or an account change stops your running turns at once, in Toolroll's
own words, and stops their agents. Removing it in Toolroll
doesn't revoke it at Claude: do that in your Claude account. An instance
operator can remove someone's sign-in from People, but can never see or set
it.

Limits for now:

- **Claude Code only.** Codex threads come later.
- **Plan sign-ins only** (`claude setup-token`), not API keys.
- The agent's model calls go through Toolroll's relay with your sign-in;
  Toolroll never gives the agent your sign-in.
- Turn limits and the project's network still apply.

Turning threads off takes effect at once. No new thread or turn starts, and a
running thread's next model call is refused. `toolroll config set flexible
off` stops every running thread's agent itself and says what it stopped;
an open console also stops them within a few seconds and keeps retrying any
it couldn't confirm. Your past threads stay readable. Turning down is never blocked: with threads off, a
project's Flexible terms still show and can be lowered or turned off
(Settings → Project, or `toolroll project flexible lower|off`); only turning
them on waits for the switch.

Still being proven before threads can be on by default: permission prompts
reaching you from Claude Code, Codex inside the sandbox, Linux sandbox
escape tests in CI, and quarantine of imported work against the real
sandbox.

### When a build fails

**The agent stopped with an error** means the agent itself failed. Toolroll
stops after that one failure. Read **What the agent said** in Live or Steps,
fix the cause, then press `r` to review and retry.

A machine glitch retries automatically after a pause. Live shows
**Last build failed**, the reason, and the time until the next try.
Automatic retries stop after three consecutive failures. Provider throttling
or exhausted credits also follow the retry rules; Toolroll never silently
switches your agent or account.

**What the agent said** contains cleaned last lines, with paths and keys
removed. It stays inside Toolroll. It is never sent through chat, push,
email or webhooks. If no lines were saved, the failure still shows its reason.

Press `x` to stop retrying a waiting task, then `x` again to resume it.
`X` cancels a queued, running or failed task. Stop, resume, cancel and retry
ask first and refuse if the task changed since you looked.

## More ways to run it

None of this is needed for a first result.

### Letting agents work on their own

Work you start and approve on this computer needs no password. Hands-off
modes, merging, releasing, people and access, and most settings ask you to
set one first. When you reach one, the page says **Set a password**; or run
`toolroll password set` at your terminal (typed twice, never a flag or a
file). Every open tab and the terminal then sign in again, and approving
your own work still needs no password.

Forgot it later? Run `toolroll password reset` in a terminal on the
computer running Toolroll and type a new one twice. Every session of that
account ends. Anyone who can run commands as you on that computer can reset
it, so keep that computer's account to yourself.

### Starting with `toolroll up`

`toolroll up` is the start for a team server, a computer reached from a
phone, or an install made before the bare `toolroll` start. Choose your
projects folder the first time:

```sh
npx toolroll up --project-root ~/Projects
```

`up` saves your password beside the database in
`.toolroll-secrets/up-login.txt`, a private folder no agent can read (every
start prints where, and the `cat` command that shows it; never the password
itself), opens the app in your browser, and connects this machine as
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
npx toolroll                    # open the terminal workbench
```

### Install with your agent

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
  there (that task then waits for your review); the request's status says why
  instead. Keep `.youi/proposals` out of
  `.gitignore`, so the agent's file is part of its result.
- **Pick in youiyoux, done in Toolroll.** When you pick an option or dismiss
  them in the hub (on the options Toolroll copied, unchanged), Toolroll marks
  the task complete without merging or
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

## Step by step in the browser console

There is one normal road: keep Toolroll running on the machine (`toolroll`
at your terminal, or `toolroll up`). It is the app and the builder for every
saved project. The separate console,
worker and OS service commands are advanced deployment tools for people
splitting those parts across machines (see [Running unattended](unattended.md)).

1. **Sign in.** A laptop install opens already signed in; otherwise use the
   login `up` printed. You land on the **inbox**:
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
   and model it will run on. On a laptop install, approving work you
   started on this computer needs no password; protected work, raised
   permissions and releases ask you to set one (or type it, once set).
   Elsewhere it asks for your password. Nothing spends a token until this
   yes.
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
   arrives on Home (`/`) and on your phone if Telegram is
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
toolroll task show retries --json          # the scope's digest and approvalTerms are what you sign
toolroll task approve retries --as you --digest <digest> --terms <approvalTerms> --yes   # asks for your password

toolroll peek                               # one pane per live agent; q leaves
toolroll decide <id> --choose <option>      # answer a parked decision
toolroll task show retries                  # attempts, outcome, where the branch is

toolroll task add "Why does the login test flake?" --id flaky --report   # a scout
toolroll chat --say "what is waiting on me across every project?"       # your lead
```

Every command takes `--json` and answers with one envelope; every mutation
takes `--key` so a retry never files twice. `toolroll --help`, `toolroll internals`
and `toolroll skills get console` are the live references; the second is what
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
approval digest binds). On a laptop install, approving attended work on this
computer needs no password; hands-off work, merges and releases ask you to
set one first. On a console like this one, every approval asks for your
password typed again, and a signed-in session alone can read everything and
approve nothing.

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
