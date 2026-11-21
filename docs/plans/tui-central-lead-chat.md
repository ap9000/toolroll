# TUI Central Lead Chat & Peekable Task Inspector

**Branch:** `tui/central-lead-chat` (built on `tui/laws-of-ux-polish`)

## Goal

Bring Toolroll's central Lead agent (`/chat`, the same single source of truth used by the browser and phone) directly into the Rust Ratatui terminal workbench so an operator can converse with the Lead across all projects, stream live replies and tool steps, review and confirm proposals under the same safety gates, and peek into any task's `Live / Steps / Diff / Terminal` panel — side-by-side on wide terminals or with one-key toggle on standard terminals.

## Architecture (3 Slices)

### Slice 1 — Typed Engine Contract & Rust Client
- **Contract (`src/contracts/engine-api.ts`, `test/fixtures/engine-api/lead-chat.json`, `schemas.json`):**
  - Added strict `leadChatSchema` (`ENGINE_RESPONSES.leadChat`) carrying `room`, `session`, `leadName`, `canSend`, `problem`, `project`, `busy`, `pendingProposals`, `queued`, and `messages` (plain-text replies, validated `ChatCard` blocks, confirmable proposals with plain-text `lines`, `LeadAsk` options, and server-parsed internal task links `{ task, tab }`). Never sends raw HTML.
- **Server (`src/engine-chat.ts`, `src/server/engine-api.ts`, `src/server/route-table.ts`):**
  - Added `GET /engine/chat[?project=]` (`engine.chat`, cookie-only, `limited: "conversation"`, `project: "conversation"`), re-proving `rereadBrowser` + `leadPrincipal` before and after reading.
  - Reuses existing `POST /chat`, `POST /chat/proposal/<id>/(confirm|dismiss)`, `POST /chat/queued/<id>/remove`, and `GET /live?room=chat` SSE (`event: turn` + `event: change`).
- **Rust API & Fake Engine (`tui/crates/toolroll-api/`, `tui/crates/toolroll-fake-engine/`):**
  - Added strict `#[serde(deny_unknown_fields)]` models for `LeadChat`, `ChatCard`, `ChatCardBlock`, `LeadCard`, `LiveTurn` with lossless fixture round-trip verification (`tests/fixtures.rs`).
  - Added `LiveSignal::Turn { room, turn }`, `Client::chat(...)`, `Client::chat_send(...)`, `Client::proposal_act(...)`, and `Client::queued_remove(...)`.
  - Extended `toolroll-fake-engine` with `/engine/chat`, `POST /chat`, proposal confirm/dismiss, queued removal, and `FakeEngine::emit_turn`.

### Slice 2 — Central Lead Chat in the TUI (`chat.rs`, `app.rs`, `run.rs`, `view.rs`)
- **Pinned Entry & Shortcut:** Pinned `◆ Lead · central chat` at the top of the Work rail (with live running indicator or solid-ink pending proposal count chip) plus global `C` (`Action::LeadChat`) and command-palette entry.
- **Live Streaming & Collapsible Tool Steps:** Subscribes to `room=chat` in `App::rooms()` and renders `event: turn` snapshots in real time (`status`, collapsible tool-call list toggled with `e`, partial reply text), then refetches `GET /engine/chat` on turn completion.
- **Structured Cards & Safety-Gated Proposals:**
  - Renders Toolroll `ChatCard` blocks (`Text` labelled as `Lead note:`, `Divider`, `Facts`, `Table`, `Notes`, `Chart`) and clean ASCII fallbacks.
  - Pending proposals wear the one solid-ink `Needs you` chip and open `Mode::ConfirmProposal` on `Enter` (never auto-confirming). Enforces `drawn_dialog`, `seen_end` reading progress, staleness cancellation on live refresh, and explicit `a` arming for `irreversible` proposals before posting `confirm=yes`.
  - `s` / `i` opens the pinned composer (`Mode::ChatCompose`) to send or queue follow-ups while the Lead is busy; `x` dismisses a selected dismissable proposal.

### Slice 3 — Docked Chat + Peek Inspector (`view.rs`, `app.rs`, `keys.rs`)
- **Wide / Docked Split (`D` / `Action::DockChat`):** On wide viewports (`>= 136` cols with full list, or `>= 104` cols with slim rail/hidden list), splits the main area into **Central Lead Chat** (center) + **Peeked Task** (`Live / Steps / Diff / Terminal`, right) alongside the **Work rail** (left).
- **Live Peek & Task Links:** Moving through tasks in the Work rail updates the Peek panel while Lead Chat stays docked and streaming; `o` / `O` (or mouse click) switches focus between Chat and Peek. Activating a task link inside a Lead card (`Enter` or click) jumps the Peek panel directly to that task and its preferred tab (`Diff`, `Steps`, or `Live`).
- **Graceful Degradation:** Standard viewports (`64–135` cols) switch seamlessly between Lead Chat (`C`) and Peeked Task; narrow viewports (`< 64` cols) show one sheet at a time with `Esc` returning cleanly to the list.

## Verification
- `npx tsc --noEmit`
- `npx vitest run src/contracts/engine-api.test.ts src/engine-chat.test.ts src/server/route-table.test.ts src/server/handler-registry.test.ts src/server/engine-api.test.ts`
- `cd tui && cargo test -p toolroll-api`
- `cd tui && cargo test -p toolroll-tui` (including `tests/lead_chat.rs`, `tests/laws_of_ux.rs`, `tests/drawn_pairs.rs`)
- `node scripts/guard-checks.mjs check --root . --base <main> --head <HEAD>`
