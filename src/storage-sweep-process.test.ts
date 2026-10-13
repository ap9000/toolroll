import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { startMaintenance } from "./maintenance.js";
import { quarantineEntries } from "./sweep-quarantine.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { lastSweep, nextSweepAt, RETRY_MS, type SweepDeps, type SweepRecord } from "./storage-sweep.js";
import { idleStorageSweep } from "./storage-sweep-schedule.js";
import { createSweepSupervisor, storageSweepSupervisor, enterSweepBackground, sweepBackground, SWEEP_NICE, sweepRequest, sweepResponse, type SweepRequest, type SweepSupervisor } from "./storage-sweep-process.js";
import { hangingSweep, observeSweep } from "../test/sweep-process.js";
import { sweepObservations } from "../test/sweep-observations.js";

// The service's pass: only a caller with an owner claims a sweep (storage-sweep-schedule.ts).
const service = {};
const dailyStorageSweep = (store: Store, deps: SweepDeps, now: () => Date, supervisor?: SweepSupervisor) => idleStorageSweep(store, { owner: service, ...deps }, now, supervisor);

let root: string, databaseFile: string, store: Store;
const cleanups: (() => void)[] = [];
const children: ChildProcess[] = [];
const forkFixture = (name: string, args: string[] = []) => {
  const child = fork(new URL(`../test/fixtures/sweep-lifecycle/${name}.mjs`, import.meta.url), args, {
    detached: true, stdio: ["ignore", "pipe", "ignore", "ipc"], execArgv: [],
  });
  children.push(child);
  return child;
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-sweep-child-")));
  databaseFile = join(root, "orders.db");
  store = openStore(databaseFile);
  const off = process.env.TOOLROLL_STORAGE_SWEEP;
  delete process.env.TOOLROLL_STORAGE_SWEEP;
  cleanups.push(() => { if (off === undefined) delete process.env.TOOLROLL_STORAGE_SWEEP; else process.env.TOOLROLL_STORAGE_SWEEP = off; });
});
afterEach(async () => {
  storageSweepSupervisor(databaseFile).stop();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, "close");
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    await closed;
  }
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("parent heartbeat and database renewals continue while the production child blocks in du during a large sweep", async () => {
  const temp = join(root, "tmp");
  mkdirSync(temp);
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 300; i++) {
    const folder = join(temp, `so-heavy-${i}`);
    mkdirSync(folder); writeFileSync(join(folder, "payload"), "synthetic leftover");
    utimesSync(join(folder, "payload"), old, old); utimesSync(folder, old, old);
  }
  const copy = join(root, "deps", "a".repeat(24));
  mkdirSync(join(copy, "node_modules"), { recursive: true });
  writeFileSync(join(copy, "ready.json"), JSON.stringify({ version: 1, repo: "/synthetic", key: "a".repeat(24), lock: "x", node: "v22", setup: "s", tree: null, createdAt: old.toISOString() }));
  for (let i = 0; i < 128; i++) writeFileSync(join(copy, "node_modules", `payload-${i}`), "x".repeat(8192));
  utimesSync(join(copy, "ready.json"), old, old);
  const duGate = { entered: join(root, "entered"), release: join(root, "release"), result: join(root, "du-result") };
  const observations = sweepObservations(root);
  cleanups.push(observations.restore);
  observations.write([], { duGate });
  let settled = false;
  const flight = observeSweep();
  cleanups.push(() => flight.supervisor.stop());
  const sweep = flight.completed.finally(() => { settled = true; });
  expect(dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [temp] }, () => new Date(), flight.supervisor)).toBeNull();
  // Behind everything else: the child's own work, like the du/rm it starts, runs at a positive nice.
  // Its 300 removals before du run under the background policy, which a busy machine (a CI runner in the middle of the
  // suite) holds back by design; the suite's own limit still bounds the test.
  await vi.waitFor(() => expect(existsSync(duGate.entered)).toBe(true), { timeout: 60_000 });
  const entered = JSON.parse(readFileSync(duGate.entered, "utf8")) as { nice: number; startedBackground: boolean | null; background: boolean | null };
  expect(entered.nice).toBeGreaterThanOrEqual(SWEEP_NICE);
  // On macOS the work runs under the background policy, but Node's own start doesn't wait behind everything else first.
  if (process.platform === "darwin") expect([entered.startedBackground, entered.background]).toEqual([false, true]);
  const during: boolean[] = [];
  const heartbeat = setInterval(() => {
    if (!existsSync(duGate.entered)) return;
    during.push(!settled);
    store.setServiceCursor("synthetic-lease-renewal", during.length, new Date());
    if (during.length === 3) { writeFileSync(duGate.release, "renewed"); clearInterval(heartbeat); }
  }, 10);
  cleanups.push(() => clearInterval(heartbeat));
  expect((await sweep).ok).toBe(true);
  const record = lastSweep(store)!;
  expect(JSON.parse(readFileSync(duGate.result, "utf8"))).toEqual({ released: true });
  expect(during).toEqual([true, true, true]);
  expect(store.serviceCursor("synthetic-lease-renewal")).toBe(3);
  expect(record.parts.find(one => one.kind === "test temp")).toMatchObject({ count: 300 });
  expect(record.parts.find(one => one.kind === "dependencies")).toMatchObject({ count: 1 });
  expect(record.parts.filter(one => one.problem !== undefined || one.failed > 0)).toEqual([]);
  expect(existsSync(copy)).toBe(false);
  expect(lastSweep(store)).toEqual(record);
});

