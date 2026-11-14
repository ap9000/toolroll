/** The Tasks list's cost grows with a family's versions, never with their square (work-index.ts ONE_READ): a family's
 * version lists are built once per family, not on every version. A family of 3,000 versions reads within a generous
 * multiple of one of 1,000; a read built per version (quadratic) takes about nine times as long, a linear one three. */
import { afterEach, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { workIndexPage, workStateRows } from "./work-index.js";
import type { WorkSummaryAccess } from "./work-summary.js";

const now = new Date("2026-11-13T12:00:00Z");
const access: WorkSummaryAccess = { principal: "operator", repos: null, includeUnplaced: true };
const stores: Store[] = [];
afterEach(() => { for (const one of stores.splice(0)) one.close(); });

/** One family: a root task and `versions - 1` revisions of it, each with the root's revision brief. */
function family(versions: number): Store {
  const store = openStore(":memory:");
  stores.push(store);
  store.transact(() => {
    store.createTask({ id: "root", title: "root" }, now);
    const root = store.refFor("built-in", "root").id;
    const run = store.startRun({ taskRef: root, leaseId: "source", runner: "builder", branch: "fixture/revision", worktree: "/tmp/none",
      role: "builder", route: { phase: "build", routeDigest: "legacy", provider: "claude", model: null, chosen: "legacy" }, now });
    store.finishRun(run, { outcome: "built", now });
    const brief = store.saveArtifact({ run, kind: "revision-brief", key: "brief.json", sha256: "c".repeat(64), bytesOriginal: 0, bytesStored: 0, truncated: false, capture: "synthetic revision" }, now);
    for (let at = 1; at < versions; at++) {
      store.createTask({ id: `v${at}`, title: `v${at}` }, new Date(now.getTime() + at * 1000));
      store.markRevision(store.refFor("built-in", `v${at}`).id, "root", brief);
    }
  });
  return store;
}

/** The fastest of a few reads of the list and the cockpit's rows, in ms. */
function readTime(store: Store): number {
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const started = performance.now();
    const page = workIndexPage(store, now, access);
    workStateRows(store, now, access);
    best = Math.min(best, performance.now() - started);
    expect(page.items.length).toBe(1);
  }
  return best;
}

test("a family of 3,000 versions reads in a small multiple of one of 1,000", () => {
  const small = family(1000), large = family(3000);
  // Both read whole: one family, every version counted.
  expect(workIndexPage(small, now, access).items[0]?.versionCount).toBe(1000);
  expect(workIndexPage(large, now, access).items[0]?.versionCount).toBe(3000);
  expect(workStateRows(large, now, access)[0]?.members.length).toBe(3000);
  const ratio = readTime(large) / readTime(small);
  console.log(`work index: 3,000-version family reads in ${ratio.toFixed(2)}x the time of a 1,000-version one`);
  expect(ratio).toBeLessThan(6);
}, 120_000);
