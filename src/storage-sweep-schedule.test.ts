/**
 * When the automatic sweep starts: once due, only while nothing is running or waiting (or 48 hours after the last), only
 * from the long-lived service, looked at no more than every 15 minutes, with the idle gates asked again where the claim
 * is made; and the one line `toolroll storage` and Settings → Storage say about it.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireIfReady } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approve } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { saveSweep, SWEEP_CURSOR, SWEEP_EVERY_MS, RETRY_MS, type SweepRecord } from "./storage-sweep.js";
import type { SweepCompletion, SweepSupervisor } from "./storage-sweep-process.js";
import { idleStorageSweep, sweepBusy, sweepSchedule, sweepScheduleWords, SWEEP_CHECK_MS, SWEEP_FORCE_MS, type SweepSchedule } from "./storage-sweep-schedule.js";

const T0 = new Date("2026-10-12T09:00:00.000Z");
const HOUR = 3_600_000;
const REPO = resolve("sweep-schedule-test-repo");
const TOKEN = "runner-token";
const service = {};
let dir: string, file: string, store: Store, approverToken: string;
const before = process.env["TOOLROLL_STORAGE_SWEEP"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-sweep-schedule-"));
  file = join(dir, "orders.db");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  store = openStore(file);
  vi.useRealTimers();
  delete process.env["TOOLROLL_STORAGE_SWEEP"];
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const added = addApprover(store, "operator", T0);
  if (!added.ok) throw new Error("approver bootstrap refused");
  approverToken = added.token;
});
afterEach(() => {
  if (before === undefined) delete process.env["TOOLROLL_STORAGE_SWEEP"]; else process.env["TOOLROLL_STORAGE_SWEEP"] = before;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A flight that records each launch and completes only when the test says so. */
function flight() {
  const launched: { at: string; complete: (result: SweepCompletion) => void }[] = [];
  const supervisor: SweepSupervisor = { running: false, stop() {}, start: (request, complete) => { launched.push({ at: request.at, complete }); return true; } };
  return { supervisor, launched };
}

const record = (at: Date): SweepRecord => ({ at: at.toISOString(), source: "automatic", actor: "worker", parts: [{ kind: "test temp", count: 0, bytes: 0, failed: 0, items: [] }] });
/** The last automatic sweep ran (and finished cleanly) at `at`. */
const sweptAt = (at: Date) => { saveSweep(store, record(at)); store.setServiceCursor(SWEEP_CURSOR, at.getTime(), at); };
const sweep = (at: Date, supervisor: SweepSupervisor, owner: object | null = service) =>
  idleStorageSweep(store, { databaseFile: file, pool: null, tempRoots: [], ...(owner === null ? {} : { owner }) }, () => at, supervisor);
/** An open run (a review: no checkout needed), as a worker's would be. */
function openRun(id: string, at: Date): void {
  const ref = store.refFor("built-in", id, "ours").id;
  store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, role, started_at) VALUES (?, ?, 'worker', 'reviewer', ?)").run(ref, `lease-${id}`, at.toISOString());
}

/** A placed, scoped task; signed unless `signed` is false. */
function task(id: string, signed = true): number {
  store.createTask({ id, title: id }, T0);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  store.saveScope({ taskId: id, goal: `finish ${id}`, outOfScope: null, touches: [], acceptance: [], proposedAt: T0.toISOString(), digest: `digest-${id}`, approvedAt: null, approvedBy: null, approvedDigest: null });
  if (signed && !approve(store, id, "operator", T0, store.getScope(id)?.digest ?? "", approverToken).ok) throw new Error("approval refused");
  return ref;
}
const worker = (now: Date) => register(store, { name: "worker", host: "test", capacity: 1, repos: [REPO], now, newToken: () => TOKEN });
const serviceLease = (now: Date) => store.acquireWatchLease("worker", REPO, "toolroll-service:watch-1", 10 * 60_000, now);

