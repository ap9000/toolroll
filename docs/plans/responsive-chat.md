# Responsive lead chat: plan (revision 2)

Baseline: release 0.9.96 (`96ca6575`). Plan only, no code. Line numbers refer to that tree. This revision applies the Codex review (16 findings, all verified against the code; see §11) and the owner's decisions of 2026-11-08 (§10).

**Scope of the first release.** Answer text streams for `claude-subscription`, the provider the lead uses today. Codex subscription (subscription-chat.ts:253 turns streaming off) and the direct API (lead.ts:544 buffers the whole response) get an honest fallback: an acknowledgment plus the live status line, then the full answer at the end. No surface pretends to stream for them. Streaming adapters for those providers are a follow-up (§9).

## 0. What the person sees today

| Surface | Acknowledged | Status while working | Text before the end | Final + cards |
|---|---|---|---|---|
| Web `/chat` (lead-chat.tsx) and task "Ask" (app.tsx) | Right away in the browser: "Thinking…" shows while `busy` (live-reply.tsx:85/100) | A list of tool steps that keeps growing (live-reply.tsx:71-80) | Claude subscription only: raw step text over SSE, batched every 80 ms (server/live.ts:46,155-178). **Not shaped**, and the `ok` flag is dropped (live-reply.tsx:31) | The saved message loads once the turn ends |
| Telegram (private chat) | Only at the first tool step (about 5.5 s in): 👍 plus "typing…" (chat-warmth.ts:29-37, telegram-lead.ts:793-805) | "typing…" | None | The whole answer, durable first (telegram-lead.ts:666-835) |
| Slack | A 👍 at the first tool step that can't work: the manifest has no `reactions:write` (slack-api.ts:269-282). Slack shows bots no typing indicator | None | None | chat_part (chat-delivery.ts:629) |
| Discord | 👍 plus typing at the first tool step (discord-chat.ts:58-61) | typing | None | chat_part |
| Teams | typing at the first tool step (teams-chat.ts:50-53) | typing | None | chat_part |
| `toolroll chat` | Nothing | Nothing | None (lead-cli.ts:280 passes no `onProgress`) | lead-cli.ts:293 |

## 1. Surface map (file:line)

| Surface | Durable ingestion (where the ack goes) | Turn | Progress today | Final + cards |
|---|---|---|---|---|
| Web | POST handler server/chat.ts:920-966; personal queue :932 | server/chat.ts:952; queued turns lead-queue-runtime.ts:98-121 (serve.ts:633) | `beginLiveTurn` server/chat.ts:1161; SSE `follow` server/live.ts:155; `useLiveReply` live-reply.tsx:38 | Saved thread message (lead.ts:705) |
| Telegram | Push: `telegramHook` server/remote-hooks.ts:27 → `keepPushedUpdate`; the bridge drains it later (`drainInbox` telegram.ts:1590, after a `PUSH_IDLE_MS` 2 s sleep, :448/:679). Poll: `drainUpdates` :1504. Either way the message is saved by `enqueueTelegramConversation` (:1910) | `kick()` :543 → telegram-lead.ts:389 → :438 → `runLeadTurn` :800 | `warmTurn` (first `tool` only) | `plan()` :666, then `sendOrHandOff` :716. In the follower the bridge cycle sends (telegram.ts:631-634) |
| Slack / Discord / Teams | Socket or webhook → `chat_event` insert (slack-chat.ts:104-125; Discord/Teams equivalents) | `workChatQueue` chat-follow.ts:18-37 → `processChatEvent` chat-delivery.ts:238 → `runLeadTurn` :500 | `warmTurn` :498 | `state.plan` :629, then one part per 1 s pass: slack-chat.ts:534, discord-chat.ts:502, teams-chat.ts:204-213 |
| Terminal | REPL lines / `--say` | lead-cli.ts:280 | none | lead-cli.ts:293 |

Two structural facts shape the design:

- **The Slack/Discord/Teams queue is serial.** `process()` awaits a whole turn before `deliver()` runs (chat-follow.ts:28-37). A second message waits behind a 20 s turn even to be picked up. Acks therefore go at durable ingestion, and live edits go through a dedicated sender beside the queue.
- **On Telegram, the follower's turn worker doesn't send finals.** The bridge cycle does (telegram.ts:534-541). Drafts go from the turn worker through the serialized sender (§3.1). They are never on the final's critical path.

## 2. The shared core: `src/live-reply.ts`

There is one source: the `progress` closure in `runLeadTurn` (lead.ts:422). The core turns `LeadProgress` into text-only views, once per turn. Surfaces render those views. They never interpret `LeadProgress` themselves.

