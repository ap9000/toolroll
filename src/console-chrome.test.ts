/**
 * Console responsiveness (docs/plans/isolated-checks.md, "Console responsiveness (0.9.78)"): the shared chrome cache
 * never hands one reader's scope to another and never outlives a database change; on an owner-shaped database the
 * chrome's reads, a cached read and /board stay under budget; and the work index never scans the whole action ledger.
 * Budgets carry ~3-4x headroom over a 2026 MacBook (this file prints what it measured) so a slower CI machine still
 * passes; a regression of the 0.9.76 kind (10x) fails them. The synthetic shape is heavier than the owner's where it
 * matters most: no family is complete, so the sidebar reads every waiting result's checks.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { accessKey, countsKey, projectSummaryOf, RevisionCache, summaryKey } from "./console-chrome.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { workCountsByProject, workIndexPage } from "./work-index.js";
import { prepareWorkspaceRevision } from "./workspace-revision.js";
import { seedOwnerShapedStore } from "../test/owner-shaped-store.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");
let dir: string, store: Store, repos: readonly string[], token: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "so-console-chrome-"));
  store = openStore(join(dir, "orders.db"));
  repos = seedOwnerShapedStore(store, NOW).repos;
  const added = addApprover(store, "alex", NOW);
  if (!added.ok) throw new Error("bootstrap");
  token = added.token;
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** The median of `runs` timed calls after one warm-up, in milliseconds. */
async function median(read: () => unknown, runs = 5): Promise<number> {
  await read();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) { const started = performance.now(); await read(); times.push(performance.now() - started); }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

test("the cache keys every authorization input, and a database change or the clock's boundary ends an entry", () => {
  let revision = "v1:1", boundary = NOW.getTime() + 60_000, now = NOW.getTime();
  const cache = new RevisionCache({ current: () => revision, expiresAt: () => boundary }, () => new Date(now), { maxAgeMs: 30_000 });
  const alex = { principal: "operator" as const, repos: ["/a", "/b"], includeUnplaced: true, viewer: "alex" };
  const narrowed = [
    { ...alex, repos: ["/a"] }, { ...alex, includeUnplaced: false }, { ...alex, viewer: "robin" }, { ...alex, repos: null },
    { ...alex, dependencyRepos: ["/a"] }, { principal: "coordinator" as const, repos: ["/a", "/b"] },
  ];
  // The same scope in another order is the same key; any narrower or other scope is another.
  expect(accessKey({ ...alex, repos: ["/b", "/a"] })).toBe(accessKey(alex));
  for (const one of narrowed) expect(accessKey(one)).not.toBe(accessKey(alex));
  expect(summaryKey("alex", alex, [{ path: "/a", name: "a" }])).not.toBe(summaryKey("robin", alex, [{ path: "/a", name: "a" }]));
  expect(summaryKey("alex", alex, [{ path: "/a", name: "a" }])).not.toBe(summaryKey("alex", alex, [{ path: "/a", name: "a" }, { path: "/b", name: "b" }]));

  let reads = 0;
  const read = (key: string) => cache.read(key, () => `${key}#${++reads}`);
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#1`);
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#1`);
  expect(read(countsKey(narrowed[0]!))).toBe(`${countsKey(narrowed[0]!)}#2`);
  revision = "v1:2";
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#3`);
  boundary = now + 1_000;
  revision = "v1:3";
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#4`);
  now += 1_000;
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#5`);
  boundary = Infinity;
  now += 30_000;
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#6`);
  now += 29_999;
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#6`);
  now += 1;
  expect(read(countsKey(alex))).toBe(`${countsKey(alex)}#7`);
  // A failed read is never kept.
  expect(() => cache.read("broken", () => { throw new Error("no"); })).toThrow("no");
  expect(cache.read("broken", () => "ok")).toBe("ok");
});

test("an entry read at one revision is never served after a commit from another connection", () => {
  const other = openStore(join(dir, "orders.db"));
  try {
    const revision = prepareWorkspaceRevision(store);
    const cache = new RevisionCache(revision, () => NOW);
    const access = { principal: "operator" as const, repos: null, includeUnplaced: true, viewer: "alex" };
    const first = cache.read(countsKey(access), () => workCountsByProject(store, NOW, access));
    expect(cache.read(countsKey(access), () => { throw new Error("recomputed"); })).toBe(first);
    other.createTask({ id: "late-arrival", title: "Arrives from the worker" }, NOW);
    const again = cache.read(countsKey(access), () => workCountsByProject(store, NOW, access));
    expect(again).not.toBe(first);
    expect(again.reduce((sum, one) => sum + one.totals.all, 0)).toBe(first.reduce((sum, one) => sum + one.totals.all, 0) + 1);
  } finally { other.close(); }
});

test.each(["revision", "expiry", "unreadable"] as const)("an in-flight chrome read is discarded after %s changes", async change => {
  let revision = "v1:1", time = NOW.getTime(), unreadable = false;
  const cache = new RevisionCache({ current: () => { if (unreadable) throw new Error("unavailable"); return revision; }, expiresAt: () => NOW.getTime() + 1_000 }, () => new Date(time));
  let answer!: (value: string) => void;
  const pending = cache.fill("needs-you", () => new Promise<string>(resolve => { answer = resolve; }));
  if (change === "revision") revision = "v1:2";
  if (change === "expiry") time += 1_000;
  if (change === "unreadable") unreadable = true;
  answer("old approval");
  expect(await pending).toBeUndefined();
  unreadable = false;
  expect(cache.peek("needs-you")).toBeUndefined();
});

