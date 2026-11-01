/**
 * Subscription limits (v105): how much of each plan's usage windows is used,
 * as the provider itself says. A subscription costs nothing per run, so these
 * windows (not dollars) are what bind it. Claude says on every turn (a
 * `rate_limit_event` in its stream: the 5-hour and weekly windows); Codex
 * answers when asked (its app server's `account/rateLimits/read`, which spends
 * nothing). The latest reading of each window is kept; the Tasks page shows
 * them beside the monthly budgets.
 */
import type { Billing } from "./spend.js";
import { topLevelEvent } from "./stream-scope.js";

export type LimitWindow = { window: string; usedPercent: number; windowMinutes: number | null; resetsAt: string | null; reached: boolean };
/** A provider's reading: its windows (all of them, or `partial` when it named only one), and how it was seen billing. */
export type LimitReading = { provider: "claude" | "codex"; plan: string | null; windows: LimitWindow[]; partial?: boolean; billing?: Billing };

const WINDOW_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const CLAUDE_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080 };

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const percent = (value: number) => Math.max(0, Math.min(100, Math.round(value * 10) / 10));
/** An epoch (seconds) as an ISO time, or null when it isn't a plausible one. */
const epoch = (value: unknown): string | null => {
  const seconds = finite(value);
  return seconds === null || seconds < 1_000_000_000 || seconds > 10_000_000_000 ? null : new Date(seconds * 1000).toISOString();
};
export const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A Claude stream event's limits, or null when it isn't the session's own `rate_limit_event` or says nothing usable.
 * A subagent's (parent_tool_use_id set) is never read: the session reports its own windows each turn, and a
 * subagent-tagged reading can't be told apart from one shaped by the subagent's own traffic (stream-scope.ts). */
export function claudeLimitsOf(event: unknown): LimitReading | null {
  const body = record(event);
  if (body === null || body["type"] !== "rate_limit_event" || !topLevelEvent(body)) return null;
  const info = record(body["rate_limit_info"]);
  if (info === null) return null;
  const rejected = info["status"] === "rejected";
  const current = typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : null;
  const windows: LimitWindow[] = [];
  const unified = record(info["unifiedWindows"]);
  for (const [name, raw] of Object.entries(unified ?? {}).slice(0, 8)) {
    const one = record(raw);
    const used = finite(one?.["utilization"]);
    if (!WINDOW_NAME.test(name) || one === null || used === null) continue;
    windows.push({ window: name, usedPercent: percent(used * 100), windowMinutes: Object.hasOwn(CLAUDE_MINUTES, name) ? CLAUDE_MINUTES[name]! : null, resetsAt: epoch(one["resetsAt"]), reached: rejected && name === current });
  }
  if (windows.length === 0 && current !== null && WINDOW_NAME.test(current)) {
    // An older CLI names only the window it's in; its use is known only when it's spent.
    const used = finite(info["utilization"]);
    if (used !== null || rejected) windows.push({ window: current, usedPercent: rejected ? 100 : percent(used! * 100), windowMinutes: Object.hasOwn(CLAUDE_MINUTES, current) ? CLAUDE_MINUTES[current]! : null, resetsAt: epoch(info["resetsAt"]), reached: rejected });
    // Only this window is known: the others keep their last reading.
    return windows.length === 0 ? null : { provider: "claude", plan: null, windows, partial: true, billing: "subscription" };
  }
  // A plan's windows are a plan's: this turn ran on the sign-in.
  return windows.length === 0 ? null : { provider: "claude", plan: null, windows, billing: "subscription" };
}

/** Codex's `account/rateLimits/read` answer as a reading, or null. */
export function codexLimitsOf(result: unknown): LimitReading | null {
  const limits = record(record(result)?.["rateLimits"]);
  if (limits === null) return null;
  // Codex names why it stopped ("rate_limit_reached", "…usage_limit_reached"), not which window: the fullest one.
  const reachedType = typeof limits["rateLimitReachedType"] === "string" ? limits["rateLimitReachedType"] : null;
  const windows: LimitWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const one = record(limits[slot]);
    const used = finite(one?.["usedPercent"]);
    if (one === null || used === null) continue;
    const minutes = finite(one["windowDurationMins"]);
    const name = minutes === 300 ? "five_hour" : minutes === 10_080 ? "seven_day" : minutes !== null && minutes > 0 ? `window_${Math.round(minutes)}m` : slot;
    windows.push({ window: name, usedPercent: percent(used), windowMinutes: minutes === null ? null : Math.round(minutes), resetsAt: epoch(one["resetsAt"]), reached: used >= 100 });
  }
  if (reachedType !== null && windows.length > 0) windows.reduce((fullest, one) => one.usedPercent > fullest.usedPercent ? one : fullest).reached = true;
  const plan = typeof limits["planType"] === "string" && /^[a-z0-9_-]{1,40}$/i.test(limits["planType"]) ? limits["planType"] : null;
  return windows.length === 0 ? null : { provider: "codex", plan, windows };
}

/** Where readings go: the store, in any process that runs Claude. The latest one set wins; one that's done removes
 * only itself, so a command that ends inside a longer one leaves the longer one's in place. Unset, readings drop. */
const sinks: ((reading: LimitReading) => void)[] = [];
export function pushLimitSink(next: (reading: LimitReading) => void): () => void {
  sinks.push(next);
  return () => { const at = sinks.lastIndexOf(next); if (at !== -1) sinks.splice(at, 1); };
}
/** A reading from a stream; never throws into the run that carried it. */
export function noteLimits(reading: LimitReading | null): void {
  const sink = sinks[sinks.length - 1];
  if (reading === null || sink === undefined) return;
  try {
    sink(reading);
  } catch {
    // A reading that can't be kept must not touch the turn.
  }
}

/** A window in words: "5-hour", "Weekly", "Weekly (Opus)". */
export function windowLabel(window: string, minutes: number | null): string {
  if (window === "five_hour") return "5-hour";
  if (window === "seven_day") return "Weekly";
  const model = /^seven_day_([a-z]+)$/.exec(window);
  if (model !== null) return `Weekly (${model[1]!.charAt(0).toUpperCase()}${model[1]!.slice(1)})`;
  if (minutes !== null) return minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  return window.replace(/_/g, " ");
}
