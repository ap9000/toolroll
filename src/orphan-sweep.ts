/**
 * Orphans Toolroll left running (the daily storage sweep, storage-sweep.ts): a process whose parent is gone (parent
 * pid 1) that runs from inside a task checkout whose run has ended, or from inside a test temp root whose suite is
 * gone — a preview server a run started and never stopped (Oct 4: `astro preview --port 4399` from a toolroll-site
 * checkout, 4 days on), a browser a killed journey left. It is stopped with whatever it started (SIGTERM, then
 * SIGKILL after the grace), and each one is in the ledger.
 *
 * "Runs from inside" is its working folder or its executable, read from the OS (lsof on macOS, /proc on Linux) —
 * never its arguments, which can carry private provider inputs. An observation that can't be read stops nothing.
 *
 * Never touched: anything whose parent is alive (a person's shell, the lead's deploy), anything at a terminal, the
 * live service and its ancestry, anything in a checkout leased or with a live run, a process born after its
 * checkout was let go (somebody started it since), anything in a temp root whose owner still runs or that something
 * touched within the day, and anything outside Toolroll's checkouts and test temp roots. Each target is looked at
 * again right before the signal: the same process (pid and birth), still an orphan, still inside.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { basename, sep } from "node:path";
import { processCensus, protectedProcesses, stopProcesses, type ProcessRow, type StopOptions } from "./run-closeout.js";
import type { Store } from "./store.js";
import { tempOwner, testTempFolders, type TempOwner } from "./test-temp.js";
import type { WorktreePool } from "./worktree.js";

const DAY_MS = 86_400_000;
/** `ps` ages are whole seconds. */
const BIRTH_SLACK_MS = 2_000;

/** Where a process runs from: its working folder and executable, when the OS says. */
export type Located = { cwd?: string; exe?: string };

/** Working folder and executable of each pid: /proc on Linux, lsof on macOS. Throws when the OS can't be asked. */
export function locateProcesses(pids: readonly number[]): Map<number, Located> {
  const found = new Map<number, Located>();
  if (pids.length === 0 || process.platform === "win32") return found;
  if (process.platform === "linux") {
    for (const pid of pids) {
      const one: Located = {};
      try { one.cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone, or not ours */ }
      try { one.exe = readlinkSync(`/proc/${pid}/exe`); } catch { /* gone, or not ours */ }
      if (one.cwd !== undefined || one.exe !== undefined) found.set(pid, one);
    }
    return found;
  }
  for (let at = 0; at < pids.length; at += 400) {
    let text: string;
    try {
      text = execFileSync("lsof", ["-nP", "-a", "-p", pids.slice(at, at + 400).join(","), "-d", "cwd,txt", "-Fpfn"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      // lsof exits 1 when some pid has gone or can't be read; what it printed still stands. No output at all: unreadable.
      const out = (error as { stdout?: unknown }).stdout;
      if (typeof out !== "string" || (error as { status?: unknown }).status !== 1) throw new Error("lsof could not list working folders");
      text = out;
    }
    let pid = 0;
    let fd = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) { pid = Number(line.slice(1)); fd = ""; }
      else if (line.startsWith("f")) fd = line.slice(1);
      else if (line.startsWith("n") && pid > 0) {
        const one = found.get(pid) ?? {};
        // The first txt is the executable; the rest are libraries it loaded.
        if (fd === "cwd") one.cwd = line.slice(1);
        else if (fd === "txt" && one.exe === undefined) one.exe = line.slice(1);
        found.set(pid, one);
      }
    }
  }
  return found;
}

/** A folder an orphan may be stopped from: a let-go checkout (only what was born before it was let go) or a temp root. */
export type SweepRoot = { path: string; kind: "checkout" | "test temp"; bornBefore?: number; repo?: string | null; taskId?: string | null };

function canonical(path: string): string[] {
  let real = path;
  try { real = realpathSync(path); } catch { /* gone */ }
  return [...new Set([path, real])];
}

