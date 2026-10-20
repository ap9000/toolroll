# Live terminal — plan

Status: draft, 2026-10-20. Branch `live-terminal` (from `agents-cockpit`).

## What and why

A herdr-style Live mode: run `claude`, `codex` or a shell **interactively, in a real terminal**, from the
console on the desktop app and the phone. The person drives; nothing here is unattended. Overnight work stays on
the structured task road, unchanged.

Herdr feels fluid because its panes are real terminals streamed both ways over a WebSocket. Ours today are
headless runs with server-rendered pages. This adds the missing piece and nothing else.

## Shape

**A terminal session** is one pseudo-terminal (pty) running one program in one fresh worktree:

- `{ id, owner, repo, worktree, branch, program: "claude" | "codex" | "shell", cols, rows, startedAt, endedAt, exit }`
- The worktree is `toolroll/live-<id>` from the project's HEAD, under `<data>/live-worktrees/<id>`, made the same
  way the coding workspace makes its own (`coding-workspace.ts` start). The default branch is never the cwd.
- The program runs with `codingEnvironment()` (the coding workspace's scrubbed env: no Toolroll or chat
  credentials, no parent agent session identity), plus `TERM=xterm-256color`, `COLORTERM=truecolor`.
- `claude` and `codex` run as their own interactive TUIs with the operator's own login and config, exactly as
  if typed in a terminal. Toolroll adds no flags, prompt or approval mode.

**The host** is the console process, through `@lydell/node-pty` (prebuilt per-platform binaries shipped as
optional packages, no install script, no compiler). It is an `optionalDependency` loaded by dynamic import: if it
is missing, Live mode says "terminals aren't available on this install" and the rest of the console is unchanged.
Spike (macOS arm64, Node 22): spawn, write, resize and SIGHUP all work.

**Lifetime.** A session lives while the console runs, attached or not (close the phone, come back, it is still
there). It ends when the program exits, when its owner closes it, or when the console stops. On close the pty's
process group gets SIGHUP, then SIGKILL after 2 s. A child that started its own session (setsid/nohup) escapes
that on macOS; that is the same limit any terminal has, and it is stated on the close control. The worktree and
branch stay after a session ends (the work is there), listed as ended until the person removes them.

Limits: 8 live sessions per console; 1 MiB of scrollback per session in memory (a ring of raw bytes, replayed on
attach); ended sessions keep their scrollback until removed or the console stops.

No schema change. Sessions are in memory; start, attach, close and remove are written to the event log (who,
which session, which project; never typed input or output).

## Transport

One WebSocket per open terminal: `GET /term/<id>/socket` with `Upgrade: websocket`, on the console's own server
(`server.on("upgrade")`), using the `ws` package (pure JS, `noServer` mode). Every check runs before the upgrade
is accepted, and a refused upgrade gets a plain HTTP status and the socket destroyed:

1. the host is one this server answers as (`allowedHost`), and the transport rule for plain HTTP holds;
2. `Origin` is present and is exactly this console's origin for that host, or the `--public-url` origin;
3. no `token` in the query; no `Authorization` header (browser sessions only, never API tokens or passwords);
4. the session cookie identifies an **approver**, re-proved like a live room (`readBrowser`: same session held,
   account unrevoked, same generation and role);
5. the terminal exists, its owner is this person, and its project is still visible to them
   (`codingProjectAllowed`, `accountCanAccess`).

The session cookie is `SameSite=Strict`, so a cross-site page's handshake carries no cookie; the Origin check is
the second wall. While open, step 4 and 5 are re-proved every 30 s and before each input frame is applied; a
failure closes the socket (4401) and the page shows "signed out".

Frames:

- server → client: **binary** = pty output bytes; **text** = JSON control: `{"t":"hello","cols","rows","program","ended"}`
  first (after the scrollback replay), `{"t":"exit","code","signal"}` when the program ends.
- client → server: **text** JSON only: `{"t":"in","d":string}` (UTF-8, ≤ 64 KiB) and `{"t":"resize","cols","rows"}`
  (cols 2–500, rows 1–200). Anything else, any binary frame, or a frame over 64 KiB (`maxPayload`) closes 1003.
- Several viewers may attach (desktop and phone, same owner). Output goes to all; the last resize wins.
- Backpressure: a viewer whose `bufferedAmount` passes 4 MiB is closed (4008, "fell behind"); its page reconnects
  and gets the scrollback replay. The pty is never paused for a slow viewer.

## Routes

| Route | Scope | Does |
|---|---|---|
| `GET /term`, `GET /term/<id>` | `coding` read, `limited: self` | the Live page (workspace shell, view `terminal`) |
| `GET /term/state` | same | JSON list of this person's sessions (for the drawer) |
| `POST /term/start` | **step-up** (`CODING_ACT`) | project + program → worktree + pty → `/term/<id>` |
| `POST /term/<id>/close` | act | end the program |
| `POST /term/<id>/remove` | act | an ended session: drop it, remove its worktree (branch kept) |
| `GET /term/<id>/socket` | upgrade only, checks above | the stream |

Starting is a step-up (a fresh password or identity-provider re-check), because a terminal is
shell-equivalent on this computer. That matches starting a coding-workspace session today.

## UI

React view `terminal` in the workspace shell, with `@xterm/xterm` + `@xterm/addon-fit` bundled by esbuild
(no CDN, notices collected by the existing build):

- **Drawer** (left on desktop, sheet on phone): this person's sessions; program, project, branch; running or ended.
- **Terminal**: full-bleed xterm, themed from the Operations Ledger tokens (ink ground, Plex Mono). Fits on resize
  and on the phone's visual viewport change (keyboard up/down).
- **Phone key bar** above the keyboard: Esc, Tab, Ctrl (sticky), ↑ ↓ ← →, and `/` — the keys a phone keyboard
  lacks and these TUIs need.
- **New session** sheet: project, program, and the step-up (the existing ceremony surface).
- Reconnects with backoff; "fell behind" and "console restarted" read as words, not errors.
- A "Live" entry in the navigation.

The desktop app needs no change: WKWebView speaks WebSocket.

## Tests

- Frame parsing and bounds; ring buffer; session cap; process-group close (a real pty running `sh`).
- Upgrade refusals, each its own test: wrong host, missing or foreign Origin, no cookie, viewer, API token,
  password bearer, someone else's session, unknown session, project no longer visible.
- A real round trip: start (step-up), attach, type into `cat`, read it back, resize, close, exit frame.
- Re-proof: sign out while attached → closed 4401; slow viewer → closed 4008 and replay on reconnect.
- Start without a fresh step-up is refused; nothing is created.

## Not in this slice

Sessions that survive a console restart (tmux-backed), split panes, handing a Live session to the task road or
back, Linux cgroup containment for terminals, notifications when an agent waits for input, the herdr-style
transcript reader for sessions started outside Toolroll.
