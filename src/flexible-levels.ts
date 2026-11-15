/**
 * Which level each agent may run a Flexible thread at (the Flexible plan v2 §4 and §5, with the owner's round-2
 * decisions and Codex round 2 item 3; slice F2c): the proven matrix, and `threadLevelAllowed`, the one check every turn
 * admission and every thread start makes.
 *
 * A level is offered only where Toolroll has a proven way to enforce it for that agent, and never above the
 * organisation's ceiling (safe → Supervised only, and only where that agent's Supervised is proven to ask before every
 * command and file change; standard → Supervised and Auto; escalated → all three). A ceiling is never traded for a
 * different level silently: an over-ceiling or unproven level is refused with the words.
 *
 * What each agent's levels mean here (§4): Full access removes the agent's own permission prompts inside the thread's
 * fence only (Claude `--permission-mode bypassPermissions`, Gemini `--approval-mode yolo`); the fence, the credential
 * split and the proxy-only network are the same at every level. Supervised and Auto depend on delivering the agent's
 * permission requests to the person, a channel no agent has proven yet (F0-F, F2d), so they are off for every agent.
 * Codex can't hold the thread fence in its own sandbox (flexible-thread.ts flexibleThreadCodexProfile), and OpenRouter
 * runs on the Codex harness, so both stay refused until a Codex thread runs inside the sandbox runtime as an outer
 * boundary (enable gate 3). Gemini's turns aren't recordable yet (thread_turn names Claude and Codex) and it has no
 * relay route: it isn't offered until both exist.
 */
import type { FlexibleLevel } from "./flexible.js";
import { FLEXIBLE_LEVEL_WORDS } from "./flexible.js";
import type { PermissionLevel } from "./policy.js";

export type FlexibleLevelAgent = "claude" | "codex" | "gemini" | "openrouter";
export type ProvenLevel =
  | { offered: true; how: string; asksBeforeEveryAction?: true }
  | { offered: false; why: string };
export type FlexibleProvenMatrix = Readonly<Record<FlexibleLevelAgent, Readonly<Record<FlexibleLevel, ProvenLevel>>>>;

const off = (why: string): ProvenLevel => ({ offered: false, why });
const NO_CHANNEL = "its permission requests can't reach you yet, so this level can't ask you anything";
const CODEX = "Codex's own sandbox can't keep a Flexible thread away from threads and files made after it starts";
const OPENROUTER = "OpenRouter runs on the Codex harness, whose own sandbox can't keep a Flexible thread away from threads and files made after it starts";
const GEMINI = "Gemini's turns can't be recorded yet and it has no sign-in relay";

/** The proven matrix (a constant: changing what is offered is a code change with its own attack rows). */
export const FLEXIBLE_PROVEN: FlexibleProvenMatrix = Object.freeze({
  claude: Object.freeze({
    supervised: off(NO_CHANNEL),
    auto: off(NO_CHANNEL),
    full: { offered: true, how: "Claude Code with --permission-mode bypassPermissions inside the thread's sandbox, signed in only through Toolroll's relay" } as ProvenLevel,
  }),
  codex: Object.freeze({ supervised: off(CODEX), auto: off(CODEX), full: off(CODEX) }),
  openrouter: Object.freeze({ supervised: off(OPENROUTER), auto: off(OPENROUTER), full: off(OPENROUTER) }),
  gemini: Object.freeze({ supervised: off(NO_CHANNEL), auto: off(NO_CHANNEL), full: off(GEMINI) }),
});

const AGENT_WORDS: Readonly<Record<FlexibleLevelAgent, string>> = Object.freeze({ claude: "Claude", codex: "Codex", gemini: "Gemini", openrouter: "OpenRouter" });
const RANK: Readonly<Record<FlexibleLevel, number>> = Object.freeze({ supervised: 0, auto: 1, full: 2 });
const TOP: Readonly<Partial<Record<PermissionLevel, FlexibleLevel>>> = Object.freeze({ safe: "supervised", standard: "auto", escalated: "full" });

export type ThreadLevelRefusal = { ok: false; reason: "above-ceiling" | "level-unavailable"; message: string };

/**
 * Whether a thread may run `agent` at `level` under the organisation's `policy` and the `proven` matrix. Refusals say
 * why in one line and what can be done.
 */
export function threadLevelAllowed(policy: { ceiling: PermissionLevel }, agent: FlexibleLevelAgent, level: FlexibleLevel, proven: FlexibleProvenMatrix = FLEXIBLE_PROVEN):
  { ok: true; how: string } | ThreadLevelRefusal {
  const entry = proven[agent]?.[level];
  const top = TOP[policy.ceiling];
  if (entry === undefined || RANK[level] === undefined) return { ok: false, reason: "level-unavailable", message: "That agent or level isn't one Toolroll knows. Nothing was started." };
  if (top === undefined || RANK[level] > RANK[top]) {
    return { ok: false, reason: "above-ceiling", message: `Your organisation's permission ceiling doesn't allow ${FLEXIBLE_LEVEL_WORDS[level]} threads. Nothing was started.` };
  }
  if (!entry.offered) return { ok: false, reason: "level-unavailable", message: `${AGENT_WORDS[agent]} threads can't run at ${FLEXIBLE_LEVEL_WORDS[level]}: ${entry.why}. Nothing was started.` };
  // At a safe ceiling only a Supervised proven to ask before every command and file change is allowed.
  if (policy.ceiling === "safe" && entry.asksBeforeEveryAction !== true) {
    return { ok: false, reason: "above-ceiling", message: `Your organisation's permission ceiling allows only a Supervised that asks before every step, and ${AGENT_WORDS[agent]}'s doesn't yet. Nothing was started.` };
  }
  return { ok: true, how: entry.how };
}