```
type LiveView =
  | { phase: "queued" }                                 // saved, waiting for the lead (busy or backlog)
  | { phase: "working"; status: string }                // one plain line
  | { phase: "writing"; status: string; text: string }  // display-safe partial
  | { phase: "closed"; why: "answered" | "failed" | "blocked" }  // terminal for previews; durable delivery takes over
```

### 2.1 Engine changes (lead.ts / lead-progress.ts)

- `step` gains `reason?: "repair" | "shorten"` (set at lead.ts:604-616), so the status can say "Fixing the reply…" or "Shortening the reply…". Today no field carries this (finding 15).
- **A trusted `blocked` event.** When a frame is suppressed because it looks like a secret (lead.ts:560) or because the final secret check refuses (lead.ts:701), emit `{ kind: "blocked", turn }` instead of staying silent. The core closes and clears the preview immediately (finding 12).
- `text.final: true` keeps its meaning: "this step's text is complete". It never means "the turn succeeded". Only the outcome of `runLeadTurn` is authoritative.

### 2.2 Text pipeline (the same for every surface and provider)

1. The engine's `scanForSecrets` gate stays (lead.ts:560).
2. **Never emit unfinished lexical material.** Show text only up to the last whitespace before the end. The unfinished last word, a code span, a link or a `**` run stays out until it closes. While the tail matches the start of any `SECRET_PATTERNS` family (evidence.ts:818: private-key header, AWS, GitHub, Slack, npm, OpenAI/Anthropic `sk-`, Stripe, Google, GitLab, Telegram, Discord and the rest), the view is withheld.
3. `shapeReply(text, { asked, appOrigin })` (reply-shape.ts:195) is **the same presentation policy as the final reply** (owner decision 4: no blanket output path filter). It labels foreign links with their real host and drops internal ids. Code spans are kept as written, and ids are kept when the owner asks for them, exactly as in the final. Documented as presentation, not redaction. For a prefix, `keepIds` is computed conservatively: drop ids unless asked.
4. The per-surface renderer (§3) escapes the text for its platform.

### 2.3 Status line

The status is the latest running tool's `leadToolLabel` plus "…". When nothing is running, "Thinking…"; once text exists, "Writing…"; during a repair or shorten step, the reason words; "Waiting for your earlier messages…" while queued. Fix the generic "Working" label to "Working on it…".

### 2.4 The serialized live sender (finding 3)

Each live surface message (a Telegram draft, a chat-app placeholder, an SSE stream, a terminal block) has one `LiveSender`:
- At most one request in flight, and one pending slot that holds only the newest view.
- A `generation` that only grows, and `close(): Promise<void>`. Closing drops the pending view, waits for the in-flight request to settle, then refuses every later view.
- **Durable final or failure delivery for that message starts only after `close()` resolves.** Telegram `plan()`/`deliver()`, the chat-app final part and the terminal's final print are all gated on it. So a late partial can never land after the final.
- Before every send, the sender re-proves standing (§5) and re-checks claim ownership after any await.
- The sender respects shared rate state (§3.5) and backs off. A send failure drops that view: previews are best effort.

## 3. Per-surface rendering

### 3.1 Telegram: `sendMessageDraft`

Verified in the current Bot API reference: private chats only, `draft_id ≠ 0`, a "temporary 30-second preview", empty text shows the native "Thinking…", and the bot must `sendMessage` the complete message to keep it. The docs say the draft disappears when the bot sends a message. Leave `can_stop` off; we don't implement stop.

