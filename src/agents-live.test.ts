/** The Live grid's runs (store.ts agentsLiveRuns; docs/plans/agents-view.md §2.5): two indexed reads, never a scan. */
import { expect, test } from "vitest";
import { openStore } from "./store.js";

test("the grid's query reads through its two indexes", () => {
  const store = openStore(":memory:");
  try {
    const plan = store.handle.prepare(`EXPLAIN QUERY PLAN SELECT id FROM run INDEXED BY run_live_open WHERE outcome IS NULL AND id > 0
      UNION SELECT id FROM run INDEXED BY run_live_recent WHERE outcome IS NOT NULL AND id > 0 AND finished_at >= ?`).all("2026-10-27T00:00:00.000Z").map(row => String(row["detail"])).join("\n");
    expect(plan).toMatch(/USING (COVERING )?INDEX run_live_open/);
    expect(plan).toMatch(/USING (COVERING )?INDEX run_live_recent/);
  } finally { store.close(); }
});

test("no cutoff before the viewer's filter: one visible agent behind 200 others is still on the grid", async () => {
  const { acquire, release } = await import("./claim.js");
  const { register } = await import("./runner.js");
  const { agentsLiveOf } = await import("./agents-live.js");
  const store = openStore(":memory:");
  try {
    register(store, { name: "mac", host: "t", capacity: 9, repos: ["/a", "/b"], now: new Date(), newToken: () => "tok" });
    const start = (id: string, repo: string, finish: boolean): number => {
      store.createTask({ id, title: id }, new Date());
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, repo);
      const took = acquire(store, ref, "mac", { now: new Date(), token: "tok", newLeaseId: () => `lease-${id}`, ttlMs: 3_600_000 });
      if (!took.ok) throw new Error(took.reason);
      const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "mac", branch: id, worktree: `/w/${id}`, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "m", chosen: "legacy" }, now: new Date() });
      if (finish) { store.finishRun(run, { outcome: "built", committed: true, now: new Date() }); release(store, `lease-${id}`, new Date()); }
      return run;
    };
    const mine = start("mine", "/b", false);
    for (let n = 0; n < 200; n += 1) start(`other-${n}`, "/a", true);
    const tiles = agentsLiveOf(store, new Date(), { canSee: run => run.repo === "/b", localRunner: "mac" });
    expect(tiles.map(tile => tile.runId)).toEqual([mine]);
  } finally { store.close(); }
});
