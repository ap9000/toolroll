/**
 * The daily storage sweep: one worker takes each day, every part runs whatever another did, a failure brings the next
 * sweep forward, and what it did is saved for `toolroll storage` and Settings → Storage. The worker's own pass runs it
 * without anyone running a command; the unit tests keep it off unless a test turns it on.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { run } from "./exec.js";
import { runOperate } from "./operate.js";
import { WorktreePool } from "./worktree.js";
import { storageHtml } from "./storage-ui.js";
import type { CheckoutPlan } from "./checkout-cleanup.js";
import { dailyStorageSweep, lastSweep, nextSweepAt, RETRY_MS, saveSweep, sweepDetails, sweepStorage, sweepWords, SWEEP_EVERY_MS, type SweepDeps, type SweepPart } from "./storage-sweep.js";

const DAY = 86_400_000;
let dir: string, file: string, store: Store, temp: string;
const before = process.env["TOOLROLL_STORAGE_SWEEP"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-sweep-"));
  file = join(dir, "orders.db");
  temp = join(dir, "tmp");
  mkdirSync(temp);
  store = openStore(file);
  // On for these tests: they sweep only their own folders.
  delete process.env["TOOLROLL_STORAGE_SWEEP"];
});
afterEach(() => {
  if (before === undefined) delete process.env["TOOLROLL_STORAGE_SWEEP"]; else process.env["TOOLROLL_STORAGE_SWEEP"] = before;
  try { store.close(); } catch { /* closed by the test */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Leftover test folders: `stale` untouched for two days, one fresh, one not a test's. */
function leftovers(stale: number): string[] {
  const old = new Date(Date.now() - 2 * DAY);
  const made: string[] = [];
  for (let at = 0; at < stale; at++) {
    const path = join(temp, `so-route-cli-${at}`);
    mkdirSync(path);
    writeFileSync(join(path, "db.sqlite"), "x");
    utimesSync(join(path, "db.sqlite"), old, old);
    utimesSync(path, old, old);
    made.push(path);
  }
  mkdirSync(join(temp, "no-wt-fresh"));
  mkdirSync(join(temp, "someone-elses"));
  utimesSync(join(temp, "someone-elses"), old, old);
  return made;
}

const deps = (more: Partial<SweepDeps> = {}): SweepDeps => ({ databaseFile: file, pool: null, tempRoots: [temp], census: () => [], locate: () => new Map(), inUse: () => [], ...more });

test("once a day, one worker takes the sweep; it removes stale test temp folders by itself and saves what it did", async () => {
  const stale = leftovers(3);
  const t0 = new Date();
  const first = await dailyStorageSweep(store, deps(), () => t0);
  expect(first).not.toBeNull();
  expect(first!.parts.find(one => one.kind === "test temp")).toMatchObject({ count: 3, failed: 0 });
  for (const path of stale) expect(existsSync(path)).toBe(false);
  expect(readdirSync(temp).sort()).toEqual(["no-wt-fresh", "someone-elses"]);
  // The same day: nobody's to take.
  expect(await dailyStorageSweep(store, deps(), () => new Date(t0.getTime() + DAY - 1))).toBeNull();
  expect(nextSweepAt(store)).toBe(new Date(t0.getTime() + SWEEP_EVERY_MS).toISOString());
  // Saved, and in the ledger.
  expect(lastSweep(store)).toMatchObject({ at: t0.toISOString(), source: "automatic", actor: "worker" });
  expect(sweepWords(lastSweep(store)!.parts)).toBe("Removed 3 test temp folders.");
  expect(store.actionLedger({ repos: null }).find(one => one.action === "storage sweep")).toMatchObject({ outcome: "removed", source: "policy", detail: "Removed 3 test temp folders." });
  // The next day it runs again; nothing due is said so (the fresh folder was touched that day).
  const nextDay = new Date(t0.getTime() + DAY);
  utimesSync(join(temp, "no-wt-fresh"), nextDay, nextDay);
  const next = await dailyStorageSweep(store, deps(), () => nextDay);
  expect(sweepWords(next!.parts)).toBe("Nothing was due.");
});

