/**
 * What a provider itself reported about one call (docs/plans/evals-nightly.md, part B1): the exact model, its turn
 * count, its reported cost and its cache usage. Read only from the provider's own events and response bodies (Claude's
 * session `system`/`init` and primary `result`, Codex's `turn.completed`, an API's response body), never from text an
 * agent or a candidate wrote. Anything unreported or malformed is unknown (null), never 0.
 *
 * Three amounts are kept apart and never summed into one number: API dollars (work billed by use, with a reported or
 * priced cost), subscription usage (the provider's own reported cost of work a plan covers: not billed), and unknown.
 */
import { usageOf } from "./run-efficiency.js";
import type { Billing } from "./spend.js";

/** A model id as a provider reports it: printable ASCII with no spaces, at most 200 characters. Anything else is
 * unknown, never trimmed into something that could read as a different model. */
const MODEL_ID = /^[\x21-\x7e]{1,200}$/;
/** Several reported models are kept as their sorted ids joined by this (it has spaces, so no one id can equal it):
 * a run whose calls ran different models never reads as any one of them. */
export const MODELS_JOIN = " + ";

export function reportedModelOf(value: unknown): string | null {
  return typeof value === "string" && MODEL_ID.test(value) ? value : null;
}

/** The one model a Claude result's `modelUsage` names; null when it names none, several, or anything malformed. */
export function soleReportedModel(modelUsage: unknown): string | null {
  if (typeof modelUsage !== "object" || modelUsage === null || Array.isArray(modelUsage)) return null;
  const keys = Object.keys(modelUsage);
  return keys.length === 1 ? reportedModelOf(keys[0]) : null;
}

/** Two reports of the same piece of work (a resumed turn, a second init): unknown if either is, the model when they
 * agree, otherwise every model named, sorted (never one chosen). */
export function combineReportedModels(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  if (a === b) return a;
  return [...new Set([...a.split(MODELS_JOIN), ...b.split(MODELS_JOIN)])].sort().join(MODELS_JOIN);
}

export function providerTurnsOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function reportedCostUsdOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One provider call's own report. `tokensIn` is everything the model read (cached included) when the provider
 * reported every part of it (run-efficiency.ts usageOf), else null. */
export type ProviderReport = {
  modelReported: string | null;
  providerTurns: number | null;
  reportedCostUsd: number | null;
  tokensIn: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/** What the session's own `system`/`init` events named: the one model they agree on, or that they disagree. */
export type ClaudeInitModel = { model: string | null; conflict: boolean };

/** A Claude primary `result` (streamed or buffered `--output-format json`), with what the session's inits named. The
 * init's model is the session's own; inits that disagree leave it unknown; with no init naming one, the result's
 * `modelUsage` counts only when it names exactly one model. */
export function claudeResultReport(result: Record<string, unknown>, init: ClaudeInitModel = { model: null, conflict: false }): ProviderReport {
  const usage = usageOf({ provider: "claude", model: null, tokensIn: null, tokensOut: null, usageJson: usageJsonOf(result["usage"]) });
  return {
    modelReported: init.conflict ? null : init.model ?? soleReportedModel(result["modelUsage"]),
    providerTurns: providerTurnsOf(result["num_turns"]),
    reportedCostUsd: reportedCostUsdOf(result["total_cost_usd"]),
    tokensIn: usage.in,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

/** Codex's `turn.completed` usage: its input already counts what came from cache; it reports no cache writes, no
 * model and no cost in `exec --json`, so those stay unknown. */
export function codexUsageReport(usage: unknown): ProviderReport {
  const read = usageOf({ provider: "codex", model: null, tokensIn: null, tokensOut: null, usageJson: usageJsonOf(usage) });
  return { modelReported: null, providerTurns: null, reportedCostUsd: null, tokensIn: read.in, cacheReadTokens: read.cacheRead, cacheWriteTokens: null };
}

function usageJsonOf(usage: unknown): string | null {
  return typeof usage === "object" && usage !== null && !Array.isArray(usage) ? JSON.stringify(usage) : null;
}

/** One of the three amounts, never added to another. */
export type ReportedAmount =
  | { kind: "api"; microusd: number }
  /** The provider's own reported cost of work a subscription covers: usage, not billed (null: it reported none). */
  | { kind: "subscription"; reportedUsd: number | null }
  | { kind: "unknown" };

/** A run's amount, from its fixed billing and its priced spend (run_spend). Subscription work reads its provider's
 * reported cost as usage, never as dollars; billed work without a reported or priced cost is unknown. v141 (Codex
 * round 1 #4, #10): billing this computer's default guessed (`basis` not evidence) is unknown, and so is a run whose
 * cost the provider never reported (its `cost_usd` then holds a conservative charge, never a measurement). */
export function runAmountOf(run: { billing: Billing | null; spendMicrousd: number | null; costUsd: number | null; basis?: "evidence" | "default" | null; costUnknown?: boolean }): ReportedAmount {
  if (run.basis !== undefined && run.basis !== "evidence") return { kind: "unknown" };
  if (run.costUnknown === true) return { kind: "unknown" };
  if (run.billing === "subscription") return { kind: "subscription", reportedUsd: reportedCostUsdOf(run.costUsd) };
  if (run.billing === "api-key" && run.spendMicrousd !== null && Number.isSafeInteger(run.spendMicrousd) && run.spendMicrousd >= 0) {
    return { kind: "api", microusd: run.spendMicrousd };
  }
  return { kind: "unknown" };
}

const SUBSCRIPTION_CHAT = new Set(["claude-subscription", "codex-subscription"]);

/** A chat request's amount: a subscription chat's reported cost is usage; an API chat's settled charge is dollars,
 * unless its spend is unknown (then the amount is, whatever was settled against the reservation). v141 (Codex round 1
 * #4): a subscription harness's request is subscription usage only when its own events said it was billed to the plan
 * (`billingReported`); one they said used a key is API dollars at its reported cost; one they said nothing of is
 * unknown. Absent `billingReported` keeps the older reading for callers that predate it. */
export function chatTurnAmountOf(turn: { provider: string; settledMicrousd: number | null; unknownSpend: boolean; reportedCostUsd: number | null; billingReported?: "subscription" | "api-key" | null }): ReportedAmount {
  if (SUBSCRIPTION_CHAT.has(turn.provider)) {
    if (turn.billingReported === undefined || turn.billingReported === "subscription") return { kind: "subscription", reportedUsd: reportedCostUsdOf(turn.reportedCostUsd) };
    const cost = reportedCostUsdOf(turn.reportedCostUsd);
    return turn.billingReported === "api-key" && cost !== null ? { kind: "api", microusd: Math.round(cost * 1_000_000) } : { kind: "unknown" };
  }
  if (turn.unknownSpend || turn.settledMicrousd === null || !Number.isSafeInteger(turn.settledMicrousd) || turn.settledMicrousd < 0) return { kind: "unknown" };
  return { kind: "api", microusd: turn.settledMicrousd };
}