test("a production child failure is recorded without raw errors and retries after one hour", async () => {
  const at = new Date(), unavailable = join(root, "private-input-in-path", "missing.db");
  const failing = createSweepSupervisor();
  const flight = observeSweep({
    get running() { return failing.running; }, stop: () => failing.stop(),
    start: (request, complete) => failing.start({ ...request, databaseFile: unavailable }, complete),
  });
  dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [] }, () => at, flight.supervisor);
  await flight.completed;
  const record = lastSweep(store)!;
  expect(record.parts).toHaveLength(4);
  expect(record.parts.every(one => one.problem?.includes("some cleanup may have completed"))).toBe(true);
  expect(JSON.stringify(record)).not.toContain("private-input-in-path");
  expect(store.actionLedger({ repos: null }).find(one => one.action === "storage sweep")).toMatchObject({ outcome: "partial" });
  expect(nextSweepAt(store)).toBe(new Date(at.getTime() + RETRY_MS).toISOString());
  expect(dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [] }, () => new Date(at.getTime() + RETRY_MS - 1))).toBeNull();
  const observations = sweepObservations(root);
  cleanups.push(observations.restore);
  const retry = observeSweep();
  dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [] }, () => new Date(at.getTime() + RETRY_MS), retry.supervisor);
  expect((await retry.completed).ok).toBe(true);
  expect(lastSweep(store)!.parts.every(one => one.problem === undefined && one.failed === 0)).toBe(true);
});

test("the child works at low priority: it enters taskpolicy's background policy itself on macOS when present, else only the nice", () => {
  expect(sweepBackground(4242, "darwin", path => path === "/usr/sbin/taskpolicy")).toEqual({ file: "/usr/sbin/taskpolicy", args: ["-b", "-p", "4242"] });
  expect(sweepBackground(4242, "darwin", () => false)).toBeNull();
  expect(sweepBackground(4242, "linux", () => true)).toBeNull();
  const ran: [string, string[]][] = [];
  expect(enterSweepBackground((file, args) => { ran.push([file, args]); })).toBe(sweepBackground(process.pid) !== null);
  expect(ran).toEqual(sweepBackground(process.pid) === null ? [] : [["/usr/sbin/taskpolicy", ["-b", "-p", String(process.pid)]]]);
  // A taskpolicy that fails leaves the sweep running at its nice.
  expect(enterSweepBackground(() => { throw new Error("refused"); })).toBe(false);
  expect(SWEEP_NICE).toBeGreaterThan(0);
});

test("the child protocol rejects malformed, incomplete and mismatched results", () => {
  const request: SweepRequest = { version: 1, databaseFile, poolRoot: null, tempRoots: [root], actor: "test-operator", at: new Date().toISOString() };
  expect(sweepRequest(request)).toBe(true);
  expect(sweepRequest({ ...request, databaseFile: ":memory:" })).toBe(false);
  expect(sweepRequest({ ...request, tempRoots: [123] })).toBe(false);
  const record: SweepRecord = { at: request.at, actor: request.actor, source: "automatic", parts: ["test temp", "orphans", "runtimes", "dependencies"].map(kind => ({ kind: kind as SweepRecord["parts"][number]["kind"], count: 0, bytes: 0, failed: 0, items: [] })) };
  expect(sweepResponse({ version: 1, record }, request)).toBe(true);
  for (const wrong of [null, {}, { version: 2, record }, { version: 1, record: { ...record, actor: "someone else" } },
    { version: 1, record: { ...record, parts: record.parts.slice(1) } },
    { version: 1, record: { ...record, parts: record.parts.map(one => ({ ...one, count: -1 })) } },
    { version: 1, record: { ...record, parts: record.parts.map(one => ({ ...one, items: [null] })) } }]) expect(sweepResponse(wrong, request)).toBe(false);
});

