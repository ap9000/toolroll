# Fallback chains, rebuilt

When an agent runs out of its plan mid-task, the work moves to the next agent the person approved.

## Why it was removed, and what changed

Removed in schema v115 / 0.9.53 (owner decision D4, 2026-10-08) as part of the simplification review. The reasons were
use and cost, not safety:

- **Never used.** 0 rows in the three fallback tables; chain columns null on all 773 runs. It could not have been used:
  the recogniser registry shipped empty, keyed to exact CLI versions, and waited for a captured fixture.
- **Cost.** About 1.5k lines, 234 store references, a second admission road beside the claim.
- The review's replacement was "exhaustion parks the task and says why". That was never built: exhaustion still counts
  as an ordinary failure.

Four review rounds found no flaw that survived, so the design's properties stand. What changed:

1. **Real evidence exists.** On 2026-10-10, the day after the removal shipped, six builder runs ended on Claude's weekly
   limit. Two died mid-task, one after 110 minutes and $3 of work; four more burned the three strikes in four minutes and
   two tasks stalled with "It will not be retried." That is the case this feature is for.
2. **The owner decided to rebuild it** (2026-11-07).

The cost argument still holds, so this is a smaller rebuild, not a restore. Not coming back: the separate admission pass,
`acquireFallback`, exact-version recogniser keys (they are why nothing could ever arm), and the reuse of the old
`allowPaidFallback` mode term. Rebuilding is worthwhile because the failure is real and the fix now has evidence.

## Evidence

The rule: a provider and auth mode are armed only when a **real run** shows the terminal through Toolroll's own parser.
Published docs may widen the wording inside that proven shape. They never arm a provider alone, because docs don't show
what our parser sees.

| Provider, auth mode | Evidence | Armed |
| --- | --- | --- |
| Claude, subscription | 6 real runs on Claude Code 2.1.290: structural failure result (`terminal_class` not-exhausted), text `You've hit your weekly limit · resets 12am (America/Los_Angeles)`. [Published errors page](https://code.claude.com/docs/en/errors#youve-hit-your-session-limit) names the family: session, weekly, Opus, Sonnet, each `· resets <time>` | **Yes** |
| Claude, API key | None real. Docs list `Credit balance is too low` | No |
| Codex | No real run, in the database or evidence folder. The hits there are Toolroll's own test strings. [Published source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs) has plan-specific wording, but how `codex exec` carries it to our parser is unproven | No |
| OpenRouter | No run ever. [Docs](https://openrouter.ai/docs/api-reference/errors): HTTP 402 | No |
| Gemini, ACP agents | No run ever | No |

Claude's spend-cap family (`You've hit your monthly spend limit`, …), `Server is temporarily limiting requests` and 429s
do not match: a spend cap is someone's deliberate limit and a throttle passes.

Version: recognised on Claude Code 2.1.290 up to, not including, 2.2. The exact text must match the whole terminal; a
wording change misses and takes the ordinary failure road. A new minor line needs a fresh look. Claude has no attested
version range, and adding one would refuse every Claude run outside it. So when a terminal already reads as a limit, the
gateway asks the installed CLI its version, with no agent in the loop; no answer means no recognition.

## Design

**The chain.** A project setting lists 1–3 fallback entries, each pinned to provider, model and auth mode. Filing
snapshots base plus entries into `task_scope.proposed_chain_json`; the approval seals it into `approved_chain_json`
(`approval_kind = 'chain'`), and the chain digest replaces the profile digest in the scope digest, as `digestOf` already
allows. New chains are digest version 2. Version 1 stays decodable for history and holds no authority, so a chain from
before v115 can't come back to life.

**Who decides.** Only a person sets the chain or the paid grant. The grant is a new per-project record, never the old
mode term: a historical signed `allowPaidFallback` stays dead. A chain with a paid entry seals only on a person's own
yes, never a mode, flow, lead or automatic seal, and in chat only through the terms card, whose digest covers the chain
lines. Every surface reads the terms from `describeScope`.

**One walk.** `fallback_walk` is one pass down a chain for one task: open or closed, cursor, tail run. `fallback_move` is
one step, with `from_run` and `to_run` unique, so an edge is admitted once. Every builder run on a chain approval is
bound to a walk in its admission transaction; a run with no binding spawns nothing.

**Moving.** In `sealFailure`, in the same transaction that releases the claim and finishes the run: the run must be the
walk's tail, genuinely finished by this seal, classed `usage-exhausted` by the gateway, for the exact entry it was pinned
to, and the next entry paid only with the live grant. Then the cursor moves, there's no strike, and the task goes back to
the queue. Otherwise the walk closes and the ordinary failure road runs.

**Running the next agent.** No second road. The ordinary tick reads the pending entry and dispatches as that entry, so
holds, capacity, sign-in, attestation, policy, budget, quota and attention all run keyed to the pinned entry. The run's
admission re-proves the seal, walk, cursor, entry digest and live grant and consumes the edge. `build()` proves against
the entry's profile; the gateway re-proves custody and the grant at the spawn, and spends under the pinned auth mode, or
refuses.

**Kept work.** An exhausted run's changes are saved as a work-in-progress commit on the task's branch, the road
`keepUnhandedWork` already has, so the next agent starts from them. One function, `fallbackBriefFor`, says so in the
brief: the place the handover note plugs in once it merges.

**Reconciler.** One resolver closes a walk whose tail ended: built closes it, parked keeps it, anything else closes it,
and the retry starts a fresh walk at the base. It runs each tick and inside dispatch, so a crash anywhere leaves a state
the next pass settles the same way.

Scope: top-level builders and their repair turns. Planners, reviewers and scouts don't move. A task with no chain keeps
today's failure road; parking it with the reset time is a separate change.

## Schema

v156: `fallback_setting`, `fallback_walk`, `fallback_move` (new names, since v115 drops the old ones). `V156_SCHEMA` in
`src/fallback-schema.ts`; no column changes. v155 belongs to next-0.9.95, so this branch skips it and lists it as
update-safe. Everything reachable from update drain tolerates the tables being absent.

## Surfaces

CLI `toolroll project fallback`; Settings → Project → Fallback agents (both a password typed now); the task page and chat cards show the
chain in full through the shared terms. Each entry says whether Toolroll can recognise its limit: "Moves on when its plan
runs out" or "Won't move on: Toolroll can't yet recognise this agent running out".
