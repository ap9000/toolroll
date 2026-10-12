import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { vi } from "vitest";
import { createSweepSupervisor, type SweepCompletion, type SweepSupervisor } from "../src/storage-sweep-process.js";
import { fakePid } from "./fake-pid.js";

/** IPC/process seam: a child that stays alive until a test delivers close. Signals never reach real PIDs. */
export function hangingSweep() {
  const events = new EventEmitter();
  const child = Object.assign(events, { pid: fakePid(), send: vi.fn((_request, done) => done(null)) }) as unknown as ChildProcess;
  const launch = vi.fn(() => child);
  const signal = vi.fn();
  return { child, launch, signal };
}

/** Observe a completion without making automatic reconciliation await it. */
export function observeSweep(delegate: SweepSupervisor = createSweepSupervisor()) {
  let resolve!: (result: SweepCompletion) => void;
  const completed = new Promise<SweepCompletion>(done => { resolve = done; });
  const supervisor: SweepSupervisor = {
    get running() { return delegate.running; },
    stop: owner => delegate.stop(owner),
    start: (request, complete, owner) => delegate.start(request, result => { complete(result); resolve(result); }, owner),
  };
  return { supervisor, completed };
}