const request = (databaseFile: string): SweepRequest => ({ version: 1, databaseFile, poolRoot: null, tempRoots: [], actor: "worker", at: new Date().toISOString() });
const valid = (req: SweepRequest) => ({ version: 1, record: { at: req.at, source: "automatic", actor: req.actor,
  parts: ["test temp", "orphans", "runtimes", "dependencies"].map(kind => ({ kind, count: 0, bytes: 0, failed: 0, items: [] })) } });

test("a hung child cannot overlap, times out through TERM/KILL, and saves once after the caller closes its store", async () => {
  vi.useFakeTimers();
  const fake = hangingSweep();
  const supervisor = createSweepSupervisor({ ...fake, timeoutMs: 1000, killGraceMs: 50 });
  cleanups.push(() => supervisor.stop());
  const at = new Date();
  const deps = { databaseFile, pool: null, tempRoots: [] };
  expect(dailyStorageSweep(store, deps, () => new Date(), supervisor)).toBeNull();
  expect(dailyStorageSweep(store, deps, () => new Date(at.getTime() + 2 * 86_400_000), supervisor)).toBeNull();
  expect(fake.launch).toHaveBeenCalledTimes(1);
  expect(lastSweep(store)).toBeNull();
  store.close();
  await vi.advanceTimersByTimeAsync(1000);
  store = openStore(databaseFile);
  expect(fake.signal.mock.calls.map(call => call[1])).toEqual(["SIGTERM"]);
  expect(lastSweep(store)!.parts.every(one => one.problem?.includes("exceeded its time limit"))).toBe(true);
  expect(nextSweepAt(store)).toBe(new Date(at.getTime() + 1000 + RETRY_MS).toISOString());
  expect(store.actionLedger({ repos: null }).find(one => one.action === "storage sweep")).toMatchObject({ outcome: "partial" });
  // The leader can exit on TERM while its descendants ignore it; KILL must still reach the whole group.
  fake.child.emit("message", valid(request(databaseFile)));
  fake.child.emit("close", 0);
  expect(supervisor.running).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(fake.signal.mock.calls.map(call => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
  expect(supervisor.running).toBe(false);
  expect(store.handle.prepare("SELECT count(*) AS n FROM storage_sweep").get()!.n).toBe(1);
});

test.each(["duplicate", "invalid", "error", "exit", "send", "spawn"])("%s failure settles once, redacts errors, and schedules a retry", async kind => {
  vi.useFakeTimers();
  const fake = hangingSweep();
  if (kind === "spawn") fake.launch.mockImplementation(() => { throw new Error("secret spawn argument"); });
  if (kind === "send") vi.mocked(fake.child.send).mockImplementation(() => { throw new Error("secret send argument"); });
  const supervisor = createSweepSupervisor({ ...fake, timeoutMs: 1000, killGraceMs: 50 });
  cleanups.push(() => supervisor.stop());
  const at = new Date();
  const result = dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [] }, () => at, supervisor);
  if (kind === "duplicate") { fake.child.emit("message", valid(request(databaseFile))); fake.child.emit("message", valid(request(databaseFile))); }
  if (kind === "invalid") fake.child.emit("message", { secret: "raw child data" });
  if (kind === "error") {
    fake.child.emit("error", new Error("secret process argument"));
    expect(() => fake.child.emit("error", new Error("late secret process argument"))).not.toThrow();
  }
  if (kind === "exit") fake.child.emit("close", 1);
  if (kind === "spawn" || kind === "send") expect(result).toEqual(lastSweep(store));
  else expect(result).toBeNull();
  expect(JSON.stringify(lastSweep(store))).not.toContain("secret");
  expect(lastSweep(store)!.parts.every(one => one.problem?.includes("valid result"))).toBe(true);
  expect(nextSweepAt(store)).toBe(new Date(at.getTime() + RETRY_MS).toISOString());
  await vi.advanceTimersByTimeAsync(1050);
  fake.child.emit("close", 0);
  expect(supervisor.running).toBe(false);
  expect(store.handle.prepare("SELECT count(*) AS n FROM storage_sweep").get()!.n).toBe(1);
});

