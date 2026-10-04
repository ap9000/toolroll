/**
 * What sized routing saved, in `toolroll spend`: each task's tier, its time
 * to a result and its plan use, by tier, and what the light tier saved.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { runOperate } from "./operate.js";
import { spendItems, usd } from "./spend.js";
import { tierLines, tierReport } from "./tier-report.js";
import { setAuthMode } from "./keys.js";

const FROM = "2026-10-01T00:00:00.000Z";
const TO = "2026-11-01T00:00:00.000Z";
const NOW = new Date("2026-10-04T12:00:00.000Z");
const legacy = { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const };

let dir: string, file: string, store: Store, serial = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-tiers-"));
  file = join(dir, "orders.db");
  store = openStore(file);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A task routed to `tier`, with a planner run when `planned`, and a build that took `minutes` from the first run. */
function task(tier: string, size: string, minutes: number | null, planned = false, costUsd = 0): string {
  const id = `t-${++serial}`;
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, "/repo/shop");
  store.handle.prepare("UPDATE task_ref SET route_tier = ?, size = ?, size_source = 'classifier', size_risky = 0 WHERE id = ?").run(tier, size, ref);
  const start = Date.parse("2026-10-02T09:00:00.000Z");
  const at = (offset: number) => new Date(start + offset * 60_000).toISOString();
  let offset = 0;
  if (planned) {
    const plan = store.startRun({ taskRef: ref, leaseId: `p-${serial}`, runner: "b1", role: "planner", branch: `p/${id}`, worktree: `/w/p-${id}`, route: { ...legacy, phase: "plan" }, now: NOW });
    store.finishRun(plan, { outcome: "built", now: NOW });
    store.handle.prepare("UPDATE run SET started_at = ?, finished_at = ? WHERE id = ?").run(at(0), at(10), plan);
    offset = 10;
  }
  const build = store.startRun({ taskRef: ref, leaseId: `b-${serial}`, runner: "b1", branch: `b/${id}`, worktree: `/w/b-${id}`, route: legacy, now: NOW });
  if (costUsd > 0) store.recordUsage(build, { costUsd });
  if (minutes !== null) store.finishRun(build, { outcome: "built", now: NOW });
  store.handle.prepare("UPDATE run SET started_at = ?, finished_at = ? WHERE id = ?").run(at(offset), minutes === null ? null : at(minutes), build);
  return id;
}

test("tasks group by tier with their time to a result and plan use, and the light tier's savings are counted", () => {
  task("light", "small", 6);
  task("light", "small", 8);
  task("routine", "medium", 30, true);
  task("routine", "medium", 20, true);
  task("strong", "large", null, true);
  const report = tierReport(store.handle, FROM, TO, spendItems(store.handle, FROM, TO));
  expect(report.rows.map(row => [row.tier, row.tasks, row.results, row.medianMinutesToResult, row.planRuns])).toEqual([
    ["light", 2, 2, 7, 0],
    ["routine", 2, 2, 25, 2],
    ["strong", 1, 0, null, 1],
  ]);
  // Two small changes skipped a plan; this month's planner runs took 10 minutes each; light results came 18m sooner.
  expect(report.saved).toEqual({ plansSkipped: 2, planMinutesSaved: 20, minutesSoonerEach: 18, microusdSaved: null });
  const lines = tierLines(report, usd);
  expect(lines[0]).toBe("  light tier               2 tasks · 7m to a result · 0 plans · $0");
  expect(lines.at(-1)).toBe("  tiers saved              2 plans skipped (~20m of planning), light results ~18m sooner each");
});

test("spend on API keys shows the light tier's dollars below the everyday tier", () => {
  const home = process.env["HOME"];
  process.env["HOME"] = dir;
  try {
    setAuthMode("claude", "api-key");
    task("light", "small", 5, false, 0.5);
    task("routine", "medium", 20, false, 2.5);
    const report = tierReport(store.handle, FROM, TO, spendItems(store.handle, FROM, TO));
    expect(report.saved.microusdSaved).toBe(2_000_000);
    expect(tierLines(report, usd).at(-1)).toContain("~$2.00 below the everyday tier");
  } finally {
    process.env["HOME"] = home;
  }
});

test("no routed work this month shows nothing", () => {
  expect(tierLines(tierReport(store.handle, FROM, TO, []), usd)).toEqual([]);
});

test("toolroll spend shows the tiers and what they saved", async () => {
  task("light", "small", 6);
  task("routine", "medium", 30, true);
  store.close();
  const lines: string[] = [];
  try {
    expect(await runOperate("spend", ["--month", "2026-10"], line => { lines.push(line); }, { databaseFile: file })).toBe(0);
    expect(lines.join("\n")).toContain("  light tier               1 task · 6m to a result · 0 plans");
    expect(lines.join("\n")).toContain("  tiers saved              1 plan skipped (~10m of planning), light results ~24m sooner each");
    lines.length = 0;
    await runOperate("spend", ["--month", "2026-10", "--json"], line => { lines.push(line); }, { databaseFile: file });
    expect(JSON.parse(lines.join("\n")).tiers.saved).toMatchObject({ plansSkipped: 1 });
  } finally {
    store = openStore(file);
  }
});
