/**
 * Backups (sprint 8): the database, copied on a schedule with SQLite's online
 * backup (one read snapshot, so the console and workers keep writing), into
 * a folder the operator chooses (by default `backups` beside the database),
 * keeping the newest N. Each backup is checked (it opens, it passes SQLite's
 * quick check) before it counts, and each one's outcome is kept.
 *
 * Only the database is copied. Provider keys, sign-in files and other secrets
 * live in their own files beside it and are never part of a backup.
 *
 * `restore` puts a backup back, only with Toolroll stopped: it checks
 * the backup's schema version and walks its ledger chain first, keeps the
 * current database as a copy, and with --dry-run changes nothing.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { BACKUP_EVERY_HOURS, MAX_KEEP } from "./backup-ui.js";
import { verifyLedgerChain } from "./ledger-chain.js";
import { openStore, readSchemaVersion, SCHEMA_VERSION, type BackupSettings, type Database, type Store } from "./store.js";

/** A scheduled backup's name: the database it came from (see `databaseTag`), then when it was made. Backups made
 * before the tag was added have none. Retention only ever removes files named like this. */
const BACKUP_NAME = /^standing-orders-(?:([0-9a-f]{8})-)?(\d{4}-\d{2}-\d{2}-\d{6})(?:-(\d+))?\.db$/;
/** The oldest schema whose ledger has a hash chain to verify. */
export const OLDEST_RESTORABLE = 103;
export { BACKUP_EVERY_HOURS, MAX_KEEP };
/** How long the console's lease lasts without a renewal: a console that stopped holds it no longer than this. */
const LEASE_MS = 3 * 60_000;
/** A worker that heartbeat this recently is taken to be running. */
const RUNNER_FRESH_MS = 3 * 60_000;

export const defaultBackupFolder = (databaseFile: string) => join(dirname(databaseFile), "backups");
export const backupFolderOf = (settings: BackupSettings, databaseFile: string) => settings.folder ?? defaultBackupFolder(databaseFile);

/** 2026-09-28T05:34:39.123Z → 2026-09-28-053439 (UTC). */
const stampOf = (now: Date) => now.toISOString().replace(/\.\d+Z$/, "").replace("T", "-").replace(/:/g, "");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Loaded on first use, as store.ts does, so modules that only import this one (the console, and tests that load it
 * in a browser-like environment) never need `node:sqlite` itself. */
function sqlite(): { backup: typeof sqliteBackup; DatabaseSync: typeof DatabaseSync } {
  return createRequire(import.meta.url)("node:sqlite") as { backup: typeof sqliteBackup; DatabaseSync: typeof DatabaseSync };
}

function connect(file: string): DatabaseSync {
  const db = new (sqlite().DatabaseSync)(file);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Copy `sourceFile` into `target` with the online backup (all pages in one step: one consistent snapshot, and
 * writers carry on meanwhile), then make the copy one self-contained file and check it. */
export async function onlineCopy(sourceFile: string, target: string): Promise<{ bytes: number; schemaVersion: number | null }> {
  const source = connect(sourceFile);
  // Every page in one step (SQLite's -1 means that too, but newer Node builds take only a positive rate).
  try { await sqlite().backup(source, target, { rate: 1_000_000 }); } finally { source.close(); }
  chmodSync(target, 0o600);
  const copy = connect(target);
  let schemaVersion: number | null;
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
    const check = copy.prepare("PRAGMA quick_check").get();
    if (check?.["quick_check"] !== "ok") throw new Error(`the copy failed SQLite's check (${String(check?.["quick_check"] ?? "no answer")})`);
    const version = readSchemaVersion(copy as unknown as Database);
    schemaVersion = version.ok ? version.version : null;
  } finally { copy.close(); }
  const handle = openSync(target, "r");
  try { fsyncSync(handle); } finally { closeSync(handle); }
  return { bytes: statSync(target).size, schemaVersion };
}

