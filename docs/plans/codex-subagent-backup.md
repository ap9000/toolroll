# Codex backup for AI teammates

Owner decision, 2026-11-19: add Codex as a backup for Maya and Rosa while Claude is unavailable. This is the bounded exception to the AI-teammate feature freeze; unrelated capability remains frozen.

Claude stays primary. Each teammate starts with its backup off. A person enables an exact Codex model in that teammate's Settings, with the existing password proof checked inside the write transaction. Settings explain that card data, memory and tool results go to Codex through the machine's ChatGPT sign-in. Chat links to this control; it cannot silently enable a new provider.

Only a missing Claude executable or a structured first-party usage-limit refusal can admit a backup. Authentication/policy failures, malformed decisions, uncertain completions and timeouts cannot switch providers. A live Codex ChatGPT sign-in is required; key/ambiguous/failed sign-in proofs refuse. The backup reuses the no-tools, no-project-config, ephemeral structured subscription transport and the original turn deadline. The unchanged turn schema and zone/tool approval rules judge the response.

Each provider attempt is reserved and counted before dispatch. Opted-in teammates preserve the stricter of their existing action/tool-call count and model-attempt count, so enabling/disabling cannot erase today's use. A failed primary remains visible. The backup is linked uniquely to that eligible primary and card entry. Unfinished attempts remain counted and hold that card entry; they never become passing evidence. Provider, chosen/reported model and billing are recorded separately. Unreported money stays unknown.

A monotonic authority generation changes with relevant teammate settings/state/soul and organisation-policy changes. Admission binds it with the card entry, flow revision, model, daily cap and budget. Both providers' results recheck authority and deadline; resulting memory, decisions and tool-call admission share that check's transaction. Revoking and re-enabling does not revive an old answer. External tool calls remain under their existing guards.

Schema176 is additive: legacy teammates keep backup off and legacy turns read as Claude, settled, unlinked attempts. Focused migration tests cover saved rows, interrupted upgrade, and damaged current guards.

Verification records live under ignored evidence/failed-journeys-codex/. Earlier failed release and direct-run evidence is preserved. Focused checks and synthetic desktop/phone inspection do not replace independent security review, fresh CI or the normal exact-candidate approved Full release check. Physical-phone keyboard behaviour is unverified. Interactive attach mode stays disabled.
