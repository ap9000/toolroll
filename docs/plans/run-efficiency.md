# Run efficiency view — plan

Status: v1 draft (2026-10-20), for Codex review. Third in Alex's order (after the lead queue and deferred tools).

## What and why

Laminar's lesson (Ramp, 2026-10-20): great agents come from reading the traces — "excess tool calls, wasted turns,
bloated context, and unexpected errors" — so they built an agent-first session view: per-turn latency, cache hit
ratio, and how much of each request each part takes.

Toolroll records most of the raw facts but shows almost none of them. The task's Details says *Usage: not reported*
for most runs. Claude's stream-json already reports per-message usage, which `cumulativeLiveResult` (src/exec.ts)
sums (input, output, cache creation, cache read tokens, `num_turns`) and the store keeps as
`run.agent_reported_usage_json` (never priced). Transcripts exist for live runs. Nothing turns these into an answer
to "was this run efficient, and where did the time go?"

## Behaviour

On the result page (and the Result tab once the one-page task lands), a **How it ran** section, open by default when
something looks wasteful, otherwise one line:

> 14 min · 38 agent turns · 212 tool calls · 1.9M tokens in (81% from cache) · 41k out

Expanded, three small blocks — no charts library, plain rows and one bar per turn:

1. **Where the time went**: phases (setup, agent, checks, review) with durations; the slowest 5 tool calls.
2. **Turns**: one thin bar per agent turn, width = duration, shade = cache share; a turn that only read files,
   or repeated the same command, is marked. Click a bar → that point in the transcript.
3. **Waste flags** (plain words, each with its evidence): *the same command ran 7 times* · *12 reads of the same file*
   · *context grew past 150k tokens at turn 30* · *3 tool calls failed and were retried identically* · *the check ran
   4 times*.

For lead turns: the same one-liner on each lead reply's "details" (tokens in/out, cached, tool calls, rounds), which
also shows the deferred-tools saving from plan 3.

## Design

- **Collect** (no new provider calls): parse what is already saved — the run's transcript/stream file (Claude
  stream-json: per-message `usage`, tool_use/tool_result pairs with timestamps), the run's phase timestamps
  (claimed, provider_started, finished, check start/end), check receipts. Codex/OpenCode/ACP runs: whatever their
  transcript format carries; missing fields render as a dash, never zero.
- **Store** a derived `run_efficiency` row per finished run (additive migration): totals + top tool calls + flags as
  JSON, computed once at disposition (and lazily for older runs on first view, bounded). Derived data only; the
  transcript stays the source of truth.
- **Flags** are deterministic rules over the parsed events (repeat command ≥ 3, same-file reads ≥ 5, failed-retry
  identical, context ≥ 75% of the model window, check runs ≥ 3), each carrying the event indexes it points at.
- **Render** in render-results (server) and the React result view; the turn bar list is HTML with inline widths.
- **Lead turns**: `lead_turn_evidence` gains tokens/cache/tool-call counts recorded by `runLeadTurn` (direct API
  usage blocks; subscription runner usage where `claude -p` reports it).

## Tests

Parser fixtures from real (scrubbed) stream-json transcripts; each flag on a crafted transcript; missing usage →
dashes; migration additive; result page renders the one-liner and opens on a flag.

## Out of scope

Pricing (usage is never priced here); cross-run dashboards; editing anything from this view.
