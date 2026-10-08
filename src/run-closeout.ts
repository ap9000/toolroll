/**
 * Closing out what a run started. When a run ends, whatever its outcome, anything still running in its process
 * groups — the provider's own group and every process or group the run was seen to start — is stopped: SIGTERM, then
 * SIGKILL for whatever is still there after 10 s. Completing or cancelling a task does the same for what Toolroll left
 * running from its checkout: what a finished run started (descends from one of its processes) or an orphan (its parent
 * gone), never one with a live parent Toolroll did not start (a deploy, a person's agent or shell). Each stop is in
 * the ledger, naming what was stopped.
 *
 * Never the live service: this process, its ancestors and their process groups are never targets.
 *
 * A pid saved in the database is never signalled on its word alone (the OS reuses pids): a target must be alive in a
 * fresh process listing and born no later than the run saw it. A group counts when its leader is that same process,
 * or when the leader is gone and the group still has members (the OS never hands a live group's id to a new
 * process). The worker's pass runs this (operate.ts reconcile), so every road a run ends by is covered.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { basename, sep } from "node:path";
import { ownedProcessCount, runOwnerTag } from "./exec.js";
import type { Store, WorktreeRow } from "./store.js";

/** How long a process has after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 10_000;
/** `ps` reports age in whole seconds: a process born this close after the run saw its pid is still that process. */
const BIRTH_SLACK_MS = 2_000;

export type ProcessRow = { pid: number; ppid: number; pgid: number; bornAt: number; name: string; terminal: boolean };

/** Every process now: ids, when it was born (from its age) and its program's name — never its arguments, which can
 * carry private provider inputs. */
export function processCensus(now = Date.now()): ProcessRow[] {
  if (process.platform === "win32") return [];
  const text = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,etime=,tty=,comm="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  return parseCensus(text, now);
}

/** `ps -o pid=,ppid=,pgid=,etime=,tty=,comm=` rows; etime is [[dd-]hh:]mm:ss, tty `??` or `?` for none. Unreadable rows are left out. */
export function parseCensus(text: string, now: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pgid, days, hours, minutes, seconds, tty, comm] = match;
    const age = ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), bornAt: now - age * 1000, name: basename(comm!.trim()) || "?", terminal: !/^(\?+|-)$/.test(tty!) });
  }
  return rows;
}

/** This process, its ancestors, pid 1 and their process groups: the live service, never stopped. */
export function protectedProcesses(census: readonly ProcessRow[], self = process.pid): { pids: Set<number>; groups: Set<number> } {
  const byPid = new Map(census.map(row => [row.pid, row]));
  const pids = new Set<number>([1, self, process.ppid]);
  for (let at = byPid.get(self), hops = 0; at !== undefined && hops < 64; at = byPid.get(at.ppid), hops++) {
    pids.add(at.pid);
    if (at.ppid <= 1) break;
  }
  const groups = new Set<number>();
  for (const pid of pids) { const row = byPid.get(pid); if (row !== undefined) groups.add(row.pgid); }
  return { pids, groups };
}

export type Witness = { pid: number; group: boolean; observedAt: number };

/**
 * What of a run is still running: each witnessed process that is still the same process (born no later than the run
 * saw it), and every member of each witnessed group whose leader is that same process or gone. Never anything
 * protected.
 */
export function closeoutTargets(census: readonly ProcessRow[], witnesses: readonly Witness[], guard: { pids: ReadonlySet<number>; groups: ReadonlySet<number> }): ProcessRow[] {
  const byPid = new Map(census.map(row => [row.pid, row]));
  const groups = new Set<number>();
  const pids = new Set<number>();
  for (const one of witnesses) {
    const now = byPid.get(one.pid);
    const same = now !== undefined && now.bornAt <= one.observedAt + BIRTH_SLACK_MS;
    if (same) pids.add(one.pid);
    if (one.group && (same || now === undefined)) groups.add(one.pid);
  }
  return census.filter(row => (pids.has(row.pid) || groups.has(row.pgid)) && !guard.pids.has(row.pid) && !guard.groups.has(row.pgid));
}

export type Stopped = { stopped: ProcessRow[]; killed: ProcessRow[] };

export type StopOptions = {
  graceMs?: number;
  census?: () => ProcessRow[];
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
};