test("a due sweep waits while a run is open, a claim is live or a task could start now, and starts once nothing is", () => {
  const due = new Date(T0.getTime() + SWEEP_EVERY_MS);
  sweptAt(T0);
  // Not due yet: a day after the last sweep, never sooner.
  const early = flight();
  expect(sweep(new Date(due.getTime() - 1), early.supervisor)).toBeNull();
  expect(early.launched).toHaveLength(0);

  worker(due);
  const ref = task("t-ready");
  expect(sweepBusy(store, due)).toBe("ready");
  const waiting = flight();
  expect(sweep(due, waiting.supervisor)).toBeNull();
  expect(waiting.launched).toHaveLength(0);
  expect(store.serviceCursor(SWEEP_CURSOR)).toBe(T0.getTime());

  expect(acquireIfReady(store, ref, "worker", { token: TOKEN, repo: REPO, now: due, newLeaseId: () => "lease-1" }).ok).toBe(true);
  expect(sweepBusy(store, due)).toBe("claim");
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("fixture route missing");
  const run = store.startRun({ taskRef: ref, leaseId: "lease-1", runner: "worker", branch: "b", worktree: REPO, provider: authority.stamp.provider, route: authority.stamp, now: due });
  expect(sweepBusy(store, due)).toBe("run");
  expect(sweep(due, flight().supervisor)).toBeNull();

  const later = new Date(due.getTime() + HOUR);
  store.finishRun(run, { outcome: "built", committed: true, now: later });
  store.handle.prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = 'lease-1'").run(later.toISOString());
  store.setTaskState("t-ready", "done", later);
  expect(sweepBusy(store, later)).toBeNull();
  const idle = flight();
  expect(sweep(later, idle.supervisor)).toBeNull();
  expect(idle.launched.map(one => one.at)).toEqual([later.toISOString()]);
  expect(store.serviceCursor(SWEEP_CURSOR)).toBe(later.getTime());
});

test("work held by an approval, a hold or a provider limit is not waiting to start, so it never defers the sweep", () => {
  const due = new Date(T0.getTime() + SWEEP_EVERY_MS);
  sweptAt(T0);
  worker(due);
  task("t-unsigned", false);
  const held = task("t-held");
  store.hold(held, "waiting for the design", null, due);
  const limited = task("t-limited");
  store.stampQuota({ runner: "worker", provider: "claude", scope: "sonnet", reason: "membership window", resetAt: new Date(due.getTime() + 5 * HOUR) }, due);
  expect(store.listReady(due).map(one => one.externalId).sort()).toEqual(["t-limited", "t-unsigned"]);
  expect(limited).toBeGreaterThan(0);
  expect(sweepBusy(store, due)).toBeNull();
  const idle = flight();
  sweep(due, idle.supervisor);
  expect(idle.launched).toHaveLength(1);
});

test("the idle gates are asked again where the claim is made: work that starts after the first look still defers it", () => {
  const due = new Date(T0.getTime() + SWEEP_EVERY_MS);
  sweptAt(T0);
  const transact = store.transact.bind(store);
  // Between the first look and the claim, a run opens.
  const race = vi.spyOn(store, "transact").mockImplementationOnce(body => {
    openRun("t-race", due);
    return transact(body);
  });
  const raced = flight();
  expect(sweep(due, raced.supervisor)).toBeNull();
  race.mockRestore();
  expect(raced.launched).toHaveLength(0);
  expect(store.serviceCursor(SWEEP_CURSOR)).toBe(T0.getTime());
});

test("once due, the service looks no more than every 15 minutes", () => {
  const due = new Date(T0.getTime() + SWEEP_EVERY_MS);
  sweptAt(T0);
  openRun("t-busy", due);
  const one = flight();
  expect(sweep(due, one.supervisor)).toBeNull();
  store.handle.prepare("UPDATE run SET finished_at = ?, outcome = 'built'").run(due.toISOString());
  // Idle a minute later, but the last look was a minute ago.
  sweep(new Date(due.getTime() + 60_000), one.supervisor);
  expect(one.launched).toHaveLength(0);
  sweep(new Date(due.getTime() + SWEEP_CHECK_MS), one.supervisor);
  expect(one.launched).toHaveLength(1);
});

