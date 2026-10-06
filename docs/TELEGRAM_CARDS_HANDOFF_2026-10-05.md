# Telegram decision cards: action first

Telegram-only layout change for the cards a person decides on: parked decisions, decide-in-chat plans, lead
proposals, flow approvals and flow choices. Built on `a5d0c08` (0.9.37). Synthetic fixture evidence; no live bot
and no physical phone were used.

## What changed

| Card | Now leads with | Moved down or removed |
| --- | --- | --- |
| Parked decision | `Decide: <question>`, then one line per option with its consequence, `(recommended)` and `⚠ can't be undone`, then `Decide by … UTC` | The recap becomes the closing `Background:` line. The `[id]` prefixes and "Decision needed" heading are gone. Cancel now restores the question **and** every consequence (it used to restore the question alone). Answered cards name the option's label. |
| Plan (decide in chat) | `Plan ready: <title>`, then `Starting allows: <access> · <budget>` on one line | Goal, `Only in:` (or `Any file in the project.`) and `Done when:` follow. Steps are capped at 3; Edit opens the full plan. The empty `Changes:` heading is gone. |
| Lead proposal | The headline, then what confirming does (approval, irreversibility) | The exact terms (goal, note, options) follow. "Confirm or Dismiss below…" is gone because the buttons already say it. |
| Flow approval | `Approve “<card>”`, then `Approve → <next> · Send back → <zone>, with your note` | Then the teammate's handoff (if any), `Draft:` with the draft as the card holds it now, and `<flow> · <zone>` last. After a tap: `✅ Approved. Moved to …` (it used to say "approved" twice). |
| Flow choice | `Choose what happens to “<card>”`, then `<option> → <zone>` for each option (`closes the card` for an end) and `or reply → <zone>, with your note` | Then the summary, pull request and `<flow> · after <step>`. After a tap: `✅ Ship it. Moved to Ship.` |
| Result, failed task, pull request | Unchanged. The words come from the notification or quiet view, and the result card already ends `Accept and finish it?`. | No change. |

## What stayed the same

- Callback data keeps its formats and limits: `d:<24 hex>` for decide-in-chat tokens and `<32 hex>` for decision, flow, choice and proposal tokens. No new callback form was added and no Details callback was minted. Every check is within `TEXT_LIMITS.telegramCallbackDataBytes` (64).
- Every tap goes through the same door, so it records the same things: the decision answer (`answeredBy`, `answeredVia: telegram`), plan approval with `approvalBasis: mode` and its ledger line, both merge ledger lines, operator completion, retry, the flow event and the `flow choice` ledger detail.
- Buttons on cards sent before this change keep working. `QUESTION_STARTS` was not changed and no question was reworded, so `cardBody` still strips the questions on old armed cards. Tests cover old-text plan and decision cards.
- These are unchanged: `flowSendContent`, `flowSendTail`, `flowChooseBody`, the saved `FlowSendContent`, saved notification bodies, and the Slack, Discord and Teams cards. `planCardText` and `proposalPreview` produce the new layout only for `channel === "telegram"`.
- Status lines are added only after the server confirms the outcome: `decided.ok`, `chosen.ok`, `answered.ok`, or the merge result from GitHub.

## Proof

- `src/telegram-cards.test.ts` (new) sends each card through `bridgePass` against a scripted Bot API, then taps it. It asserts the exact new text and button order, callback forms and bytes, 4,096-character fitting, and that the records are unchanged. It also covers long and maximum-length cases (a split recap, six 500-character options with Cancel staying in one message, a 12,000-character draft) and cards sent before this change. `test/telegram-script.ts` holds the shared scripted transport.
- With `TELEGRAM_CARDS_OUT=<file>`, the same test writes every card state it sees. The baseline was captured on the unchanged source (`before.json`) and again after the change (`after.json`).
- `node scripts/telegram-cards-proof.mjs evidence/telegram-cards/before.json evidence/telegram-cards/after.json` draws those exact texts and buttons as chat bubbles in headless Chrome at 1280px and 390px. It checks for sideways overflow, tap targets under 40px and cut-off button labels, and found none at either width (`evidence/telegram-cards/checks.json`).
- Screenshots are saved under `evidence/telegram-cards/` and are not committed. They are `desktop-screen-decisions.png` (1280px, before and after), `phone-screen-decisions.png` and `phone-screen-plan-proposal.png` (390px, after), plus full-page `desktop-before-after.png`, `phone-before.png`, `phone-after.png` and `phone-after-sent.png`. They are labelled as fixture previews, not the Telegram app.

