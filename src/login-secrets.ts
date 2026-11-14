/**
 * Where Toolroll keeps the saved credentials beside its database: a reserved owner-only folder, `.toolroll-secrets`,
 * that every agent fence denies whole (agent-fence.ts). It is made before any agent launches, so a credential written
 * into it later (the first saved login, written while a build already runs) is behind a fence that was fixed at launch.
 * A file beside the database that appears after launch is not: bubblewrap can't deny a path that isn't there, and a
 * fence built from a listing can't name one either.
 *
 * The saved login moved here from `up-login.txt` directly beside the database. Readers look here first and then at
 * the old place; the next `up` moves an old file in (migrateLegacyLogin), never through a link, never readable by
 * anyone else on the way.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

/** The reserved folder's name, beside the database. Toolroll's own; nothing else belongs there. */
export const SECRETS_DIR = ".toolroll-secrets";
/** The saved login's file name, inside the folder (and, from older versions, directly beside the database). */
export const LOGIN_FILE_NAME = "up-login.txt";
/** The largest saved login read. */
const LOGIN_LIMIT = 8192;

export class UntrustedSecretsFolder extends Error {}

/** The reserved folder for a state folder (the database's folder), by name. */
export const secretsDirOf = (stateDir: string): string => join(stateDir, SECRETS_DIR);
/** Where the saved login lives now. */
export const loginFileOf = (stateDir: string): string => join(secretsDirOf(stateDir), LOGIN_FILE_NAME);
/** Where older versions saved it: directly beside the database. */
export const legacyLoginFileOf = (stateDir: string): string => join(stateDir, LOGIN_FILE_NAME);

const present = (path: string): boolean => {
  try { lstatSync(path); return true; } catch { return false; }
};

/**
 * Make the reserved folder if it isn't there (owner-only), and prove it is a real folder of this user's, owner-only,
 * reached by no link. Returns its path. Throws UntrustedSecretsFolder when something else holds the name: nothing is
 * written there then, and the fence still denies the name.
 */
export function ensureSecretsDir(stateDir: string): string {
  let base: string;
  try { base = realpathSync(stateDir); } catch { throw new UntrustedSecretsFolder("The folder beside the database can't be resolved."); }
  const folder = join(base, SECRETS_DIR);
  try { mkdirSync(folder, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new UntrustedSecretsFolder(`Could not make ${SECRETS_DIR} beside the database (${(error as Error).message}).`);
  }
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    || (process.getuid !== undefined && stat.uid !== process.getuid()) || realpathSync(folder) !== resolve(folder)) {
    throw new UntrustedSecretsFolder(`${SECRETS_DIR} beside the database is not a private folder of yours; nothing was saved there.`);
  }
  return folder;
}

/** The saved-login file to write: inside the reserved folder, made and proven first. Throws when it can't be. */
export function writableLoginFile(stateDir: string): string {
  ensureSecretsDir(stateDir);
  // By the name the caller knows the state folder by (it is shown to the person); the folder under it was just proven.
  return loginFileOf(stateDir);
}

/** The saved-login file to read: the reserved folder's when anything is there, else the old place's when anything is
 * there, else the reserved folder's (nothing saved yet). */
export function savedLoginFile(stateDir: string): string {
  const current = loginFileOf(stateDir);
  if (present(current)) return current;
  const legacy = legacyLoginFileOf(stateDir);
  return present(legacy) ? legacy : current;
}

/** The bytes of a file that is a regular file of this user's, opened without following a link and without blocking on
 * a FIFO, of at most `limit` bytes; null otherwise. */
function ownRegularBytes(path: string, limit: number): { bytes: Buffer; dev: number; ino: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (process.getuid !== undefined && stat.uid !== process.getuid())) return null;
    const bytes = readFileSync(fd);
    return bytes.length > limit ? null : { bytes, dev: stat.dev, ino: stat.ino };
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

const fsyncFolder = (folder: string): void => {
  let fd: number | null = null;
  try { fd = openSync(folder, fsConstants.O_RDONLY); fsyncSync(fd); } catch { /* some filesystems refuse a folder fsync */ } finally { if (fd !== null) closeSync(fd); }
};

export type LoginMigration =
  | { kind: "none" }
  | { kind: "moved"; from: string; to: string }
  /** Both existed with the same contents: the old copy was removed. */
  | { kind: "deduplicated"; from: string; to: string }
  /** Both exist and differ: the reserved folder's wins for reads, the old one is left for the person. */
  | { kind: "both"; from: string; to: string }
  /** The old file is a link, not a regular file of this user's, or too large: left exactly where it is. */
  | { kind: "refused"; from: string; reason: string }
  | { kind: "failed"; from: string; reason: string };

/**
 * Move a saved login from directly beside the database into the reserved folder. The new file is a fresh one (never
 * the old file's inode, so no other name for that file — a hard link — reaches it), created owner-only (0600) inside
 * the owner-only folder and published whole under its name (written to a private temporary name, synced, then
 * hard-linked in, which fails rather than replace anything), and the old one is removed only after. A link or
 * anything other than this user's own regular file at the old name is never followed or moved. Never throws.
 */