/** SIGTERM each target, wait up to the grace for them to go, then SIGKILL what is still the same process. */
export async function stopProcesses(targets: readonly ProcessRow[], options: StopOptions = {}): Promise<Stopped> {
  if (targets.length === 0) return { stopped: [], killed: [] };
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const census = options.census ?? (() => processCensus());
  const signal = options.signal ?? ((pid, name) => process.kill(pid, name));
  const sleep = options.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const send = (rows: readonly ProcessRow[], name: NodeJS.Signals) => {
    for (const row of rows) {
      try { signal(row.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
    }
  };
  // Still there: the same pid, born at the same time (a reused pid is somebody else).
  const remaining = () => {
    let rows: ProcessRow[];
    try { rows = census(); } catch { return [...targets]; }
    const alive = new Map(rows.map(row => [row.pid, row]));
    return targets.filter(one => { const now = alive.get(one.pid); return now !== undefined && Math.abs(now.bornAt - one.bornAt) <= BIRTH_SLACK_MS; });
  };
  send(targets, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let left = remaining();
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    left = remaining();
  }
  if (left.length > 0) send(left, "SIGKILL");
  return { stopped: [...targets], killed: left };
}

/** "node (4123), serve (4130); 1 needed SIGKILL after 10 s" — for the ledger. */
export function stoppedWords(done: Stopped, graceMs = STOP_GRACE_MS): string {
  const names = done.stopped.map(one => `${one.name} (${one.pid})`).join(", ");
  const groups = new Set(done.stopped.map(one => one.pgid)).size;
  const killed = done.killed.length === 0 ? "" : `; ${done.killed.length} needed SIGKILL after ${Number((graceMs / 1000).toFixed(1))} s`;
  return `${done.stopped.length} process${done.stopped.length === 1 ? "" : "es"} in ${groups} group${groups === 1 ? "" : "s"}: ${names}${killed}`;
}

export type CloseoutOptions = StopOptions & { repo?: string; actor?: string };

/**
 * The worker's pass: every finished run of this host that still has a process witness open is closed out. A run
 * whose transport here still holds a live child is left to that road.
 * Returns what each run had stopped.
 */
export async function closeOutRuns(store: Store, clock: () => Date, options: CloseoutOptions = {}): Promise<{ runId: number; done: Stopped }[]> {
  if (process.platform === "win32") return [];
  const db = store.handle;
  const runs = db.prepare(`SELECT DISTINCT p.run AS run FROM run_process p JOIN run r ON r.id = p.run JOIN task_ref t ON t.id = r.task_ref
    WHERE p.exited_at IS NULL AND p.pid IS NOT NULL AND p.containment IS NULL AND p.container IS NULL AND p.host = ?
      AND r.outcome IS NOT NULL${options.repo === undefined ? "" : " AND t.repo = ?"} ORDER BY p.run`)
    .all(...[hostname(), ...(options.repo === undefined ? [] : [options.repo])]).map(row => Number(row["run"]));
  const out: { runId: number; done: Stopped }[] = [];
  if (runs.length === 0) return out;
  let census: ProcessRow[] | null = null;
  for (const runId of runs) {
    store.recordRunProcessExits(runId, clock());
    if (ownedProcessCount(runOwnerTag(store, runId)) > 0) continue;
    const witnesses: Witness[] = db.prepare(`SELECT pid, process_group, observed_at FROM run_process
      WHERE run = ? AND exited_at IS NULL AND pid IS NOT NULL AND containment IS NULL AND container IS NULL AND host = ?`).all(runId, hostname())
      .map(row => ({ pid: Number(row["pid"]), group: Number(row["process_group"]) === 1, observedAt: Date.parse(String(row["observed_at"])) }))
      .filter(one => Number.isFinite(one.observedAt));
    if (witnesses.length === 0) continue;
    try { census ??= (options.census ?? (() => processCensus()))(); } catch { return out; }
    const targets = closeoutTargets(census, witnesses, protectedProcesses(census));
    if (targets.length === 0) continue;
    const done = await stopProcesses(targets, options);
    census = null;
    const run = store.getRun(runId);
    const ref = run === null ? null : store.refById(run.taskRef);
    store.recordAction({ at: clock().toISOString(), actor: options.actor ?? "worker", repo: ref?.repo ?? null, taskId: ref?.externalId ?? null, runId,
      action: "run processes stopped", outcome: "stopped", source: "work", detail: `run #${runId} ended (${run?.outcome ?? "?"}); stopped ${stoppedWords(done, options.graceMs)}` });
    store.recordRunProcessExits(runId, clock());
    out.push({ runId, done });
  }
  store.settleQuiescentStops(clock());
  return out;
}

/** Which processes run from inside each of `paths` (their working directory is there): lsof on macOS, /proc on Linux. */
export function processesIn(paths: readonly string[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  if (paths.length === 0 || process.platform === "win32") return found;
  const roots = paths.map(path => { let real = path; try { real = realpathSync(path); } catch { /* gone */ } return { path, real }; });
  const note = (pid: number, cwd: string) => {
    for (const one of roots) {
      if ([one.path, one.real].some(root => cwd === root || cwd.startsWith(root + sep))) found.set(one.path, [...(found.get(one.path) ?? []), pid]);
    }
  };
  if (process.platform === "linux" && existsSync("/proc")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try { note(Number(name), readlinkSync(`/proc/${name}/cwd`)); } catch { /* gone, or not ours */ }
    }
    return found;
  }
  let text = "";
  try { text = execFileSync("lsof", ["-nP", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (error) { text = String((error as { stdout?: unknown }).stdout ?? ""); }
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) note(pid, line.slice(1));
  }
  return found;
}

/**
 * Of the processes running from a finished checkout (`inside`), the ones Toolroll left there: each descends from a
 * process a finished run started (`roots`), or is an orphan (its parent is pid 1), or is the child of one that goes.
 * Never one with a live parent Toolroll didn't start — a deploy the lead runs from the checkout, a person's agent or
 * its tools — nor anything at a terminal or protected.
 */
export function checkoutTargets(census: readonly ProcessRow[], inside: ReadonlySet<number>, roots: ReadonlySet<number>, guard: { pids: ReadonlySet<number>; groups: ReadonlySet<number> }): ProcessRow[] {
  const byPid = new Map(census.map(row => [row.pid, row]));
  const fromRun = (row: ProcessRow) => {
    for (let at: ProcessRow | undefined = row, hops = 0; at !== undefined && at.pid > 1 && hops < 64; at = byPid.get(at.ppid), hops++) {
      if (roots.has(at.pid)) return true;
    }
    return false;
  };
  const verdict = new Map<number, boolean>();
  const left = (row: ProcessRow): boolean => {
    const known = verdict.get(row.pid);
    if (known !== undefined) return known;
    verdict.set(row.pid, false);
    const parent = byPid.get(row.ppid);
    const ours = inside.has(row.pid) && !row.terminal && !guard.pids.has(row.pid) && !guard.groups.has(row.pgid)
      && (row.ppid === 1 || fromRun(row) || (parent !== undefined && left(parent)));
    verdict.set(row.pid, ours);
    return ours;
  };
  return census.filter(left);
}

/** The processes finished runs on this host started that are still the same process: what a leftover may descend from. */
function finishedRunProcesses(store: Store, census: readonly ProcessRow[]): Set<number> {
  const byPid = new Map(census.map(row => [row.pid, row]));
  const roots = new Set<number>();
  const rows = store.handle.prepare(`SELECT p.pid AS pid, p.observed_at AS observed_at FROM run_process p JOIN run r ON r.id = p.run
    WHERE p.exited_at IS NULL AND p.pid IS NOT NULL AND p.host = ? AND r.outcome IS NOT NULL`).all(hostname());
  for (const row of rows) {
    const now = byPid.get(Number(row["pid"]));
    const observedAt = Date.parse(String(row["observed_at"]));
    if (now !== undefined && Number.isFinite(observedAt) && now.bornAt <= observedAt + BIRTH_SLACK_MS) roots.add(now.pid);
  }
  return roots;
}

/** Checkouts this process already closed out since their task finished (path and when). */
const closed = new Set<string>();

/**
 * Completing or cancelling a task closes out its checkout: what Toolroll left running from it (`checkoutTargets`) is
 * stopped (SIGTERM, then SIGKILL after the grace), in the ledger. `finished` lists the checkouts whose task is
 * complete or cancelled, with when it finished; each is looked at once per finish.
 */
export async function closeOutCheckouts(store: Store, clock: () => Date, finished: readonly { row: WorktreeRow; taskId: string | null; finishedAt: string }[], options: CloseoutOptions & { find?: typeof processesIn } = {}): Promise<{ path: string; done: Stopped }[]> {
  const fresh = finished.filter(one => !closed.has(`${one.row.path}\u0000${one.finishedAt}`) && existsSync(one.row.path) && one.row.runner === null);
  const out: { path: string; done: Stopped }[] = [];
  if (fresh.length === 0 || process.platform === "win32") return out;
  const inside = (options.find ?? processesIn)(fresh.map(one => one.row.path));
  let census: ProcessRow[] | null = null;
  for (const one of fresh) {
    closed.add(`${one.row.path}\u0000${one.finishedAt}`);
    const pids = new Set(inside.get(one.row.path) ?? []);
    if (pids.size === 0) continue;
    try { census ??= (options.census ?? (() => processCensus()))(); } catch { return out; }
    const targets = checkoutTargets(census, pids, finishedRunProcesses(store, census), protectedProcesses(census));
    if (targets.length === 0) continue;
    const done = await stopProcesses(targets, options);
    census = null;
    store.recordAction({ at: clock().toISOString(), actor: options.actor ?? "worker", repo: one.row.repo, taskId: one.taskId, runId: null,
      action: "checkout processes stopped", outcome: "stopped", source: "work", detail: `${basename(one.row.path)}: its task finished; stopped ${stoppedWords(done, options.graceMs)}` });
    out.push({ path: one.row.path, done });
  }
  return out;
}