test("two workers on the same database: exactly one sweeps the day", async () => {
  leftovers(1);
  const other = openStore(file);
  try {
    const at = new Date();
    const both = await Promise.all([dailyStorageSweep(store, deps(), () => at), dailyStorageSweep(other, deps(), () => at)]);
    expect(both.filter(one => one !== null)).toHaveLength(1);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM storage_sweep").get()!["n"]).toBe(1);
  } finally { other.close(); }
});

test("turned off, the worker never sweeps", async () => {
  const stale = leftovers(1);
  process.env["TOOLROLL_STORAGE_SWEEP"] = "off";
  expect(await dailyStorageSweep(store, deps(), () => new Date())).toBeNull();
  expect(existsSync(stale[0]!)).toBe(true);
  expect(nextSweepAt(store)).toBeNull();
});

test("a part that fails is said, the others still run, and the next sweep comes an hour later", async () => {
  const stale = leftovers(1);
  const at = new Date();
  const swept = await dailyStorageSweep(store, deps({ census: () => { throw new Error("ps refused"); } }), () => at);
  expect(swept!.parts.find(one => one.kind === "orphans")).toMatchObject({ count: 0, problem: "the process list couldn't be read" });
  expect(existsSync(stale[0]!)).toBe(false);
  expect(sweepWords(swept!.parts)).toBe("Removed 1 test temp folder. Couldn't check processes.");
  expect(store.actionLedger({ repos: null }).find(one => one.action === "storage sweep")).toMatchObject({ outcome: "partial" });
  expect(await dailyStorageSweep(store, deps(), () => new Date(at.getTime() + RETRY_MS - 1))).toBeNull();
  expect(await dailyStorageSweep(store, deps(), () => new Date(at.getTime() + RETRY_MS))).not.toBeNull();
});

test("extra staged runtimes are swept; with no runtime in use, every runtime stays and the sweep says why", async () => {
  const staged = join(dir, "staged-upgrades");
  for (const [name, age] of [["browser-0", 12], ["browser-a", 9], ["browser-b", 5], ["browser-c", 1]] as const) {
    mkdirSync(join(staged, name, "runtime"), { recursive: true });
    const when = new Date(Date.now() - age * DAY).toISOString();
    writeFileSync(join(staged, name, "deployment.json"), JSON.stringify({ phase: "deployed", deployedAt: when }));
  }
  const refused = await sweepStorage(store, deps(), () => new Date());
  expect(refused.parts.find(one => one.kind === "runtimes")).toMatchObject({ count: 0, problem: "kept every staged runtime: no staged runtime is in use, so which one runs now is unknown" });
  const swept = await sweepStorage(store, deps({ inUse: () => [join(staged, "browser-b", "runtime", "dist", "cli.js")] }), () => new Date());
  // browser-b runs, browser-a was before it, browser-c is the newest.
  expect(swept.parts.find(one => one.kind === "runtimes")).toMatchObject({ count: 1, failed: 0, items: [join(realpathSync(staged), "browser-0")] });
  expect(readdirSync(staged).sort()).toEqual(["browser-a", "browser-b", "browser-c"]);
});

test("the worker's own pass sweeps by itself, and toolroll storage shows what and when", async () => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["commit", "-q", "--allow-empty", "-m", "first"]]) await run("git", args, { cwd: repo });
  register(store, { name: "builder-1", host: "test", now: new Date() });
  store.close();
  const stale = leftovers(2);
  const options = { databaseFile: file, evidenceRoot: join(dir, "evidence"), tempRoots: [temp] };
  let lines: string[] = [];
  const cli = async (command: string, argv: string[]) => { lines = []; const code = await runOperate(command, argv, line => { lines.push(line); }, options); return { code, out: lines.join("\n") }; };
  const empty = await cli("storage", []);
  expect(empty.out).toContain("Automatic sweep: not run yet; it runs once a day.");
  const pass = await cli("reconcile", ["--repo", repo, "--pool", join(dir, "worktrees"), "--json"]);
  expect(pass.code).toBe(0);
  const result = JSON.parse(pass.out) as { storageSweep: { source: string; parts: SweepPart[] } };
  expect(result.storageSweep.source).toBe("automatic");
  expect(result.storageSweep.parts.find(one => one.kind === "test temp")).toMatchObject({ count: 2 });
  for (const path of stale) expect(existsSync(path)).toBe(false);
  const shown = await cli("storage", []);
  expect(shown.out).toMatch(/Last swept .+ automatically: Removed 2 test temp folders\./);
  expect(shown.out).toContain(`  ${stale[0]}`);
  const json = JSON.parse((await cli("storage", ["--json"])).out) as { sweep: { last: { source: string; parts: SweepPart[] }; next: string } };
  expect(json.sweep.last.source).toBe("automatic");
  expect(json.sweep.last.parts.map(one => one.kind)).toEqual(["test temp", "orphans", "checkouts", "runtimes", "dependencies"]);
  expect(Date.parse(json.sweep.next)).toBeGreaterThan(Date.now());
  // A second pass the same day doesn't sweep again.
  const again = JSON.parse((await cli("reconcile", ["--repo", repo, "--pool", join(dir, "worktrees"), "--json"])).out) as { storageSweep: unknown };
  expect(again.storageSweep).toBeNull();
  store = openStore(file);
});

