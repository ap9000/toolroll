/**
 * The daily storage sweep: the plane cleans up after itself without anyone running a command. Once a day (one worker
 * takes the day: the cursor moves in the same transaction) it removes test temp folders nothing touched for a day
 * (test-temp.ts), stops orphans Toolroll left running (orphan-sweep.ts), removes finished checkouts the cleanup
 * setting lets go (checkout-cleanup.ts), keeps the current, previous and newest staged runtimes (staged-runtimes.ts)
 * and removes shared dependency installs no checkout has used for a week (shared-deps.ts).
 *
 * Nothing live work uses goes (`liveWork`): while a run is open, a lease current or a checkout in use, each removal
 * and each signal first asks again whether that work uses the folder, and when its processes can't be read nothing
 * goes. Every scan and removal runs in a separate child: synchronous disk work must never delay the worker's lease
 * heartbeats (90 s). On Oct 12 the sweep starved those heartbeats and three builds ended interrupted half a second
 * after it finished. Once a run has ended, the next sweep removes what
 * it no longer uses.
 *
 * The everyday work stays where it happens: suites remove their own temp roots and processes, a run's processes stop
 * when it ends and a finished checkout goes on the worker's next pass. This is the net for what slipped through.
 *
 * What each sweep did is saved (the latest few) and in the ledger: `toolroll storage` and Settings → Storage show it.
 * A clean-up by hand (`storage clean --yes`) is saved the same way. A part that failed, or had more than one pass
 * takes, brings the next sweep forward to an hour later. `TOOLROLL_STORAGE_SWEEP=off` turns the automatic sweep off
 * (the unit tests do, so a test never sweeps the machine it runs on).
 */
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { cleanCheckouts } from "./checkout-cleanup.js";
import { durationWords, locateProcesses, sweepOrphans, ownerRunning, type Located } from "./orphan-sweep.js";
import { processCensus, type ProcessRow } from "./run-closeout.js";
import { linkedKey, pruneUnusedShared, sharedDepsRoot, sharedUse, SHARED_UNUSED_MS } from "./shared-deps.js";
import { pruneStagedRuntimes, runtimesInUse, runtimeScriptPaths, stagePlan } from "./staged-runtimes.js";
import { bytesWords, diskBytes } from "./storage.js";
import { openStoreNoMigrate, type Store } from "./store.js";
import { removeStaleTestTemp } from "./test-temp.js";
import { worktreeProcessOccupancy, type WorktreePool } from "./worktree.js";
import { runSweepChild, storageSweepSupervisor, type SweepSupervisor, type SweepCompletion, type SweepExecutor } from "./storage-sweep-process.js";

const CURSOR = "storage-sweep";
export const SWEEP_EVERY_MS = 86_400_000;
/** A sweep that failed somewhere, or left work for later, runs again this soon. */
export const RETRY_MS = 60 * 60_000;
/** Sweeps kept. */
const KEEP = 30;
/** Test temp folders one sweep removes at most (Oct 4 found 107,418). */
const TEMP_MAX = 20_000;
/** Paths saved per part, for the disclosure. */
const ITEMS_MAX = 20;

export type SweepKind = "test temp" | "orphans" | "checkouts" | "runtimes" | "dependencies";
export type SweepPart = { kind: SweepKind; count: number; bytes: number; failed: number; more?: boolean; problem?: string; items: string[] };
export type SweepRecord = { at: string; source: "automatic" | "manual"; actor: string; parts: SweepPart[] };

export type SweepDeps = {
  databaseFile: string;
  pool: WorktreePool | null;
  tempRoots: readonly string[];
  actor?: string;
  /** Parent lifecycle only; never sent to the child. */
  owner?: object;
  census?: () => ProcessRow[];
  locate?: (pids: readonly number[]) => Map<number, Located>;
  inUse?: () => string[];
  scripts?: (pids: readonly number[]) => string[];
  graceMs?: number;
};

export function storageSweepOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["TOOLROLL_STORAGE_SWEEP"] ?? "").trim().toLowerCase() === "off";
}

export function storageSweepDue(store: Store, now: Date): boolean {
  return now.getTime() - store.serviceCursor(CURSOR) >= SWEEP_EVERY_MS;
}