/** A folder the operator may choose: a full path, outside every project and build checkout (agents work there). */
export function checkBackupFolder(path: string, forbidden: readonly string[]): string | null {
  const folder = path.trim();
  if (!isAbsolute(folder) || folder.length > 500 || /[\u0000-\u001f]/.test(folder)) return "The folder is a full path, like /Volumes/Backup/standing-orders.";
  const at = resolve(folder);
  const inside = (one: string, parent: string) => one === parent || one.startsWith(`${parent}/`);
  if (forbidden.some(one => inside(at, resolve(one)) || inside(resolve(one), at))) return "Choose a folder outside your projects and build checkouts: agents work there.";
  return null;
}

/** A short tag for one database, from its full path, so databases that share a backup folder tell their backups apart. */
export function databaseTag(databaseFile: string): string {
  let path = resolve(databaseFile);
  try { path = realpathSync(path); } catch { /* not there yet: its path as given */ }
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

/** Whose backups are whose: this database's tag, and every backup file its own history records making. */
export type BackupOwner = { tag: string; made: ReadonlySet<string> };
export function backupOwner(store: Store, databaseFile: string): BackupOwner {
  const made = store.handle.prepare("SELECT file FROM backup_run WHERE ok = 1 AND file IS NOT NULL").all().map(row => resolve(String(row["file"])));
  return { tag: databaseTag(databaseFile), made: new Set(made) };
}

/** This database's backups in a folder, made on a schedule or by `backup now`, newest first. A backup tagged for
 * another database is never this one's. An untagged one (made before backups were tagged) is this one's only when its
 * own history records making it: pruning deletes, so what can't be proved ours is left alone. */
export function backupFiles(folder: string, owner: BackupOwner): { name: string; path: string; bytes: number }[] {
  let names: string[];
  try { names = readdirSync(folder); } catch { return []; }
  const named = names.flatMap(name => { const m = BACKUP_NAME.exec(name); return m === null ? [] : [{ name, tag: m[1] ?? null, order: `${m[2]}-${(m[3] ?? "1").padStart(6, "0")}` }]; });
  return named
    .filter(one => one.tag === owner.tag || (one.tag === null && owner.made.has(resolve(folder, one.name))))
    .sort((a, b) => a.order < b.order ? 1 : a.order > b.order ? -1 : a.name < b.name ? 1 : -1)
    .flatMap(({ name }) => {
      const path = join(folder, name);
      try { const stat = lstatSync(path); return stat.isFile() ? [{ name, path, bytes: stat.size }] : []; } catch { return []; }
    });
}

/** Remove all but this database's newest `keep` backups. Never touches another database's, or anything else in the folder. */
export function pruneBackups(folder: string, keep: number, owner: BackupOwner): number {
  let removed = 0;
  for (const one of backupFiles(folder, owner).slice(Math.max(1, keep))) {
    try { rmSync(one.path); removed++; } catch { /* the next backup tries again */ }
  }
  return removed;
}

/** A failure in plain words: the common file-system ones by name, anything else as SQLite or Node said it. */
function failureWords(error: unknown, folder: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return `Toolroll isn't allowed to write to ${folder}.`;
  if (code === "ENOSPC" || code === "EDQUOT") return `The disk holding ${folder} is full.`;
  if (code === "ENOTDIR" || code === "EEXIST") return `${folder} isn't a folder.`;
  return message(error);
}

/** The checkpoint made before a backup: the head it records, a broken chain's first break (none recorded), or null (nothing new since the last). */
export type BackupCheckpoint = { through: number; hash: string } | { problem: string } | null;
export type BackupOutcome = { ok: true; id: number; file: string; bytes: number; removed: number; checkpoint: BackupCheckpoint } | { ok: false; id: number; error: string };

/** Back the database up now, keep the newest N, and record how it went. */
export async function backupNow(store: Store, databaseFile: string, trigger: "scheduled" | "manual", clock: () => Date = () => new Date()): Promise<BackupOutcome> {
  const settings = store.backupSettings();
  const folder = backupFolderOf(settings, databaseFile);
  const id = store.startBackupRun(trigger, clock());
  let partial: string | null = null;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stamp = `${databaseTag(databaseFile)}-${stampOf(clock())}`;
    let name = `standing-orders-${stamp}.db`;
    for (let n = 2; existsSync(join(folder, name)); n++) name = `standing-orders-${stamp}-${n}.db`;
    // The whole chain walked and its head checkpointed first, so the copy carries the checkpoint. A broken chain gets
    // none (the walk raises the console's chain alarm, as any whole walk does); the backup goes ahead either way.
    let checkpoint: BackupCheckpoint;
    try { checkpoint = store.ledgerCheckpoint("system", clock(), {}); } catch (error) { checkpoint = { problem: message(error) }; }
    partial = join(folder, `.${name}.${randomBytes(4).toString("hex")}.partial`);
    const made = await onlineCopy(databaseFile, partial);
    const file = join(folder, name);
    renameSync(partial, file);
    partial = null;
    const removed = pruneBackups(folder, settings.keep, backupOwner(store, databaseFile));
    store.finishBackupRun(id, { ok: true, file, bytes: made.bytes, schemaVersion: made.schemaVersion, removed }, clock());
    return { ok: true, id, file, bytes: made.bytes, removed, checkpoint };
  } catch (error) {
    if (partial !== null) rmSync(partial, { force: true });
    const words = failureWords(error, folder);
    store.finishBackupRun(id, { ok: false, error: words }, clock());
    if (trigger === "scheduled") {
      const day = clock().toISOString().slice(0, 10);
      store.enqueueNotification({ dedupeKey: `backup-failed:${day}`, kind: "backup-failed", pushClass: "attention", link: "/settings/backups",
        subject: "A backup failed", body: `The scheduled backup didn't finish: ${words.slice(0, 200)}`, source: { installation: true } }, clock());
    }
    return { ok: false, id, error: words };
  }
}

