/**
 * The continuous copy (docs/plans/actors-lessons.md): every few minutes (default 5) the worker takes an online SQLite
 * backup of the database into a folder (default `backups/live` beside it), checks it with `PRAGMA integrity_check`,
 * hashes it and renames it into place, then records it as the latest verified copy (path, sha256, time, schema). It
 * keeps the newest 24 and the newest of each of the last 7 days.
 *
 * Off the hot path: the copy, the check and the hash run on a worker thread, so neither the console nor the worker's
 * loops wait for them. One process copies at a time (the live_backup lease).
 *
 * The folder is checked every time before use: a plain directory this user owns, not a link and reached through none,
 * not writable by others, and inside the permanent fenced `backups` namespace beside the actual database, outside
 * every project and build checkout (backup.ts checkBackupFolder). Restoring stays manual (`toolroll restore <file>` with Toolroll stopped). A deploy reuses the latest copy only
 * when it is fresh, its schema matches and its content proves equal to the database it would otherwise copy
 * (scripts/deploy-phases.mjs liveCopyBackup).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { checkBackupFolder, databaseTag } from "./backup.js";
import { holdLiveBackup, liveBackupState, recordLiveBackup, releaseLiveBackup, type LiveBackupCopy, type LiveBackupSettings, type Store } from "./store.js";

/** The choices Settings offers, in minutes (0: off is its own choice). */
export const LIVE_EVERY_MINUTES = [1, 5, 15, 30] as const;
/** Daily copies are kept this many days besides the newest `keep`. */
export const LIVE_DAILY_DAYS = 7;
/** How long one copy may hold the lease. */
const LEASE_MS = 15 * 60_000;

