/** The Tasks list's reads prepare on the SQLite this Node bundles. SQLite 3.54 (bundled from Node 22.23, 24.22 and
 * 26.13 on) refuses a statement once its CTE references have opened SQLITE_LIMIT_EXPR_DEPTH (1000) cursors: Toolroll
 * 0.9.105 stopped with "VIEWs and/or subqueries nested too deep" as soon as a project was added (work-index.ts
 * ONE_READ). Every read here runs on the running Node's own SQLite, and where node:sqlite can lower the limit, every
 * statement those reads prepare still prepares under a third of it, so the next CTE added fails here, not on a
 * person's computer. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDemoRepos, seedDemo } from "./demo.js";
import { openStore, type Store } from "./store.js";
import { workCountsByProject, workIndexPage, workIndexTask, workOutcomeRows, workReadyForReview, workStateRows, workTidyRows } from "./work-index.js";
import type { WorkSummaryAccess } from "./work-summary.js";

/** A third of SQLite's default (and largest) SQLITE_LIMIT_EXPR_DEPTH. */
const HEADROOM = 333;

type Handle = { prepare(sql: string): unknown; limits?: { exprDepth: number } };

let root: string;
let store: Store;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-sqlite-compat-")));
  store = openStore(join(root, "orders.db"));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

/** Every work-index read, on the demo's work, and each statement text it prepared. */
function readEverything(): string[] {
  const now = new Date();
  store.recordInstallationFact("demo", "1", now);
  const repos = makeDemoRepos(root);
  mkdirSync(join(root, "evidence"), { recursive: true });
  const seed = seedDemo(store, repos, join(root, "evidence"), now);
  const handle = store.handle as unknown as Handle;
  const original = handle.prepare.bind(handle);
  const prepared = new Set<string>();
  handle.prepare = (sql: string) => { prepared.add(sql); return original(sql); };
  try {
    const operator: WorkSummaryAccess = { principal: "operator", repos: null, includeUnplaced: true, viewer: "demo" };
    const coordinator: WorkSummaryAccess = { principal: "coordinator", repos: [repos.api] };
    for (const access of [operator, coordinator]) {
      for (const view of ["all", "needs-you", "ready", "running", "queued", "completed", "archived"] as const) {
        const first = workIndexPage(store, now, access, { view, limit: 2 });
        if (first.nextCursor !== null) workIndexPage(store, now, access, { view, limit: 2, cursor: first.nextCursor });
      }
      const all = workIndexPage(store, now, access, { project: repos.api, state: "queued", completedSince: now.toISOString() });
      expect(all.totals.all).toBeGreaterThanOrEqual(0);
      workCountsByProject(store, now, access);
      workStateRows(store, now, access);
      workTidyRows(store, now, access);
      workReadyForReview(store, now, access);
      workOutcomeRows(store, now, access, repos.api, new Date(now.getTime() - 86_400_000).toISOString(), 5);
    }
    const listed = workIndexPage(store, now, operator, { limit: 50 });
    expect(listed.items.length).toBeGreaterThan(0);
    const one = listed.items[0]!;
    expect(workIndexTask(store, one.activeTaskId, now, operator)?.rootId).toBe(one.rootId);
    workIndexPage(store, now, operator, { roots: [one.rootId], root: one.rootId });
    expect(seed).toBeDefined();
  } finally {
    handle.prepare = original;
  }
  return [...prepared];
}

test(`every Tasks list read prepares and runs on this Node's SQLite (${process.versions.sqlite})`, () => {
  const statements = readEverything();
  // The projection's reads are among them: the page, the counts, the cockpit's rows, Activity and tidy.
  expect(statements.filter(sql => sql.includes("ranked AS MATERIALIZED")).length).toBeGreaterThanOrEqual(6);
});

test("each statement those reads prepare fits in a third of SQLite's nesting limit", () => {
  const statements = readEverything();
  const handle = store.handle as unknown as Handle;
  // node:sqlite exposes the limits from Node 24 on; an older Node's SQLite is checked by the read above.
  if (handle.limits === undefined) return;
  const before = handle.limits.exprDepth;
  expect(before).toBe(1000);
  const refused: string[] = [];
  handle.limits.exprDepth = HEADROOM;
  try {
    for (const sql of statements) {
      try { handle.prepare(sql); } catch (error) { refused.push(`${String(error)}: ${sql.slice(0, 120)}`); }
    }
  } finally {
    handle.limits.exprDepth = before;
  }
  expect(refused).toEqual([]);
});
