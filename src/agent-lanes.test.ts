/** The agent timeline: one row per task over a window, in the admitted projects only, needs-you first, capped. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { agentLanesOf, agentLanesSql, LANE_ROWS, LANE_SEGMENTS, laneLiveRunsSql, laneRunsSql, laneSinceOf } from "./agents-board.js";
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
const build = (ref: number, startedAt: Date, finishedAt: Date | null, outcome = "built", role: "builder" | "scout" = "builder") => {
  const run = store.startRun({ taskRef: ref, leaseId: `l-${ref}-${role}-${startedAt.getTime()}`, runner: "builder-1", branch: `b-${ref}`, worktree: dir, provider: "claude", now: startedAt, ...route, ...(role === "scout" ? { role } : {}) });
  if (finishedAt !== null) store.finishRun(run, { outcome, reason: "agent", now: finishedAt });
  return run;
};
const lanesAt = (repos: readonly string[] | null) => agentLanesOf(store, T0, { repos }, "alex", "2h");

test("another project's runs never reach the timeline, and nothing in the window means no timeline", () => {
  build(task("mine"), at(-30 * MIN), null);
  build(task("theirs", "/projects/secret"), at(-20 * MIN), null);
  expect(lanesAt(["/projects/shop"])!.lanes.map(lane => lane.taskId)).toEqual(["mine"]);
  expect(lanesAt(null)!.lanes.map(lane => lane.taskId).sort()).toEqual(["mine", "theirs"]);
  expect(lanesAt(["/projects/none"])).toBeNull();
});

const plan = (sql: string, params: Record<string, unknown>) => store.handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(row => String(row["detail"]));

test("running tasks come first, then the most recently active; the running count covers every task; each row's state is its own build's", () => {
  build(task("old"), at(-5 * 60 * MIN), at(-4 * 60 * MIN));
  build(task("asks"), at(-50 * MIN), at(-40 * MIN), "failed");
  build(task("live"), at(-100 * MIN), null);
  build(task("recent"), at(-20 * MIN), at(-5 * MIN));
  const lanes = lanesAt(null)!;
  expect(lanes.lanes.map(lane => lane.taskId)).toEqual(["live", "recent", "asks"]);
  // The board's own rule, row by row: a failed build needs you, a built one is done, a live one is at work (or stuck).
  expect(lanes.lanes.find(lane => lane.taskId === "asks")!.group).toBe("needs-you");
  expect(lanes.lanes.find(lane => lane.taskId === "recent")!.group).toBe("done");
  expect(["working", "stuck"]).toContain(lanes.lanes.find(lane => lane.taskId === "live")!.group);
  expect(lanes.lanes[0]!.segments[0]).toMatchObject({ role: "builder", endedAt: null });
  expect([lanes.running, lanes.more]).toEqual([1, 0]);
  expect(lanes.since).toBe(laneSinceOf("2h", T0).toISOString());

  // Twenty more running: twelve rows, every running count, the rest a number.
  for (let n = 0; n < 20; n++) build(task(`many-${n}`), at(-(n + 1) * MIN), null);
  const many = lanesAt(null)!;
  expect(many.lanes).toHaveLength(LANE_ROWS);
  expect(many.lanes.every(lane => lane.segments.some(one => one.endedAt === null))).toBe(true);
  expect([many.running, many.more]).toEqual([21, 23 - LANE_ROWS]);
});

test("a long build that finished inside the window shows, however long it ran; old runs never crowd out a live one", () => {
  build(task("marathon"), at(-30 * 60 * MIN), at(-1 * MIN));
  const busy = task("busy");
  for (let n = 0; n < 300; n++) build(busy, at(-90 * MIN + n * 10_000), at(-90 * MIN + n * 10_000 + 5_000));
  build(task("slow"), at(-100 * MIN), null);
  const lanes = lanesAt(null)!;
  expect(lanes.lanes.map(lane => lane.taskId)).toEqual(["slow", "marathon", "busy"]);
  expect(lanes.lanes.find(lane => lane.taskId === "busy")!.segments).toHaveLength(LANE_SEGMENTS);
});

test("a row never loses its live run to the segment cap, and takes its state from its newest build even before the window", () => {
  const busy = task("busy");
  build(busy, at(-100 * MIN), null);
  for (let n = 0; n < LANE_SEGMENTS; n++) build(busy, at(-60 * MIN + n * 10_000), at(-60 * MIN + n * 10_000 + 5_000), "built", "scout");
  const row = lanesAt(null)!.lanes.find(lane => lane.taskId === "busy")!;
  expect(row.segments.filter(one => one.endedAt === null)).toHaveLength(1);
  expect(["working", "stuck"]).toContain(row.group);
  expect(lanesAt(null)!.running).toBe(1);

  const asked = task("asked");
  build(asked, at(-4 * 60 * MIN), at(-3 * 60 * MIN), "failed");
  build(asked, at(-30 * MIN), at(-20 * MIN), "built", "scout");
  expect(lanesAt(null)!.lanes.find(lane => lane.taskId === "asked")!.group).toBe("needs-you");
});

test("a quiet window keeps the timeline (and its window choice) when something ran today; nothing in a day is no timeline", () => {
  build(task("earlier"), at(-5 * 60 * MIN), at(-5 * 60 * MIN + 10 * MIN));
  expect(lanesAt(null)).toMatchObject({ lanes: [], running: 0, more: 0 });
  expect(agentLanesOf(store, at(30 * 60 * MIN), { repos: null }, "alex", "2h")).toBeNull();
});

test("the timeline reads index ranges and each chosen task's own runs, never every run", () => {
  const busy = task("busy");
  for (let n = 0; n < 200; n++) build(busy, at(-3 * 24 * 60 * MIN - n * MIN), at(-3 * 24 * 60 * MIN - n * MIN + 30_000));
  const lanes = plan(agentLanesSql(), { $lookback: at(-26 * 60 * MIN).toISOString(), $since: at(-2 * 60 * MIN).toISOString(), $now: T0.toISOString(), $all: 1, $repos: "[]", $rows: LANE_ROWS });
  for (const index of ["run_started", "work_unfinished", "agent_board_recent"]) expect(lanes.some(step => step.includes(index)), index).toBe(true);
  expect(lanes.some(step => /SEARCH r USING INTEGER PRIMARY KEY/.test(step))).toBe(true);
  const runs = plan(laneRunsSql(), { $ref: busy, $from: 1, $since: at(-2 * 60 * MIN).toISOString() });
  const live = plan(laneLiveRunsSql(), { $ref: busy });
  expect(live.some(step => step.includes("work_unfinished") && step.includes("task_ref=?")), live.join(" | ")).toBe(true);
  // The chosen task's runs are a seek from its first run in the window, not its whole history.
  expect(runs.some(step => /SEARCH run USING .*INDEX .*\(task_ref=\? AND id>\?\)/.test(step)), runs.join(" | ")).toBe(true);
  for (const steps of [lanes, runs, live]) expect(steps.filter(step => /^SCAN (run|r)\b/.test(step) && !/INDEX/.test(step))).toEqual([]);
});

test("the indexes the timeline names exist (a missing one would be an SQL error, not a slow page)", () => {
  const names = store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run'").all().map(row => String(row["name"]));
  expect(names).toEqual(expect.arrayContaining(["run_started", "work_unfinished", "agent_board_recent"]));
});
