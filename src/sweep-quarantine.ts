/** Atomic rename before deletion. Trash is never a reusable dependency copy or staged runtime.
 * Its journal survives partial deletion so the next sweep can recheck the original identity and retry.
 * No database write lock spans filesystem work. A live owner keeps its trash; recovery claims a dead
 * owner's folder by renaming it to a fresh, never-reused name, so two recoverers cannot both win. */
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { currentBootId, provenDeadByBootChange } from "./boot-identity.js";

export const QUARANTINE_NOTE = ".toolroll-sweep.json";
const PREFIX = ".toolroll-trash-";
type Journal<T> = { version: 1; name: string; data: T; deleting: boolean; pid: number; host: string; bootId: string | null };
export type Quarantine<T> = { path: string; original: string; journal: Journal<T> };
const freshPath = (root: string) => join(root, `${PREFIX}${randomBytes(16).toString("hex")}`);
const owner = () => ({ pid: process.pid, host: hostname(), bootId: currentBootId() });
function alive(one: Journal<unknown>): boolean {
  if (one.pid === 0) return false;
  if (one.host !== hostname()) return true;
  if (one.bootId !== null && provenDeadByBootChange(one)) return false;
  try { process.kill(one.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function read<T>(path: string): Journal<T> | null {
  try {
    const j = JSON.parse(readFileSync(join(path, QUARANTINE_NOTE), "utf8")) as Journal<T>;
    return j.version === 1 && typeof j.name === "string" && j.name !== "." && j.name !== ".." &&
      j.name !== "" && !/[\\/\0]/.test(j.name) && Number.isSafeInteger(j.pid) && j.pid >= 0 && typeof j.host === "string" &&
      (j.bootId === null || typeof j.bootId === "string") && typeof j.deleting === "boolean" ? j : null;
  } catch { return null; }
}
function write<T>(path: string, journal: Journal<T>, exclusive = false): void {
  const note = join(path, QUARANTINE_NOTE), temp = `${note}.${randomBytes(8).toString("hex")}`;
  writeFileSync(temp, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
  try { if (exclusive) linkSync(temp, note); else renameSync(temp, note); }
  finally { try { unlinkSync(temp); } catch { /* renamed */ } }
}

export function quarantineEntries<T>(root: string): Quarantine<T>[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter(name => /^\.toolroll-trash-[0-9a-f]{32}$/.test(name)).flatMap(name => {
    const path = join(root, name);
    try { if (!lstatSync(path).isDirectory()) return []; } catch { return []; }
    const journal = read<T>(path);
    // A crash after unlinking the journal can leave only an empty folder. No resource data remains in it.
    if (journal === null) { try { if (readdirSync(path).length === 0) rmdirSync(path); } catch { /* next pass */ } }
    return journal === null ? [] : [{ path, original: join(root, journal.name), journal }];
  });
}

/** A small marker closes discovery before the atomic rename. It is never published half-written. */
export function quarantine<T>(original: string, data: T): Quarantine<T> | null {
  if (!lstatSync(original).isDirectory()) return null;
  let journal = read<T>(original);
  if (journal !== null && alive(journal)) return null;
  if (journal === null) {
    journal = { version: 1, name: basename(original), data, deleting: false, ...owner() };
    write(original, journal, true);
  } else {
    journal = { ...journal, ...owner() };
    write(original, journal);
  }
  const path = freshPath(dirname(original));
  renameSync(original, path);
  return { path, original, journal };
}

/** Returns null if another sweep owns it (or won recovery). */
export function claimQuarantine<T>(entry: Quarantine<T>): Quarantine<T> | null {
  const seen = read<T>(entry.path);
  if (seen === null || alive(seen)) return null;
  const journal = { ...seen, ...owner() };
  const path = freshPath(dirname(entry.path));
  try {
    // Mark live before moving. Contenders already reading the old name race the rename; just one wins.
    write(entry.path, journal);
    renameSync(entry.path, path);
    write(path, journal);
    return { ...entry, path, journal };
  } catch { return null; }
}

export function releaseQuarantine<T>(entry: Quarantine<T>): void {
  if (existsSync(entry.path)) write(entry.path, { ...entry.journal, pid: 0 });
}

/** A partially deleted tree must never become discoverable again. */
export function restoreQuarantine<T>(entry: Quarantine<T>): boolean {
  if (entry.journal.deleting || existsSync(entry.original)) return false;
  renameSync(entry.path, entry.original);
  unlinkSync(join(entry.original, QUARANTINE_NOTE));
  return true;
}

/** Keep the journal until all potentially large removals succeeded. Recovery never guesses at a half-deleted tree. */
export async function deleteQuarantine<T>(entry: Quarantine<T>, remove: (path: string) => void | Promise<void>): Promise<void> {
  entry.journal = { ...entry.journal, deleting: true };
  write(entry.path, entry.journal);
  for (const name of readdirSync(entry.path)) if (name !== QUARANTINE_NOTE) await remove(join(entry.path, name));
  unlinkSync(join(entry.path, QUARANTINE_NOTE));
  rmdirSync(entry.path);
}

/** Staged pruning is also called synchronously by update/deploy. */
export function deleteQuarantineSync<T>(entry: Quarantine<T>, remove: (path: string) => void): void {
  entry.journal = { ...entry.journal, deleting: true };
  write(entry.path, entry.journal);
  for (const name of readdirSync(entry.path)) if (name !== QUARANTINE_NOTE) remove(join(entry.path, name));
  unlinkSync(join(entry.path, QUARANTINE_NOTE));
  rmdirSync(entry.path);
}