test("48 hours after the last automatic sweep it runs even while work is running; a failed one retries an hour later", () => {
  sweptAt(T0);
  openRun("t-busy", T0);
  const almost = new Date(T0.getTime() + SWEEP_FORCE_MS - 1);
  const waiting = flight();
  expect(sweep(almost, waiting.supervisor)).toBeNull();
  expect(waiting.launched).toHaveLength(0);
  const forced = new Date(T0.getTime() + SWEEP_FORCE_MS);
  const going = flight();
  sweep(forced, going.supervisor);
  expect(going.launched).toHaveLength(1);
  // It timed out: saved, and due again an hour later; the busy gate applies again because this sweep just ran.
  going.launched[0]!.complete({ ok: false, reason: "timeout" });
  expect(store.serviceCursor(SWEEP_CURSOR)).toBe(forced.getTime() - SWEEP_EVERY_MS + RETRY_MS);
  const retry = flight();
  expect(sweep(new Date(forced.getTime() + RETRY_MS), retry.supervisor)).toBeNull();
  expect(retry.launched).toHaveLength(0);
});

test("a one-shot caller (no service owner) never claims a due sweep, so the service still can", () => {
  const due = new Date(T0.getTime() + SWEEP_EVERY_MS);
  sweptAt(T0);
  const once = flight();
  expect(sweep(due, once.supervisor, null)).toBeNull();
  expect(once.launched).toHaveLength(0);
  expect(store.serviceCursor(SWEEP_CURSOR)).toBe(T0.getTime());
  const owned = flight();
  sweep(due, owned.supervisor);
  expect(owned.launched).toHaveLength(1);
  const finished = new Date(due.getTime() + 1000);
  owned.launched[0]!.complete({ ok: true, record: record(finished) });
  store.close();
  store = openStore(file);
  expect(sweepSchedule(store, finished)).toMatchObject({ state: "no-service", lastAt: finished.toISOString() });
  expect(store.handle.prepare("SELECT count(*) AS n FROM storage_sweep").get()!.n).toBe(2);
  expect(sweep(finished, owned.supervisor, null)).toBeNull();
  expect(owned.launched).toHaveLength(1);
});

test("a never-swept installation forces at 48 hours from creation, even after reopening and a delayed first service pass", () => {
  expect(store.installationFact("installed-at")).toBe(T0.toISOString());
  store.close();
  store = openStore(file);
  openRun("t-busy", T0);
  for (const hours of [24, 47]) {
    const waiting = flight();
    sweep(new Date(T0.getTime() + hours * HOUR), waiting.supervisor);
    expect(waiting.launched).toHaveLength(0);
    expect(store.serviceCursor(SWEEP_CURSOR)).toBe(0);
  }
  const later = flight();
  sweep(new Date(T0.getTime() + SWEEP_FORCE_MS), later.supervisor);
  expect(later.launched).toHaveLength(1);
});

test.each([false, true])("completion after claim immediately reports recent or retry (failure=%s)", failed => {
  const going = flight();
  let now = T0;
  idleStorageSweep(store, { databaseFile: file, pool: null, tempRoots: [], owner: service }, () => now, going.supervisor);
  now = new Date(T0.getTime() + 60_000);
  serviceLease(now);
  expect(sweepSchedule(store, now).state).toBe("sweeping");
  const result = record(now);
  if (failed) result.parts[0]!.failed = 1;
  going.launched[0]!.complete({ ok: true, record: result });
  for (const elapsed of [0, HOUR / 2]) {
    const at = new Date(now.getTime() + elapsed);
    serviceLease(at);
    expect(sweepSchedule(store, at)).toMatchObject({ state: failed ? "retry" : "recent", lastAt: now.toISOString(),
      nextAt: new Date(failed ? now.getTime() + RETRY_MS : T0.getTime() + SWEEP_EVERY_MS).toISOString() });
  }
});

