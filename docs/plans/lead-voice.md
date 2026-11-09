# Lead voice: short, casual, clear

Status: plan v2, 2026-11-09 (one Codex round: GO WITH CHANGES, ledger at the end). Branch `lead-voice`.

## Goal

The lead's replies read like a colleague's quick message: the answer first, one to three sentences, everyday words,
and no narration of its own steps. Honesty rules stay. Nothing about what the lead may do changes.

## Why replies are heavy today

- `src/lead-contract.ts` (version 51) is about 2,100 words of procedure. Two paragraphs cover tone. The reply paragraph
  asks for short answers and, in the same breath, for three extra sentences in every reply: "Say what you checked this
  turn and what it showed", "Mark anything you did not check this turn as a guess", and (twice) "cite the decision ids
  you rely on". (The paragraph does give every channel the 1-3 sentence rule; the extra sentences work against it.)
- `src/lead-context.ts` `CHANNEL_WORDS` gives the four chat apps "a few short lines". The console and the terminal get
  no length guidance at all, and no limit (`LEAD_REPLY_LIMITS` is null for both).
- The contract calls the person "the operator" and "the owner" throughout and tool results use internal names
  (`currentExecution`, scope, digest, standing, ceiling). The model mirrors both. One line bans six words;
  `src/plain-words.ts` already lists about fifty.
- A handful of fixed strings the lead's cards and the phone status send still use internal words (list in V4).
- Nothing measures reply length or wording, so a regression is invisible. `src/lead-answer-eval.ts` grades facts,
  routing and speed, not voice.

## Slices

### V1 — The contract's voice rules (`src/lead-contract.ts`, version 52)

Replace today's "Replies:" paragraph and the "Talk like a colleague" paragraph with one block placed directly after the
opening identity paragraph, so it is read before the procedure:

1. **How you talk.** "Talk like a capable colleague sending a quick message. Answer first, in one to three short
   sentences, then stop unless they asked for more or the work truly needs it. Everyday words and contractions: task
   titles, 'the changes', 'the checks', 'try again'. No headers, no bullet list for fewer than three things, no
   sign-off, no restating their question, and no account of your own steps: they can open Steps to see what you read.
   When there is a next step, end with it or with the one thing they can do."
