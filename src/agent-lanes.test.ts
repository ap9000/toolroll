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

test("the window keeps running runs and runs that ended inside it; needs-you rows come first; the rest past the cap are a count", () => {
  const old = task("old"); build(old, at(-5 * 60 * MIN), at(-4 * 60 * MIN));
  const late = task("late"); build(late, at(-3 * 60 * MIN), at(-30 * MIN));
  const live = task("live"); build(live, at(-10 * MIN), null);
  const asks = task("asks"); build(asks, at(-50 * MIN), at(-40 * MIN), "failed");
  const lanes = lanesAt(null, [{ rows: [{ taskId: "asks", group: "needs-you" }, { taskId: "live", group: "working" }, { taskId: "late", group: "done" }] }])!;
  expect(lanes.lanes.map(lane => [lane.taskId, lane.group])).toEqual([["asks", "needs-you"], ["live", "working"], ["late", "done"]]);
  expect(lanes.lanes.find(lane => lane.taskId === "live")!.segments[0]).toMatchObject({ role: "builder", endedAt: null });
  expect(lanes.since).toBe(laneSinceOf("2h", T0).toISOString());

  for (let n = 0; n < LANE_ROWS + 3; n++) build(task(`many-${n}`), at(-(n + 1) * MIN), null);
  expect(lanesAt(null)!.lanes).toHaveLength(LANE_ROWS);
  expect(lanesAt(null)!.more).toBe(LANE_ROWS + 3 + 3 - LANE_ROWS);
});

test("the timeline's query reads index ranges, never a scan of every run", () => {
  const plan = store.handle.prepare(`EXPLAIN QUERY PLAN ${agentLanesSql()}`)
    .all({ $lookback: at(-8 * 60 * MIN).toISOString(), $since: at(-2 * 60 * MIN).toISOString(), $all: 1, $repos: "[]" }).map(row => String(row["detail"]));
  expect(plan.filter(step => /^SCAN (run|r)\b/.test(step) && !/INDEX/.test(step))).toEqual([]);
});