/** `backups/live` beside the database, through its real path (the folder check refuses a path through a link). */
export function defaultLiveFolder(databaseFile: string): string {
  let database = resolve(databaseFile);
  try { database = realpathSync(database); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let at = dirname(database);
  try { at = realpathSync(at); } catch { /* not there yet: as given */ }
  return join(at, "backups", "live");
}
export const liveFolderOf = (settings: LiveBackupSettings, databaseFile: string): string => settings.folder ?? defaultLiveFolder(databaseFile);

/** Why a folder can't hold the copies, or null. Missing is fine (it is made on first use, then checked again). */
export function liveFolderProblem(folder: string, forbidden: readonly string[], protectedRoot?: string): string | null {
  const said = checkBackupFolder(folder, forbidden);
  if (said !== null) return said;
  if (protectedRoot !== undefined) {
    const rel = relative(resolve(protectedRoot), resolve(folder));
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return `Choose a location inside the protected backup folder ${protectedRoot}.`;
  }
  let stat;
  try { stat = lstatSync(folder); } catch { return null; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${folder} isn't a plain folder.`;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return `${folder} belongs to another user.`;
  if ((stat.mode & 0o022) !== 0) return `Other users can write to ${folder}.`;
  let real: string;
  try { real = realpathSync(folder); } catch { return `${folder} can't be read.`; }
  if (real !== resolve(folder)) return `${folder} goes through a link; choose its real path (${real}).`;
  return null;
}

const NAME = (tag: string) => new RegExp(`^live-${tag}-(\\d{4}-\\d{2}-\\d{2})-(\\d{6})(?:-(\\d+))?\\.db$`);
const PARTIAL = (tag: string) => new RegExp(`^\\.live-${tag}-.*\\.partial$`);
const stampOf = (now: Date) => now.toISOString().replace(/\.\d+Z$/, "").replace("T", "-").replace(/:/g, "");

/** This database's copies in a folder, newest first (plain files named for it only). */
export function liveCopies(folder: string, tag: string): { name: string; path: string; day: string }[] {
  let names: string[];
  try { names = readdirSync(folder); } catch { return []; }
  const pattern = NAME(tag);
  return names.flatMap(name => {
    const m = pattern.exec(name);
    if (m === null) return [];
    try { if (!lstatSync(join(folder, name)).isFile()) return []; } catch { return []; }
    return [{ name, path: join(folder, name), day: m[1]!, order: `${m[1]}-${m[2]}-${(m[3] ?? "1").padStart(6, "0")}` }];
  }).sort((a, b) => a.order < b.order ? 1 : a.order > b.order ? -1 : 0).map(({ name, path, day }) => ({ name, path, day }));
}

/** Keep the newest `keep`, the newest of each of the last LIVE_DAILY_DAYS days, and `protect`; remove the rest (and
 * this database's partial files older than an hour). Never anything not named for this database. */
export function pruneLiveCopies(folder: string, tag: string, keep: number, now: Date, protect: string | null): number {
  const copies = liveCopies(folder, tag);
  const kept = new Set(copies.slice(0, Math.max(1, keep)).map(one => one.path));
  const oldest = new Date(now.getTime() - (LIVE_DAILY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const days = new Set<string>();
  for (const one of copies) if (one.day >= oldest && !days.has(one.day)) { days.add(one.day); kept.add(one.path); }
  if (protect !== null) kept.add(resolve(protect));
  let removed = 0;
  for (const one of copies) if (!kept.has(one.path)) { try { rmSync(one.path); removed++; } catch { /* the next pass tries again */ } }
  try {
    for (const name of readdirSync(folder).filter(one => PARTIAL(tag).test(one))) {
      const path = join(folder, name), stat = lstatSync(path);
      if (stat.isFile() && now.getTime() - stat.mtimeMs > 60 * 60_000) rmSync(path, { force: true });
    }
  } catch { /* the next pass tries again */ }
  return removed;
}

/** The thread's whole job, plain JavaScript (an eval worker: no loader, the same in a checkout and when installed). */
const COPY_THREAD = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync, backup } = require("node:sqlite");
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
(async () => {
  const { source, partial, target } = workerData;
  try {
    const db = new DatabaseSync(source);
    db.exec("PRAGMA busy_timeout = 5000");
    // SQLite inherits the private file: no world-readable partial exists even briefly.
    fs.closeSync(fs.openSync(partial, "wx", 0o600));
    try { await backup(db, partial, { rate: 1000000 }); } finally { db.close(); }
    fs.chmodSync(partial, 0o600);
    const copy = new DatabaseSync(partial);
    let schemaVersion;
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
      const check = copy.prepare("PRAGMA integrity_check").all();
      if (check.length !== 1 || check[0].integrity_check !== "ok") throw new Error("the copy failed SQLite's integrity check");
      schemaVersion = Number(copy.prepare("SELECT version FROM schema_version").get()?.version);
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("the copy has no settled schema version");
    } finally { copy.close(); }
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1 << 20), fd = fs.openSync(partial, "r");
    try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(partial, target);
    const dir = fs.openSync(path.dirname(target), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    parentPort.postMessage({ ok: true, sha256: hash.digest("hex"), bytes: fs.statSync(target).size, schemaVersion });
  } catch (error) {
    try { fs.rmSync(partial, { force: true }); } catch {}
    parentPort.postMessage({ ok: false, problem: String((error && error.message) || error).slice(0, 300) });
  }
})();
`;

/** One copy on a worker thread: copied, checked, hashed and renamed into place, or a problem (nothing left behind). */
export function copyOffThread(source: string, folder: string, tag: string, now: Date): Promise<{ ok: true; copy: Omit<LiveBackupCopy, "madeAt"> } | { ok: false; problem: string }> {
  const stamp = stampOf(now);
  let name = `live-${tag}-${stamp}.db`;
  for (let n = 2; (() => { try { lstatSync(join(folder, name)); return true; } catch { return false; } })(); n++) name = `live-${tag}-${stamp}-${n}.db`;
  const target = join(folder, name), partial = join(folder, `.live-${tag}-${stamp}.${randomBytes(4).toString("hex")}.partial`);
  return new Promise(done => {
    const thread = new Worker(COPY_THREAD, { eval: true, workerData: { source, partial, target } });
    let settled = false;
    const finish = (answer: { ok: true; copy: Omit<LiveBackupCopy, "madeAt"> } | { ok: false; problem: string }): void => { if (!settled) { settled = true; done(answer); } };
    thread.once("message", (message: { ok: boolean; sha256?: string; bytes?: number; schemaVersion?: number; problem?: string }) => finish(message.ok
      ? { ok: true, copy: { file: target, sha256: String(message.sha256), bytes: Number(message.bytes), schemaVersion: Number(message.schemaVersion) } }
      : { ok: false, problem: message.problem ?? "the copy failed" }));
    thread.once("error", (error: Error) => { rmSync(partial, { force: true }); finish({ ok: false, problem: String(error.message).slice(0, 300) }); });
    thread.once("exit", () => finish({ ok: false, problem: "the copy stopped before it finished" }));
  });
}

/** Whether a copy is due: on, and the latest (or the latest try) is at least the schedule old. */
export function liveCopyDue(store: Store, now: Date): boolean {
  const state = liveBackupState(store);
  if (!state.settings.enabled) return false;
  const every = state.settings.everyMinutes * 60_000;
  const last = Math.max(state.latest === null ? 0 : Date.parse(state.latest.madeAt), state.triedAt === null ? 0 : Date.parse(state.triedAt));
  return !Number.isFinite(last) || now.getTime() - last >= every;
}

/** One pass: hold the lease, and when due check the folder, copy, record and prune. */
export async function liveBackupPass(store: Store, databaseFile: string, holder: string, forbidden: () => readonly string[], clock: () => Date = () => new Date()): Promise<{ ok: true; copy: LiveBackupCopy } | { ok: false; problem: string } | null> {
  const now = clock();
  if (!liveCopyDue(store, now)) return null;
  if (!holdLiveBackup(store, holder, now, new Date(now.getTime() + LEASE_MS))) return null;
  try {
    const state = liveBackupState(store);
    const folder = liveFolderOf(state.settings, databaseFile);
    const fail = (problem: string) => { recordLiveBackup(store, { ok: false, problem }, clock()); return { ok: false as const, problem }; };
    let problem = liveFolderProblem(folder, forbidden(), dirname(defaultLiveFolder(databaseFile)));
    if (problem !== null) return fail(problem);
    try { mkdirSync(folder, { recursive: true, mode: 0o700 }); } catch (error) { return fail(`${folder} couldn't be made (${(error as Error).message})`); }
    // Checked again now that it exists: what was made (or found) is what is used.
    problem = liveFolderProblem(folder, forbidden(), dirname(defaultLiveFolder(databaseFile)));
    if (problem !== null) return fail(problem);
    const made = await copyOffThread(databaseFile, folder, databaseTag(databaseFile), now);
    if (!made.ok) return fail(made.problem);
    const copy: LiveBackupCopy = { ...made.copy, madeAt: now.toISOString() };
    recordLiveBackup(store, { ok: true, copy }, clock());
    pruneLiveCopies(folder, databaseTag(databaseFile), state.settings.keep, clock(), copy.file);
    return { ok: true, copy };
  } finally { releaseLiveBackup(store, holder); }
}

/** The loop in the worker: a pass a minute (the first after 30 s). The returned stop waits for a copy under way. */
export function startLiveBackups(store: Store, databaseFile: string, forbidden: () => readonly string[], everyMs = 60_000): () => Promise<void> {
  const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let stopped = false, timer: NodeJS.Timeout | null = null, running: Promise<unknown> = Promise.resolve();
  const pass = (): void => {
    if (stopped) return;
    running = liveBackupPass(store, databaseFile, holder, forbidden).catch(() => null).finally(() => {
      if (!stopped) { timer = setTimeout(pass, everyMs); timer.unref?.(); }
    });
  };
  timer = setTimeout(pass, 30_000);
  timer.unref?.();
  return async () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    // A copy under way gets a few seconds; past that the process may end under it (its partial file is removed later).
    await Promise.race([running, new Promise(resolveWait => setTimeout(resolveWait, 10_000).unref?.())]);
  };
}
