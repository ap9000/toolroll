import { execFileSync, type ChildProcess } from "node:child_process";
import { processMayBeAlive } from "./process-liveness.js";

type ProcessRow = { pid: number; parent: number; group: number };
export type ObservedProcess = { pid: number; group: boolean };
export type ProcessObservationFailure = {
  phase: "sample" | "periodic" | "final-exit" | "stop" | "supervisor";
  operation: "snapshot" | "descendant-write" | "exit-write" | "signal" | "diagnostic-read";
  code: string;
  rootPid: number | null;
  at: string;
  identityUnknown: boolean;
};
export type ProcessTreeObserver = {
  onDescendant?: (pid: number, group: boolean) => void;
  /** A dedicated durable fallback for the exact identities already observed.
   * Return true only after preserving every row. Never replay arbitrary callbacks. */
  onDescendantWriteFailure?: (rows: readonly ObservedProcess[]) => boolean;
  /** An observed PID (and its group, when recorded) is now proven absent.
   * This never follows merely from reparenting or the root's exit. */
  onDescendantExit?: (pid: number, group: boolean) => void;
  /** Diagnostics never establish exit or erase a custody witness. */
  onObservationFailure?: (failure: ProcessObservationFailure) => void;
  onUnknown?: () => void;
};
const observed = new Map<ChildProcess, { observer: ProcessTreeObserver; seen: Map<string, { pid: number; group: boolean }>; failures: Set<string> }>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Read identifiers only: command lines can contain private provider inputs. */
function snapshot(): ProcessRow[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
    .trim().split("\n").map(line => {
      const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
      if (!pid || !Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || parent! < 0 || !Number.isSafeInteger(group) || group! < 0 || line.trim().split(/\s+/).length !== 3) throw Object.assign(new Error("unreadable process ancestry"), { code: "MALFORMED_SNAPSHOT" });
      return { pid, parent: parent!, group: group! };
    });
}
function descendants(rows: ProcessRow[], root: number): ProcessRow[] {
  const ids = new Set([root]);
  const found: ProcessRow[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (!ids.has(row.pid) && ids.has(row.parent)) {
      ids.add(row.pid); found.push(row); changed = true;
    }
  }
  return found;
}
function live(child: ChildProcess): boolean { return child.pid !== undefined && child.exitCode === null && child.signalCode === null; }
function remember(child: ChildProcess, rows: ProcessRow[], phase: "sample" | "periodic" | "stop"): void {
  const tracked = observed.get(child);
  if (!tracked) return;
  // Keep the entire observed set before a persistence callback can throw.
  const fresh = rows.map(row => ({ pid: row.pid, group: row.group === row.pid }))
    .filter(row => !tracked.seen.has(`${row.pid}:${row.group}`));
  for (let index = 0; index < fresh.length; index++) {
    const row = fresh[index]!;
    try { tracked.observer.onDescendant?.(row.pid, row.group); }
    catch (error) {
      // A stop must not signal from a snapshot made stale by waiting for a
      // fallback write. Preserve its existing conservative failure path.
      if (phase === "stop") throw error;
      const remaining = fresh.slice(index);
      let preserved = false;
      try { preserved = tracked.observer.onDescendantWriteFailure?.(remaining) === true; } catch { /* The unknown safeguard remains. */ }
      if (!preserved) throw error;
      for (const one of remaining) tracked.seen.set(`${one.pid}:${one.group}`, one);
      failed(child, phase, "descendant-write", error, true);
      return;
    }
    tracked.seen.set(`${row.pid}:${row.group}`, row);
  }
}
function recordExits(child: ChildProcess, rows: ProcessRow[]): void {
  const tracked = observed.get(child);
  if (!tracked) return;
  const pids = new Set(rows.map(row => row.pid)), groups = new Set(rows.map(row => row.group));
  for (const [key, prior] of tracked.seen) {
    if (pids.has(prior.pid) || (prior.group && groups.has(prior.pid))) continue;
    // A missing ancestry edge proves nothing. Require both the complete
    // system snapshot and an ESRCH-only probe; no birth inference or signal.
    if (processMayBeAlive(prior.pid, prior.group)) continue;
    tracked.observer.onDescendantExit?.(prior.pid, prior.group);
    tracked.seen.delete(key); // The same number can later identify a NEW child.
  }
}
// Only fixed error codes survive; error messages/output can contain private data.
const observationCodes = new Set(["EAGAIN", "EMFILE", "ENFILE", "ETIMEDOUT", "ENOBUFS", "ENOENT", "EPERM", "EACCES", "EIO", "ESRCH", "MALFORMED_SNAPSHOT", "SUPERVISOR_DIAGNOSTIC", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_READONLY", "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_FULL", "SQLITE_CONSTRAINT"]);
function failed(child: ChildProcess, phase: ProcessObservationFailure["phase"], operation: ProcessObservationFailure["operation"], error: unknown, identitiesPreserved = false): void {
  const tracked = observed.get(child);
  if (!tracked) return;
  const rawCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const sqliteCodes: Record<number, string> = { 5: "SQLITE_BUSY", 6: "SQLITE_LOCKED", 8: "SQLITE_READONLY", 10: "SQLITE_IOERR", 11: "SQLITE_CORRUPT", 13: "SQLITE_FULL", 19: "SQLITE_CONSTRAINT" };
  const sqlite = typeof error === "object" && error !== null && "errcode" in error && Number.isSafeInteger(error.errcode)
    ? sqliteCodes[Number(error.errcode) & 0xff] : undefined;
  const code = sqlite ?? (typeof rawCode === "string" && observationCodes.has(rawCode) ? rawCode : "UNKNOWN");
  // Exit-only checks retire already-durable identities; they discover no
  // children. Any failure leaves those witnesses intact for later OS probes.
  // Discovery and descendant persistence failures can lose an identity.
  const identityUnknown = !identitiesPreserved && phase !== "final-exit" && operation !== "exit-write";
  const key = `${phase}:${operation}:${code}:${identityUnknown}`;
  if (!tracked.failures.has(key)) {
    try {
      tracked.observer.onObservationFailure?.({ phase, operation, code, rootPid: child.pid ?? null, at: new Date().toISOString(), identityUnknown });
      tracked.failures.add(key);
    } catch { /* No diagnostic, but no witness was retired by this callback. */ }
  }
  if (identityUnknown) {
    // A failed persistence callback never becomes an uncaught timer error or
    // permission to release custody. The existing unknown road stays closed.
    try { tracked.observer.onUnknown?.(); } catch {}
  }
}
function observeRows(child: ChildProcess, rows: ProcessRow[], phase: "sample" | "periodic"): void {
  try { recordExits(child, rows); }
  catch (error) { failed(child, phase, "exit-write", error); }
  try { remember(child, descendants(rows, child.pid!), phase); }
  catch (error) { failed(child, phase, "descendant-write", error); }
}

/** Capture current descendants before asking an owned process to exit.
 * A cooperative root may exit before the next periodic observation; even
 * a killed tool can retain its PID briefly after its process group is gone. */
export function sampleProcessTree(child: ChildProcess): void {
  if (!live(child) || !observed.has(child)) return;
  let rows: ProcessRow[];
  try { rows = snapshot(); }
  catch (error) { failed(child, "sample", "snapshot", error); return; }
  observeRows(child, rows, "sample");
}

/** Observe escaped process groups while their ancestry is still provable.
 * Durable witnesses prevent recovery from mistaking a dead harness for a dead
 * shell. They never grant permission to send a signal after worker recovery. */
export function observeProcessTree(child: ChildProcess, observer: ProcessTreeObserver): void {
  if (process.platform === "win32" || observer.onDescendant === undefined) return;
  observed.set(child, { observer, seen: new Map(), failures: new Set() });
  child.once("close", () => {
    if (observed.get(child)?.seen.size) {
      let rows: ProcessRow[] | null = null;
      try { rows = snapshot(); } catch (error) { failed(child, "final-exit", "snapshot", error); }
      if (rows !== null) {
        try { recordExits(child, rows); } catch (error) { failed(child, "final-exit", "exit-write", error); }
      }
    }
    observed.delete(child);
    if (observed.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
  });
  if (timer !== null) return;
  timer = setInterval(() => {
    let rows: ProcessRow[];
    try { rows = snapshot(); }
    catch (error) {
      for (const [one] of observed) if (live(one)) failed(one, "periodic", "snapshot", error);
      return;
    }
    for (const [one] of observed) if (live(one)) observeRows(one, rows, "periodic");
  }, 500);
  timer.unref();
}

/** Freeze the owned handle, then its live descendants before killing them.
 * Claude's tool shells create new process groups, so killing only -rootPid
 * leaves writers behind. Re-scan after freezing parents to catch a child born
 * during the previous scan. Every target comes from current ancestry of the
 * still-owned handle, never from a saved PID. Unknown ancestry stays blocked. */
export function stopProcessTree(child: ChildProcess): boolean {
  if (process.platform === "win32" || !live(child)) return false;
  const stopped = new Set<number>();
  let operation: ProcessObservationFailure["operation"] = "signal";
  try {
    if (!child.kill("SIGSTOP")) return false;
    for (let pass = 0; pass < 8; pass++) {
      operation = "snapshot";
      const rows = descendants(snapshot(), child.pid!);
      operation = "descendant-write";
      remember(child, rows, "stop");
      operation = "signal";
      const fresh = rows.filter(row => !stopped.has(row.pid));
      if (fresh.length === 0) {
        // Parents are frozen, so none can fork between this seal and kill.
        for (const row of rows.reverse()) { try { process.kill(row.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
        child.kill("SIGKILL");
        return true;
      }
      for (const row of fresh) {
        try { process.kill(row.pid, "SIGSTOP"); stopped.add(row.pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    throw new Error("process ancestry did not settle");
  } catch (error) {
    failed(child, "stop", operation, error);
    // Do not leave any process frozen after a failed observation. The caller
    // can still stop its known group; unresolved custody prevents Resume.
    for (const pid of stopped) { try { process.kill(pid, "SIGCONT"); } catch {} }
    try { child.kill("SIGCONT"); } catch {}
    return false;
  }
}