/** Claim and launch only. A hung child never holds reconciliation or the caller's store open. */
export function dailyStorageSweep(store: Store, deps: SweepDeps, now: () => Date, supervisor: SweepSupervisor = storageSweepSupervisor(deps.databaseFile)): SweepRecord | null {
  if (storageSweepOff() || supervisor.running || !storageSweepDue(store, now())) return null;
  // This handle belongs to the flight, not to the command that has already returned by the time it finishes.
  const connection = openStoreNoMigrate(deps.databaseFile);
  if (!connection.ok) throw new Error("Sweep result store unavailable");
  const results = connection.store;
  const at = now();
  let completed: SweepRecord | null = null;
  let owned = false;
  try {
    const mine = store.transact(() => {
      if (!storageSweepDue(store, at)) return false;
      store.setServiceCursor(CURSOR, at.getTime(), at);
      return true;
    });
    if (!mine) return null;
    const request = { version: 1 as const, databaseFile: deps.databaseFile, poolRoot: deps.pool?.root ?? null, tempRoots: [...deps.tempRoots], actor: deps.actor ?? "worker", at: at.toISOString() };
    owned = supervisor.start(request, result => {
      const record = result.ok ? result.record : sweepFailure(request.at, request.actor, deps.pool !== null, result.reason);
      try {
        results.transact(() => {
          if (!results.schemaCurrent()) throw new Error("Sweep result store changed");
          saveSweep(results, record);
          // Only this claim can reschedule itself. A later claim must never be overwritten by a late callback.
          if (record.parts.some(one => one.failed > 0 || one.more === true || one.problem !== undefined) && results.serviceCursor(CURSOR) === at.getTime()) {
            results.setServiceCursor(CURSOR, Math.max(0, now().getTime() - SWEEP_EVERY_MS + RETRY_MS), now());
          }
        });
        completed = record;
      } catch {
        // No exception/path from a process or database is safe to copy into a log.
        console.error("Could not save the storage sweep result.");
      } finally { results.close(); }
    }, deps.owner);
    if (!owned) {
      store.transact(() => {
        if (store.serviceCursor(CURSOR) === at.getTime()) store.setServiceCursor(CURSOR, Math.max(0, at.getTime() - SWEEP_EVERY_MS + RETRY_MS), now());
      });
    }
    return completed;
  } finally { if (!owned) results.close(); }
}

function sweepFailure(at: string, actor: string, withPool: boolean, reason: Exclude<SweepCompletion, { ok: true }>["reason"]): SweepRecord {
  const problem = reason === "timeout" ? "The sweep process exceeded its time limit; some cleanup may have completed. Cleanup will retry later."
    : reason === "stopped" ? "The sweep process was stopped; some cleanup may have completed. Cleanup will retry later."
    : "The sweep process did not return a valid result; some cleanup may have completed.";
  return { at, source: "automatic", actor, parts: sweepKinds(withPool).map(kind => ({ kind, count: 0, bytes: 0, failed: 0, items: [], problem })) };
}

/**
 * What live work uses now. Live work: an open run, a current (unexpired, unreleased) lease, or a checkout leased, held
 * by a process or whose task has either. It uses its checkouts, the shared install each links, and every folder its
 * open runs' processes (with their groups and what they started) run from. `where` says where the given processes run
 * from, or null when that can't be read: then `blind`, and everything stays. With nothing live, nothing is read from the OS.
 */
export type LiveWork = { live: boolean; paths: string[]; blind: boolean };