test("on an owner-shaped database the chrome's reads, a cached read and /board stay under budget", async () => {
  const access = { principal: "operator" as const, repos: null, includeUnplaced: true, viewer: "alex" };
  const projects = repos.map(path => ({ path, name: path.split("/").pop()! }));
  const counts = await median(() => workCountsByProject(store, NOW, access));
  const needsYou = await median(() => workIndexPage(store, NOW, access, { view: "needs-you", limit: 40 }));
  const summary = await median(() => projectSummaryOf(store, NOW, access, "alex", projects, undefined));
  const cache = new RevisionCache(prepareWorkspaceRevision(store), () => NOW);
  cache.read(summaryKey("alex", access, projects), () => projectSummaryOf(store, NOW, access, "alex", projects, undefined));
  const cached = await median(() => cache.read(summaryKey("alex", access, projects), () => { throw new Error("recomputed"); }));

  const server: Server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), clock: () => NOW });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let board = Infinity, boardChanged = Infinity;
  try {
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const read = async () => {
      const answer = await fetch(`${base}/board`, { headers: { cookie } });
      expect(answer.status).toBe(200);
      await answer.text();
    };
    // Nothing changed between views: the chrome is the cache's.
    board = await median(read);
    // A database change before each view: the chrome is read again every time.
    let n = 0;
    boardChanged = await median(async () => {
      store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: "budget probe", outcome: `${n++}`, source: "work" });
      await read();
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }

  const measured = { counts, needsYou, summary, cached, board, boardChanged };
  console.info(`console budgets (ms): ${JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`);
  expect(counts, "work index counts").toBeLessThan(150);
  expect(needsYou, "work index page (Needs you)").toBeLessThan(150);
  expect(summary, "sidebar project states").toBeLessThan(1_500);
  expect(cached, "cached chrome").toBeLessThan(30);
  expect(board, "/board render (chrome cached)").toBeLessThan(300);
  expect(boardChanged, "/board render after a database change").toBeLessThan(2_500);
});

test("the work index never scans the whole action ledger", () => {
  const fresh = openStore(":memory:");
  try {
    seedOwnerShapedStore(fresh, NOW);
    const access = { principal: "operator" as const, repos: null, includeUnplaced: true, viewer: "alex" };
    const raw = fresh.handle.prepare.bind(fresh.handle);
    const captured: { sql: string; params: unknown }[] = [];
    const spy = vi.spyOn(fresh.handle, "prepare").mockImplementation(sql => {
      const statement = raw(sql);
      if (!/\baction_ledger\b/.test(sql) || !/admitted AS MATERIALIZED/.test(sql)) return statement;
      return new Proxy(statement, { get(target, name) {
        const value = Reflect.get(target, name, target);
        if (name !== "all" && name !== "get") return typeof value === "function" ? value.bind(target) : value;
        return (...params: unknown[]) => { captured.push({ sql, params: params[0] }); return (value as (...args: unknown[]) => unknown).apply(target, params); };
      } });
    });
    try {
      workCountsByProject(fresh, NOW, access);
      workIndexPage(fresh, NOW, access, { view: "needs-you", limit: 40 });
      workIndexPage(fresh, NOW, access, { limit: 40, project: "/owner/app" });
    } finally { spy.mockRestore(); }
    expect(captured.length).toBeGreaterThanOrEqual(3);
    // The ledger's b-trees (the table and each of its indexes), by root page: aliases can't hide a read of them.
    const roots = new Map((raw("SELECT name, rootpage FROM sqlite_master WHERE tbl_name = 'action_ledger' AND rootpage > 0").all() as { name: string; rootpage: number }[])
      .map(row => [Number(row.rootpage), String(row.name)]));
    for (const { sql, params } of captured) {
      const program = raw(`EXPLAIN ${sql}`).all(params as never) as { opcode: string; p1: number; p2: number }[];
      // Every cursor opened on the ledger, then any loop that starts at one end of it (Rewind/Last: a walk of the whole
      // table or index — a plain SCAN, or the build of an automatic index) instead of seeking into it.
      const cursors = new Map<number, string>();
      for (const op of program) if ((op.opcode === "OpenRead" || op.opcode === "ReopenIdx") && roots.has(Number(op.p2))) cursors.set(Number(op.p1), roots.get(Number(op.p2))!);
      expect(cursors.size, "the work index reads the ledger").toBeGreaterThan(0);
      const walks = program.filter(op => (op.opcode === "Rewind" || op.opcode === "Last") && cursors.has(Number(op.p1))).map(op => `${op.opcode} ${cursors.get(Number(op.p1))}`);
      expect(walks, `the ledger is read by seeking an index, never walked:\n${walks.join("\n")}`).toEqual([]);
    }
  } finally { fresh.close(); }
});
