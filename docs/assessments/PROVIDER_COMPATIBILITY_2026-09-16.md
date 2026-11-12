# Provider compatibility pass — 2026-09-16

## Result

Claude and Codex passed isolated live plan → build → verification → independent review workflows, plus subscription chat, image evidence and same-session resume checks. This is evidence for the exact routes below, not a guarantee for every model or provider combination.

Two chat issues were fixed on the audit branch. The new patch has focused verification, but has NOT passed its own final native gate/review or been deployed.

## Live matrix

Host: macOS arm64, Node 22.22.0. Installed CLIs: Claude 2.1.270, Codex 0.154.0, Gemini 0.57.0.

| Route | Live result | Limits |
| --- | --- | --- |
| Claude subscription, claude-fable-5-1 | Plan/build/machine gate/review passed; duplicate dispatch refused. Tool proposal, Unicode chat, synthetic image and exact-session resume passed. | One disposable task and one small image, not arbitrary repositories or image sizes. |
| Codex subscription, gpt-6-astra | Same successful checks as Claude. | Same limits. |
| Gemini API, requested gemini-3.8-flash → Claude review | Planning passed; build failed; review never reached. | Transcript reported daily quota exhaustion inside an agent tool. Recorded transcript model was gemini-3.5-flash, different from the requested route. NOT certified. |
| OpenRouter | No live run: no key configured. | Existing transport/fault tests do not certify a real model or account. |
| Direct Anthropic API chat | No live run: no API key configured. | Claude subscription success does not certify this separate API path. |
| Windows | Not run on a Windows host. | CI configuration and local stdin tests are not Windows certification. |
| Cross-provider review | Canary can now select a separate reviewer/model. | Attempted Gemini→Claude run stopped during build. No new successful mixed-provider certificate from this pass. |

Gemini is not supported as an independent reviewer; the canary refuses that route before creating a task. Switching provider/model/authentication is not an automatic remedy for an account failure.

## Fixes

1. **Reject unfinished or failed subscription chat output.** On the accepted baseline, injected valid proposals with failure terminal events and exit code zero were accepted by both subscription adapters. Claude now requires a successful result envelope. Codex requires exactly one completed turn and rejects failed, malformed or out-of-order output. A partial answer cannot authorize host tools.
2. **Deliver subscription chat prompts through stdin.** Both transports previously put the full prompt in argv. They now use the existing process-group runner with stdin support. Exact large Unicode delivery and closed-pipe refusal have regression tests; actual Claude and Codex chat calls passed. This removes that command-line-size dependency but is NOT a reproduced/fixed Windows certification claim.

Existing review authority, approval terms, native validation, process isolation and evidence checks were not loosened. No new agent timeout or test skips were introduced.

Canary improvement: `--review-provider` plus `--review-model` can certify an explicitly selected mixed workflow. Unsupported reviewer and incomplete option pairs fail before dispatch. Certificates identify the requested reviewer pair.

## Verification and candidate identity

- Baseline: `b2b396075ea95909e3f35210bb466abe57044369`, native builder 1665 / independent review 1666. Final gate: typecheck, 3,183 passed / 23 existing skips across 176 files, build passed; all three signed criteria upheld. This evidence covers b2 only.
- Production code patch: `3c74b5d9a6481ca7ab4089a0d4d71753c9e9a273` on `codex/provider-compatibility-audit-20260916`. Six focused suites passed 176 tests; typecheck passed. Canary argument guard added afterward passed its focused test.
- Additional direct-API fault coverage: two table-driven cases cover Anthropic/OpenRouter HTTP 401/429/503, connection failure and cancellation. All 17 converse tests plus typecheck passed after this addition.
- Fault checks are injected, not deliberate account exhaustion. Existing baseline tests cover session mismatch, malformed/oversized output, custody/provenance, large evidence ranges, replay and restart paths. They are not live account or Windows proof.
- No full-suite rerun was duplicated locally. The changed candidate still needs its own unchanged approved final gate and independent review.
- No GitHub push, npm release, credential-mode change or data cleanup occurred during this pass. The accepted formatting baseline `b2b396075ea95909e3f35210bb466abe57044369` was deployed at 2026-09-16T06:04:41.850Z; this chat patch is not deployed.

## Remaining issues, in order

1. Run the native final gate/review for the prepared chat patch before guarded deployment. Do not bundle the unaccepted Telegram candidate.
2. Resolve Gemini quota and actual-model identity. Its displayed failure was only a TERM warning, masking the useful quota detail. A local CLI source inspection found model resolution can substitute a Flash model under configuration flags; that is a possible explanation, not a proven cause for this run. Do not add a quota/fallback recognizer based on arbitrary model prose.
3. With restricted local keys, certify one explicit OpenRouter model and direct Anthropic API chat. Keep subscription configuration unchanged. Never paste keys in chat.
4. Run a successful mixed-provider build/review, then native Windows checks for prompt delivery, paths, process containment, restart and service launch.
5. Automatic quota fallback remains disabled/not live-certified. Fixture tests do not justify claiming seamless account switching. Large real-image/model-context combinations also remain unverified.

## Evidence

Local artifacts: `/tmp/standing-orders-provider-audit-ZPsedJ`.
- `claude-e2e.json`, `codex-e2e.json`: passed workflows on exact clean b2 runtime.
- `gemini-mixed-e2e.json`: failed mixed workflow on b2 plus then-uncommitted audit changes.
- `claude-subscription-chat.json`, `codex-subscription-chat.json`: successful tool envelope and Unicode requests after stdin change.
- `claude-review-smoke.json`, `codex-review-smoke.json`: synthetic image and exact-session resume, both true. These are not product review verdicts.
- `focused-final.log`: 176 tests; `stdin-before.log`: reproduced regression failures before runner support.
- Native baseline receipt: `~/.config/standing-orders/evidence/1665/verification-receipt.json`.

Temporary artifacts are retained locally, not published. The reusable canary is committed; reruns require local credentials and disposable state, not production projects.

Official references used to check transport behavior: [Codex non-interactive use](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex CLI controls](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Claude headless use](https://code.claude.com/docs/en/headless), [Gemini model identifier](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash). Documentation is not evidence that an account or CLI actually used a model.

