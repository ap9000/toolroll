# Lead deferred tools and prompt caching — plan

Status: **v2** (2026-10-20) after Codex plan review r1 (NO-GO, 2 High / 4 Medium / 1 Low). For re-review.

## What and why

After Ramp's Laminar post (most tools deferred behind one search tool): the lead sends **55 tool schemas, 65,123 JSON
characters** (measured at 27d2e594) with every request, on every round — `propose_flow` alone ~25k. Whether that is
*paid* in full depends on the provider: Anthropic direct has no `cache_control` today; OpenRouter may cache
implicitly; subscription turns record zero dollars locally but still spend the plan's context and time. v2 states the
goal precisely: **send fewer schema bytes per request, account cache usage correctly, and measure** — no promise of
universally faster turns (discovery can add a round).

## Behaviour

Each request advertises a **core** set plus `find_tools`. `find_tools(query)` returns compact matches
(`name`, one-line summary). Found tools are **advertised from the next request of the same turn** — never callable
in the same response that found them. Calling a registered-but-unadvertised tool gets a tool error *"call find_tools
first"* (the turn continues), not a failed turn.

## Design

**Registry vs advertisement** (src/lead-tools.ts, src/lead.ts):
- One registry of all tools (55 + `find_tools`), each with `deferred: boolean` and `keywords`. `isLeadTool` keeps
  meaning *registered* (the engine fails a turn on unregistered names, src/lead.ts:590 — unchanged).
- Per request, an **immutable advertised set** = core ∪ tools found in earlier requests of this turn. `executeLeadTool`
  checks advertisement **before** `read`/`prepare`/`handle`; missing state fails closed. All three schema uses in
  `runLeadTurn` (direct compose, subscription compose, the base used for scanning/reservation) and the subscription
  output-schema enum (src/subscription-chat.ts:78) read the advertised set.
- Discovery never changes authority: a found tool runs through its unchanged contract and handler.

**Core set — curated, dependency-aware** (not frequency-only; no historical tool-call store exists —
`lead_turn_evidence` holds screenshots). Starting core: `find_tools`, `get_brief`, `get_task`, `get_result`,
`get_project_context`, `search_project_memory`, `get_capabilities`, `get_decision`, `get_actions`,
`get_action_status`, `propose_task`, `propose_scope`, `propose_action`, `propose_steer`, `propose_answer`, `remember`,
`ask_owner`, `commit_to` — plus every tool another core tool's guard requires as a prior read (src/lead-tools.ts:1873;
a unit test derives these prerequisites and fails if a core tool's prerequisite is deferred). Deferred: flows,
subagents, sweeps, settings/agents/route, hooks, learning, project tools, cancel/hold/repair proposals, the rest.
Optional later: bounded per-turn telemetry of tool **names and outcomes only** (no arguments/results; chat retention)
to revisit the split; counted by distinct turns.

**Search**: deterministic keyword + exact-name match over name, summary and keywords; prerequisites of a match are
returned with it; empty/no-match answers list the deferred groups ("flows, subagents, sweeps, …") so the model can
search again. Bounded: ≤6 results, ≤3 `find_tools` calls per turn, cumulative discovered-schema bytes capped.

**Reservation stays proven**: the direct-API worst-case reservation keeps using the **full registry's schema size**
(as today), so any discovery within the turn is already covered; the actual request is smaller, the reservation is
not. (Simplest correct bound; tightening it is a later optimisation.)

**Cache accounting first, caching second** (src/converse.ts):
1. Parse usage categories per provider: Anthropic `input_tokens`, `cache_creation_input_tokens`,
   `cache_read_input_tokens`, `output_tokens` (today only `input_tokens` is read — a cache-heavy call would be
   under-counted); validate totals; unknown/malformed usage keeps today's unknown-cost handling.
2. Price them with pinned per-category prices (cache write and read have their own rates); the worst-case reservation
   assumes cache **writes** (the most expensive) so settlement never exceeds it.
3. Persist per-step and per-turn usage categories on the existing accounting rows (`chat_turn` per request,
   `mate_turn` per turn) — the data plan 2 reads.
4. Then enable Anthropic caching: `system` emitted as blocks; a `cache_control` breakpoint on the **last core tool**
   (tools render before system, so found tools are appended **after** that breakpoint and the core prefix stays
   identical across discovery) and one on the static system block. OpenRouter: leave implicit caching to the
   provider; its existing cost handling (max of pinned math and reported cost, src/lead.ts:554) is kept until reported
   cache costs are validated.
5. Measure cold/warm requests and discovery transitions on a real-model journey before claiming savings.

**Parity and docs**: `chat-channel.ts` `parityGaps()` keeps auditing the **full** registry (+ `find_tools`); Telegram
and chat-delivery call the shared engine and need no change; `get_capabilities` keeps its meaning. `LEAD_CONTRACT`
gains one line: search with `find_tools` before saying something can't be done.

## Tests

Registry: all 55 + `find_tools` classified exactly once; core prerequisites never deferred; core schema budget
(fails if core grows past a set size). Engine: unadvertised call → tool error, turn continues (direct + subscription);
`find_tools` and a found tool in the **same** response → the found tool refused that round, works next round;
per-turn isolation; repeated/empty/invalid searches; discovery caps. Accounting: cache read/write parsing and pricing;
reservation ≥ settlement with all tools discovered; malformed usage → unknown-cost path; migration of new usage
columns. Journeys: scripted lead journeys follow the two-step road for flows/sweeps/subagents; real-model journeys
for an ordinary task, a result revision and a flow (the model must discover the tool itself).

## Out of scope

Embedding search; per-project deferral; MCP-gateway tool search for build agents; provider-native deferred loading.