export function liveWork(store: Store, depsRoot: string, now: Date, where: (pids: readonly number[]) => string[] | null): LiveWork {
  const db = store.handle;
  const tasks = new Set<number>();
  const paths: string[] = [];
  for (const row of db.prepare("SELECT task_ref, worktree FROM run WHERE finished_at IS NULL").all()) {
    tasks.add(Number(row["task_ref"]));
    if (typeof row["worktree"] === "string" && row["worktree"] !== "") paths.push(row["worktree"]);
  }
  for (const row of db.prepare("SELECT task_ref FROM claim WHERE released_at IS NULL AND expires_at > ?").all(now.toISOString())) tasks.add(Number(row["task_ref"]));
  const pids = new Set<number>();
  for (const row of store.listWorktrees()) {
    let held: ReturnType<typeof worktreeProcessOccupancy>;
    try { held = worktreeProcessOccupancy(row.path); } catch { held = { held: true, by: 0 }; }
    if (row.releasedAt !== null && row.runner === null && !held.held && (row.taskRef === null || !tasks.has(row.taskRef))) continue;
    paths.push(row.path);
    if (held.held && held.by > 1) pids.add(held.by);
  }
  if (tasks.size === 0 && paths.length === 0) return { live: false, paths: [], blind: false };
  const witnessed = db.prepare(`SELECT p.pid AS pid FROM run_process p JOIN run r ON r.id = p.run
    WHERE r.finished_at IS NULL AND p.exited_at IS NULL AND p.pid IS NOT NULL AND p.host = ?`).all(hostname());
  for (const row of witnessed) pids.add(Number(row["pid"]));
  const from = pids.size === 0 ? [] : where([...pids].sort((a, b) => a - b));
  if (from === null) return { live: true, paths, blind: true };
  paths.push(...from);
  // A checkout (or a run's folder inside one) links its node_modules to a shared install: that install is in use.
  for (const path of [...paths]) {
    for (let at = resolve(path), hops = 0; hops < 32; at = dirname(at), hops++) {
      const key = linkedKey(at, depsRoot);
      if (key !== null) { paths.push(join(depsRoot, key)); break; }
      if (dirname(at) === at) break;
    }
  }
  return { live: true, paths, blind: false };
}

/** Where the processes run from, with their groups and every process under them; null when that can't be read. */
function processFolders(pids: readonly number[], census: () => ProcessRow[], locate: (pids: readonly number[]) => Map<number, Located>, scripts: (pids: readonly number[]) => string[]): string[] | null {
  try {
    const rows = census();
    const take = new Set(rows.filter(row => pids.includes(row.pid) || pids.includes(row.pgid)).map(row => row.pid));
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) if (!take.has(row.pid) && take.has(row.ppid) && row.ppid > 1) { take.add(row.pid); grew = true; }
    }
    if (take.size === 0) return [];
    const located = locate([...take]);
    for (const pid of take) {
      if (located.get(pid)?.cwd !== undefined) continue;
      // A vanished process is fine. An unreadable live working folder is not evidence that it uses nothing.
      try { process.kill(pid, 0); return null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null; }
    }
    return [...[...located.values()].flatMap(one => [one.cwd, one.exe]).filter((one): one is string => one !== undefined && one !== ""), ...scripts([...take])];
  } catch { return null; }
}

const forms = (path: string): string[] => {
  const out = [resolve(path)];
  try { out.push(realpathSync(path)); } catch { /* gone */ }
  return out;
};

/**
 * Whether live work uses `path`, asked again at every call, including process children. A cached process look
 * cannot protect a child launched between the pre-rename and post-rename guards. All this work is in the child.
 */
