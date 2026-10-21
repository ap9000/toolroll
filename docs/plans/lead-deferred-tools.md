# Lead deferred tools and prompt caching — plan

Status: v1 draft (2026-10-20), for Codex review.

## What and why

Alex chose this second (2026-10-20), after Ramp's Laminar post: Laminar hit context bloat at 100+ tools and made
**tool search** a base primitive — most tools are *deferred* behind one search tool and loaded when the model asks.

Measured today (dist at b0c7a860): the lead sends **55 tool schemas, 65,067 characters (~16k tokens), on every
call**. `propose_flow` alone is 24,966 characters (38%); `get_flows` 4,227; `propose_subagent` 3,839;
`propose_sweep` 2,387. On the subscription path (`composeSubscriptionLeadPrompt`, src/subscription-chat.ts) the
schemas are pasted into the prompt as JSON on **every round** of a turn, so a 4-round turn pays it 4 times. Nothing
in the codebase uses prompt caching (`cache_control` appears nowhere), so the direct-API path pays it in full too.

## Behaviour

- Every lead turn starts with a **core set** of tools — the ones most turns use — plus one new tool,
  **`find_tools`**: *"Search the lead's other tools by what you want to do; matching tools become available for the
  rest of this turn."*
- When the model calls `find_tools("make a flow that sorts my inbox")`, the result lists the matches compactly
  (name + one-line description, not schemas) and those tools **join the tool list for the rest of the turn** (direct
  API: the next request carries their schemas; subscription: the next round's AVAILABLE HOST TOOLS includes them).
- A turn that names a deferred tool directly (e.g. it remembers `propose_flow`) gets one refusal that says to call
  `find_tools` first, never a silent failure.
- The person sees no difference except faster, cheaper turns.

## Design

**Split** in src/lead-tools.ts: `LEAD_CORE_TOOLS` (always sent) and `LEAD_DEFERRED_TOOLS` (searchable), from one
list with a `deferred: boolean` per tool so the 55 stay declared once. Proposed core (to be confirmed by usage data
below): `get_brief`, `get_task`, `get_result`, `get_project_context`, `get_actions`, `get_action_status`,
`propose_task`, `propose_scope`, `propose_action`, `propose_steer`, `answer`, `remember`, `ask_owner`, `commit_to`,
`find_tools`. Deferred: flows (`propose_flow`, `get_flows`, …), subagents, sweeps, settings/agents/route, hooks,
learning, capabilities, project tools, cancel/hold/repair proposals.

**Choosing the core from data, not guesses**: a one-off script reads `lead_turn_evidence` / the lead turn tool-call
records in a copy of the operator's database and counts tool calls per tool over the last 30 days; tools used in
≥ 2% of turns are core. The plan's list above is the default if no history exists.

**Search**: `find_tools(query, limit≤6)` ranks deferred tools by keyword overlap on name + description + a short
`keywords` list per tool (no embeddings: deterministic, no model call, no network). Returns
`{ name, summary }[]` and records the found names in the turn's state (`LeadToolContext`), so `isLeadTool` and the
schema list for later rounds include them. Found tools stay available for the rest of the turn only.

**Execution guard**: `executeLeadTool` refuses a deferred tool not yet found in this turn with
*"call find_tools first"* — the model cannot invoke what it was never shown, and the refusal teaches it the road.

**Channels**: `chat-channel.ts` (the tool-name list for Slack/Discord/Teams) and Telegram use the same core list;
any surface that lists the lead's capabilities (`get_capabilities`, the contract docs) reads the full list.

**Prompt caching (direct API)**: mark the system prompt + tool block cacheable where the provider supports it
(Anthropic `cache_control: {type:"ephemeral"}` on the last tool and the system block; OpenAI caches long prefixes
automatically when the prefix is stable). To keep the prefix stable: tools in a fixed order, found tools appended
**after** the core block, the data document after the cached block. Record `cache_read`/`cache_creation` tokens on
the turn so the saving is visible (feeds plan 2).

**Contract text**: `LEAD_CONTRACT` gains one line: *"Most tools are found with find_tools; search by what you want to
do before saying you can't."* — and the existing per-tool guidance for deferred tools moves into their descriptions
(returned only when found).

## Safety

No tool gains or loses authority: a found tool runs through the same `read` contract and handler. The guard closes
the one new path (calling an unshown tool). Prompt caching changes no content.

## Measuring

Before/after on the scripted lead journeys: characters of tool schema per request (expect ~16k → ~4-5k tokens),
and on a real-model journey the provider-reported input and cached tokens per turn. A regression test pins the core
list's total schema size under a budget (e.g. 20k characters) so it can't silently grow back.

## Tests

- Unit: split covers all 55 exactly once; `find_tools` ranking (flow words → propose_flow first); found tools appear
  in the next round's schemas (direct and subscription composers); calling a deferred tool unfound → refusal; found
  → runs; schema-size budget.
- Lead journeys (scripted runner): a turn that needs `propose_flow` calls `find_tools` then `propose_flow`; existing
  flow/sweep/subagent journeys updated to the two-step road.
- Real-model journey: one flow request end to end (the model must discover the tool unprompted).

## Out of scope

Embedding search; deferring tools per project; MCP gateway tool search for build agents (a later plan).