/** The root `located` runs from inside of, if any (its working folder first, then its executable). */
export function rootOf(located: Located | undefined, roots: readonly SweepRoot[]): SweepRoot | null {
  if (located === undefined) return null;
  for (const at of [located.cwd, located.exe]) {
    if (at === undefined || at === "") continue;
    for (const root of roots) {
      if (canonical(root.path).some(base => base !== "/" && base !== "" && (at === base || at.startsWith(base + sep)))) return root;
    }
  }
  return null;
}

export type OrphanTarget = { row: ProcessRow; root: SweepRoot; orphan: number };

/**
 * Which processes go: each orphan (parent 1, no terminal, not protected) running from inside a root — for a checkout,
 * born before it was let go — and every process descending from one that goes (none at a terminal or protected).
 */
export function orphanTargets(census: readonly ProcessRow[], located: ReadonlyMap<number, Located>, roots: readonly SweepRoot[], guard: { pids: ReadonlySet<number>; groups: ReadonlySet<number> }): OrphanTarget[] {
  const safe = (row: ProcessRow) => row.pid > 1 && !row.terminal && !guard.pids.has(row.pid) && !guard.groups.has(row.pgid);
  const out = new Map<number, OrphanTarget>();
  for (const row of census) {
    if (row.ppid !== 1 || !safe(row)) continue;
    const root = rootOf(located.get(row.pid), roots);
    if (root === null) continue;
    if (root.bornBefore !== undefined && row.bornAt > root.bornBefore + BIRTH_SLACK_MS) continue;
    out.set(row.pid, { row, root, orphan: row.pid });
  }
  // Whatever an orphan that goes started goes with it.
  const children = new Map<number, ProcessRow[]>();
  for (const row of census) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  for (const top of [...out.values()]) {
    const pending = [...(children.get(top.row.pid) ?? [])];
    while (pending.length > 0) {
      const row = pending.pop()!;
      if (out.has(row.pid) || !safe(row)) continue;
      out.set(row.pid, { row, root: top.root, orphan: top.orphan });
      pending.push(...(children.get(row.pid) ?? []));
    }
  }
  return [...out.values()];
}

/** Whether a temp root's owner (pid and start) is still the running process. */
export function ownerRunning(census: readonly ProcessRow[]): (owner: TempOwner) => boolean {
  const byPid = new Map(census.map(row => [row.pid, row]));
  return owner => { const now = byPid.get(owner.pid); return now !== undefined && Math.abs(now.bornAt - owner.startedAt) <= BIRTH_SLACK_MS; };
}

/**
 * The roots orphans may be stopped from now: every checkout let go with no live run on its task and not held, and
 * every test temp root whose owner is gone or that nothing touched for a day.
 */
export function sweepRoots(store: Store, pool: WorktreePool | null, census: readonly ProcessRow[], tempRoots: readonly string[], now: Date): SweepRoot[] {
  const roots: SweepRoot[] = [];
  const live = store.handle.prepare("SELECT 1 FROM run WHERE task_ref = ? AND finished_at IS NULL LIMIT 1");
  for (const row of store.listWorktrees()) {
    if (row.releasedAt === null || row.runner !== null || !existsSync(row.path)) continue;
    if (pool !== null && pool.inUse(row.path).held) continue;
    if (row.taskRef !== null && live.get(row.taskRef) !== undefined) continue;
    const releasedAt = Date.parse(row.releasedAt);
    if (!Number.isFinite(releasedAt)) continue;
    roots.push({ path: row.path, kind: "checkout", bornBefore: releasedAt, repo: row.repo, taskId: row.taskRef === null ? null : store.externalIdFor(row.taskRef) });
  }
  const running = ownerRunning(census);
  const found = testTempFolders(tempRoots, now);
  for (const one of found.all) {
    const owner = tempOwner(one.path);
    const gone = owner !== null ? !running(owner) : now.getTime() - one.touchedAt > DAY_MS;
    if (gone) roots.push({ path: one.path, kind: "test temp" });
  }
  return roots;
}

