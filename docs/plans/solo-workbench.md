# Solo first: the terminal workbench, growing into the team's control plane (plan v2, 2026-11-14, main a093e54)

Written after user research across ~2,000 Hacker News comments, the competitors' most-upvoted GitHub issues and 2026
developer surveys, an independent plan review, and a terminal-stack study (summarised in the appendix). Owner decisions: solo first; team mode kept; Flexible un-parked in parallel; terminal first,
web second; the terminal is a COMPLETE workbench (diffs, review, accept too) and the web is a companion; Rust + ratatui.

**One-liner.** Toolroll: the terminal workbench for your coding agents — every agent you already pay for, watched and
steered from one screen, reviewed and accepted without leaving it, with none of your keys inside the agent. When a
second person joins, it becomes the team's control plane.

## Owner decision (2026-11-14, later): Flexible is the solo terminal default
For a solo developer the terminal workbench defaults to Flexible: no approval steps, full access inside the thread's
isolated repository copy (no keychain, no other projects, proxy-only network), one-press Ship — no more friction than
T3 Code or herdr. Consequences:
- Flexible moves onto the critical path and IS the launch: F2e (week 1) → F2c thread start + full process custody
  (week 2) → F2b Claude relay (week 3) → F2d answers (weeks 3–4) → F3 the thread view in the terminal, as one more
  LiveSession in the same panes (weeks 4–5) → F4 controlled import + one-press Ship (weeks 5–6) → launch week 7.
- Until Flexible ships, solo mode's default chain is "Just code" (no plan approval), Accept is one key, and password
  steps remain only for credentials — ordinary builds still run in the fence.
- Invisible protections stay: full process custody, import filtering of protected names and placeholders, the Linux
  (bubblewrap) attack rows green, and a kill switch, before the default flips. Each real-model F0 batch still needs the
  owner's explicit yes (it spends money).

## Owner decision (2026-11-14, later): any agent, your own login — two tiers in Flexible
Ordinary builds already run each agent on its own login and subscription (Claude Code, Codex, Gemini CLI, OpenRouter,
ACP agents). Flexible supports agents in two tiers, and the screen says which tier each runs in, in one line:
1. **Relay tier — the key never enters the agent.** The agent talks to a local Toolroll relay that holds the login
   (bound to an admitted turn, charged per call, fixed upstream, no redirects, revocable, redacted logs). Claude Code
   (setup-token), Codex/OpenAI, Gemini, OpenRouter, and agents built on them. Launch (week 7) ships this tier.
2. **Own-login tier — for agents that can't use a relay.** Only that agent's own login file, read-only; network only to
   its provider's hosts; no keychain, no other credentials, no other projects. Ships in the 1–2 weeks after launch, with
   first-run conformance per installed agent (Copilot CLI, Amp, Droid, Pi, Cursor, Cline, Qwen, Goose, OpenCode…).

