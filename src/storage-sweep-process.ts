/** The storage child's bounded IPC protocol. No paths or process arguments are written to logs. */
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SweepRecord } from "./storage-sweep.js";

export type SweepRequest = { version: 1; databaseFile: string; poolRoot: string | null; tempRoots: string[]; actor: string; at: string };
export type SweepExecutor = (request: SweepRequest) => Promise<SweepRecord>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(one => typeof one === "string");

export function sweepRequest(value: unknown): value is SweepRequest {
  return object(value) && value.version === 1 && typeof value.databaseFile === "string" && value.databaseFile !== ":memory:" &&
    (value.poolRoot === null || typeof value.poolRoot === "string") && strings(value.tempRoots) && typeof value.actor === "string" && date(value.at);
}

export function sweepResponse(value: unknown, request: SweepRequest): value is { version: 1; record: SweepRecord } {
  if (!object(value) || value.version !== 1 || !object(value.record)) return false;
  const record = value.record;
  const kinds = ["test temp", "orphans", ...(request.poolRoot === null ? [] : ["checkouts"]), "runtimes", "dependencies"];
  if (!date(record.at) || record.source !== "automatic" || record.actor !== request.actor || !Array.isArray(record.parts) || record.parts.length !== kinds.length) return false;
  return record.parts.every((part: unknown, index: number) => object(part) && part.kind === kinds[index] &&
    [part.count, part.bytes, part.failed].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) &&
    strings(part.items) && part.items.length <= 20 && part.items.every(item => item.length <= 16_384) &&
    (part.more === undefined || typeof part.more === "boolean") && (part.problem === undefined || (typeof part.problem === "string" && part.problem.length <= 65_536)));
}

export type SweepCompletion = { ok: true; record: SweepRecord } | { ok: false; reason: "failed" | "timeout" | "stopped" };
export type SweepSupervisor = {
  readonly running: boolean;
  start: (request: SweepRequest, complete: (result: SweepCompletion) => void, owner?: object) => boolean;
  stop: (owner?: object) => void;
};
export const SWEEP_TIMEOUT_MS = 20 * 60_000;
export const SWEEP_KILL_GRACE_MS = 5_000;

/** Only source checkouts need tsx; installed builds use the sibling child and the same Node. */
function forkSweep(): ChildProcess {
  const source = import.meta.url.endsWith(".ts");
  const child = fork(fileURLToPath(new URL(source ? "./storage-sweep-child.ts" : "./storage-sweep-child.js", import.meta.url)), [], {
    execArgv: source ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true,
  });
  // A one-shot CLI may exit after reconcile; the child's parent-loss guard then ends it.
  child.unref();
  child.channel?.unref();
  return child;
}

/** The fork is a group leader: rm/du and any other descendants must receive the same signal. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Owns one child without lending its lifetime to a reconcile pass or its database connection. */
export function createSweepSupervisor(options: {
  timeoutMs?: number;
  killGraceMs?: number;
  launch?: () => ChildProcess;
  signal?: (child: ChildProcess, signal: NodeJS.Signals) => void;
} = {}): SweepSupervisor {
  const timeoutMs = options.timeoutMs ?? SWEEP_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? SWEEP_KILL_GRACE_MS;
  for (const value of [timeoutMs, killGraceMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Invalid sweep process time limit");
  }
  const signal = options.signal ?? signalGroup;
  let active: { stop: () => void; owner: object | undefined } | null = null;
  const stoppedOwners = new WeakSet<object>();
  return {
    get running() { return active !== null; },
    stop(owner) {
      if (owner !== undefined) stoppedOwners.add(owner);
      if (owner === undefined || active?.owner === owner) active?.stop();
    },
    start(request, complete, owner) {
      if (active !== null || (owner !== undefined && stoppedOwners.has(owner))) return false;
      let child: ChildProcess;
      let settled = false, closed = false, killing = false, killed = false;
      let record: SweepRecord | null = null;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: SweepCompletion) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        complete(result);
      };
      const release = () => {
        if (!closed || grace !== undefined) return;
        clearTimeout(deadline);
        child.removeListener("message", message);
        child.removeListener("error", error);
        child.removeListener("close", close);
        // A late IPC write error must not become an unhandled EventEmitter error.
        child.on("error", () => {});
        active = null;
      };
      const kill = () => {
        if (killed) return;
        killed = true;
        killing = true;
        clearTimeout(grace);
        grace = undefined;
        signal(child, "SIGKILL");
        release();
      };
      const terminate = (reason: "failed" | "timeout") => {
        if (settled) return;
        killing = true;
        signal(child, "SIGTERM");
        // Even if the leader exits on TERM, descendants may ignore it. Keep the group owned through KILL.
        grace = setTimeout(kill, killGraceMs);
        grace.unref?.();
        settle({ ok: false, reason });
      };
      const message = (value: unknown) => {
        if (settled) return;
        if (record !== null || !sweepResponse(value, request)) { terminate("failed"); return; }
        record = value.record;
      };
      const error = () => terminate("failed");
      const close = (code: number | null) => {
        closed = true;
        if (!settled) {
          if (code === 0 && record !== null) settle({ ok: true, record });
          else { signal(child, "SIGKILL"); settle({ ok: false, reason: "failed" }); }
        }
        if (!killing || grace === undefined) release();
      };
      try { child = (options.launch ?? forkSweep)(); }
      catch { complete({ ok: false, reason: "failed" }); return true; }
      active = { owner, stop: () => { kill(); settle({ ok: false, reason: "stopped" }); } };
      child.on("message", message);
      child.on("error", error);
      child.once("close", close);
      deadline = setTimeout(() => terminate("timeout"), timeoutMs);
      deadline.unref?.();
      try { child.send(request, error => { if (error !== null) terminate("failed"); }); }
      catch { terminate("failed"); }
      return true;
    },
  };
}

// All watch loops in this process share a flight. Other workers arbitrate the daily claim in SQLite.
const supervisors = new Map<string, SweepSupervisor>();
export function storageSweepSupervisor(databaseFile: string): SweepSupervisor {
  const key = resolve(databaseFile);
  let supervisor = supervisors.get(key);
  if (supervisor === undefined) { supervisor = createSweepSupervisor(); supervisors.set(key, supervisor); }
  return supervisor;
}

/** Awaitable only for explicit callers/tests; automatic maintenance always uses start(). */
export const runSweepChild: SweepExecutor = request => new Promise((resolve, reject) => {
  createSweepSupervisor().start(request, result => {
    if (result.ok) resolve(result.record);
    else reject(new Error("Sweep child failed"));
  });
});
