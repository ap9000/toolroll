# Explicit learning assessment

## What was missing

The previous reviewer prompt said “consider” optional learning. Both omission and `learning: []` were accepted without a decision summary. The actual date-fix review returned an empty array; the controller did not drop a lesson. There was no observable distinction between a deliberate no-lesson decision and skipping assessment.

## What changed

The **existing reviewer** now performs a learning check after judging the result, in the **same call**:

1. Does the supplied evidence show a reusable pitfall, convention, correction, or approach?
2. What should a different future task do differently?
3. Is that already covered by the supplied code, tests, instructions, or lessons?

It returns `learningAssessment: { decision: "propose" | "none", reason }` and zero to two suggestions. The reason is a concise public decision summary, not a reasoning transcript. New Claude review output requires both fields in its existing structured schema; other review providers receive the same prompt. No additional reviewer, scheduler, database schema, model call, time limit, automatic adoption, or success criterion was added.

The controller checks decision type, bounded non-secret reason, and consistency with suggestions. It atomically records the assessment with optional capture in the existing append-only ledger. Invalid decisions cannot publish suggestions; missing assessment is explicitly **unassessed**, not “none.” Core review remains strict and independent: optional missing/invalid assessment never triggers extra correction calls or turns valid task completion into failure. Failed storage retries from the sealed response, without changing a recorded decision on replay. Previously recorded captures are not retroactively relabelled as assessed.

Settings → Learning uses **No lesson needed**, **Learning suggested**, **Learning not assessed**, or **Learning assessment invalid**. The reason stays under Details. A proposal still needs source validation and explicit adoption; an assessment is not evidence of improved output.

## Verification

- Runtime code committed as **`47cee6aba8bc64ab4f42048a1b25d751ab86a773`** on `codex/review-learning`.
- Final `npm run typecheck` and `npx vitest run src/project-learning.test.ts src/provider.test.ts src/reviewer.test.ts`: **183 passed / three files**, build completed through the existing test setup. Includes actual reviewer invocation with a proposed assessment, explicit none, missing/invalid decisions, contradictions suppressing suggestions, secret filtering, atomic-write failure recovery, and replay immutability. No tests skipped or limits changed.
- A real isolated follow-up task, `learning-date-followup`, used Astra builder **7** and Opus reviewer **8**, both subscription-authenticated. Builder candidate **`442ca30e365de9eb81e2283a0500ea9b8f20ded7`**, native `npm test` **15 passed**, review **verified** (three comments, one judgment). This validates the review flow, not an independent review of the Standing Orders patch.
- The sealed response `evidence/8/reviewer-response-1.txt` explicitly returned `learningAssessment.decision="none"` and the reason: **“Small, clean run with no pitfalls, corrections, or conventions beyond this task; nothing repeatable to record.”** The optional array was empty. Ledger event **11** records the same decision and reason with reviewer run 8; nothing was inferred from an empty array.
- Playwright inspected Settings → Learning at **390×844** and **1400×900**. The new **No lesson needed** entry keeps its reason under Details. Actual images: `output/playwright/learning-assessment-phone.png` and `output/playwright/learning-assessment-desktop.png`. Both were visually inspected; desktop document overflow check passed. Existing layout/CSS is unchanged. Physical phone/Windows acceptance is not claimed.
- Product-wide final gate and independent review of this patch remain pending. No push, release, or intentional deployment was performed. The private pilot runner was retired and its preview stopped after verification.

## Installation side effect discovered during final checks

The real installed database was found at **v58**, not the expected v57, at approximately 03:31 UTC September 15. Do not claim the installed state remained unchanged. `PRAGMA quick_check` returned `ok`; the latest real run remains 1599, with no new real build/review in this experiment. This is not a controlled deployment or proof that all installed components are compatible.

The auto-restarting LaunchAgent `com.standing-orders.watch.<user>-documents-standing-orders` targets this checkout's **dist/cli.js**. Its log repeatedly says **that token does not match**, launchd reports exit 3, and `src/operate.ts` opens the migrating store **before** dispatching watch/token validation. Rebuilding this shared checkout exposed the new schema runtime to that watcher; this is the identified migration path, although the exact migrating process invocation was not captured. Tests use disposable state, and explicit pilot commands target the private database.

No downgrade, backup restore, token rotation, worker restart, or installed configuration change was attempted. The authenticated older preview still served Settings; installed-port checks redirected to login and do not establish installed health. Repairing the installed worker and separating its runtime from development builds requires operator approval. Future development builds should use an isolated checkout until that coupling is fixed.
