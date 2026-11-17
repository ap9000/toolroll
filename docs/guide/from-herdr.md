# Coming from herdr

Delegate a change. Review the diff here.

Toolroll keeps tasks, build terms, results and review history. A task panel
shows saved work and live output; it is not a raw agent PTY.

| In herdr | In Toolroll |
|---|---|
| Panes | Task panels, pinned to separate tasks |
| Type into an agent | `s` sends a steering note to a running task |
| “Done” | **Ready**, awaiting your review; accept to mark Complete |
| Detach | Quit and choose **Keep agents running**; reopen with `toolroll` |
| Sidebar states | **Needs you / Working / Up next / Recent** |
| goto | `!` / `@` jump to the next / previous thing needing you |
| Layouts | `L` cycles one/two/four panels; `<` / `>` resize, `b` cycles the list, `z` zooms |
| Copy-mode search | `/` searches the current pane |

## Two tasks at once

1. Start `toolroll` in your main repository checkout. Press `n` and describe
   one small change, for example “Handle an empty search query without an error.”
   Enter submits **Just code**. Read the proposed build terms and confirm.
   For a plan first, press Tab before submitting, then review the plan.
2. Press `n` again for an independent change, such as “Document the search
   endpoint's empty-query response.” Review its terms and start it too.
   Each task builds on its own branch.
3. Press `L` for two panels. The other panel is pinned to another task;
   press `o` to focus it and choose the second task if needed. `O` goes back.
   Only the focused panel receives your input. Use `s` to steer its agent.
   The palette (`:` or Ctrl-K) also offers **Watch running tasks**: up to four
   running or retry-waiting tasks in a grid, with empty slots when fewer exist.
4. When a task is **Ready**, select it and press Enter to review its diff.
   Press `a` to accept after reading the confirmation, or `r` to submit
   feedback for a revision. Review the second result the same way. Accepting
   does not merge or publish either branch.

These example prompts are a walkthrough, not results from a real agent run.
For remote review, the browser and paired chat use the same saved task state;
**Watch running tasks** is a local terminal layout action, reached in its palette.

## What's different / not yet

- **No attaching to the running task agent yet.** Steering sends notes.
  Interactive agent threads are a beta setting, separate from task builds.
- **Open build shell** (`t`) opens a shell in a separate copy of the latest
  saved build. It does not control the running agent. The confirmation warns
  that your shell startup files and project hooks run there; Ctrl-] returns.
- **Remote work means builders and tailnet access**, not SSH panes. Connect
  the machine holding the projects as a builder; use the browser over a
  tailnet for remote access. See [getting started](getting-started.md#starting-with-toolroll-up).
- **Persistence depends on how you quit.** Keep-running installs/uses the
  background service; stopping saves work and ends the owned worker.
  See [what survives what](getting-started.md#what-survives-what).
- **Ready is a review state.** Read the actual check status and limitations.
  Completion never changes a failed check or grants permission to deploy.

[All terminal keys](getting-started.md#keys-and-layout) · [Tasks and revisions](tasks.md)