/** Whether a scheduled backup is due: the last good one is older than the schedule, and the last try over an hour ago. */
export function backupDue(store: Store, now: Date): boolean {
  const settings = store.backupSettings();
  if (!settings.enabled) return false;
  const runs = store.backupRuns(50);
  const last = runs[0];
  if (last !== undefined && last.finishedAt === null && now.getTime() - Date.parse(last.startedAt) < 60 * 60_000) return false;
  const good = runs.find(one => one.ok === true);
  const every = settings.everyHours * 60 * 60_000;
  if (good !== undefined && now.getTime() - Date.parse(good.startedAt) < every) return false;
  return last === undefined || now.getTime() - Date.parse(last.startedAt) >= Math.min(every, 60 * 60_000);
}

/** One pass of the loop beside the console: renew the lease (a restore sees it), and back up when due. */
export async function backupPass(store: Store, databaseFile: string, holder: string, clock: () => Date = () => new Date()): Promise<BackupOutcome | null> {
  const now = clock();
  if (!store.holdBackupLease(holder, now, new Date(now.getTime() + LEASE_MS))) return null;
  if (!backupDue(store, now)) return null;
  return backupNow(store, databaseFile, "scheduled", clock);
}

/** The loop beside the console: a pass a minute. */
export function startBackups(store: Store, databaseFile: string, everyMs = 60_000): () => void {
  const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let stopped = false, timer: NodeJS.Timeout | null = null;
  const pass = async () => {
    if (stopped) return;
    try { await backupPass(store, databaseFile, holder); } catch { /* the next pass tries again */ }
    if (!stopped) { timer = setTimeout(() => void pass(), everyMs); timer.unref?.(); }
  };
  timer = setTimeout(() => void pass(), 2_000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    try { store.releaseBackupLease(holder); } catch { /* the lease runs out on its own */ }
  };
}