## Checks run (on this working tree, uncommitted, base `a5d0c08`)

- `npx vitest run src/telegram.test.ts src/chat-decide.test.ts src/telegram-mate.test.ts src/flow-send.test.ts src/flow-items.test.ts src/telegram-flow.test.ts src/telegram-team.test.ts src/slack.test.ts src/discord.test.ts src/teams.test.ts src/telegram-cards.test.ts`: every file passed. The 7 assertions that failed on the first run expected the old Telegram wording and were updated. Slack, Discord, Teams, telegram-mate and telegram-team passed without changes.
- `npm run typecheck`: passed.
- `npm test`, run once at the end: **failed**, with 30 failed, 4956 passed and 28 skipped tests (4 failed files out of 333). The failing files were `src/coding-provider.test.ts`, `src/exec.held.test.ts`, `src/mcp-cli.test.ts` and `src/task-control-adversarial.test.ts`. The errors say Codex process cleanup could not be verified, a command exited with code 126, a process group was missing, and a `0600` mode check failed. These four files fail the same way when run on their own. None of them imports the changed Telegram, chat or flow modules, and this change touches no process, exec or credential code. That points to the build sandbox rather than this change, but they were not run on the base commit, so this is an inference. The output was saved to `evidence/telegram-cards/npm-test.txt` and `unrelated-rerun.txt` (not committed).

## Limitations

- No physical-device or live-bot trial was run. Telegram's own font, wrapping and inline-button truncation may differ from the preview.
- The pull-request card still says "Merge it from the task." above its Merge button. Those words come from the pull-request notification, which is outside the Telegram presentation code this change touched (follow-up).
- The flow-approval card shows the draft as the card holds it when the card is sent (Approve acts on that draft), rather than the saved notice's copy.

## Exact before and after (from fixtures)

Tokens are masked as `<n hex>`. `url` marks a link button opened under the trusted console origin.

### Parked decision — sent

**Before**

```text
alpha · Decision needed

The payout guard needs a policy call before the release.

Q: Fail open or fail closed?

[open] Fail open
    Bad payouts slip through until the guard is fixed.
[closed] Fail closed  (recommended)  — IRREVERSIBLE
    Queued payouts are dropped and can't be replayed.

deadline: 2026-10-04T17:00:00.000Z
```

Buttons: [Fail open] `<32 hex>`<br>[Fail closed ✓ ⚠] `<32 hex>`

**After**

```text
alpha · Decide: Fail open or fail closed?
• Fail open: Bad payouts slip through until the guard is fixed.
• Fail closed (recommended) ⚠ can't be undone: Queued payouts are dropped and can't be replayed.
Decide by 2026-10-04 17:00 UTC

Background: The payout guard needs a policy call before the release.
```

Buttons: [Fail open] `<32 hex>`<br>[Fail closed ✓ ⚠] `<32 hex>`

### Parked decision — armed (can't be undone)

**Before**

```text
⚠ Fail closed is IRREVERSIBLE.
Queued payouts are dropped and can't be replayed.

Confirm?
```

Buttons: [⚠ Yes, Fail closed] `<32 hex>`<br>[Cancel] `<32 hex>`

**After**

```text
Fail closed? ⚠ This can't be undone.
Queued payouts are dropped and can't be replayed.
```

Buttons: [⚠ Yes, Fail closed] `<32 hex>`<br>[Cancel] `<32 hex>`

### Parked decision — after Cancel

**Before**

```text
Q: Fail open or fail closed?
```

Buttons: [Fail open] `<32 hex>`<br>[Fail closed ✓ ⚠] `<32 hex>`

**After**

