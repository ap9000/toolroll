/** The agent timeline: one row per task over a window, in the admitted projects only, needs-you first, capped. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { agentLanesOf, agentLanesSql, LANE_ROWS, laneSinceOf } from "./agents-board.js";
import { BUILT_IN, openStore, type Store } from "./store.js";

const T0 = new Date("2026-10-11T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const route = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

let store: Store, dir: string;
beforeEach(() => { store = openStore(":memory:"); dir = mkdtempSync(join(tmpdir(), "so-lanes-")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const task = (id: string, repo = "/projects/shop") => {
  store.createTask({ id, title: `Task ${id}` }, T0);
  const ref = store.refFor(BUILT_IN, id).id;
  store.placeTask(ref, repo);
  return ref;
};
const build = (ref: number, startedAt: Date, finishedAt: Date | null, outcome = "built") => {
  const run = store.startRun({ taskRef: ref, leaseId: `l-${ref}-${startedAt.getTime()}`, runner: "builder-1", branch: `b-${ref}`, worktree: dir, provider: "claude", now: startedAt, ...route });
  if (finishedAt !== null) store.finishRun(run, { outcome, reason: "agent", now: finishedAt });
  return run;
};
const lanesAt = (repos: readonly string[] | null, board: { rows: { taskId: string; group: "needs-you" | "working" | "done" }[] }[] = []) =>
  agentLanesOf(store, T0, { repos }, board as never, "2h");

test("another project's runs never reach the timeline, and nothing in the window means no timeline", () => {
  build(task("mine"), at(-30 * MIN), null);
  build(task("theirs", "/projects/secret"), at(-20 * MIN), null);
  expect(lanesAt(["/projects/shop"])!.lanes.map(lane => lane.taskId)).toEqual(["mine"]);
  expect(lanesAt(null)!.lanes.map(lane => lane.taskId).sort()).toEqual(["mine", "theirs"]);
  expect(lanesAt(["/projects/none"])).toBeNull();
});

test("the window keeps running runs and runs that ended inside it, a long one included; rows follow the board, newest first; counts cover every task", () => {
  const old = task("old"); build(old, at(-5 * 60 * MIN), at(-4 * 60 * MIN));
  const long = task("long"); build(long, at(-9 * 60 * MIN), at(-1 * MIN));
  const live = task("live"); build(live, at(-10 * MIN), null);
  const asks = task("asks"); build(asks, at(-50 * MIN), at(-40 * MIN), "failed");
  const board = [{ rows: [{ taskId: "asks", group: "needs-you" as const }, { taskId: "live", group: "working" as const }, { taskId: "long", group: "done" as const }] }];
  const lanes = lanesAt(null, board)!;
  expect(lanes.lanes.map(lane => [lane.taskId, lane.group])).toEqual([["asks", "needs-you"], ["live", "working"], ["long", "done"]]);
  expect(lanes.lanes.find(lane => lane.taskId === "live")!.segments[0]).toMatchObject({ role: "builder", endedAt: null });
  expect(lanes.since).toBe(laneSinceOf("2h", T0).toISOString());

  // Twenty running tasks: twelve rows, the newest first, and counts over all of them.
  for (let n = 0; n < 20; n++) build(task(`many-${n}`), at(-(n + 1) * MIN), null);
  const working = [{ rows: [...board[0]!.rows, ...Array.from({ length: 20 }, (_, n) => ({ taskId: `many-${n}`, group: "working" as const }))] }];
  const many = lanesAt(null, working)!;
  expect(many.lanes).toHaveLength(LANE_ROWS);
  // Needs you first, then working with the newest start first ("live" began ten minutes ago, after many-8).
  expect(many.lanes.slice(0, 3).map(lane => lane.taskId)).toEqual(["asks", "many-0", "many-1"]);
  expect([many.running, many.needsYou, many.more]).toEqual([21, 1, 23 - LANE_ROWS]);
});

test("a long history outside the window hides nothing current and is never walked", () => {
  const busy = task("busy");
  for (let n = 0; n < 700; n++) build(busy, at(-3 * 24 * 60 * MIN - n * MIN), at(-3 * 24 * 60 * MIN - n * MIN + 30_000));
  build(task("now"), at(-5 * MIN), null);
  expect(lanesAt(null)!.lanes.map(lane => lane.taskId)).toEqual(["now"]);
  const plan = store.handle.prepare(`EXPLAIN QUERY PLAN ${agentLanesSql()}`)
    .all({ $lookback: at(-26 * 60 * MIN).toISOString(), $since: at(-2 * 60 * MIN).toISOString(), $all: 1, $repos: "[]" }).map(row => String(row["detail"]));
  // The candidates come from the start range and the unfinished index, and drive the join; no plain scan of runs.
  expect(plan.some(step => step.includes("run_started"))).toBe(true);
  expect(plan.some(step => step.includes("work_unfinished"))).toBe(true);
  expect(plan.filter(step => /^SCAN (run|r)\b/.test(step) && !/INDEX/.test(step))).toEqual([]);
  expect(plan.some(step => /SEARCH r USING INTEGER PRIMARY KEY/.test(step))).toBe(true);
});

test("the indexes the timeline names exist (a missing one would be an SQL error, not a slow page)", () => {
  const names = store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run'").all().map(row => String(row["name"]));
  expect(names).toEqual(expect.arrayContaining(["run_started", "work_unfinished"]));
});