export function migrateLegacyLogin(stateDir: string): LoginMigration {
  const from = legacyLoginFileOf(stateDir);
  let held;
  try { held = lstatSync(from); } catch { return { kind: "none" }; }
  if (!held.isFile() || held.isSymbolicLink() || (process.getuid !== undefined && held.uid !== process.getuid())) {
    return { kind: "refused", from, reason: `${LOGIN_FILE_NAME} beside the database is a link or not your own regular file` };
  }
  let folder: string;
  try { folder = ensureSecretsDir(stateDir); } catch (error) { return { kind: "failed", from, reason: (error as Error).message }; }
  const to = join(folder, LOGIN_FILE_NAME);
  const old = ownRegularBytes(from, LOGIN_LIMIT);
  if (old === null || old.dev !== held.dev || old.ino !== held.ino) {
    return { kind: "refused", from, reason: `${LOGIN_FILE_NAME} beside the database changed, is too large, or is not your own regular file` };
  }
  const removeOld = (): boolean => {
    // Only the file that was read: a replacement since then stays for the person.
    try {
      const now = lstatSync(from);
      if (!now.isFile() || now.dev !== old.dev || now.ino !== old.ino) return false;
      unlinkSync(from);
      fsyncFolder(stateDir);
      return true;
    } catch { return false; }
  };
  if (present(to)) {
    const current = ownRegularBytes(to, LOGIN_LIMIT);
    if (current !== null && current.bytes.equals(old.bytes) && removeOld()) return { kind: "deduplicated", from, to };
    return { kind: "both", from, to };
  }
  const temporary = join(folder, `.${LOGIN_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, old.bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, to); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "both", from, to };
      throw error;
    }
    fsyncFolder(folder);
  } catch (error) {
    return { kind: "failed", from, reason: (error as Error).message };
  } finally {
    try { unlinkSync(temporary); } catch { /* already gone */ }
  }
  removeOld();
  return { kind: "moved", from, to };
}

/** What `toolroll password reset` did with the saved first passwords: removed, known stale but left (it changed while
 * being removed, or couldn't be removed), or left unchecked (not a plain file of this user's inside the state folder). */
export type StaleLoginCleanup = { removed: string[]; stale: string[]; unchecked: string[] };

/**
 * After `toolroll password reset`: remove each saved first password (the reserved folder's, and an older version's
 * beside the database) that is this account's and no longer its password — stale, it only misleads. Removed only when
 * every part of its path below the state folder is proved, by lstat from the state folder down, to be a real folder or
 * file of this user's (no link anywhere, one name for the file), and only when the file read just before removal is
 * the same file (device, inode) with the same bytes as the one judged stale. Anything else is left for the person and
 * reported: another account's file and one holding the new password are not touched at all. `beforeRemove` (tests)
 * runs between the judgement and the removal. Never throws.
 */
export function removeStaleSavedLogin(stateDir: string, account: string, current: string, beforeRemove?: (path: string) => void): StaleLoginCleanup {
  const done: StaleLoginCleanup = { removed: [], stale: [], unchecked: [] };
  const uid = process.getuid?.();
  /** "absent", "contained" (every part below the state folder proved), or "doubtful". */
  const proved = (parts: readonly string[]): "absent" | "contained" | "doubtful" => {
    for (let index = 1; index <= parts.length; index += 1) {
      let held;
      try { held = lstatSync(join(stateDir, ...parts.slice(0, index))); } catch { return "absent"; }
      const last = index === parts.length;
      if (held.isSymbolicLink() || (uid !== undefined && held.uid !== uid)) return "doubtful";
      if (last ? !held.isFile() || held.nlink !== 1 : !held.isDirectory()) return "doubtful";
    }
    return "contained";
  };
  for (const parts of [[SECRETS_DIR, LOGIN_FILE_NAME], [LOGIN_FILE_NAME]] as const) {
    const path = join(stateDir, ...parts);
    const first = proved(parts);
    if (first === "absent") continue;
    if (first === "doubtful") { done.unchecked.push(path); continue; }
    const held = ownRegularBytes(path, LOGIN_LIMIT);
    if (held === null) { done.unchecked.push(path); continue; }
    const raw = held.bytes.toString("utf8").trim();
    const cut = raw.indexOf(" ");
    if (cut <= 0 || raw.slice(0, cut) !== account || raw.slice(cut + 1) === current) continue;
    beforeRemove?.(path);
    const again = proved(parts) === "contained" ? ownRegularBytes(path, LOGIN_LIMIT) : null;
    if (again === null || again.dev !== held.dev || again.ino !== held.ino || !again.bytes.equals(held.bytes)) { done.stale.push(path); continue; }
    try {
      unlinkSync(path);
      fsyncFolder(join(stateDir, ...parts.slice(0, -1)));
      done.removed.push(path);
    } catch { done.stale.push(path); }
  }
  return done;
}
