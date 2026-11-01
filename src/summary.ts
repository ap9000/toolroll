/**
 * A window of runs, tallied — one arithmetic, shared by the CLI brief and
 * the web console so the two can never disagree about what a stretch of
 * unattended work cost.
 *
 * Economics are measured, never asserted: every provider spawn stamps its
 * run before spending, so `invoked` is the complete population; `measured`
 * is the subset whose envelopes actually reported cost, and the gap between
 * them is named by callers instead of summed as zero.
 */

import type { Run } from "./store.js";

export type RunTally<T extends Run> = {
  built: T[];
  failed: T[];
  refused: T[];
  /** Runs that never finished — the process died with them. Also an answer. */
  cutDown: T[];
  invoked: T[];
  measured: T[];
  spend: number;
  tokens: number;
};

export function tally<T extends Run>(runs: T[]): RunTally<T> {
  const invoked = runs.filter(one => one.providerStartedAt !== null);
  const measured = invoked.filter(one => one.costUsd !== null);
  return {
    built: runs.filter(one => one.outcome === "built" || one.outcome === "no-change"),
    failed: runs.filter(one => one.outcome === "failed"),
    refused: runs.filter(one => one.outcome === "refused"),
    cutDown: runs.filter(one => one.outcome === null),
    invoked,
    measured,
    spend: measured.reduce((sum, one) => sum + (one.costUsd ?? 0), 0),
    tokens: invoked
      .filter(one => one.tokensOut !== null)
      .reduce((sum, one) => sum + (one.tokensOut ?? 0) + (one.tokensIn ?? 0), 0),
  };
}

/**
 * Provider harnesses do not all mean the same thing when they report a
 * dollar figure. Claude Code includes `total_cost_usd` in its result even
 * when it authenticated with a paid membership. In that case the number is
 * useful as an API-price equivalent for comparing work, but it is not API
 * key spend and must never be presented as a separate charge.
 */
export function runCostWords(run: Pick<Run, "authMode" | "costUsd" | "tokensIn" | "tokensOut">, live = false): string {
  // An ACP agent signs in its own way and reports no price Toolroll trusts.
  if (run.authMode === "agent-login") return live ? "the agent's own sign-in · in progress" : "the agent's own sign-in · cost not measured";
  if (run.authMode === "subscription") {
    return run.costUsd === null
      ? live
        ? "subscription usage in progress"
        : "subscription · no API-key spend"
      : `subscription · $${run.costUsd.toFixed(2)} API-price equivalent (not an API charge)`;
  }
  if (run.costUsd !== null) {
    return run.authMode === "api-key" ? `$${run.costUsd.toFixed(2)} API-key usage` : `$${run.costUsd.toFixed(2)}`;
  }
  return run.tokensIn !== null || run.tokensOut !== null
    ? "dollar cost unmeasured — this provider reports tokens, not prices"
    : live
      ? "usage in progress"
      : "unmeasured";
}

/** The spend line, one wording everywhere. */
export function spendLine(summary: RunTally<Run>): string {
  if (summary.invoked.length === 0) return "nothing — no provider was invoked";
  const subscription = summary.measured.filter(one => one.authMode === "subscription");
  const metered = summary.measured.filter(one => one.authMode !== "subscription");
  const subscriptionEquivalent = subscription.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
  const meteredSpend = metered.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
  if (subscription.length > 0) {
    const money = [
      ...(metered.length > 0 ? [`$${meteredSpend.toFixed(4)} API-key usage`] : []),
      `$${subscriptionEquivalent.toFixed(4)} API-price equivalent from ${subscription.length} subscription invocation(s) — not an API charge`,
    ].join(" · ");
    const unmeasured = summary.invoked.length - summary.measured.length;
    return `${money} · ${summary.tokens.toLocaleString()} tokens${unmeasured === 0 ? "" : ` · ${unmeasured} invocation(s) unmeasured`}`;
  }
  const dollars = `$${summary.spend.toFixed(4)}`;
  return summary.measured.length === summary.invoked.length
    ? `${dollars} · ${summary.tokens.toLocaleString()} tokens, measured across all ${summary.invoked.length} invocation(s)`
    : `${dollars} measured across ${summary.measured.length}/${summary.invoked.length} invocation(s) — ${summary.invoked.length - summary.measured.length} unmeasured`;
}