export function liveUse(store: Store, deps: SweepDeps, now: () => Date): (path: string) => boolean {
  const census = deps.census ?? (() => processCensus());
  const locate = deps.locate ?? locateProcesses;
  const where = (pids: readonly number[]) => processFolders(pids, census, locate, deps.scripts ?? (pids => runtimeScriptPaths(dirname(deps.databaseFile), pids)));
  return path => {
    const work = liveWork(store, sharedDepsRoot(deps.databaseFile), now(), where);
    if (!work.live) return false;
    if (work.blind) return true;
    const outer = forms(path);
    return work.paths.some(one => forms(one).some(inner => outer.some(base => inner === base || inner.startsWith(base + sep))));
  };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

const capped = (items: readonly string[]) => items.slice(0, ITEMS_MAX);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Parent side: no filesystem/process scans here. The executor seam is for deterministic unit tests only. */
export async function sweepStorage(store: Store, deps: SweepDeps, now: () => Date, execute: SweepExecutor = runSweepChild): Promise<SweepRecord> {
  const at = now().toISOString();
  const actor = deps.actor ?? "worker";
  let record: SweepRecord;
  try {
    record = await execute({ version: 1, databaseFile: deps.databaseFile, poolRoot: deps.pool?.root ?? null, tempRoots: [...deps.tempRoots], actor, at });
  } catch {
    // Never save child stdout, argv or exception text: those may contain private process inputs.
    record = sweepFailure(at, actor, deps.pool !== null, "failed");
  }
  return saveSweep(store, record);
}

export function sweepKinds(withPool: boolean): SweepKind[] {
  return ["test temp", "orphans", ...(withPool ? ["checkouts" as const] : []), "runtimes", "dependencies"];
}

/** Child side (also a focused unit-test seam): every scan and removal, without saving the parent's result. */
export async function executeSweep(store: Store, deps: SweepDeps, now: () => Date): Promise<SweepRecord> {
  const actor = deps.actor ?? "worker";
  const read = deps.census ?? (() => processCensus());
  const parts: SweepPart[] = [];
  const spare = liveUse(store, deps, now);
  const part = async (kind: SweepKind, work: () => Promise<Omit<SweepPart, "kind">>) => {
    await nextTurn();
    try { parts.push({ kind, ...await work() }); } catch (error) { parts.push({ kind, count: 0, bytes: 0, failed: 0, problem: failure(error), items: [] }); }
  };

  await part("test temp", async () => {
    // A root whose owner still runs stays, however old it looks; with no process list, every owned root stays.
    let alive: (owner: { pid: number; startedAt: number }) => boolean = () => true;
    try { alive = ownerRunning(read()); } catch { /* owned roots stay */ }
    const done = await removeStaleTestTemp(deps.tempRoots, now(), { ownerAlive: alive, max: TEMP_MAX, spare });
    return { count: done.removed.length, bytes: 0, failed: done.failed.length, ...(done.more ? { more: true } : {}), items: capped(done.removed) };
  });

  await part("orphans", async () => {
    const done = await sweepOrphans(store, now, {
      actor, pool: deps.pool, tempRoots: deps.tempRoots, census: read, spare,
      ...(deps.locate === undefined ? {} : { locate: deps.locate }), ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
    });
    return {
      count: done.stopped.length, bytes: 0, failed: 0, ...(done.failed.length === 0 ? {} : { problem: done.failed.join("; ") }),
      items: capped(done.stopped.map(one => `${one.name} (${one.pid}), ${durationWords(one.ranMs)}, in ${one.where}`)),
    };
  });

  if (deps.pool !== null) {
    const pool = deps.pool;
    await part("checkouts", async () => {
      const done = await cleanCheckouts(store, pool, now, { manual: false, actor, spare });
      return { count: done.removed.length, bytes: done.freed, failed: done.kept.filter(one => one.why === "git refused").length, items: capped(done.removed.map(one => one.path)) };
    });
  }

  const stateDir = dirname(deps.databaseFile);
  await part("runtimes", async () => {
    const inUse = deps.inUse ?? (() => runtimesInUse([], undefined, undefined, stateDir));
    const plan = stagePlan(stateDir, inUse(), now());
    const sizes = diskBytes(plan.go.map(one => one.path));
    const done = pruneStagedRuntimes(stateDir, now(), { inUse, spare });
    return {
      count: done.removed.length, bytes: done.removed.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0), failed: done.failed.length,
      ...(done.refused === null ? {} : { problem: `kept every staged runtime: ${done.refused}` }), items: capped(done.removed),
    };
  });

  await part("dependencies", async () => {
    const root = sharedDepsRoot(deps.databaseFile);
    const checkouts = () => store.listWorktrees().map(row => ({ path: row.path, repo: row.repo }));
    const candidates = sharedUse(root, checkouts()).filter(one => one.checkouts.length === 0 && now().getTime() - Date.parse(one.usedAt) > SHARED_UNUSED_MS);
    const sizes = diskBytes(candidates.map(one => one.dir));
    const done = await pruneUnusedShared(root, checkouts, now(), SHARED_UNUSED_MS, { spare });
    return { count: done.removed.length, bytes: done.removed.reduce((sum, one) => sum + (sizes.get(one.dir) ?? 0), 0), failed: done.failed.length, items: capped(done.removed.map(one => one.dir)) };
  });

  return { at: now().toISOString(), source: "automatic", actor, parts };
}

/** Save what a sweep or a clean-up by hand did (the latest few are kept), with one ledger entry saying it. */
export function saveSweep(store: Store, record: SweepRecord): SweepRecord {
  store.transact(() => {
    store.handle.prepare("INSERT INTO storage_sweep (at, source, actor, result) VALUES (?, ?, ?, ?)").run(record.at, record.source, record.actor, JSON.stringify(record.parts));
    store.handle.prepare("DELETE FROM storage_sweep WHERE id NOT IN (SELECT id FROM storage_sweep ORDER BY id DESC LIMIT ?)").run(KEEP);
  });
  const did = record.parts.some(one => one.count > 0);
  const failed = record.parts.some(one => one.failed > 0 || one.problem !== undefined);
  store.recordAction({ at: record.at, actor: record.actor, repo: null, taskId: null, runId: null, action: "storage sweep",
    outcome: failed ? "partial" : did ? "removed" : "nothing due", source: record.source === "automatic" ? "policy" : "request", detail: sweepWords(record.parts) });
  return record;
}

