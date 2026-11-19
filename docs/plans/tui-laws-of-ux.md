# TUI Laws of UX Pass (`tui/laws-of-ux-polish`)

This document records the UX rationale, concrete changes, and verification steps for the Laws of UX pass on the Rust terminal workbench (`tui/crates/toolroll-tui/`), benchmarked against [Laws of UX](https://lawsofux.com/), Toolroll's Signal design system (`DESIGN.md`), and terminal multiplexers/orchestrators (**Zellij**, **tmux**, **lazygit**, **k9s**, **Claude Code**, **OpenCode**, **Codex**, **claude-squad**, **Agent of Empires**).

## 1. What Changed and Why

### A. Single-home header & Goal-Gradient pipeline (`view.rs`)
- **Laws applied:** *Law of Prägnanz*, *Occam's Razor*, *Goal-Gradient Effect*, *Von Restorff Effect*.
- **Problem:** On a live build, `"Building"` previously appeared 4 times simultaneously (list badge, right title badge, `Building now` in provenance, and `Build ◐ 4m` on the strip), while every row in a single-project view repeated the top bar's project name.
- **Change:**
  - Upgraded `strip()` into a structured, visual pipeline: completed steps read quietly (`✓ Plan`), the active stage is highlighted in its Signal role (`◐ Build · 4m 12s` running wash, solid-ink `● Ready` / `● Approval` chip when waiting on a person, vermilion `✕ Build` on failure, neutral fill on hold/retry wait), and upcoming steps stay muted. Smaller panels use shorter separators, then show the active stage and its clock when the whole chain no longer fits.
  - Omitted the duplicate title-line status badge whenever the pipeline already carries the active stage (while keeping mid-build `Question` chips visible on the title line).
  - Omitted duplicate `"Building now"` and duplicate live clock from `facts_line()` while the pipeline displays them, leaving crisp provenance (`claude sonnet · $0.31 · attempt 1`).
  - Omitted repeated project names from list rows when every listed item already belongs to the top bar's active project.

### B. Explicit `List` vs. `Detail` focus model (`app.rs`, `keys.rs`, `sheet.rs`, `view.rs`)
- **Laws applied:** *Jakob's Law*, *Law of Common Region*, *Selective Attention*, *Von Restorff Effect*.
- **Problem:** `j`/`k` switched tasks on `Live`/`Steps`/`Terminal` but silently switched to scrolling lines on `Diff`, while `n` created a New task everywhere except `Diff` (where it jumped to Next note). `/` searched pane text rather than filtering the task list, and the 2-column layout had no active-pane focus indicator.
- **Change:**
  - Added `Focus::List` (default) and `Focus::Detail` (`App::effective_focus()`).
  - `Enter` (`Open`) opens the appropriate tab and moves focus into `Detail`; `Right` (`FocusDetail`) and `Left` (`FocusList`) switch focus explicitly; `Esc` returns focus from `Detail` back to `List` (and in narrow `<64`-col view returns to the task list, labeled `· Esc list`).
  - Added `sheet::focus_bar()` — a bold ink `━` bar across the top padding row of the focused sheet (zero content rows lost, readable in all themes and `NO_COLOR`), plus bold/dimmed `"Work"` heading contrast.
  - Scoped `Diff` bindings (`j`/`k` line motion, `n`/`N` notes, etc.) strictly to `Focus::Detail` on `Tab::Diff`, so `j`/`k` and `n` never collide when navigating the Work list.
  - Made `/` contextual: in `Focus::List` it opens live `Mode::ListFilter` to narrow tasks by title/status/project (`Enter` opens & focuses, `Esc` clears); in `Focus::Detail` it opens `Mode::Search` to search the focused pane.
  - Clicking the List sheet focuses `List`; clicking a tab or the Detail sheet focuses `Detail`. Opening a build shell (`t`) moves focus to `Detail`.
  - Updated `bar_keys()` to reflect `Focus::List` vs. `Focus::Detail` and stopped duplicating `s steer` when the live composer right above already displays `[Steer s] [Pause p] [Stop x]`.

### C. Von Restorff / One Signal Rule & Fitts's Law (`view.rs`, `app.rs`)
- **Laws applied:** *Von Restorff Effect*, *Fitts's Law*, *Signal's One Signal Rule (`DESIGN.md`)*.
- **Problem:** Top-bar layout flags (`ZOOM`, `NARROW`, `RAIL`, `LIST HIDDEN`) used solid-ink `sheet::chip()`, competing directly with `N need you`.
- **Change:**
  - Demoted top-bar mode flags to neutral fill badges (`sheet::badge(m, Role::Fill)`), reserving solid ink exclusively for what needs a person.
  - Recorded `app.areas.needs_chip` and made clicking `N need you` jump straight to the oldest item waiting on you.

### D. Context-ranked Command Palette, Chunked Help, and Peak-End Clarity (`palette.rs`, `view.rs`)
- **Laws applied:** *Hick's Law*, *Choice Overload*, *Miller's Law*, *Chunking*, *Peak-End Rule*.
- **Change:**
  - Added `context_rank()` in `palette.rs`: keeps every applicable action reachable via search (preserving palette-to-key parity) while surfacing state-relevant actions first (`Answer` choices on a Question, `Accept`/`Send back` on Ready, `Steer`/`Pause`/`Stop` on Building).
  - Grouped the `?` Help overlay into **Navigate & layout**, **Work & decisions**, and **In Diff** while staying within 30 rows.
  - Added explicit reading progress (`Read X/Y · ↓ N more lines`) on `seen_end`-gated approval/send-back dialogs, counts of working items in the `q` Quit dialog, and kept `Typing · Ctrl-] back` visible on the Terminal header whenever room allows or `key_bar` is off.

## 2. Simplicity Pass (`AGENTS.md`)
- Removed 3× repeated `"Building"` labels in the active task header and per-row repeated project names in single-project views.
- Removed duplicate `s steer` keycap between the live composer and bottom key bar.
- Every drawn color pair continues to pass `tests/drawn_pairs.rs` (WCAG contrast + zero amber + Signal roles only across Light, Dark, High-Contrast, Terminal, 256, 16-color, and `NO_COLOR`).

## 3. Verification
Run from `tui/`:
```sh
cargo test -p toolroll-tui
```
Key coverage:
- `tests/laws_of_ux.rs` — focus separation, contextual `/` filter vs. pane search, single-home pipeline, Von Restorff top bar + clickable `needs_chip`, context-ranked palette.
- `tests/drawn_pairs.rs` — contrast & palette invariants across all themes and depths.
- Updated snapshots across `tests/snapshots/` reviewed for visual accuracy.

## 4. Follow-Up Scope (Not Included in This Slice)
These larger P1/P2 items remain for dedicated follow-up slices:
1. **Narrative-first collapsible transcript** (`transcript.rs`): fold consecutive routine passed tool calls (`▸ 3 completed steps · +14 −3`) with keyboard toggle and scroll-anchor preservation.
2. **Shared multiline composer + per-task draft persistence + clipboard image attachments** (`app.rs`, `view.rs`, `toolroll-api`).
3. **Wire `reduced_motion` & deadline-coalesced spinner ticks** in `run.rs` (one calm spinner on the focused live task only).
4. **Multi-pane direct jumping (`Alt+1..4`) & attention propagation** on background watched panes (`panes.rs`).
