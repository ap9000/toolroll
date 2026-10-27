/** The Live grid's runs (store.ts agentsLiveRuns; docs/plans/agents-view.md §2.5): two indexed reads, never a scan. */
import { expect, test } from "vitest";
import { openStore } from "./store.js";

test("the grid's query reads through its two indexes", () => {
  const store = openStore(":memory:");
  try {
    const plan = store.handle.prepare(`EXPLAIN QUERY PLAN SELECT id FROM run INDEXED BY run_live_open WHERE outcome IS NULL
      UNION SELECT id FROM run INDEXED BY run_live_recent WHERE outcome IS NOT NULL AND finished_at >= ?`).all("2026-10-27T00:00:00.000Z").map(row => String(row["detail"])).join("\n");
    expect(plan).toMatch(/USING (COVERING )?INDEX run_live_open/);
    expect(plan).toMatch(/USING (COVERING )?INDEX run_live_recent/);
  } finally { store.close(); }
});
