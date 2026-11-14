/** One request's work reads (work-reads.ts): the projection and the rows' saved facts are read once per request, and
 * never stand in for what changed since — a write, the clock or another reader's projects. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { workCountsByProject, workIndexPage, workStateRows } from "./work-index.js";
import { WORK_READ_REUSE_MS, outsideWorkReads, withWorkReads, workReadsOf } from "./work-reads.js";
import type { WorkSummaryAccess } from "./work-summary.js";
import { LEAD_CLAIMED } from "./lead-voice.js";

const now = new Date("2026-11-13T12:00:00Z");
const operator: WorkSummaryAccess = { principal: "operator", repos: null, includeUnplaced: true };
let dir: string | undefined;
const stores: Store[] = [];
afterEach(() => {
  for (const one of stores.splice(0)) one.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function world(): Store {
  dir = mkdtempSync(join(tmpdir(), "so-work-reads-"));
  const store = openStore(join(dir, "orders.db"));
  stores.push(store);
  for (const [id, repo] of [["a", "/repo/one"], ["b", "/repo/one"], ["c", "/repo/two"], ["d", null]] as const) {
    store.createTask({ id, title: `task ${id}` }, now);
    if (repo !== null) store.placeTask(store.refFor("built-in", id).id, repo, {}, now);
  }
  return store;
}
const temps = (store: Store) => store.handle.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' ORDER BY name").all().map(row => String(row["name"]));
const page = (store: Store, access: WorkSummaryAccess = operator, at: Date = now) => workIndexPage(store, at, access, { view: "all", limit: 40 });

test("outside a request nothing is kept; inside one the projection is read once and gone when it ends", () => {
  const store = world();
  expect(workReadsOf(store)).toBeNull();
  const plain = { page: page(store), states: workStateRows(store, now, operator), counts: workCountsByProject(store, now, operator) };
  expect(temps(store)).toEqual([]);
  const kept = withWorkReads(() => {
    const read = { page: page(store), states: workStateRows(store, now, operator), counts: workCountsByProject(store, now, operator) };
    // Three reads, one projection.
    expect(temps(store)).toEqual(["so_work_ranked_0"]);
    return read;
  });
  expect(kept).toEqual(plain);
  expect(temps(store)).toEqual([]);
});

test("a write during the request is read at once: nothing kept from before it stands in", () => {
  const store = world();
  withWorkReads(() => {
    const before = page(store);
    expect(before.items.find(item => item.rootId === "a")?.state).toBe("queued");
    store.setTaskState("a", "cancelled", now);
    const after = page(store);
    expect(after.items.find(item => item.rootId === "a")?.state).toBe("cancelled");
    expect(after).toEqual(withoutReads(() => page(store)));
  });
});

test("another reader's projects are another projection: a narrower reader never reads the wider one's rows", () => {
  const store = world();
  const narrow: WorkSummaryAccess = { principal: "operator", repos: ["/repo/two"], includeUnplaced: false };
  withWorkReads(() => {
    expect(page(store).items.map(item => item.rootId).sort()).toEqual(["a", "b", "c", "d"]);
    const limited = page(store, narrow);
    expect(limited.items.map(item => item.rootId)).toEqual(["c"]);
    expect(limited).toEqual(withoutReads(() => page(store, narrow)));
    expect(temps(store)).toHaveLength(2);
  });
});

test("inputs that decide no row share one copy; once they decide one, each reader reads its own", () => {
  const store = world();
  const placedOnly: WorkSummaryAccess = { principal: "operator", repos: null, includeUnplaced: false };
  const asAlex: WorkSummaryAccess = { ...operator, viewer: "alex" };
  const reads = () => withWorkReads(() => {
    const out = [page(store), page(store, placedOnly), page(store, asAlex)];
    return { out, copies: temps(store).length };
  });
  // Unplaced work (task d) and no lead claims: the unplaced copy is its own, the lead's reader shares the operator's.
  let seen = reads();
  expect(seen.copies).toBe(2);
  expect(seen.out).toEqual([page(store), page(store, placedOnly), page(store, asAlex)]);
  // Place d: nothing unplaced is left, so admitting unplaced work admits nothing.
  store.placeTask(store.refFor("built-in", "d").id, "/repo/two", {}, now);
  seen = reads();
  expect(seen.copies).toBe(1);
  expect(seen.out).toEqual([page(store), page(store, placedOnly), page(store, asAlex)]);
  // Alex's lead takes a task on: alex's reader now reads it as claimed, the others don't.
  store.recordAction({ at: now.toISOString(), actor: "lead for alex", repo: "/repo/one", taskId: "a", runId: null, action: LEAD_CLAIMED, outcome: "on it", source: "work" });
  seen = reads();
  expect(seen.copies).toBe(2);
  expect(seen.out).toEqual([page(store), page(store, placedOnly), page(store, asAlex)]);
  expect(seen.out[2]!.items.find(item => item.rootId === "a")?.lead).toBeDefined();
  expect(seen.out[0]!.items.find(item => item.rootId === "a")?.lead).toBeUndefined();
});

test("the projection is kept only near the instant it was read for: a hold that ends later reads as ended", () => {
  const store = world();
  store.hold(store.refFor("built-in", "b").id, "wait a moment", new Date(now.getTime() + 1_000), now);
  const later = new Date(now.getTime() + WORK_READ_REUSE_MS + 1_000);
  withWorkReads(() => {
    expect(page(store).items.find(item => item.rootId === "b")?.status.label).not.toBe(withoutReads(() => page(store, operator, later)).items.find(item => item.rootId === "b")?.status.label);
    expect(page(store, operator, later)).toEqual(withoutReads(() => page(store, operator, later)));
  });
});

test("saved answers are copies, and a write through the saving store forgets them", () => {
  const store = world();
  withWorkReads(() => {
    const reads = workReadsOf(store)!;
    const first = reads.store.getTask("a")!;
    (first as { title: string }).title = "changed by a caller";
    expect(reads.store.getTask("a")!.title).toBe("task a");
    reads.store.setTaskState("a", "cancelled", now);
    expect(reads.store.getTask("a")!.state).toBe("cancelled");
    // A write the saving store never saw (the store itself) is found on the next proof.
    store.setTaskState("b", "cancelled", now);
    expect(workReadsOf(store)!.store.getTask("b")!.state).toBe("cancelled");
  });
});

test("an async request keeps its reads until it ends, and drops them after", async () => {
  const store = world();
  await withWorkReads(async () => {
    page(store);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(temps(store)).toEqual(["so_work_ranked_0"]);
  });
  expect(temps(store)).toEqual([]);
});

/** The same read with no request around it, as every read was before. */
const withoutReads = <T>(run: () => T): T => outsideWorkReads(run);