## Principles
1. **One engine, two renderers, one keymap.** The Node engine owns state, PTYs, the fence, sanitising, auth and every
   write. The Rust TUI and the web are clients of one local API (never two runtimes — herdr-app's split is the warning).
2. **Solo visible, team silent.** The solo screen shows no team concepts. Team mode turns on only by a literal act
   (inviting a second person, or an acting token for someone else); chat apps notify and can approve for the owner's
   own paired account in solo; team control features only in team.
3. **Status from the stream, not scraping.** Needs-you and step state come from the engine's structured records.
4. **Measured, not self-graded.** Every bar below is a gated number or a stranger observation.

## Surface split
| Capability | Terminal (Rust) | Web | Phone |
|---|---|---|---|
| Every agent, which needs you | primary | yes (Work) | push |
| Live transcript of a run | primary (rich records, subagents) | read-and-steer panel | — |
| Steer, pause, stop, answer a question | primary | yes | answer |
| Open build shell (separate copy of the latest build) | primary (`/term` pane) | yes (/term) | — |
| Pick steps (chain preset) | primary | yes | — |
| Diff review, line comments → one send back | primary (files → hunks, syntax, side-by-side on wide) | yes, plus very large diffs | — |
| Accept / send back / retry | primary | yes | one tap |
| Screenshots at full fidelity, browser annotation | `w` opens web (kitty images where supported) | primary | — |
| Password/credential steps, settings | `w` opens web | primary | — |
| Team: people, approvals by others, chat, chat apps, flows | — | primary | notifications + approvals |

## Bars
| Need | Bar |
|---|---|
| Works in minutes | 8/10 strangers: fresh Mac/Linux → their installed agent working on their repo in < 2 min |
| Feels instant | TUI key→paint p95 ≤ 100 ms (spike target: echo < 16 ms, frame < 8 ms); server time per read ≤ 300 ms, gated |
| See the work | record → TUI pane ≤ 1 s |
| Steer | live-input agents ≤ 2 s; others "delivered at the next turn", said honestly |
| Review in the terminal | median Ready→Accept time; share of reviews done in the terminal |
| Needs you | exactly one notification per ask (terminal bell/OSC 9, push) |
| Cost | cost per result shown on every run; published vs a single Claude Code thread |
| Adoption (owner) | external installs reaching Ready, issues, first outside PR, stars |

## Build (8 weeks; work limit 3 streams)

**Week 1 — foundations**
- A0 **Engine API** (Node): a provider-agnostic LiveSession read (run/thread), JSON reads for work rows, a task's step
  cards and a run's live-record window, a per-file diff endpoint (the result doc is 2.2 MB today), and a JSON local-owner
  link redemption returning cookie + mutation key (one-time/no-store/epoch kept — Codex review). One contract in
  src/contracts (zod → generated serde models; fixture tests both sides).
- Mode derivation (solo/team) inside the write transaction like localOwnerStandsNow: owner-minted tokens keep solo
  (they never approve); a second person flips to team; phone use by the same account stays solo; an explicit, recorded
  "It's just me" switch for existing single-person installs; chains that skip Approve plan still hit isProtectedWork.
- **Rust spike (3–4 days, go/no-go)**: 3 panes × 100k-line rings + a vt100 pane replaying a recorded session (p95 frame
  < 8 ms at 200×60), key→echo < 16 ms, redeem a link + `/live` SSE + `/term` WS from Rust, `npm pack`/`npm i -g` with two
  platform packages on Mac + Linux, `--omit=optional` → Ink, ad-hoc signing on macOS 15. If the release path blocks →
  fall back to OpenTUI (report §6).
- A0b **Instant start**: detect installed agents and their sign-in on first run; file the first task to the one you
  have; "Sign in to X: run …" per agent.
- Gate server time per read in wire budgets (today report-only).
- Stream C: F2e turn admission and caps.

**Weeks 2–3 — T1 the terminal workbench (Rust)**: Cargo workspace (tui/crates/{toolroll-tui,toolroll-api,toolroll-vt,
toolroll-diff}); PR `rust` CI job; layout per report §4 (needs-you / working / done; Live · Steps · Diff · Terminal tabs;
step line; steer box; key bar; mouse); live transcript from records; steer/pause/stop/answer through the same routes as
the browser; bell/OSC 9 notifications; launcher in easy-start.ts with Ink fallback; insta snapshots per state.
Stream B: B1 first-run conformance for the installed agent binary (instead of exact-version attestation treadmill);
verify which of Copilot CLI / Pi / Amp / Droid actually speak ACP. Stream C: F2c thread start + full custody.

**Week 4 — T2 terminal diff review**: files sidebar + virtual list, unified default, side-by-side on Tab at ≥ 160 cols,
word-level emphasis, syntax highlight (syntect), context expand, `e` $EDITOR / `o` shell / `w` web; watch-mode diff as the
agent writes. Web A1w: Activity tab (read + steer) on the same LiveSession; sidebar Working group (A2). Stream C: F2b relay.

**Week 5 — T3 comments, accept, images**: range comments → ONE send back (ReviewComment {path,line,note,severity}),
Accept / Send back / Retry with terms shown whole, kitty images (else `w`). A4: verify existing push; desktop via
terminal OSC 9 / bell; tab badge; "idle while waiting on a command" test. A5: cost per run/result on rows and panes.
Stream C: F2d answers.

**Week 6 — T4 steps + open build shell**: step-chain presets on the sealed route — four fields {plan, approvePlan,
review provider, reviseRounds ≤ 2}; Check not pickable; cards = the existing stepper rows; cost shown before starting.
Open build shell = a `/term` PTY in a separate copy of the latest build; it does not control the running agent (tui-term pane; /term allowed for the local
owner in solo mode, Codex-reviewed). Web A3-min (picker) and A5. Stream C: F3 on A0 (threads as LiveSessions).

**Week 7 — 10 strangers, LAUNCH** (owner): Show HN / r/ClaudeAI / r/ChatGPTCoding, a 90-second terminal + phone video,
an honest comparison page (T3 has more harnesses and a polished GUI; herdr hosts real terminals; we review and accept in
the terminal with keys kept out of the agent).

**Week 8 — polish and F4**: fixes from strangers; Flexible F4 controlled import + Ship; enable gates; F0 real-model
batches (owner's yes for each). Solo mode defaults to Flexible only when all seven gates + F0 + Ship arm + a kill switch
+ a stranger test on Flexible pass. Flexible stays in one worktree off the release path until then.

**Flexible enable gates (status 2026-11-16; the full list is in src/flexible-available.ts).** The compile-time
constant is gone: Settings → General's "Interactive agent threads (beta)" switch (flexible_setting, schema v171; CLI
`toolroll config set flexible on|off`) turns threads on, off by default including on upgraded installs, an instance
operator's ordinary step-up (a solo session stands in, a team needs the password, never a token). Claude Code only;
Codex threads are refused. Every entry point that starts something new checks it (the thread start again inside its
recording transaction, the relay inside each call's reservation); turned off mid-thread, the relay refuses the next
call and the console's upkeep stops the agent. Built: F2a–F2e, F3, F4, the console's launcher, the start's terms card
and the woken thread view. Left before a later slice flips the default on for solo installs: the F0 real-model matrix
(the owner's yes per batch), Claude's stdio permission channel proved (F0 row H), Codex threads inside the srt fence,
the bubblewrap attack runs green in CI, the import's quarantine proved against the real sandbox, and a stranger test.

## Cut / park
The old Swift WKWebView app (a menu-bar notifier after launch, if wanted); row-level live deltas (B2b) unless the gated
budgets still fail; the "10 agents attested" bar (replaced by first-run conformance); a second keymap; staging/commit/
push in the TUI; sixel; any team surface in the solo screen; Settings consolidation beyond Projects; org-facing features;
the feature freeze stands (flows, teammates, kits, email, evals).

## Risks
1. Focus: two renderers + Flexible in parallel (herdr's funded team got 592 issues in a month) — one keymap, one engine,
   snapshot tests on every TUI state, the work limit of 3.
2. Contract drift TS↔Rust — generated types, fixtures, a `hello` build handshake.
3. Auth plumbing for the mutation key — Codex review; in-memory only; one-time redemption.
4. Perceived speed bounded by the engine — gate server time first.
5. optionalDependencies pitfalls — runtime fallback to Ink, install-smoke per platform.
6. vt100 fidelity for interactive agents in take-over — measured in the spike; libghostty-vt path.
7. Accessibility — Ink kept as `--screen-reader`.
8. Solo→team growth is unproven — we're first to try; measure invites after launch.

## Reviews
Security-relevant slices (A0 auth/redemption, mode derivation, /term for the local owner, every Flexible slice) get
Codex implementation reviews (2 rounds max). Rust code gets clippy -D warnings, snapshots and the same review loop.

---

# Appendix: the terminal workbench's stack and architecture

## Recommendation
Native Rust binary: ratatui 0.30.2 + crossterm 0.29 + tokio, a THIN CLIENT of the local Toolroll server (HTTP JSON + SSE
`/live` for state and live records; the existing `/term/<id>/socket` WebSocket for real terminals), shipped inside the
npm package as per-platform optionalDependencies (esbuild/Codex pattern), current Ink screen kept as fallback
(`--omit=optional`, unknown platforms, Windows before its package, `--screen-reader`). As shipped (owner's decision,
2026-11-15): the four binaries ride INSIDE the `toolroll` package at `dist/tui/<platform>-<arch>/toolroll-tui` (the
`@toolroll/*` scope isn't registered), found first after `--tui-binary` by the launcher (src/tui-launch.ts). Agrees with the owner's
Rust + ratatui choice; no strong reason against ratatui (only gap: no accessibility tree → keep Ink for screen readers).
Both leading agent TUIs use exactly this stack: Codex CLI (codex-rs/tui: ratatui 0.30.2 scrolling-regions, crossterm 0.29,
tokio, vt100, portable-pty 0.9, diffy+syntect, 1,536 insta snapshots) and herdr 0.9.5 (ratatui 0.30, crossterm 0.29,
portable-pty, tokio, vendored libghostty-vt). Why not others: Ink (no mouse, whole-frame rewrites, full clear above one
screen; Claude Code rewrote its renderer); OpenTUI 0.9.0 (needs Node >= 26.4 + --experimental-ffi or Bun; still 8 native
packages; OpenCode #6172 long-session render loop); Bubble Tea (second language, weaker VT); Textual (Python).

## Architecture
- The binary renders and sends intents; PTYs, fence, sanitising, auth and all writes stay in the Node engine. It holds
  no state the browser doesn't.
- Auth with no new credential: the existing instance socket `link` verb (HMAC of the DB secret) → one-time
  `/login/once/<code>` local-owner link; the binary redeems it and keeps cookie + CSRF + mutation key in memory only.
  Engine work: a JSON redemption that also returns the mutation key (keeps one-time/no-store/epoch; needs a Codex review).
- Reads: JSON for work rows, a task's step cards, a run's live-record window (today only 3 `?format=json` routes exist;
  zod contracts in src/contracts/console-api.ts → generate serde models; fixture tests; `hello` build handshake).
- Live work: default = rich transcript from sanitised LiveRecords (live.ts / live-records.ts kinds session|message|edit|
  command|read|search|lookup|plan|delegate|tool + .sub.jsonl subagents); "Open build shell" = a `/term` PTY pane in a separate copy of the latest
  build, rendered via tui-term/vt100 (libghostty-vt 1.0 later if fidelity demands), survives the TUI quitting because
  the console owns the PTY. Build agents in a PTY = later engine/fence change, not v1.
- Acts: same POST routes the browser uses (steer/pause/stop/complete/revise) with CSRF + `x-toolroll-key`.

## Packaging and CI
- `@toolroll/tui-{darwin-arm64,darwin-x64,linux-x64-musl,linux-arm64-musl}` (Windows later), os/cpu/libc fields, no
  install scripts (works with `npm publish --ignore-scripts`); launcher (easy-start.ts) resolves, runs a `--version`
  self-check, spawns with signal forwarding, falls back to Ink with one line. npm aliases avoid provisioning names
  (Codex: "@openai/codex-darwin-arm64": "npm:@openai/codex@<v>-darwin-arm64"). Pitfalls: npm < 11.3 lockfiles,
  `--omit=optional`, pnpm/yarn supportedArchitectures → runtime fallback + install-smoke per platform.
- Linux static musl via cargo-zigbuild 0.24.1; macOS: linker ad-hoc signature suffices for npm-extracted binaries;
  Developer ID + notarization only if a Mac app bundles it. Size 6–12 MB/target (lto fat, codegen-units 1, strip,
  panic abort, opt-level s vs z measured; rustls).
- CI: PR `rust` job (fmt, clippy -D warnings, cargo test; ubuntu + macos); release matrix macos-15, macos-15-intel,
  ubuntu-24.04 + ubuntu-24.04-arm (free for public repos) or one zigbuild lane; ~15 min/release.

## Repo layout
```
Cargo.toml                    # workspace members tui/crates/*; release profile
tui/crates/toolroll-tui/      # event loop: tokio select over crossterm EventStream, SSE, WS, frame requests; alt screen;
                              # DEC 2026 sync per frame; frames on request capped ~120 fps; kitty kbd push/pop; panic hook
tui/crates/toolroll-api/      # reqwest (rustls, cookies) + own SSE parser; tokio-tungstenite for /term; serde models from zod
tui/crates/toolroll-vt/       # terminal pane trait: tui-term 0.3.4/vt100 now; libghostty-vt behind a feature
tui/crates/toolroll-diff/     # similar/diffy hunks + syntect; Codex diff_render.rs as the model
scripts/tui-build.mjs         # builds each platform's binary; publish.yml bundles all four in dist/tui and checks them
```
Tests: ratatui TestBackend + insta snapshots per screen state; Codex's VT100Backend for escape-level tests; a fake engine
(axum, recorded fixtures); PTY tests via portable-pty; contract fixtures checked by both zod and Rust types.

## Patterns to copy (Codex, herdr)
Immediate-mode from one state struct; cell diffing; DEC 2026 around each frame (probe DECRQM); select! over
input/network/tick; frames on request, input echoed in the same frame; real VT state machine for PTY bytes; layout from
live size each frame; bracketed paste; kitty keyboard per screen; panic hook restores the terminal. herdr's top complaint
#1134: 60 Hz cap, 12–22 ms echo; copy/paste under constant redraws; screen-scraped status. Toolroll has structured status.

## First version (beat herdr for a solo developer)
```
┌ Toolroll · ~/code/app ───────────────────────────── plan 62% · $1.84 today · 2 need you ┐
│ NEEDS YOU                        │ LIVE  ·  Steps  ·  Diff  ·  Terminal          run 3412 │
│ ● fix login redirect     asks    │ claude-sonnet · Code → Check · 4m12s · $0.31           │
│ ● csv export             review  │ ▸ Edited src/auth/redirect.ts (+14 −3)                 │
│ WORKING                          │ ▸ Ran  npm test  → 212 passed  (3.1 s)                 │
│ ◐ upgrade test runner   plan 2m  │ ▸ "Redirect now preserves ?next; adding a test…"       │
│ ◐ rate-limit middleware code 7m  │ ▸ Question: keep the legacy /login?return= alias?      │
│ DONE TODAY                       │   1 yes   2 no   3 ask me later                        │
│ ✓ bump deps              merged  │ STEPS  Plan ✓ 1m · Code ◐ 4m · Check · Review(codex)    │
│                                  │ › steer: keep the alias, add a deprecation log line_   │
├──────────────────────────────────┴──────────────────────────────────────────────────────┤
│ j/k move  ⏎ open  s steer  p pause  x stop  t open build shell  d diff  a accept  r revise  1-9 answer  n new  ? help  q │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```
(Use ink for needs-you per DESIGN.md — no amber.) Diff `d`: files → hunks, syntect, `[`/`]`, accept/revise with a note.
Terminal tab: `/term` pane, full key/mouse pass-through, Ctrl-] back. Mouse click/wheel/drag split. Bell + OSC 9/777
notifications. Alternate screen, with "dump transcript to scrollback" for copy.

## De-risk spike (3–4 days, go/no-go)
- Render: 3 panes × 100k-line ring at 10k lines/s + a vt100 pane replaying a recorded `claude` session; p95 frame < 8 ms
  at 200×60; no tearing on resize.
- Input: key → echo in the steer box < 16 ms.
- Engine path: redeem a local-owner link from Rust against a dev console (JSON redemption stub), `/live` SSE, `/term` WS.
- Packaging: `npm pack` + `npm i -g` with two platform packages on Mac + a Linux container; `--omit=optional` → Ink;
  sizes s vs z.
- Signing: ad-hoc on macOS 15, any first-run prompt for a fresh user.

## Risks
Contract drift TS↔Rust; auth plumbing for the mutation key (Codex review); perceived speed bounded by engine live
latency; optionalDependencies pitfalls; vt100 fidelity for interactive claude/codex; accessibility (keep Ink);
agent-written Rust needs the same review loop.