```text
Decide: Fail open or fail closed?
• Fail open: Bad payouts slip through until the guard is fixed.
• Fail closed (recommended) ⚠ can't be undone: Queued payouts are dropped and can't be replayed.
Decide by 2026-10-04 17:00 UTC
```

Buttons: [Fail open] `<32 hex>`<br>[Fail closed ✓ ⚠] `<32 hex>`

### Parked decision — answered

**Before**

```text
✓ payout-1 — answered: open
by bob via telegram
```

Buttons: (no buttons)

**After**

```text
✓ Answered: Fail open
payout-1 · by bob via telegram
```

Buttons: (no buttons)

### Parked decision, long recap — part 1 of 2

**Before**

```text
alpha · Decision needed

The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call.
```

Buttons: (no buttons)

**After**

```text
alpha · Decide: Fail open or fail closed?
• Fail open: Bad payouts slip through until the guard is fixed.
• Fail closed (recommended) ⚠ can't be undone: Queued payouts are dropped and can't be replayed.

Background: The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call
```

Buttons: (no buttons)

### Parked decision, long recap — part 2 of 2

**Before**

```text
 The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call.

Q: Fail open or fail closed?

[open] Fail open
    Bad payouts slip through until the guard is fixed.
[closed] Fail closed  (recommended)  — IRREVERSIBLE
    Queued payouts are dropped and can't be replayed.
```

Buttons: [Fail open] `<32 hex>`<br>[Fail closed ✓ ⚠] `<32 hex>`

**After**

```text
. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call. The payout guard needs a policy call.
```

Buttons: [Fail open] `<32 hex>`<br>[Fail closed ✓ ⚠] `<32 hex>`

### Plan approval — sent

**Before**

```text
Plan ready: Refuse over-limit payouts

Refuse over-limit payouts.
Keep the public API unchanged.

Changes:
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.

You're allowing: file edits and routine commands; anything risky stops · up to $2.00 per attempt
```

Buttons: [Approve & start] `d:<24 hex>`<br>[Edit ↗] `url` [Not now] `d:<24 hex>`

**After**

```text
Plan ready: Refuse over-limit payouts
Starting allows: file edits and routine commands; anything risky stops · up to $2.00 per attempt

Refuse over-limit payouts.
Keep the public API unchanged.
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.
```

Buttons: [Approve & start] `d:<24 hex>`<br>[Edit ↗] `url` [Not now] `d:<24 hex>`

### Plan approval — armed

**Before**

```text
Plan ready: Refuse over-limit payouts

Refuse over-limit payouts.
Keep the public API unchanged.

Changes:
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.

You're allowing: file edits and routine commands; anything risky stops · up to $2.00 per attempt

Approve and start "Refuse over-limit payouts"?
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

**After**

```text
Plan ready: Refuse over-limit payouts
Starting allows: file edits and routine commands; anything risky stops · up to $2.00 per attempt

Refuse over-limit payouts.
Keep the public API unchanged.
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.

Approve and start "Refuse over-limit payouts"?
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

### Plan approval — after Cancel

**Before**

```text
Plan ready: Refuse over-limit payouts

Refuse over-limit payouts.
Keep the public API unchanged.

Changes:
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.

You're allowing: file edits and routine commands; anything risky stops · up to $2.00 per attempt
```

Buttons: [Approve & start] `d:<24 hex>`<br>[Edit ↗] `url` [Not now] `d:<24 hex>`

**After**

```text
Plan ready: Refuse over-limit payouts
Starting allows: file edits and routine commands; anything risky stops · up to $2.00 per attempt

Refuse over-limit payouts.
Keep the public API unchanged.
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.
```

Buttons: [Approve & start] `d:<24 hex>`<br>[Edit ↗] `url` [Not now] `d:<24 hex>`

### Plan approval — approved

**Before**

```text
Plan ready: Refuse over-limit payouts

Refuse over-limit payouts.
Keep the public API unchanged.

Changes:
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.

You're allowing: file edits and routine commands; anything risky stops · up to $2.00 per attempt

✓ Approved under your chat approval mode. Work starts when a worker is free.
```