function parseParts(text: string): SweepPart[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((one): one is SweepPart => typeof one === "object" && one !== null && typeof (one as SweepPart).kind === "string") : [];
  } catch { return []; }
}

/** The latest sweep (of `source`, or either), or null when there has been none. */
export function lastSweep(store: Store, source?: SweepRecord["source"]): SweepRecord | null {
  const row = store.handle.prepare(`SELECT at, source, actor, result FROM storage_sweep${source === undefined ? "" : " WHERE source = ?"} ORDER BY id DESC LIMIT 1`)
    .get(...(source === undefined ? [] : [source]));
  if (row === undefined) return null;
  return { at: String(row["at"]), source: row["source"] === "manual" ? "manual" : "automatic", actor: String(row["actor"]), parts: parseParts(String(row["result"])) };
}

/** When the next automatic sweep is due, or null when it is off. */
export function nextSweepAt(store: Store): string | null {
  if (storageSweepOff()) return null;
  const last = store.serviceCursor(CURSOR);
  return last === 0 ? null : new Date(last + SWEEP_EVERY_MS).toISOString();
}

const NOUNS: Record<SweepKind, [string, string]> = {
  "test temp": ["test temp folder", "test temp folders"],
  orphans: ["leftover process", "leftover processes"],
  checkouts: ["finished checkout", "finished checkouts"],
  runtimes: ["staged runtime", "staged runtimes"],
  dependencies: ["unused dependency install", "unused dependency installs"],
};

/** What a part looks at, for "Couldn't check …". */
const CHECKED: Record<SweepKind, string> = { "test temp": "test temp folders", orphans: "processes", checkouts: "checkouts", runtimes: "staged runtimes", dependencies: "dependency installs" };

export function partWords(one: Pick<SweepPart, "kind" | "count">): string {
  return `${one.count.toLocaleString("en-US")} ${NOUNS[one.kind][one.count === 1 ? 0 : 1]}`;
}

function list(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "Removed 120 test temp folders and 2 finished checkouts, about 1.2 GB. Stopped 1 leftover process. 3 couldn't be removed." */
export function sweepWords(parts: readonly SweepPart[]): string {
  const removed = parts.filter(one => one.kind !== "orphans" && one.count > 0);
  const stopped = parts.find(one => one.kind === "orphans" && one.count > 0);
  const bytes = removed.reduce((sum, one) => sum + one.bytes, 0);
  const failed = parts.reduce((sum, one) => sum + one.failed, 0);
  const problems = parts.filter(one => one.problem !== undefined).map(one => one.kind);
  const said = [
    ...(removed.length === 0 ? [] : [`Removed ${list(removed.map(partWords))}${bytes > 0 ? `, about ${bytesWords(bytes)}` : ""}.`]),
    ...(stopped === undefined ? [] : [`Stopped ${partWords(stopped)}.`]),
    ...(failed === 0 ? [] : [`${failed} couldn't be removed.`]),
    ...(problems.length === 0 ? [] : [`Couldn't check ${list(problems.map(kind => CHECKED[kind]))}.`]),
  ];
  return said.length === 0 ? "Nothing was due." : said.join(" ");
}

/** The details a disclosure shows: each part's paths, problems and what's left for later, one line each. */
export function sweepDetails(parts: readonly SweepPart[]): string[] {
  const lines: string[] = [];
  for (const one of parts) {
    if (one.problem !== undefined) lines.push(`${NOUNS[one.kind][1][0]!.toUpperCase()}${NOUNS[one.kind][1].slice(1)}: ${one.problem}`);
    if (one.more === true) lines.push(`More ${NOUNS[one.kind][1]} are left for the next sweep.`);
    for (const item of one.items) lines.push(item);
    if (one.items.length > 0 && one.count > one.items.length) lines.push(`… and ${(one.count - one.items.length).toLocaleString("en-US")} more ${NOUNS[one.kind][1]}`);
  }
  return lines;
}