const plan = (more: Partial<CheckoutPlan> = {}): CheckoutPlan => ({ at: new Date().toISOString(), cleanup: "finished", manual: true, go: [], stay: [], count: 0, totalBytes: 0, freeBytes: 0, waitingReview: 0, withChanges: 0, ...more });
const part = (kind: SweepPart["kind"], count: number, more: Partial<SweepPart> = {}): SweepPart => ({ kind, count, bytes: 0, failed: 0, items: [], ...more });

test("Settings → Storage says when the last sweep ran and what it did, in one line; its paths sit behind Details", () => {
  const view = (last: Parameters<typeof storageHtml>[0]["sweep"]) => storageHtml({ plan: plan(), csrf: "c".repeat(64), ...(last === undefined ? {} : { sweep: last }) }, {});
  expect(view({ last: null, off: false })).toContain("Toolroll sweeps leftovers once a day. It hasn't run yet.");
  expect(view({ last: null, off: true })).toContain("Automatic sweep is off.");
  const at = "2026-10-04T03:12:00.000Z";
  const normal = view({ last: { at, source: "automatic", actor: "worker", parts: [part("test temp", 104_990, { items: ["/tmp/so-route-cli-1"] }), part("orphans", 1, { items: ["node (4123), 4 days, in /state/worktrees/site/build-1"] }), part("checkouts", 2, { bytes: 600 * 1024 ** 2 })] } });
  expect(normal).toContain(`<time datetime="${at}">`);
  expect(normal).toContain("Removed 104,990 test temp folders and 2 finished checkouts, about 600 MB. Stopped 1 leftover process.");
  expect(normal).toContain("<summary>Details</summary>");
  expect(normal).toContain("node (4123), 4 days, in /state/worktrees/site/build-1");
  expect(normal).not.toContain('class="problem"');
  const nothing = view({ last: { at, source: "automatic", actor: "worker", parts: [part("test temp", 0)] } });
  expect(nothing).toContain("Nothing was due.");
  expect(nothing).not.toContain("<summary>Details</summary>");
  const failed = view({ last: { at, source: "automatic", actor: "worker", parts: [part("test temp", 3, { failed: 2 }), part("orphans", 0, { problem: "working folders couldn't be read: lsof could not list working folders" })] } });
  expect(failed).toContain('<p class="problem">');
  expect(failed).toContain("Removed 3 test temp folders. 2 couldn&#39;t be removed. Couldn&#39;t check processes.");
  expect(failed).toContain("Leftover processes: working folders couldn&#39;t be read");
  const manual = view({ last: { at, source: "manual", actor: "alex", parts: [part("checkouts", 1)] } });
  expect(manual).toContain("Cleaned up by alex");
  expect(view(undefined)).not.toContain("data-last-sweep");
});

test("the details list what each part did, cut short with a count, and what's left for later", () => {
  const items = Array.from({ length: 20 }, (_, at) => `/tmp/so-${at}`);
  expect(sweepDetails([part("test temp", 25, { items, more: true })])).toEqual(["More test temp folders are left for the next sweep.", ...items, "… and 5 more test temp folders"]);
  saveSweep(store, { at: new Date().toISOString(), source: "manual", actor: "alex", parts: [part("checkouts", 0)] });
  expect(lastSweep(store, "automatic")).toBeNull();
  expect(lastSweep(store)).toMatchObject({ source: "manual", actor: "alex" });
});