test("only a live unbounded service lease counts as a running service", () => {
  worker(T0);
  store.acquireWatchLease("worker", REPO, "bounded-watch", 60_000, T0);
  expect(sweepSchedule(store, T0).state).toBe("no-service");
  const later = new Date(T0.getTime() + 60_000);
  serviceLease(later);
  expect(sweepSchedule(store, later).state).toBe("due");
  expect(sweepSchedule(store, new Date(later.getTime() + 10 * 60_000)).state).toBe("no-service");
});

test("the status says when it last ran and why it waits: off, no service, sweeping, recent, retry, busy, due and forced", () => {
  const words = (schedule: SweepSchedule) => sweepScheduleWords(schedule, at => at.slice(11, 16));
  expect(sweepSchedule(store, T0)).toMatchObject({ state: "no-service", lastAt: null, nextAt: null });
  expect(words(sweepSchedule(store, T0))).toBe("waiting: no Toolroll service running.");
  expect(sweepSchedule(store, T0, { TOOLROLL_STORAGE_SWEEP: "off" })).toMatchObject({ state: "off" });
  expect(words(sweepSchedule(store, T0, { TOOLROLL_STORAGE_SWEEP: "off" }))).toBe("off.");
  // Claimed and not saved yet: sweeping, whether or not a service is live.
  store.setServiceCursor(SWEEP_CURSOR, T0.getTime(), T0);
  expect(words(sweepSchedule(store, new Date(T0.getTime() + 60_000)))).toBe("sweeping now.");
  saveSweep(store, record(T0));
  const soon = new Date(T0.getTime() + HOUR);
  expect(sweepSchedule(store, soon)).toMatchObject({ state: "no-service", lastAt: T0.toISOString(), nextAt: new Date(T0.getTime() + SWEEP_EVERY_MS).toISOString() });
  worker(soon);
  serviceLease(soon);
  expect(words(sweepSchedule(store, soon))).toBe("swept recently, next due 09:00.");
  const failure = record(soon);
  failure.parts[0]!.failed = 1;
  saveSweep(store, failure);
  store.setServiceCursor(SWEEP_CURSOR, soon.getTime() - SWEEP_EVERY_MS + RETRY_MS, soon);
  expect(words(sweepSchedule(store, soon))).toBe("retry due 11:00.");
  saveSweep(store, record(T0));
  const due = new Date(T0.getTime() + SWEEP_EVERY_MS);
  store.setServiceCursor(SWEEP_CURSOR, T0.getTime(), T0);
  serviceLease(due);
  worker(due);
  expect(words(sweepSchedule(store, due))).toBe("due; it starts within 15 minutes while nothing is running.");
  task("t-ready");
  expect(sweepSchedule(store, due)).toMatchObject({ state: "busy", busy: "ready" });
  expect(words(sweepSchedule(store, due))).toBe("due, waiting: a task is ready to start.");
  const forced = new Date(T0.getTime() + SWEEP_FORCE_MS);
  serviceLease(forced);
  expect(words(sweepSchedule(store, forced))).toBe("over 48 hours since the last sweep; it runs at the next check even if work is running.");
  // Reading the status never claims or writes anything.
  expect(store.serviceCursor(SWEEP_CURSOR)).toBe(T0.getTime());
  expect(sweepScheduleWords({ state: "busy", busy: "run", lastAt: null, nextAt: null }, String)).toBe("due, waiting: work is running.");
  expect(sweepScheduleWords({ state: "busy", busy: "claim", lastAt: null, nextAt: null }, String)).toBe("due, waiting: a worker is starting a task.");
});
