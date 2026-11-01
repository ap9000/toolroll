/** Latency timelines (docs/plans/actors-lessons.md): what is kept, bounded, and read back for the page. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckReport } from "./contracts/release-check.js";
import { checkMilestones, keepSlowRequest, partDurations, SLOW_REQUEST_MS, Timeline, timingFor } from "./latency-timeline.js";
import { latencyTimelines, openStore, type Store } from "./store.js";
import { keepDeployTimeline, noteMilestone } from "../scripts/deploy-phases.mjs";

let store: Store | undefined, dir: string | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test("a release check's parts: starts from its sealed report, ends from its own took: line", () => {
  const stdout = ["unit: exit 0", "took: typecheck 40 s, build 12 s, unit 6.5 min, app 3 min; whole check 10.2 min", "{\"report\":1}"].join("\n");
  expect([...partDurations(stdout)]).toEqual([["typecheck", 40_000], ["build", 12_000], ["unit", 390_000], ["app", 180_000]]);
  const report = { mode: "full", parts: [
    { part: "typecheck", startedAt: "2026-10-29T10:00:00.000Z" },
    { part: "build", startedAt: "2026-10-29T10:00:00.000Z" },
    { part: "unit", startedAt: "2026-10-29T10:00:45.000Z" },
    { part: "upgrade", startedAt: null },
  ] } as unknown as CheckReport;
  const timeline = checkMilestones(report, stdout)!;
  expect(timeline.startedAt.toISOString()).toBe("2026-10-29T10:00:00.000Z");
  expect(timeline.milestones).toEqual([
    { name: "typecheck started", ms: 0 }, { name: "build started", ms: 0 }, { name: "build ended", ms: 12_000 },
    { name: "typecheck ended", ms: 40_000 }, { name: "unit started", ms: 45_000 }, { name: "unit ended", ms: 435_000 },
  ]);
  expect(timeline.totalMs).toBe(435_000);

  store = openStore(":memory:");
  store.handle.prepare("INSERT INTO latency_timeline (kind, subject, task_id, run_id, started_at, total_ms, milestones_json) VALUES ('release-check', 'check full', 't-1', 7, ?, 435000, ?)")
    .run(timeline.startedAt.toISOString(), JSON.stringify(timeline.milestones));
  const view = timingFor(store, 7, "t-1")!;
  expect(view[0]).toMatchObject({ title: "Release check", total: "7:15" });
  expect(view[0]!.rows.find(row => row.label === "unit ended")).toEqual({ label: "unit ended", at: "+7:15", detail: "took 6:30" });
  // Another run's check is not this run's; nothing kept reads as nothing.
  expect(timingFor(store, 8, "t-2")).toBeNull();
});

test("a console request keeps its timeline only when it was slow", () => {
  store = openStore(":memory:");
  const now = new Date();
  const quick = new Timeline();
  quick.mark("route matched");
  keepSlowRequest(store, quick, "task.page", 200, now);
  expect(latencyTimelines(store, { kind: "console" })).toEqual([]);
  const slow = new Timeline();
  slow.mark("route matched");
  // As if the request had taken longer than the threshold.
  (slow as unknown as { t0: number }).t0 -= SLOW_REQUEST_MS + 5;
  keepSlowRequest(store, slow, "task.page", 200, now);
  const [kept] = latencyTimelines(store, { kind: "console" });
  expect(kept).toMatchObject({ subject: "task.page" });
  expect(kept!.milestones.at(-1)).toMatchObject({ name: "answered", detail: "status 200" });
});

test("a deployment's phases and waits reach the task's timeline once, bounded", () => {
  dir = mkdtempSync(join(tmpdir(), "so-deploy-timeline-"));
  const file = join(dir, "orders.db");
  openStore(file).close();
  const r: Record<string, unknown> = { candidate: "abcdef0123", task: "t-9", createdAt: new Date(Date.now() - 60_000).toISOString() };
  noteMilestone(r, "preparing");
  noteMilestone(r, "preparing");
  noteMilestone(r, "waiting for the new service to start", "its console is not answering yet");
  noteMilestone(r, "waiting for the new service to start", "its console is not answering yet");
  noteMilestone(r, "deployed");
  for (let n = 0; n < 60; n++) noteMilestone(r, `phase ${n}`);
  expect((r["timeline"] as unknown[]).length).toBe(40);
  keepDeployTimeline(file, r);
  keepDeployTimeline(file, r);
  store = openStore(file);
  const kept = latencyTimelines(store, { taskId: "t-9" });
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ kind: "deploy", subject: "abcdef0" });
  expect(kept[0]!.milestones.slice(0, 3).map(one => [one.name, one.detail ?? null])).toEqual([["preparing", null], ["waiting for the new service to start", "its console is not answering yet"], ["deployed", null]]);
});
