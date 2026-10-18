/** The agent timeline: one row per task over a window, in the admitted projects only, needs-you first, capped. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { agentLanesOf, agentLanesSql, LANE_ROWS, laneRunsSql, laneSinceOf } from "./agents-board.js";
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

const plan = (sql: string, params: Record<string, unknown>) => store.handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(row => String(row["detail"]));

test("running tasks come first, then the most recently active; counts cover every task; state comes from the board", () => {
  build(task("old"), at(-5 * 60 * MIN), at(-4 * 60 * MIN));
  build(task("asks"), at(-50 * MIN), at(-40 * MIN), "failed");
  build(task("live"), at(-100 * MIN), null);
  build(task("recent"), at(-20 * MIN), at(-5 * MIN));
  const board = [{ rows: [{ taskId: "asks", group: "needs-you" as const }, { taskId: "live", group: "working" as const }] }];
  const lanes = lanesAt(null, board)!;
  expect(lanes.lanes.map(lane => [lane.taskId, lane.group])).toEqual([["live", "working"], ["recent", "idle"], ["asks", "needs-you"]]);
  expect(lanes.lanes[0]!.segments[0]).toMatchObject({ role: "builder", endedAt: null });
  expect([lanes.running, lanes.needsYou, lanes.more]).toEqual([1, 1, 0]);
  expect(lanes.since).toBe(laneSinceOf("2h", T0).toISOString());

  // Twenty more running: twelve rows, every running count, the rest a number.
  for (let n = 0; n < 20; n++) build(task(`many-${n}`), at(-(n + 1) * MIN), null);
  const many = lanesAt(null, board)!;
  expect(many.lanes).toHaveLength(LANE_ROWS);
  expect(many.lanes.every(lane => lane.segments.some(one => one.endedAt === null))).toBe(true);
  expect([many.running, many.more]).toEqual([21, 23 - LANE_ROWS]);
});

test("a long build that finished inside the window shows, however long it ran; old runs never crowd out a live one", () => {
  build(task("marathon"), at(-30 * 60 * MIN), at(-1 * MIN));
  const busy = task("busy");
  for (let n = 0; n < 300; n++) build(busy, at(-90 * MIN + n * 10_000), at(-90 * MIN + n * 10_000 + 5_000));
  build(task("slow"), at(-100 * MIN), null);
  expect(lanesAt(null)!.lanes.map(lane => lane.taskId)).toEqual(["slow", "marathon", "busy"]);
});

test("a quiet window keeps the timeline (and its window choice) when something ran today; nothing in a day is no timeline", () => {
  build(task("earlier"), at(-5 * 60 * MIN), at(-5 * 60 * MIN + 10 * MIN));
  expect(lanesAt(null)).toMatchObject({ lanes: [], running: 0, more: 0 });
  expect(agentLanesOf(store, at(30 * 60 * MIN), { repos: null }, [], "2h")).toBeNull();
});

test("the timeline reads index ranges and each chosen task's own runs, never every run", () => {
  const busy = task("busy");
  for (let n = 0; n < 200; n++) build(busy, at(-3 * 24 * 60 * MIN - n * MIN), at(-3 * 24 * 60 * MIN - n * MIN + 30_000));
  const lanes = plan(agentLanesSql(), { $lookback: at(-26 * 60 * MIN).toISOString(), $since: at(-2 * 60 * MIN).toISOString(), $now: T0.toISOString(), $all: 1, $repos: "[]", $rows: LANE_ROWS });
  for (const index of ["run_started", "work_unfinished", "agent_board_recent"]) expect(lanes.some(step => step.includes(index)), index).toBe(true);
  expect(lanes.some(step => /SEARCH r USING INTEGER PRIMARY KEY/.test(step))).toBe(true);
  const runs = plan(laneRunsSql(), { $refs: "[1]", $since: at(-2 * 60 * MIN).toISOString() });
  for (const steps of [lanes, runs]) expect(steps.filter(step => /^SCAN (run|r)\b/.test(step) && !/INDEX/.test(step))).toEqual([]);
});

test("the indexes the timeline names exist (a missing one would be an SQL error, not a slow page)", () => {
  const names = store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run'").all().map(row => String(row["name"]));
  expect(names).toEqual(expect.arrayContaining(["run_started", "work_unfinished", "agent_board_recent"]));
});