2. **How you stay honest, briefly.** "When the answer rests on something you read this turn, name the source in a few
   words ('the check log says a missing import'). When you did not check, say so in a word or two ('probably',
   'I haven't checked'). When you don't know, say 'I don't know', then check with a tool. Never make up an answer and
   never present a guess as something you remember."
3. **Their words, not ours.** "They are 'you'. In your own sentences, don't write operator, owner, execution, run,
   scope, digest, dispatch, lane, standing, ceiling, candidate, gate or contract. Tool data uses those names; say it
   the everyday way: an attempt, the plan, starting, your sign-in, the limit, the changes, the checks. Leave ids and
   version strings out unless they ask or two things would otherwise read the same. This never changes a quotation:
   when you quote a tool's words, a file, or what someone wrote, quote it exactly; and when they ask for the technical
   detail, give it in its real names."
4. **One example pair**, to anchor length: Good: "The login fix is ready and its checks passed. Approve it below."
   Not: "I checked the task this turn and it showed the current attempt reached a built result with all approved
   checks passing."

Other contract edits:
- "cite the decision ids you rely on" (two places) becomes "name the decision you rely on by what it settled ('you
  chose Postgres in March'); give its id when they ask". The call to `search_project_memory` before a proposal is
  unchanged; the plane enforces that from earlier tool calls (`src/lead-tools.ts:2134`), not from reply text. The
  memory tool's description (`src/lead-tools.ts:1526`), which still asks for kind-and-id citations, gets the same
  wording.
- The reply text that triggers attachment-claim repair (`src/reply-shape.ts:380`, `src/lead.ts:678`) is untouched; the
  new rules must not tell the lead to phrase image claims differently.
- "Then say what you checked, what is missing, and the one next step." becomes "Then say what is missing and the one
  next step."
- No other paragraph changes meaning. "The operator" inside procedure paragraphs may stay: rule 3 governs what the
  lead writes.

Every rule about authority, proposals, approvals, credentials, untrusted data and never inventing an answer keeps its
exact meaning. Net contract length must not grow by more than 100 words.

### V2 — Console and terminal get the same length guidance (`src/lead-context.ts`)

- console: "The Toolroll console in a browser: a few short lines. Cards and links show beside your reply, so don't
  repeat what a card shows."
- terminal: "The Toolroll CLI in a terminal: a few short lines of plain text."

No new limit and no new shorten step: a second model call would slow every long reply.

### V3 — Measure the voice (`src/reply-voice.ts`, new; `src/lead-answer-eval.ts`; `scripts/lead-answer-eval.mjs`)

- `replyVoice(reply)`: pure, and run on the shaped text a person sees (`shapeReply`), not the raw reply. Returns characters, sentence count, the `PLAIN_WORDS` rows it hits outside code spans
  (plus "operator" and "owner" as address), and whether it opens by narrating ("I checked", "I looked at", "Let me",
  "Certainly", "Sure,"). Unit tests in `src/reply-voice.test.ts`.
- The eval records it per answer and reports, for read questions per model: median characters, the share of answers
  over 320 characters, internal-word hits, and narrated openings. It prints them and writes them to `--out`.
- The numbers are reported, not gated: the eval's `pass` stays the Quick answers gate and its meaning does not change.
  A `--voice-only` flag is not added; a real run stays the owner's choice because it spends model usage.

### V4 — Fixed strings (`src/lead-doors.ts`, `src/chat-actions.ts`, `src/server/render-chat.ts`, `src/telegram-status.ts`, `src/server/chrome.ts`)

Wording only; reasons, kinds and every refusal's logic stay as they are.

| Today | After |
| --- | --- |
| your approver standing changed — sign in again | Your sign-in changed. Sign in again. |
| the admitted projects changed since this was proposed — it cannot be confirmed | Your projects changed since this was drafted, so it can't be confirmed. Ask for it again. |
| cancelling is armed on the task itself — open the task | Cancel from the task page. |
| filed `<id>` — review and approve its scope to start work | Filed `<id>`. Approve its plan to start work. |
| `<id>`'s scope rewritten — approve it with your password on the task | `<id>`'s plan changed. Approve it on the task page. |
| Stop released. Other requirements still prevent the next attempt. | Stop lifted. Something else still holds the next attempt. |
| Scope revision / save scope | Plan change / save plan |
| membership login · no dollar ceiling | membership login · no dollar limit |
| No connected projects are available to this bridge. | No projects are connected here yet. |
| Status is a snapshot, not a promise that the next attempt will succeed. | This is how things stand right now. |
| Latest agent-reported milestone update: … (not independent proof). | Latest update from the agent, not verified: … |
| Operating mode — the signed posture this repository runs under | Operating mode — how much this project may do without asking |
| Action ledger (menus) | Audit log, the name the page already has |

Left alone on purpose: the sweep approval's "Confirming files all of them…" (`src/chat-actions.ts:699`) and the
"Requirements … satisfied in the saved record" line (`src/chat-actions.ts:1089`, `src/telegram-status.ts:276`). Both
are approval terms; terms enter approval digests and action stamps (`src/chat-actions.ts:1096`), so changing them
changes what a saved card matches. Any other row the builder finds inside `terms` stays too.

The builder updates the existing assertions that quote these strings (`src/telegram-lead.slow.test.ts:384,1349,1634`,
`src/chat-parity.test.ts:507`, `src/telegram-status.test.ts:159,334`, `src/serve.chat.slow.test.ts:1415,1436,1776`)
and adds the edited surfaces to the rule table in `src/plain-words.test.ts` where they are not covered. No new
per-string wording tests.

## What must not change

- What the lead may do, which tools it has, and every refusal.
- The honesty rules: no invented answers, guesses marked, sources named.
- Reply shaping (`src/reply-shape.ts`) and platform limits.
- Preserved content and consent text.
- Tool result field names (`currentExecution` and the rest): renaming them touches the contract's procedure
  paragraphs and many tests. V1 rule 3 covers it for now.

## Not in this arc

- Renaming tool result fields to plain names.
- The worker's result prompt in `src/builder.ts` (it already asks for a compact result, and it may be part of what an
  approval covers).
- Result reports with screenshots or preview links first.
- A hard length limit or an automatic shorten step on the console.

## Checks

Targeted tests only: `src/reply-voice.test.ts`, `src/lead-answer-eval.test.ts`, `src/plain-words.test.ts`,
`src/one-vocabulary.test.ts`, the tests beside each edited file, typecheck, and the guard tests. The full suite runs
in GitHub CI.

## Proof it worked

Before and after numbers from the eval's voice report on a real run (owner's choice, since it spends usage). Without
that run, the claim is only "the rules now ask for it", and the release note must say so.

## Codex round 1 ledger (v1 → v2)

| # | Severity | Finding | Change |
| --- | --- | --- | --- |
| 1 | High | Two V4 rows are approval terms that enter digests and stamps | Both rows removed and named as left alone |
| 2 | Medium | An absolute word ban conflicts with exact quotation and requested detail | Rule 3 covers the lead's own sentences only; quotations and requested detail are exempt |
| 3 | Medium | V4 breaks assertions in four test files | The files and lines are listed for the builder |
| 4 | Low | Three statements about today's code were wrong | Corrected in "Why replies are heavy today" |
| 5 | Low | Memory tool description still demands ids; example modelled an extra round trip; measure shaped text | All three taken |
