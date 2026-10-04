/**
 * What sized routing saved (v2 routing), for `toolroll spend`: each task's
 * tier (recorded on the task when its route is filed), how long it took
 * from its first run to its first result, and whether it used a planner —
 * grouped by tier, with what the light tier saved: the plans small changes
 * skipped, results that came sooner, and spend below the everyday tier.
 */
import type { SpendItem } from "./spend.js";
import type { Database } from "./store.js";

export type TierTask = { taskId: string; tier: string; size: string | null; planRuns: number; minutesToResult: number | null; microusd: number };
export type TierRow = { tier: string; tasks: number; results: number; medianMinutesToResult: number | null; planRuns: number; microusd: number };
export type TierSaved = {
  /** Small changes that built with no planner run. */
  plansSkipped: number;
  /** Those skipped plans at this month's median planner run, in minutes; null when no planner run was measured. */
  planMinutesSaved: number | null;
  /** How much sooner a light result came than an everyday one (medians), in minutes; null without both. */
  minutesSoonerEach: number | null;
  /** Light tasks' spend below the everyday tier's average task, in micro-USD; null when either is unpriced or $0. */
  microusdSaved: number | null;
};
export type TierReport = { tasks: TierTask[]; rows: TierRow[]; saved: TierSaved };

const TIER_ORDER = ["light", "routine", "strong", "override", "pinned"];

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const minutesBetween = (from: string, to: string): number | null => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 6_000) / 10 : null;
};

/** Every routed task with a run in [from, to), by tier, and what the light tier saved. `items` are the month's spend. */
export function tierReport(db: Database, from: string, to: string, items: readonly SpendItem[]): TierReport {
  const spendOf = new Map<string, number>();
  for (const item of items) if (item.taskId !== null) spendOf.set(item.taskId, (spendOf.get(item.taskId) ?? 0) + (item.microusd ?? 0));
  const rows = db.prepare(`SELECT r.external_id AS task, r.route_tier AS tier, r.size AS size,
      (SELECT COUNT(*) FROM run p WHERE p.task_ref = r.id AND p.role = 'planner') AS plan_runs,
      (SELECT MIN(f.started_at) FROM run f WHERE f.task_ref = r.id) AS first_started,
      (SELECT MIN(b.finished_at) FROM run b WHERE b.task_ref = r.id AND b.role = 'builder' AND b.outcome IN ('built', 'no-change') AND b.finished_at IS NOT NULL) AS result_at
    FROM task_ref r
    WHERE r.route_tier IS NOT NULL AND EXISTS (SELECT 1 FROM run x WHERE x.task_ref = r.id AND x.started_at >= ? AND x.started_at < ?)
    ORDER BY r.id`).all(from, to);
  const tasks: TierTask[] = rows.map(row => ({
    taskId: String(row["task"]),
    tier: String(row["tier"]),
    size: row["size"] == null ? null : String(row["size"]),
    planRuns: Number(row["plan_runs"] ?? 0),
    minutesToResult: row["first_started"] == null || row["result_at"] == null ? null : minutesBetween(String(row["first_started"]), String(row["result_at"])),
    microusd: spendOf.get(String(row["task"])) ?? 0,
  }));
  const tiers = [...new Set(tasks.map(one => one.tier))].sort((a, b) => (TIER_ORDER.indexOf(a) + 1 || 99) - (TIER_ORDER.indexOf(b) + 1 || 99));
  const byTier: TierRow[] = tiers.map(tier => {
    const mine = tasks.filter(one => one.tier === tier);
    const done = mine.flatMap(one => (one.minutesToResult === null ? [] : [one.minutesToResult]));
    return { tier, tasks: mine.length, results: done.length, medianMinutesToResult: median(done), planRuns: mine.reduce((sum, one) => sum + one.planRuns, 0), microusd: mine.reduce((sum, one) => sum + one.microusd, 0) };
  });

  const plansSkipped = tasks.filter(one => one.size === "small" && one.planRuns === 0).length;
  const plannerMinutes = db.prepare("SELECT started_at, finished_at FROM run WHERE role = 'planner' AND finished_at IS NOT NULL AND started_at >= ? AND started_at < ?").all(from, to)
    .flatMap(row => { const m = minutesBetween(String(row["started_at"]), String(row["finished_at"])); return m === null ? [] : [m]; });
  const perPlan = median(plannerMinutes);
  const light = byTier.find(one => one.tier === "light") ?? null;
  const routine = byTier.find(one => one.tier === "routine") ?? null;
  const sooner = light?.medianMinutesToResult != null && routine?.medianMinutesToResult != null && routine.medianMinutesToResult > light.medianMinutesToResult
    ? Math.round((routine.medianMinutesToResult - light.medianMinutesToResult) * 10) / 10 : null;
  const perTask = (row: TierRow | null): number | null => (row === null || row.tasks === 0 || row.microusd <= 0 ? null : row.microusd / row.tasks);
  const lightEach = light === null || light.tasks === 0 ? null : light.microusd / light.tasks;
  const routineEach = perTask(routine);
  const microusdSaved = light !== null && lightEach !== null && routineEach !== null && routineEach > lightEach ? Math.round((routineEach - lightEach) * light.tasks) : null;
  return {
    tasks,
    rows: byTier,
    saved: { plansSkipped, planMinutesSaved: perPlan === null || plansSkipped === 0 ? null : Math.round(perPlan * plansSkipped), minutesSoonerEach: sooner, microusdSaved },
  };
}

const minutesWords = (minutes: number): string => (minutes >= 90 ? `${Math.round(minutes / 6) / 10}h` : `${Math.round(minutes)}m`);

/** The spend report's lines: one per tier, then what the tiers saved. Empty when no routed task ran this month. */
export function tierLines(report: TierReport, usd: (microusd: number) => string): string[] {
  if (report.rows.length === 0) return [];
  const lines = report.rows.map(row =>
    `  ${`${row.tier} tier`.padEnd(24)} ${row.tasks} ${row.tasks === 1 ? "task" : "tasks"} · ${row.medianMinutesToResult === null ? "no result yet" : `${minutesWords(row.medianMinutesToResult)} to a result`} · ${row.planRuns} ${row.planRuns === 1 ? "plan" : "plans"} · ${usd(row.microusd)}`);
  const saved = report.saved;
  const parts = [
    ...(saved.plansSkipped === 0 ? [] : [`${saved.plansSkipped} ${saved.plansSkipped === 1 ? "plan" : "plans"} skipped${saved.planMinutesSaved === null ? "" : ` (~${minutesWords(saved.planMinutesSaved)} of planning)`}`]),
    ...(saved.minutesSoonerEach === null ? [] : [`light results ~${minutesWords(saved.minutesSoonerEach)} sooner each`]),
    ...(saved.microusdSaved === null ? [] : [`~${usd(saved.microusdSaved)} below the everyday tier`]),
  ];
  return [...lines, `  ${"tiers saved".padEnd(24)} ${parts.length === 0 ? "nothing yet — no small change has run on the light tier" : parts.join(", ")}`];
}
