import { afterEach, expect, test, vi } from "vitest";
import { startMaintenance } from "./maintenance.js";
import { createSweepSupervisor } from "./storage-sweep-process.js";
import { hangingSweep } from "../test/sweep-process.js";

afterEach(() => vi.useRealTimers());
test("maintenance keeps its cadence with one hanging sweep and stop cancels it synchronously without awaiting close", async () => {
  vi.useFakeTimers();
  const fake = hangingSweep();
  const supervisor = createSweepSupervisor({ ...fake, timeoutMs: 1000, killGraceMs: 50 });
  const complete = vi.fn();
  const run = vi.fn(async () => {
    supervisor.start({ version: 1, databaseFile: "/synthetic/orders.db", poolRoot: null, tempRoots: [], actor: "worker", at: new Date().toISOString() }, complete);
  });
  const owner = {};
  const maintenance = startMaintenance({ intervalMs: 100, shouldStop: () => false, onError: error => { throw error; }, run, onStop: () => supervisor.stop() });
  try {
    await maintenance.runNow();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(4);
    expect(fake.launch).toHaveBeenCalledTimes(1);
    supervisor.stop(owner); // Another watch cannot stop a flight it does not own.
    expect(fake.signal).not.toHaveBeenCalled();
    const stopped = maintenance.stop();
    expect(fake.signal.mock.calls.map(call => call[1])).toEqual(["SIGKILL"]);
    await stopped;
    supervisor.stop(); // Repeated shutdown signals are idempotent even before close.
    expect(supervisor.running).toBe(true);
    expect(complete).toHaveBeenCalledExactlyOnceWith({ ok: false, reason: "stopped" });
    await maintenance.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(4);
    expect(fake.signal).toHaveBeenCalledTimes(1);
  } finally { await maintenance.stop(); fake.child.emit("close", null); }
});

test("a reconcile already in progress cannot launch a sweep after its maintenance owner stops", async () => {
  const fake = hangingSweep();
  const supervisor = createSweepSupervisor(fake);
  const owner = {};
  let resume!: () => void;
  const ready = new Promise<void>(resolve => { resume = resolve; });
  const started = vi.fn();
  const maintenance = startMaintenance({ intervalMs: 1000, shouldStop: () => false, onError: error => { throw error; },
    run: async () => {
      started();
      await ready;
      expect(supervisor.start({ version: 1, databaseFile: "/synthetic/orders.db", poolRoot: null, tempRoots: [], actor: "worker", at: new Date().toISOString() }, vi.fn(), owner)).toBe(false);
    },
    onStop: () => supervisor.stop(owner),
  });
  const running = maintenance.runNow();
  await Promise.resolve();
  expect(started).toHaveBeenCalledTimes(1);
  const stopped = maintenance.stop();
  resume();
  await Promise.all([running, stopped]);
  expect(fake.launch).not.toHaveBeenCalled();
});