/** What's running against the database now: the console (its backup lease), and workers (watch leases, runner heartbeats). */
export function runningNow(store: Store, now: Date): string[] {
  const running: string[] = [];
  if (store.backupLease(now) !== null) running.push("the console");
  const watches = store.handle.prepare("SELECT COUNT(*) AS n FROM watch_lease WHERE expires_at >= ?").get(now.toISOString());
  const fresh = new Date(now.getTime() - RUNNER_FRESH_MS).toISOString();
  const runners = store.handle.prepare("SELECT name FROM runner WHERE retired_at IS NULL AND heartbeat_at >= ? ORDER BY name").all(fresh).map(row => String(row["name"]));
  if (Number(watches?.["n"] ?? 0) > 0 || runners.length > 0) running.push(runners.length === 0 ? "a worker" : `the worker ${runners.join(", ")}`);
  return running;
}

export type RestoreRefusal = "not-found" | "same-file" | "running" | "unreadable" | "schema" | "ledger";
export type RestoreReport = {
  ok: boolean;
  dryRun: boolean;
  file: string;
  /** Why it won't restore, each in words (every check that failed, so one attempt shows them all). */
  refusals: { reason: RestoreRefusal; words: string }[];
  schemaVersion: number | null;
  ledger: { entries: number; through: number | null } | null;
  /** Where the database as it was before the restore is kept (null on a dry run or a refusal). */
  savedAs: string | null;
};

/**
 * Put a backup back in place of the database. Refuses while Toolroll is running, when the backup isn't a
 * Toolroll database this build can read (its schema version), or when its ledger chain doesn't verify. The
 * backup is copied beside the database first and every check runs on that copy, so what was checked is what goes in.
 */
