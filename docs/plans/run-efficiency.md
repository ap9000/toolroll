# Run efficiency view — plan

Status: **v2** (2026-10-21). v1 NO-GO (2 High, 3 Medium): it promised measurements the stored data doesn't hold, treated a
display-only, short-lived transcript as a source of truth, and wrote flags that could claim more than the evidence.
v2 shows only what is recorded, says what isn't, and starts recording the rest from now on. One Codex implementation
review at the end of the build (Alex 2026-10-21: no per-round plan loops).

## What and why

Laminar's lesson (Ramp, 2026-10-20): read the traces — excess tool calls, wasted turns, bloated context, errors. A
person reviewing a Toolroll result can't see how the run went: the result's Details show tokens and cost, nothing about
where the time went, how much came from cache, or what the agent kept doing.

## What is recorded today (the source matrix)

| Fact | Where | Claude | Codex | ACP (OpenCode…) | Retained |
|---|---|---|---|---|---|
| Wall times: started, provider started, finished | `run` | yes | yes | yes | with the run |
| Tokens in / out, cost | `run.tokens_*`, `cost_usd` | yes | yes (no cost) | agent's own report, unpriced | with the run |
| Cache read / write tokens | `run.usage_json` (provider's raw usage) | `cache_read_input_tokens`, `cache_creation_input_tokens` | `cached_input_tokens` (read only) | — | with the run |
| Agent turns | provider envelope `num_turns` | parsed, **not stored** | — | — | — |
| Tool steps with observed times | live records `<evidence>/live/<run>.jsonl` (normalized, display-only, no digest) | yes | start+end often synthetic | may arrive late | 24 h, 4 MiB, 500 files |
| Command text | live records, only when the project opted into command detail | opt-in | opt-in | opt-in | as above |
| Check start / end | — (the receipt has none) | — | — | — | — |

Anything not recorded renders as **—**, never 0. Old runs show what their `run` row holds; nothing is backfilled from
expired live files.

## Behaviour

On the result (its page and the task's Result tab), one row in the result's record: **How it ran**.

> 14 min · 38 turns · 1.9M tokens in, 81% from cache · 41k out · 212 steps

Open, three short blocks, each saying where its numbers come from:

1. **Time** — waiting to start (started → provider started), the agent (provider started → finished). No check or
   review phase is invented: checks have no recorded times, so they are not split out.
2. **Steps** — counts by kind (Read, Edit, Bash, Search, other), how many failed, and the five longest steps with an
   **observed** interval (a step whose start or end the recorder synthesised says "duration unknown"). While the
   live records are kept (24 h) the block says so; after that it says the step detail has expired.
3. **Repeated activity** — not claimed (implementation review): the step records keep a short form of each step (a
   file name, a host, a command with its shell wrapper taken off), so two different steps can read alike. The block
   says so; a future change that records a digest of each step's whole input could count repeats honestly.

Lead replies: their details line gains cache: "12k in · 74% cached · 900 out · 3 steps".

## Design

- **Record from now on (no new provider calls).** Store the envelope's turn count (`run.agent_turns`, when reported).
  Lead requests store cache read/write tokens (`chat_turn.cache_read_tokens`, `cache_write_tokens`; already measured
  by `settleWithCache`, never stored). Additive v129 columns, saved values NULL (unknown), never 0.
- **Derive at view, bounded and cached.** A `run_efficiency` row per finished run, written the first time its result is
  viewed (and refreshed only while its live records are still kept): parser version, sources used and their
  completeness (`usage`: reported/absent; `steps`: complete/truncated/expired/absent + reason), counts by kind, failed
  count, up to five longest observed steps (kind, observed ms — **no command text stored**), no repeat groups. Budgets: one descriptor-safe read (no link followed, measured once, never more than 4 MiB read
  whatever the file does), ≤ 20 000 records, stored row ≤ 16 KiB; lines that don't read are counted and said; over a
  budget → completeness "truncated" with the bound named.
- **Display only.** The derived row never changes completion, approval, billing or a check verdict. It is shown under
  the same access as the result.
- **Cache share** = cache read ÷ (input + cache read + cache write) for Claude (its input excludes cached); cache read ÷
  input for Codex (its input includes cached); "—" when a part is unreported.

## Tests

Usage parsing per provider (Claude, Codex, absent, malformed); a live-records fixture per provider (synthetic start/end,
late step, unfinished step); budgets (oversize file, too many records → truncated, named); repeat grouping only with
complete inputs; expired live file → no step detail, said; migration additive (v128 → v129, NULLs); render: one-liner,
dashes for unknown; lead reply details line with cache share. Journey: the result's How it ran row.

## Out of scope

Pricing changes; cross-run dashboards; check timings (needs check-side recording, its own change); acting on flags.
