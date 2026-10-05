/**
 * The daily storage sweep: the plane cleans up after itself without anyone running a command. Once a day (one worker
 * takes the day: the cursor moves in the same transaction) it removes test temp folders nothing touched for a day
 * (test-temp.ts), stops orphans Toolroll left running (orphan-sweep.ts), removes finished checkouts the cleanup
 * setting lets go (checkout-cleanup.ts), keeps the current, previous and newest staged runtimes (staged-runtimes.ts)
 * and removes shared dependency installs no checkout has used for a week (shared-deps.ts).
 *
 * The everyday work stays where it happens: suites remove their own temp roots and processes, a run's processes stop
 * when it ends and a finished checkout goes on the worker's next pass. This is the net for what slipped through.
 *
 * What each sweep did is saved (the latest few) and in the ledger: `toolroll storage` and Settings → Storage show it.
 * A clean-up by hand (`storage clean --yes`) is saved the same way. A part that failed, or had more than one pass
 * takes, brings the next sweep forward to an hour later. `TOOLROLL_STORAGE_SWEEP=off` turns the automatic sweep off
 * (the unit tests do, so a test never sweeps the machine it runs on).
 */
import { dirname } from "node:path";
import { cleanCheckouts } from "./checkout-cleanup.js";
import { durationWords, sweepOrphans, ownerRunning, type Located } from "./orphan-sweep.js";
import { processCensus, type ProcessRow } from "./run-closeout.js";
import { pruneUnusedShared, sharedDepsRoot, sharedUse, SHARED_UNUSED_MS } from "./shared-deps.js";
import { pruneStagedRuntimes, runtimesInUse, stagePlan } from "./staged-runtimes.js";
import { bytesWords, diskBytes } from "./storage.js";
import type { Store } from "./store.js";
import { removeStaleTestTemp } from "./test-temp.js";
import type { WorktreePool } from "./worktree.js";

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
  census?: () => ProcessRow[];
  locate?: (pids: readonly number[]) => Map<number, Located>;
  inUse?: () => string[];
  graceMs?: number;
};

export function storageSweepOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["TOOLROLL_STORAGE_SWEEP"] ?? "").trim().toLowerCase() === "off";
}

export function storageSweepDue(store: Store, now: Date): boolean {
  return now.getTime() - store.serviceCursor(CURSOR) >= SWEEP_EVERY_MS;
}

/** The daily sweep, when it's due and on: one worker takes it. Null when it wasn't this pass's to run. */
export async function dailyStorageSweep(store: Store, deps: SweepDeps, now: () => Date): Promise<SweepRecord | null> {
  if (storageSweepOff()) return null;
  const at = now();
  const mine = store.transact(() => {
    if (!storageSweepDue(store, at)) return false;
    store.setServiceCursor(CURSOR, at.getTime(), at);
    return true;
  });
  if (!mine) return null;
  const record = await sweepStorage(store, deps, now);
  // Something failed or was left for later: the next sweep comes an hour from now, not tomorrow.
  if (record.parts.some(one => one.failed > 0 || one.more === true || one.problem !== undefined)) {
    store.setServiceCursor(CURSOR, Math.max(0, at.getTime() - SWEEP_EVERY_MS + RETRY_MS), now());
  }
  return record;
}

const capped = (items: readonly string[]) => items.slice(0, ITEMS_MAX);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One sweep, now, every part; saved and in the ledger. Each part's failure is its own: the others still run. */
export async function sweepStorage(store: Store, deps: SweepDeps, now: () => Date): Promise<SweepRecord> {
  const actor = deps.actor ?? "worker";
  const read = deps.census ?? (() => processCensus());
  const parts: SweepPart[] = [];
  const part = async (kind: SweepKind, work: () => Promise<Omit<SweepPart, "kind">>) => {
    try { parts.push({ kind, ...await work() }); } catch (error) { parts.push({ kind, count: 0, bytes: 0, failed: 0, problem: failure(error), items: [] }); }
  };

  await part("test temp", async () => {
    // A root whose owner still runs stays, however old it looks; with no process list, every owned root stays.
    let alive: (owner: { pid: number; startedAt: number }) => boolean = () => true;
    try { alive = ownerRunning(read()); } catch { /* owned roots stay */ }
    const done = removeStaleTestTemp(deps.tempRoots, now(), { ownerAlive: alive, max: TEMP_MAX });
    return { count: done.removed.length, bytes: 0, failed: done.failed.length, ...(done.more ? { more: true } : {}), items: capped(done.removed) };
  });

  await part("orphans", async () => {
    const done = await sweepOrphans(store, now, {
      actor, pool: deps.pool, tempRoots: deps.tempRoots, census: read,
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
      const done = await cleanCheckouts(store, pool, now, { manual: false, actor });
      return { count: done.removed.length, bytes: done.freed, failed: done.kept.filter(one => one.why === "git refused").length, items: capped(done.removed.map(one => one.path)) };
    });
  }

  const stateDir = dirname(deps.databaseFile);
  await part("runtimes", async () => {
    const inUse = deps.inUse ?? (() => runtimesInUse());
    const plan = stagePlan(stateDir, inUse(), now());
    const sizes = diskBytes(plan.go.map(one => one.path));
    const done = pruneStagedRuntimes(stateDir, now(), { inUse });
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
    const done = pruneUnusedShared(root, checkouts, now());
    return { count: done.removed.length, bytes: done.removed.reduce((sum, one) => sum + (sizes.get(one.dir) ?? 0), 0), failed: done.failed.length, items: capped(done.removed.map(one => one.dir)) };
  });

  return saveSweep(store, { at: now().toISOString(), source: "automatic", actor, parts });
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