test("one valid message only succeeds on a clean exit and saves through an independent store", () => {
  const fake = hangingSweep();
  const supervisor = createSweepSupervisor(fake);
  dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [] }, () => new Date(), supervisor);
  fake.child.emit("message", valid(request(databaseFile)));
  expect(lastSweep(store)).toBeNull();
  store.close();
  fake.child.emit("close", 0);
  store = openStore(databaseFile);
  expect(lastSweep(store)!.parts.every(one => one.problem === undefined)).toBe(true);
  expect(supervisor.running).toBe(false);
  expect(fake.signal).not.toHaveBeenCalled();
});

test("the deadline kills the real process group and a later sweep finishes partially deleted quarantine", async () => {
  const depsRoot = join(root, "deps");
  const original = join(depsRoot, "a".repeat(24));
  mkdirSync(original, { recursive: true });
  writeFileSync(join(original, "first"), "synthetic resource");
  writeFileSync(join(original, "second"), "synthetic resource");
  const child = forkFixture("hang", [original]);
  const [ready] = await once(child, "message");
  expect(ready.ready).toBe(true);
  expect(() => process.kill(ready.descendant, 0)).not.toThrow();
  const [trash] = quarantineEntries(depsRoot);
  expect(trash!.journal.deleting).toBe(true);
  expect(existsSync(original)).toBe(false);
  const closed = once(child, "close", { signal: AbortSignal.timeout(5000) });
  vi.useFakeTimers();
  const flight = observeSweep(createSweepSupervisor({ launch: () => child, timeoutMs: 1000, killGraceMs: 50 }));
  const at = new Date();
  dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [] }, () => new Date(), flight.supervisor);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await flight.completed).toEqual({ ok: false, reason: "timeout" });
  expect(() => process.kill(child.pid!, 0)).not.toThrow();
  expect(() => process.kill(ready.descendant, 0)).not.toThrow();
  expect(existsSync(trash!.path)).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  vi.useRealTimers();
  // close includes the stdout pipe the descendant inherited: killing just the leader cannot satisfy this.
  expect(await closed).toEqual([null, "SIGKILL"]);
  expect(flight.supervisor.running).toBe(false);
  expect(lastSweep(store)!.parts.every(one => one.problem?.includes("exceeded its time limit"))).toBe(true);
  expect(nextSweepAt(store)).toBe(new Date(at.getTime() + 1000 + RETRY_MS).toISOString());
  const observations = sweepObservations(root);
  cleanups.push(observations.restore);
  const retry = observeSweep();
  dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [] }, () => new Date(at.getTime() + 1000 + RETRY_MS), retry.supervisor);
  expect((await retry.completed).ok).toBe(true);
  expect(quarantineEntries(depsRoot)).toEqual([]);
  expect(existsSync(original)).toBe(false);
});

test("the production child exits promptly when its IPC parent disconnects", async () => {
  const child = forkFixture("child");
  await once(child, "message");
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
  child.disconnect();
  await exited;
  expect(() => process.kill(child.pid!, 0)).toThrow();
});

test("the parent-pid watchdog ends a real child even when filesystem work blocks IPC disconnect handling", async () => {
  const marker = join(root, "blocked");
  const parent = forkFixture("parent", [marker]);
  const [ready] = await once(parent, "message");
  const pid = ready.pid as number;
  cleanups.push(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } });
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
  const closed = once(parent, "close", { signal: AbortSignal.timeout(5000) });
  parent.send("exit");
  // The child inherited stdout, so parent's close cannot occur until the watchdog ends the blocked child too.
  expect(await closed).toEqual([0, null]);
});

test("maintenance stop returns before a real hanging child exits and kills its descendant group", async () => {
  const original = join(root, "synthetic-resource");
  mkdirSync(original);
  writeFileSync(join(original, "first"), "synthetic resource");
  const child = forkFixture("hang", [original]);
  await once(child, "message");
  const closed = once(child, "close", { signal: AbortSignal.timeout(5000) });
  const supervisor = createSweepSupervisor({ launch: () => child });
  const owner = {};
  const maintenance = startMaintenance({ intervalMs: 100, shouldStop: () => false, onError: error => { throw error; },
    run: async () => { dailyStorageSweep(store, { databaseFile, pool: null, tempRoots: [], owner }, () => new Date(), supervisor); },
    onStop: () => supervisor.stop(owner),
  });
  try {
    await maintenance.runNow();
    let exited = false;
    void closed.then(() => { exited = true; });
    await maintenance.stop();
    expect(exited).toBe(false);
    expect(lastSweep(store)!.parts.every(one => one.problem?.includes("stopped"))).toBe(true);
    expect(await closed).toEqual([null, "SIGKILL"]);
    expect(supervisor.running).toBe(false);
  } finally { await maintenance.stop(); }
});