- **Ack (owner decision 1).** Right after `enqueueTelegramConversation` (telegram.ts:1910), in the same pass, `setMessageReaction` 👀. When the reply has been delivered (`finish({state:"done"})` in `deliver`, telegram-lead.ts:661) or the failure notice has been sent, remove it (`reaction: []`). Never replace it with a "done" mark: an answer isn't finished work. At most one ack per binding per second; a burst coalesces.
- **Push arrival latency (finding 9).** `keepPushedUpdate` saves the update, then the bridge drains it only after up to 2 s of sleep. When the hook and the bridge share a process, the hook wakes the bridge (an in-memory signal that ends `wait()` early). When they don't, the ack target is "within one bridge cycle (≤ 2 s)". Report it that way; don't promise 1 s.
- **Queued.** A row deferred as `busy`/`backlog` gets `sendMessageDraft` "Waiting for your earlier messages…", refreshed every 25 s while it waits. That covers waits of up to two hours for free.
- **Working and writing.** Drafts carry the status line as an italic entity, then `telegramReply(shaped)` text plus entities (no `parse_mode`). **Truncation happens before entities are built**: cut the shaped text at a safe boundary (never inside a surrogate pair or a protected token, using `cutAt` from reply-shape.ts), render, measure the rendered length against 4 096, and cut again if needed. Throttle: adaptive, starting at one draft per 1.2 s, with a keep-alive every 25 s.
- **Fence.** Every data-bearing draft requires `telegramChannelProblem()` (telegram-lead.ts:102: live binding and generation, approver role, current project ceiling equal to the turn's), the turn still running under its generation (`getLeadTurn`), and `held()` (claim ownership). Re-check `held()` after the registry read. The registry read is cached per turn for at most 5 s so drafts don't hammer it. The 👀 ack and the empty "Thinking…" draft carry no project data, so pairing alone (`pairingProblem`) is enough for them.
- **Close, then final.** Before `plan()` (telegram-lead.ts:832), `await liveSender.close()`. The existing `plan`/`deliver`, `recover`, `requeue`, `sendOrHandOff` paths are unchanged, so durability and replay are as today.
- **Failed, refused or blocked.** `close()`, then the existing `notify(...)`. A notify can be lost (it is best effort, :474-484). The draft then expires on its own within 30 s, and for a running turn no unfinished words persist anywhere. A crash leaves the same picture: no drafts after restart, `recover()` reports the saved outcome.
- **Waiters and replays** (`requeue("replayed:running")`, `recover`) send no data drafts.
- **Team and group chats** (telegram-team.ts) get 👀 plus typing only.

### 3.2 Slack, Discord, Teams: a durable placeholder with a corrected lifecycle (owner decision 8, findings 1, 6, 11)

**Data model.** Add one row per event: `chat_live(provider, event, message, state, generation, created)`, with `state ∈ creating | uncertain | placed | finalized | abandoned`. It is separate from `chat_part` ordinals, so `plan()` and its "skip existing ordinal" rule are untouched. The event stays `queued` (no `finish()`) until the final plan.

**Lifecycle**

1. **Placement**, a separate operation `placeLive(event)`. It runs under the event claim, after the turn is admitted (the receipt exists) or when the event is deferred busy/backlog (with "Waiting for your earlier messages…"). It inserts `creating`, sends "Working on it…" with no buttons, and records `placed` with the message id.
   - **Discord:** POST with `nonce` = hash(event) and `enforce_nonce: true` (as discord-chat.ts:489 already does), so a retry inside Discord's nonce window returns the same message.
   - **Slack and Teams:** no creation idempotency. A lost response or a crash between send and record leaves the row `creating`, and the next claimant marks it `uncertain`. An `uncertain` placeholder is **never re-created**: the turn runs without a live message, the final posts fresh, and the possible orphan is reported in the event's problem text. The promise is "no duplicate except after an uncertain create on Slack or Teams", not "never".
2. **Live edits** go through the LiveSender (§2.4) on `placed` rows only, as direct `options.api` calls beside the queue.
3. **Final.** Once the turn has an outcome: `await liveSender.close()`, then plan. Final planning adds a **distinct** first reply part (its own ordinal 0 in `chat_part`, as today) with `edit: <placeholder id>`. The existing `content.edit` paths (slack-chat.ts:521,534; discord-chat.ts:502; teams-chat.ts:204-213) rewrite the placeholder into the answer. Cards and the rest follow as new messages, exactly as today. `chat_live` → `finalized` in the same transaction as `plan`.
4. **Failure, refusal, block.** The failure plan (chat-delivery.ts:576-600, 609-627) uses the same `edit` to replace the placeholder with the truthful failure words. These are durable parts, retried like any part, so a restart still replaces the placeholder.
5. **Crash and replay.** On restart, `processChatEvent` finds the receipt (:571 onward) and the `chat_live` row. Turn still running → defer (unchanged). Turn ended → plan the final or failure with `edit` = the placed id. No new placeholder is made for an event that has a `chat_live` row.
6. **Revocation or permanent loss of access.** An unauthorized edit is never sent, cleanup included. The placeholder's last visible text must therefore be harmless on its own. Every live edit after the first word ends with the visible marker "(still writing — not final)", and the status-only placeholder says "Working on it…". The row → `abandoned`. This limit is documented (finding 7).

**Payloads (exact fields, replaced every edit)**

- **Slack.** `chat.update` with top-level `text` = rendered mrkdwn, `blocks` = `slackVoiceBlocks(...)` with **`verbatim: true` on every mrkdwn text object**, `parse: "none"`, `link_names: false`, `unfurl_links/unfurl_media: false`. Blocks are always sent, so "Working on it…" can't linger. `renderReply("slack")` already escapes `& < >`, which neutralizes `<!here>`-style syntax. With `verbatim: true`, a literal `@here` is never auto-parsed (finding 4). **Apply the same `verbatim` fix to today's final voice blocks** (slack-chat.ts:226-231): it is a pre-existing gap.
- **Discord.** The same shape as the final voice payload, `discordCard(text, [], true)` (discord-chat.ts:214-220): `content: ""`, one embed `description` (limit 4 096, measured after `renderReply("discord")`), `components: []`, and **`allowed_mentions: { parse: [], replied_user: false }` on every PATCH** (Discord doesn't inherit it).
- **Teams.** PUT the activity with the same text body the final uses (`teams` escaping), measured after rendering against the activity size.
- A partial longer than the platform limit keeps its first window, plus "(continues…)"; the final split is unchanged.

**Ack (owner decision 1, finding 9).** At durable ingestion (the `chat_event` insert), for the owner's own DM only: Slack `reactions.add` 👀, Discord PUT 👀, Teams typing (Teams has no bot reactions). The ack is removed once the final is delivered (Slack `reactions.remove`, Discord DELETE of its own reaction; discord-api.ts:22/37 needs `DELETE` and the 👀 path added to its allowlist). Coalesce to one ack per binding per second.

### 3.3 Slack reinstall, the one-time owner step (owner decision 3)

Add `reactions:write` (both the 👀 ack and its removal need it) to `SLACK_MANIFEST.oauth_config.scopes.bot` (slack-api.ts:269-282). `assistant:write` for Slack's native "is thinking" status is **not** added in this release: it needs Slack's AI-app feature and duplicates the placeholder's status line. Revisit only if the placeholder reads poorly in Slack.

In plain words, for the owner:
1. In Toolroll, open Settings → Chat apps → Slack and click **app manifest** to download the new one.
2. On api.slack.com/apps, open the Toolroll app, go to **App Manifest**, paste the new manifest and save. Slack will say the app's permissions changed.
3. Click **Reinstall to Workspace** (Slack shows it in a yellow banner, or under OAuth & Permissions), check that the list now includes "Add emoji reactions", and allow.
4. Back on OAuth & Permissions, compare the **Bot User OAuth Token** with the one in Toolroll. If Slack shows a different `xoxb-` token, paste it into Settings → Chat apps → Slack → Bot token and save.
5. Send the bot a message. 👀 should appear on it within a second or two.

Until this is done, Slack works as today without the ack. A failed `reactions.add` is skipped silently. Settings → Chat apps shows "Reinstall needed for reactions" when Slack answers `missing_scope`.

### 3.4 Web `/chat` and task "Ask" (owner decision 2)

- Feed `beginLiveTurn` (server/chat.ts:1161) from `LiveView`. SSE snapshots carry `{ status, text, phase }`, with the text already shaped.
- **One live status line.** The tool steps sit behind a "Steps" disclosure (closed by default, a System component via YouIyouX `ui_find_component`). Partial text renders through the same pieces as saved messages (`replyPieces`), so the swap to the saved message doesn't jump.
- **Failure is derived from saved state (finding 7).** `readLiveReply` keeps `ok`. When the stream ends with `ok:false`, or reconnects and finds no running turn, the bubble drops partial text immediately. It shows the turn's saved failure from `GET` (the turn row's `failureReason` → `leadFailureText`), not the in-memory `noteLead` (server/chat.ts:1205), which a restart loses. On `lost`, partial text is dimmed and marked "Connection lost — reloading", never shown as an answer.
- Queued messages show "Waiting for your earlier messages…" as the status.

### 3.5 Shared rate and abuse control (finding 10)

- Live sends share each platform's existing retry state: Telegram `telegramRetryAt`/`deferTelegram`, the chat apps' `chat_runtime.retry_at`. No cosmetic send happens while a cooldown holds. A 429 on a cosmetic send records the cooldown, so durable delivery honours it too.
- **Priority:** durable final and failure parts first, acks next, live views last. A live view is dropped, never queued, when the shared budget is short.
- Rates are adaptive: start from conservative defaults (Telegram 1.2 s, Slack 1.5 s, Discord 1.25 s, Teams 2 s), widen on any 429 or retry-after, never hard-code Discord buckets, and keep at most one in-flight live request per message.
- The plumbing cut "deliver all of an event's parts in one pass" (§6) is bounded: up to 5 parts or until a rate signal, whichever comes first.

### 3.6 Terminal (`toolroll chat`) (finding 5)

- **TTY only** (not `--json`, not piped). Pass `onProgress` at lead-cli.ts:280. Draw one status line redrawn in place, then a bounded live block of at most 6 lines, wrapped to the terminal width using display width (wide and combining characters). Redraw on resize.
- **All model text goes through `terminalText()`** (terminal-text.ts:27: CSI, OSC, other ESC, C0/C1, bidi and format characters out) before shaping and printing, **partials and the final alike**. That closes a pre-existing gap at lead-cli.ts:293. The decoder's chunk boundaries can't split a sequence past it, because the filter runs on the whole accumulated text every time. Only Toolroll's renderer emits cursor controls.
- At the end, close the sender, erase the live block (cursor-up within the block's known height), then print the final exactly as today. The plan doesn't claim the block is gone from scrollback: a terminal that scrolled during the turn keeps what it showed. On Ctrl-C, erase the block and print "Stopped."
- `--json` output is byte-identical to today.

## 4. Durability, replay and failure rules

1. **Records.** The saved thread message plus planned parts are the record. Live views are never authoritative. The chat-app placeholder is a tracked `chat_live` row only so that the final can replace it.
2. **Cards, buttons, asks, images and approval tokens** exist only after `finalizeLeadTurn(answered)`, minted in `plan()`. No live payload carries `reply_markup`, Slack action blocks, Discord components or Adaptive Card actions.
3. **Ordering.** Durable delivery for a message begins only after its LiveSender has closed (§2.4).
4. **Computation outcome is not delivery outcome (finding 7).** Replacing visible partial text is a durable intent: chat-app failure parts are retried, and the web reads saved turn state. Telegram's best-effort notify is backed by the draft's 30 s expiry. Limits, stated plainly: a revoked or permanently failing chat may keep the last placeholder edit, which always carries "(still writing — not final)". Toolroll never bypasses authorization to clean up.
5. **Crash and replay** are as in §3.1 and §3.2. The Telegram receipt and parts are unchanged; chat-app events stay queued until the final plan.
6. **Secret refusal** at the end (lead.ts:701) and mid-stream suppression both emit `blocked`. The preview closes at once, and the failure path replaces any placeholder.

## 5. Security constraints

- **Standing before every data-bearing send (finding 2).** On Telegram: the full `telegramChannelProblem()` ceiling check, plus the turn running under its generation, plus claim ownership. On chat apps: `channelAccess(options, binding, ceilingDigest)` (chat-delivery.ts:119, an async proof), then the claim re-checked after the await. Non-data acks need only the pairing or binding fence.
- **Inert text per platform.** Telegram entities only. Slack `verbatim:true` plus escaping, no `parse`/`link_names`. Discord `discordPlain` inside an embed, with `allowed_mentions` empty on every edit. Teams escaping. Terminal `terminalText`. Web React text nodes. Cards keep `LEAD_NOTE_WORDS` labelling (card-render.ts:21) and are never partial.
- **Presentation, not redaction.** `redactForLead` (lead-tools.ts:146-168) scrubs paths, digests and names from model *inputs*. Outputs, partial and final, get `shapeReply` presentation only, with its code and "asked for ids" exceptions (owner decision 4).
- **Secrets.** The hold-back of unfinished words, the tail check against every detector family, and the `blocked` close (§2.1-2.2).
- **No authority from partials.** Approvals only ever come through `plan()` tokens and the doors.

## 6. Where turn time goes (live DB, read-only, 2026-10-21 → 2026-11-08)

| Measure | Value |
|---|---|
| Answered turns | 190. Average **22.5 s**. 2 steps: 146 (77%), 16.9 s; 3 steps: 28, 34.2 s; 4 steps: 12, 52.4 s; max 7 steps, 107.8 s |
| One-step answers | None in the window |
| Step 1 | **5.5 s** average (2.6–20.7), 264 tokens out, 44 reply bytes: tool calls only |
| Step 2 | **10.6 s** average, 1 002 tokens out, the answer |
| Tool execution between steps | 0.32 s average (max 8.5 s). Admission 0.25 s, finalize 0.01 s |
| Telegram arrival → turn / turn → delivered | 0.3 s / 2.3 s (5 messages) |
| Failed turns | 15, **all 120 s timeouts on step 1**, 2026-11-06…08 |
| Model | `claude-subscription`, `opus` (reports `claude-opus-5-5`). No effort flag. A fresh `claude -p` per step |
| Internal provider turns per step | 2.08 average (the CLI's structured-output round) |
| Cache | Step 1: 12.3k in, 1.4k read, 24.2k written. Step 2: 16.8k in, 5.9k read, 29.2k written. The prefix is mostly not reused. The cause is **unproven** (finding 13): contract, tools and DATA already lead the prompt, and the advertised tools can change between steps (lead.ts:350) |

**Tool names per step are not recorded anywhere** (owner decision 5 asked to measure them read-only). The DB has no per-call tool log, and `LEAD_TRACE` is opt-in stderr only. What the DB does show, from activity lines and proposals:

| Steps | Reads in the turn | Turns |
|---|---|---|
| 2 | 1 | 36 |
| 2 | 2 | 56 |
| 2 | 3 | 38 |
| 2 | 4 | 16 |
| 3+ | 0–19 | 44 |

In a two-step turn every read happens in step 1, so **step 1 usually makes 2–4 reads in parallel**. Only 36 of 190 turns (19%) made exactly one read. That is the **upper bound** for one prefetched brief removing a step, and only if that one read was `get_brief`. Only 8 of 190 answered turns (4%) proposed anything.

## 7. Latency plan

1. **Perceived latency (slices 1–4):** ack, status and streaming. No model change.
2. **Brief prefetch: not adopted (owner decision 5).** The data caps the benefit at 19% of turns, unproven. Slice 5 first records tool names per step (a nullable `tools` column on the step row, names only, no arguments). Revisit only if two weeks of data show one read covering a real share of turns. If it does, trial a bounded, project-scoped prefetch (`get_brief` is scoped by repo, lead-tools.ts:613).
3. **Caching A/B (spike S3, not a change).** Measure cache reads and time per step for: today's prompt; stable contract plus tools pinned across steps (fixed advertised set); `--append-system-prompt` versus `--system-prompt` for the **contract only**. **DATA and history never move into the system prompt**: they hold untrusted project and task text (finding 13).
4. **Completion: keep result- and exit-based success (owner decision 6).** No early stop at the structured-output block. `--max-turns 1` is not pursued.
5. **The 15 step-1 timeouts.** Diagnose first, from the step rows (`provider_turns`, `billing_reported`, partial stdout if any was kept). Keep the hard 120 s deadline. Any inactivity watchdog is provider-specific (Claude streaming only), and it trips on "no stream event at all for 45 s", never on "no visible text" (finding 14).
6. **Plumbing:** the Telegram push wake (§3.1). Bounded multi-part delivery per pass on the chat apps (§3.5).
7. **A persistent process per turn** is a separate lifecycle proposal, not part of this plan (finding 14).
8. **Fast model for quick questions (owner decision 7):** §8.

## 8. Quick-answer router (owner decision 7)

**Rule.** Decide before the turn, deterministically, conservatively. A message routes to the fast model (`sonnet`, the model the e2e journeys already use for the lead, app-e2e.mjs:934) only when **all** of these hold:
- The Settings switch "Quick answers use a faster model" (Settings → Lead) is on.
- There is no task focus or reply-to-task context. Task-scoped chats discuss revisions.
- The message reads as a status or read question (an interrogative opening or a trailing "?", or a short "status"/"what's…"/"show…" form) and contains no act words from a fixed list: file, make, create, add, fix, change, build, plan, approve, confirm, merge, release, ship, deploy, cancel, pause, hold, resume, retry, steer, remember, delete, archive, send, run, start, stop.
- The message is not an answer to an open `ask_owner` question.

Everything else stays on Opus, unchanged.

**A fast turn is read-only by construction.** It advertises only read tools (the `READ_TOOLS` set) plus `find_tools`, restricted to read results. **Escalation inside the same turn:** if a fast step returns any call outside that set (a `propose_*`, `remember`, `commit_to`, `ask_owner`, `show_card`, `show_control`, a write tool found by `find_tools`), or calls `find_tools` for something to change, the step's calls are discarded unrun. The turn re-runs that step on Opus with the same history (reads already done stay), and every later step stays on Opus. Spend and steps count as normal. The turn's wall clock and step cap still bind.

**Record.** Each step row already stores `model`. Add `route` to `mate_turn` (`default | fast | escalated`). The activity line says "answered by Sonnet" or "moved to Opus". Spend and results-routing reports can then split by route.

**Eval gate (it ships enabled only if this passes).** Add a `lead-answer` eval kind to the existing harness (src/evals.ts, evals/cases, eval-world.ts):
- A seeded world with known tasks, decisions, results, checks, a queue and flows.
- 30 real-style read questions (status, "what needs me", "why did X fail", "what's queued", "which tasks are ready", flow health), each with an oracle computed **from the records**: the exact task titles, states and counts the answer must name, and facts it must not claim.
- 10 act-intent questions, which must route to Opus or escalate.
- Each question runs k=3 per model (pass^k, the harness's rule).
- **Pass:** fast accuracy on must-name facts ≥ Opus accuracy minus 0 points (no regression), zero false claims beyond Opus's count, 10/10 act questions on Opus or escalated, and median turn time ≥ 30% faster.
- If it fails, the switch ships **off by default**, with the eval result shown beside it in Settings.

## 9. Build slices (ordered, each built and reviewed on its own)

| # | Slice | Contents | Depends on |
|---|---|---|---|
| 1 | **Live core + web** | `live-reply.ts` (views, pipeline, LiveSender), engine events (`blocked`, step reason), SSE snapshot `{status,text,phase}`, web single status line + Steps disclosure, saved-state failure, `ok` kept | — |
| 2 | **Telegram** | 👀 ack and removal, push wake, queued draft, `sendMessageDraft` previews, full fence, close-before-plan, rate sharing | 1 |
| 3 | **Slack / Discord / Teams** | `chat_live` migration, placement / uncertain / final-edit lifecycle, exact payloads, Slack `verbatim` fix (finals too), Discord `allowed_mentions` on edits and the DELETE/👀 allowlist, ingestion ack, shared rate state, bounded multi-part delivery, Slack manifest + reinstall copy | 1 |
| 4 | **Terminal** | TTY status and live block, `terminalText` on partials and finals, resize and Ctrl-C | 1 |
| 5 | **Latency + router** | Tool names per step, step-1 timeout diagnosis, S3 caching A/B, router + escalation + `route` column + Settings switch, `lead-answer` eval (gate) | 1 (router needs none of 2–4) |
| later | Provider adapters | Direct API SSE streaming (Anthropic and OpenRouter) and Codex `--json` deltas, plugged into the same `onText` | 1 |

Spikes before their slice: **S1** (slice 2), a real Telegram client: draft replaced by `sendMessage` and by a notify, backgrounded app, `retry_after` on drafts. **S2** (slice 3, optional), whether `chat.update` can rewrite a message after `chat.stopStream`; native Slack streams stay out unless they can journal the same placeholder lifecycle. **S3** (slice 5), §7.3.

## 10. Owner decisions applied (2026-11-08)

1. Ack: 👀 on arrival, removed once the answer (or failure notice) is delivered; never a "done" mark. §3.1, §3.2
2. Web: one live status line, steps behind a disclosure. §3.4
3. Slack: reinstall once with `reactions:write`; `assistant:write` deferred. §3.3
4. No blanket output path filter; partials get the final's `shapeReply` presentation. §2.2, §5
5. Brief prefetch: measured; not adopted on current evidence; record tool names first. §6, §7.2
6. Keep result/exit-based completion; no early stop. §7.4
7. Auto fast model for read-only status questions, escalate in-turn, record the route, Settings switch, eval-gated. §8
8. Durable placeholder on Slack/Discord/Teams with the corrected lifecycle. §3.2

## 11. Changes from review (Codex round 1)

Each finding was checked against the code. All 16 are confirmed; none rejected. Two are confirmed with a narrower reading.

| # | Finding | Verified | Fix in this revision |
|---|---|---|---|
| 1 | Placeholder via `plan()` finishes the event and loses ordinal 0 | Yes: `plan()` skips existing ordinals and calls `finish()`, which sets done and erases the payload (chat-delivery-state.ts:102,116-151); `next()` takes queued only (:93) | Separate `chat_live` row and `placeLive` op; event stays queued; a distinct final part edits it (§3.2) |
| 2 | Telegram draft fence is pairing-only | Yes: `pairingProblem` checks binding and role (telegram-lead.ts:466-472); finals use `telegramChannelProblem` (:529) | Full ceiling + turn generation + claim before every data draft; same with `channelAccess` on chat apps (§3.1, §5) |
| 3 | A late partial can overwrite the final | Yes: `progress` is synchronous and unawaited (lead.ts:422); finals go through separate paths | LiveSender: one in flight, newest pending, generation, `close()` awaited before durable delivery (§2.4, §4.3) |
| 4 | Slack mrkdwn lacks `verbatim:true` | Yes: `slackVoiceBlocks` (slack-chat.ts:226-231) has none; only the card code block sets it (card-render.ts:84) | `verbatim:true` on every model-derived mrkdwn, partial and final; `link_names:false` (§3.2) |
| 5 | Terminal control sequences pass through | Yes: `renderReply("terminal")` doesn't filter (reply-shape.ts:326), and lead-cli prints it raw (:293); `terminalText` exists (terminal-text.ts:27) | `terminalText` on partials and finals (§3.6) |
| 6 | Saving the id after send doesn't prevent duplicates | Yes: `partSent` records after the send (:196); Discord alone uses a nonce (discord-chat.ts:489) | `creating`/`uncertain` states, Discord nonce, never re-create when uncertain, weaker promise on Slack/Teams (§3.2) |
| 7 | Failure replacement overpromised | Yes: `noteLead` is in-memory (server/chat.ts:1205), `readLiveReply` drops `ok` (live-reply.tsx:31), notify is best effort (telegram-lead.ts:474-484) | Computation vs delivery split, durable failure parts, web reads saved state, "not final" marker, cleanup limits documented (§3.4, §4.4) |
| 8 | Early stop at StructuredOutput is a protocol change | Yes: success requires exit 0 and the primary result line (subscription-chat.ts:320-325) | Dropped; result/exit completion kept (owner decision 6, §7.4) |
| 9 | Ack points miss 1 s | Yes: serial queue (chat-follow.ts:28-37); push drained after the `PUSH_IDLE_MS` sleep (telegram.ts:448,679) | Ack at durable ingestion; push wake; queued status; honest ≤ 2 s target cross-process (§3.1, §3.2) |
| 10 | Fixed throttles aren't rate control | Yes: the API wrappers surface retry info, but nothing schedules side-channel sends against it | Shared cooldowns, priority, adaptive rates, bounded batching (§3.5) |
| 11 | Partial payloads lack size and field contracts | Yes: Discord voice is an embed with empty content and explicit `allowed_mentions` (discord-chat.ts:214-220) | Exact per-platform payloads, fields replaced, limits measured after rendering, `allowed_mentions` per PATCH, truncation before entities (§3.1, §3.2) |
| 12 | Secret stream contract incomplete | Yes: `SECRET_PATTERNS` has 14+ families (evidence.ts:818); suppression at lead.ts:560 is silent | `blocked` event, hold-back of unfinished words, every detector family in table tests, `final` = step complete only (§2.1-2.2, §12) |
| 13 | Cache diagnosis unproven; DATA in system prompt changes trust | Narrower: low cache reads are measured (§6), but the cause is unproven: the order is already contract/tools/DATA/history (subscription-chat.ts:95-108) and tools can change per step | Cause marked unproven; S3 is an A/B; DATA never goes into the system prompt; the two flags are treated as different (§7.3) |
| 14 | Prefetch savings and timeout behavior unestablished | Yes: tool names aren't recorded; the DB shows 2–4 parallel reads in most step-1s | Measured upper bound of 19%; prefetch not adopted; watchdog only after diagnosis, Claude-streaming-specific, hard deadline kept (§6, §7) |
| 15 | Streaming isn't cross-provider; no reason field | Yes: Codex excluded (subscription-chat.ts:253), direct API buffered (lead.ts:544); `step` has no reason | Scope statement + status-only fallback + adapters as a later slice; `step.reason` added (top, §2.1, §9) |
| 16 | Verification gaps; ambiguous message assertion | Yes: `data-message-id` is on operator messages too (app.tsx:568, lead-chat.tsx:116/130); AGENTS.md:29-33 requires typecheck and desktop + phone journeys with failure/long/empty states | Assert on the assistant message for the exact turn; typecheck, YouIyouX checks, desktop + phone for /chat and Ask, adversarial cases (§12) |

## 12. Verification

Typecheck plus the focused test files of each slice. The full suite runs in CI and the release check.

**Unit and slow tests (security, contracts and data integrity, per docs/testing.md)**
- **live-reply (slice 1):** view ordering; a table of every `SECRET_PATTERNS` family split at every boundary (start, mid-token, around a multiline PEM header) never emitting; `blocked` clears and closes; held-back unfinished code, link and bold; shaped output; LiveSender (a late in-flight partial resolving after `close()` never reaches the transport; generation monotonic; newest wins); no view carries buttons.
- **Telegram (slice 2):** 👀 at enqueue and removal after `done`; drafts gated on a ceiling change mid-turn (no draft after the change); claim lost mid-draft; no draft after `sendMessage`; truncation keeps entity offsets valid at a surrogate pair; 429 on a draft records the cooldown and finals wait; recover/waiter rows send no data drafts; a lost notify after drafts.
- **Chat apps (slice 3):** `chat_live` placed → final edit with the event kept queued until plan; crash after send, before record (Slack/Teams → uncertain, no second placeholder; Discord nonce → same message); failure plan edits; revoked mid-turn → no edits, row abandoned, last edit carries the marker; Slack payload `verbatim:true` (partial and final) with a literal `@here` and `<!channel>`; Discord PATCH always carries `allowed_mentions`, an embed and `components: []`; cooldown honoured; priority (a final preempts a live view).
- **Terminal (slice 4):** ESC/OSC/OSC-52/CR/bidi in model text are stripped from partial and final, including sequences split across chunks; `--json` byte-identical; wrapping with wide characters.
- **Router (slice 5):** the routing table (act words, task focus, open asks); escalation discards fast calls unrun and continues on Opus; `route` recorded; switch off means always Opus.

**Journeys (desktop and phone, `/chat` and task Ask)**
- Teach the scripted provider (scripts/fixtures/scripted-provider.mjs:577) to emit `stream_event` `input_json_delta` frames with delays and a scripted two-step turn.
- **New scripted journey (lead group):** after submit, the live status line appears within 1 s; the status reads a tool label while the tool runs; live text grows over at least 2 snapshots **before the assistant message for that turn** (located by turn, not by `data-message-id` count) exists; the saved assistant message then replaces the bubble with no duplicate; a card appears only after done; no `**` or raw id in live text; the Steps disclosure opens. Also covered: a long reply, a failed turn (live text removed, saved failure shown), and the empty state before the first word.
- Existing journeys (app-e2e.mjs lead :952-983, maya "messages that wait for the lead"; flows-e2e.mjs :78-99) keep their final-answer assertions. The real-model journeys also report "time to first status" and "time to first text" (reported, not gated).
- UI work passes the YouIyouX checks (AGENTS.md design language section).

Telegram, Slack, Discord and Teams have no browser journeys. They are covered by the slow tests above plus spike S1 on a real client.