export type OrphanStop = { pid: number; name: string; where: string; kind: SweepRoot["kind"]; ranMs: number; killed: boolean };
export type OrphanSweep = { stopped: OrphanStop[]; failed: string[] };

export type OrphanOptions = StopOptions & {
  actor?: string;
  pool?: WorktreePool | null;
  tempRoots?: readonly string[];
  locate?: (pids: readonly number[]) => Map<number, Located>;
  self?: number;
};

/** Stop the orphans Toolroll left (see the top of this file), each in the ledger. */
export async function sweepOrphans(store: Store, now: () => Date, options: OrphanOptions = {}): Promise<OrphanSweep> {
  if (process.platform === "win32") return { stopped: [], failed: [] };
  const read = options.census ?? (() => processCensus());
  const locate = options.locate ?? locateProcesses;
  const failed: string[] = [];
  let census: ProcessRow[];
  try { census = read(); } catch { return { stopped: [], failed: ["the process list couldn't be read"] }; }
  const roots = sweepRoots(store, options.pool ?? null, census, options.tempRoots ?? [], now());
  if (roots.length === 0) return { stopped: [], failed };
  const guard = protectedProcesses(census, options.self);
  const orphans = census.filter(row => row.ppid === 1 && row.pid > 1 && !row.terminal && !guard.pids.has(row.pid) && !guard.groups.has(row.pgid)).map(row => row.pid);
  let located: Map<number, Located>;
  try { located = locate(orphans); } catch (error) { return { stopped: [], failed: [`working folders couldn't be read: ${(error as Error).message}`] }; }
  const first = orphanTargets(census, located, roots, guard);
  if (first.length === 0) return { stopped: [], failed };
  // Right before the signal, everything again: the same process, still an orphan (or under one), still inside.
  let again: OrphanTarget[];
  try {
    const fresh = read();
    const freshGuard = protectedProcesses(fresh, options.self);
    const freshLocated = locate(fresh.filter(row => row.ppid === 1).map(row => row.pid));
    const before = new Map(first.map(one => [one.row.pid, one]));
    again = orphanTargets(fresh, freshLocated, roots, freshGuard).filter(one => {
      const was = before.get(one.row.pid);
      return was !== undefined && Math.abs(was.row.bornAt - one.row.bornAt) <= BIRTH_SLACK_MS && was.root.path === one.root.path;
    });
  } catch (error) { return { stopped: [], failed: [`a second look failed: ${(error as Error).message}`] }; }
  if (again.length === 0) return { stopped: [], failed };
  const done = await stopProcesses(again.map(one => one.row), options);
  const killed = new Set(done.killed.map(row => row.pid));
  const at = now();
  const stopped: OrphanStop[] = [];
  for (const one of again) {
    const ranMs = Math.max(0, at.getTime() - one.row.bornAt);
    const where = basename(one.root.path);
    stopped.push({ pid: one.row.pid, name: one.row.name, where: one.root.path, kind: one.root.kind, ranMs, killed: killed.has(one.row.pid) });
    store.recordAction({ at: at.toISOString(), actor: options.actor ?? "worker", repo: one.root.repo ?? null, taskId: one.root.taskId ?? null, runId: null,
      action: "orphan process stopped", outcome: "stopped", source: "work",
      detail: `${one.row.name} (${one.row.pid}) running ${durationWords(ranMs)} from ${one.root.kind === "checkout" ? "checkout" : "test temp folder"} ${where}${one.orphan === one.row.pid ? "; its parent had gone" : `; started by orphan ${one.orphan}`}${killed.has(one.row.pid) ? "; needed SIGKILL" : ""}` });
  }
  return { stopped, failed };
}

export function durationWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}