export async function restoreDatabase(options: { databaseFile: string; file: string; dryRun: boolean; now: Date; actor?: string }): Promise<RestoreReport> {
  const { databaseFile, dryRun, now } = options;
  const file = resolve(options.file);
  const report: RestoreReport = { ok: false, dryRun, file, refusals: [], schemaVersion: null, ledger: null, savedAs: null };
  const refuse = (reason: RestoreRefusal, words: string) => { report.refusals.push({ reason, words }); return report; };
  let stat;
  try { stat = lstatSync(file); } catch { return refuse("not-found", `There's no file at ${file}.`); }
  if (!stat.isFile()) return refuse("not-found", `${file} isn't a plain file.`);
  if (existsSync(databaseFile) && resolve(databaseFile) === file) return refuse("same-file", "That's the database in use now, not a backup.");

  // What's running, and where the copy of the current database goes, from the database as it is.
  let folder: string;
  {
    const store = openStore(databaseFile);
    try {
      const running = runningNow(store, now);
      if (running.length > 0) refuse("running", `Toolroll is running (${running.join(" and ")}). Stop it first, then restore. If it has just stopped, wait a few minutes.`);
      folder = backupFolderOf(store.backupSettings(), databaseFile);
    } finally { store.close(); }
  }

  const staged = join(dirname(databaseFile), `.restore-${randomBytes(6).toString("hex")}.db`);
  let keepStaged = false;
  try {
    copyFileSync(file, staged, constants.COPYFILE_EXCL);
    chmodSync(staged, 0o600);
    if (existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0) {
      return refuse("unreadable", "That backup still has changes in its -wal file beside it. Open it once with sqlite3 to fold them in, or choose another backup.");
    }
    let db: DatabaseSync;
    try { db = connect(staged); } catch { return refuse("unreadable", "That file isn't a database Toolroll can open."); }
    try {
      let check: string;
      try { check = String(db.prepare("PRAGMA quick_check").get()?.["quick_check"] ?? ""); } catch { check = "not a database"; }
      if (check !== "ok") return refuse("unreadable", `That file isn't a sound SQLite database (${check}).`);
      const version = readSchemaVersion(db as unknown as Database);
      const schema = version.ok ? version.version : null;
      report.schemaVersion = schema;
      if (schema === null) return refuse("schema", "That file isn't a Toolroll database: it has no schema version.");
      if (schema > SCHEMA_VERSION) return refuse("schema", `That backup was made by a newer Toolroll (schema ${schema}; this one reads up to ${SCHEMA_VERSION}). Restore it with that version.`);
      if (schema < OLDEST_RESTORABLE) return refuse("schema", `That backup is from schema ${schema}, before the ledger had a hash chain to check. Restore it with the Toolroll that made it.`);
      const chain = verifyLedgerChain(db as unknown as Database);
      report.ledger = { entries: chain.entries, through: chain.through };
      if (!chain.ok) return refuse("ledger", `That backup's ledger chain doesn't verify: ${chain.problem?.what ?? "it breaks"}.`);
      db.exec("PRAGMA journal_mode = DELETE");
    } finally { db.close(); }
    // It must open as this build's database (every table it needs, every step up to this schema) before it may replace
    // the live one: a sound file with the right version can still be missing what Toolroll reads.
    if (report.refusals.length === 0) {
      const probe = `${staged}.probe`;
      try {
        copyFileSync(staged, probe);
        try { openStore(probe).close(); } catch (error) { refuse("schema", `That backup doesn't open as a Toolroll database (${firstLine(error)}).`); }
      } finally { for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${probe}${suffix}`, { force: true }); }
    }
    if (report.refusals.length > 0 || dryRun) { report.ok = report.refusals.length === 0; return report; }

    // Keep the database as it is now, checked like any backup, before anything replaces it.
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const saved = join(folder, `before-restore-${stampOf(now)}-${randomBytes(3).toString("hex")}.db`);
    const partial = `${saved}.partial`;
    try { await onlineCopy(databaseFile, partial); renameSync(partial, saved); } catch (error) { rmSync(partial, { force: true }); throw new Error(`the current database couldn't be saved first, so nothing was replaced (${message(error)})`); }
    report.savedAs = saved;

    // Again, just before the swap: nothing may have started meanwhile.
    const store = openStore(databaseFile);
    try {
      const running = runningNow(store, new Date());
      if (running.length > 0) return refuse("running", `Toolroll started (${running.join(" and ")}). Stop it first, then restore. The database is unchanged.`);
    } finally { store.close(); }
    // Fold the write-ahead log in and drop it, so nothing of the old database is left beside the new one.
    const live = connect(databaseFile);
    try { live.exec("PRAGMA wal_checkpoint(TRUNCATE)"); live.exec("PRAGMA journal_mode = DELETE"); } finally { live.close(); }
    for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${databaseFile}${suffix}`, { force: true });
    renameSync(staged, databaseFile);
    keepStaged = true;

    // The restored database brought up to this build, and the restore in its ledger. Should it still not open, the
    // database it replaced goes back, and the restore says so.
    let restored: Store;
    try {
      restored = openStore(databaseFile);
    } catch (error) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${databaseFile}${suffix}`, { force: true });
      copyFileSync(saved, databaseFile);
      chmodSync(databaseFile, 0o600);
      report.savedAs = null;
      return refuse("unreadable", `The restored database didn't open (${firstLine(error)}), so the one it replaced was put back as it was.`);
    }
    try {
      restored.recordAction({ at: now.toISOString(), actor: options.actor ?? "command line", repo: null, taskId: null, runId: null, action: "database restored", outcome: "restored", source: "policy",
        detail: `from ${basename(file)} (schema ${report.schemaVersion}); the database before it was kept as ${basename(saved)}` });
    } finally { restored.close(); }
    report.ok = true;
    return report;
  } finally {
    if (!keepStaged) rmSync(staged, { force: true });
  }
}

/** An error's first line, for a sentence. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
}