Buttons: (no buttons)

**After**

```text
Plan ready: Refuse over-limit payouts
Starting allows: file edits and routine commands; anything risky stops · up to $2.00 per attempt

Refuse over-limit payouts.
Keep the public API unchanged.
Only in: src/guard.ts

Done when:
• Over-limit payouts are refused.
• Refusals are logged with the payout id.

✓ Approved under your chat approval mode. Work starts when a worker is free.
```

Buttons: (no buttons)

### Result — sent

**Before**

```text
Keep the guard readable is ready. Your tests passed. Accept and finish it?
```

Buttons: [Accept and finish] `d:<24 hex>` [Request changes] `d:<24 hex>`<br>[Look first ↗] `url`

**After**

```text
Keep the guard readable is ready. Your tests passed. Accept and finish it?
```

Buttons: [Accept and finish] `d:<24 hex>` [Request changes] `d:<24 hex>`<br>[Look first ↗] `url`

### Result — armed

**Before**

```text
Keep the guard readable is ready. Your tests passed. Accept and finish it?

Accept and finish "Keep the guard readable"?
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

**After**

```text
Keep the guard readable is ready. Your tests passed. Accept and finish it?

Accept and finish "Keep the guard readable"?
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

### Result — finished

**Before**

```text
Keep the guard readable is ready. Your tests passed. Accept and finish it?

✓ Accepted and finished. The recorded checks are unchanged.
```

Buttons: (no buttons)

**After**

```text
Keep the guard readable is ready. Your tests passed. Accept and finish it?

✓ Accepted and finished. The recorded checks are unchanged.
```

Buttons: (no buttons)

### Failed task — sent

**Before**

```text
alpha · Guard the payout path stalled after 3 straight failures

The last attempt failed its checks.
```

Buttons: [Retry] `d:<24 hex>`<br>[Look first ↗] `url`

**After**

```text
alpha · Guard the payout path stalled after 3 straight failures

The last attempt failed its checks.
```

Buttons: [Retry] `d:<24 hex>`<br>[Look first ↗] `url`

### Failed task — armed

**Before**

```text
alpha · Guard the payout path stalled after 3 straight failures

The last attempt failed its checks.

Retry "Guard the payout path"? It queues another attempt.
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

**After**

```text
alpha · Guard the payout path stalled after 3 straight failures

The last attempt failed its checks.

Retry "Guard the payout path"? It queues another attempt.
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

### Failed task — queued again

**Before**

```text
alpha · Guard the payout path stalled after 3 straight failures

The last attempt failed its checks.

✓ Queued again. Existing approvals and holds still apply.
```

Buttons: (no buttons)

**After**

```text
alpha · Guard the payout path stalled after 3 straight failures

The last attempt failed its checks.

✓ Queued again. Existing approvals and holds still apply.
```

Buttons: (no buttons)

### Pull request — sent

**Before**

```text
alpha · Ready to merge: Keep the guard readable (PR #3)

Checks passed on aaaaaaaaaaaa. Merge it from the task.
```

Buttons: [Merge] `d:<24 hex>`<br>[Look first ↗] `url`

**After**

```text
alpha · Ready to merge: Keep the guard readable (PR #3)

Checks passed on aaaaaaaaaaaa. Merge it from the task.
```

Buttons: [Merge] `d:<24 hex>`<br>[Look first ↗] `url`

### Pull request — armed

**Before**

```text
alpha · Ready to merge: Keep the guard readable (PR #3)

Checks passed on aaaaaaaaaaaa. Merge it from the task.

Merge "Keep the guard readable"?
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

**After**

```text
alpha · Ready to merge: Keep the guard readable (PR #3)

Checks passed on aaaaaaaaaaaa. Merge it from the task.

Merge "Keep the guard readable"?
```

Buttons: [Yes] `d:<24 hex>` [Cancel] `d:<24 hex>`

### Pull request — merged

**Before**

```text
alpha · Ready to merge: Keep the guard readable (PR #3)

Checks passed on aaaaaaaaaaaa. Merge it from the task.

✓ Merged.
```

Buttons: (no buttons)

**After**

```text
alpha · Ready to merge: Keep the guard readable (PR #3)

Checks passed on aaaaaaaaaaaa. Merge it from the task.

✓ Merged.
```

Buttons: (no buttons)

### Proposal: new task — sent

**Before**

```text
Create task in alpha: Log refused payouts
Goal: Write one line per refused payout with its id and the limit it passed.
Not: Change the limit itself.

Confirm files it. You still approve its scope before work starts.

Confirm or Dismiss below. Nothing changes until you confirm.
```

Buttons: [Confirm] `<32 hex>` [Dismiss] `<32 hex>`

**After**

```text
Create task in alpha: Log refused payouts
Confirm files it. You still approve its scope before work starts.

Goal: Write one line per refused payout with its id and the limit it passed.
Not: Change the limit itself.
```

Buttons: [Confirm] `<32 hex>` [Dismiss] `<32 hex>`

### Proposal: irreversible answer — sent

**Before**

```text
Answer decision #1 on Guard the payout path with "Fail closed"
Q: Fail open or fail closed?
  Fail open: Requests pass while the check is down
→ Fail closed — IRREVERSIBLE (the builder recommends this): Requests are refused; a rollback restores them
Why: Safer while the guard is new.

⚠ This choice is irreversible. Confirming asks you once more.

Confirm or Dismiss below. Nothing changes until you confirm.
```

Buttons: [Confirm] `<32 hex>` [Dismiss] `<32 hex>`

**After**

```text
Answer decision #1 on Guard the payout path with "Fail closed"
⚠ This choice can't be undone. Confirming asks you once more.

Q: Fail open or fail closed?
  Fail open: Requests pass while the check is down
→ Fail closed ⚠ can't be undone (the builder recommends this): Requests are refused; a rollback restores them
Why: Safer while the guard is new.
```

Buttons: [Confirm] `<32 hex>` [Dismiss] `<32 hex>`

### Proposal: irreversible answer — armed

**Before**

```text
⚠ This answer is IRREVERSIBLE.

Answer decision #1 on Guard the payout path with "Fail closed"
Q: Fail open or fail closed?
  Fail open: Requests pass while the check is down
→ Fail closed — IRREVERSIBLE (the builder recommends this): Requests are refused; a rollback restores them
Why: Safer while the guard is new.

⚠ This choice is irreversible. Confirming asks you once more.

Confirm?
```

Buttons: [⚠ Yes, answer it] `<32 hex>`<br>[Cancel] `<32 hex>`

**After**

```text
Answer decision #1 on Guard the payout path with "Fail closed"
⚠ This choice can't be undone. Confirming asks you once more.

Q: Fail open or fail closed?
  Fail open: Requests pass while the check is down
→ Fail closed ⚠ can't be undone (the builder recommends this): Requests are refused; a rollback restores them
Why: Safer while the guard is new.

⚠ Last step: this answer can't be undone. Confirm?
```

Buttons: [⚠ Yes, answer it] `<32 hex>`<br>[Cancel] `<32 hex>`

### Proposal: irreversible answer — after Cancel

**Before**

```text
Answer decision #1 on Guard the payout path with "Fail closed"
Q: Fail open or fail closed?
  Fail open: Requests pass while the check is down
→ Fail closed — IRREVERSIBLE (the builder recommends this): Requests are refused; a rollback restores them
Why: Safer while the guard is new.

⚠ This choice is irreversible. Confirming asks you once more.

Confirm or Dismiss below. Nothing changes until you confirm.
```

Buttons: [Confirm] `<32 hex>` [Dismiss] `<32 hex>`

**After**

```text
Answer decision #1 on Guard the payout path with "Fail closed"
⚠ This choice can't be undone. Confirming asks you once more.

Q: Fail open or fail closed?
  Fail open: Requests pass while the check is down
→ Fail closed ⚠ can't be undone (the builder recommends this): Requests are refused; a rollback restores them
Why: Safer while the guard is new.
```

Buttons: [Confirm] `<32 hex>` [Dismiss] `<32 hex>`

### Proposal: irreversible answer — answered

**Before**

```text
✓ decision #1 answered: Fail closed
```

Buttons: (no buttons)

**After**

```text
✓ decision #1 answered: Fail closed
```

Buttons: (no buttons)

### Flow approval — sent

**Before**

```text
alpha · Support: Refund for order 42? needs alex's decision

Check the reply: approve this draft to send it as written, edit it, or send it back with a note.

Hi Sam, we refunded order 42 today. It reaches your card in 3–5 working days.
```

Buttons: [✅ Approve] `<32 hex>`<br>[✏️ Edit] `<32 hex>` [↩️ Send back] `<32 hex>`<br>[Open console ↗] `url`

**After**

```text
alpha · Approve “Refund for order 42?”
Approve → Post it · Send back → Write the reply, with your note

Draft:
Hi Sam, we refunded order 42 today. It reaches your card in 3–5 working days.

Support · Check the reply
```

Buttons: [✅ Approve] `<32 hex>`<br>[✏️ Edit] `<32 hex>` [↩️ Send back] `<32 hex>`<br>[Open console ↗] `url`

### Flow approval — Edit asks for a reply

**Before**

```text
Send your version of the draft for “Refund for order 42?” as a reply to this message. It replaces the draft, and comes back here for you to approve.
```

Buttons: (no buttons)

**After**

```text
Send your version of the draft for “Refund for order 42?” as a reply to this message. It replaces the draft, and comes back here for you to approve.
```

Buttons: (no buttons)

### Flow approval — your version, back for a decision

**Before**

```text
Support: your version of the draft for “Refund for order 42?”

Hi Sam, we refunded order 42 today. Expect it within 5 working days.

Approve to send it as written.
```

Buttons: [✅ Approve] `<32 hex>`<br>[✏️ Edit] `<32 hex>` [↩️ Send back] `<32 hex>`

**After**

```text
Approve your version of “Refund for order 42?”
Approve → Post it · Send back → Write the reply, with your note

Draft:
Hi Sam, we refunded order 42 today. Expect it within 5 working days.

Support · Check the reply
```

Buttons: [✅ Approve] `<32 hex>`<br>[✏️ Edit] `<32 hex>` [↩️ Send back] `<32 hex>`

### Flow approval — approved

**Before**

```text
Support: your version of the draft for “Refund for order 42?”

Hi Sam, we refunded order 42 today. Expect it within 5 working days.

Approve to send it as written.

✅ You approved it. Approved. Moved to Post it.
```

Buttons: (no buttons)

**After**

```text
Approve your version of “Refund for order 42?”
Approve → Post it · Send back → Write the reply, with your note

Draft:
Hi Sam, we refunded order 42 today. Expect it within 5 working days.

Support · Check the reply

✅ Approved. Moved to Post it.
```

Buttons: (no buttons)

### Flow choice — sent

**Before**

```text
alpha · Fixes: Checkout rounding · Build

Totals now round half-up, with a regression test.

Choose one. Or reply with what you'd change.
```

Buttons: [Ship it] `<32 hex>`<br>[Ignore] `<32 hex>`<br>[Result ↗] `url` [Card ↗] `url`

**After**

```text
alpha · Choose what happens to “Checkout rounding”
Ship it → Ship · Ignore → closes the card · or reply → Build, with your note

Totals now round half-up, with a regression test.

Fixes · after Build
```

Buttons: [Ship it] `<32 hex>`<br>[Ignore] `<32 hex>`<br>[Result ↗] `url` [Card ↗] `url`

### Flow choice — chosen

**Before**

```text
alpha · Fixes: Checkout rounding · Build

Totals now round half-up, with a regression test.

Choose one. Or reply with what you'd change.

✅ You chose “Ship it”. Ship it. Moved to Ship.
```

Buttons: (no buttons)

**After**

```text
alpha · Choose what happens to “Checkout rounding”
Ship it → Ship · Ignore → closes the card · or reply → Build, with your note

Totals now round half-up, with a regression test.

Fixes · after Build

✅ Ship it. Moved to Ship.
```

Buttons: (no buttons)

