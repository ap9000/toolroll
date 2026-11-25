/**
 * What a build keeps of the provider's own home, and nothing more.
 *
 * A build loads none of the operator's Claude settings or Codex config
 * (provider.ts), so two things from them are carried explicitly:
 *
 * - A build routed with no model runs as the operator's own CLI would: the
 *   model they chose (Claude's settings.json `model`, Codex's config.toml
 *   `model`), Claude's `alwaysThinkingEnabled` and Codex's reasoning effort.
 *   Nothing else of either file (hooks, plugins, MCP servers) is read.
 * - A Codex build gets its own CODEX_HOME for the launch: a copy of the
 *   operator's `auth.json` (so it signs in) and a sessions folder of its own
 *   holding only this task's earlier sessions (so a repair resumes the same
 *   thread), and no skills, AGENTS.md or anything else from theirs. Nothing
 *   there leads back to the operator's folder: the run never writes their
 *   sign-in, nor reads or writes any other session. A sign-in the run
 *   refreshes stays in its copy (it is never written back: the run controls
 *   that file); if Codex later asks the operator to sign in again, `codex
 *   login` fixes it. The folder is the launch's own (fenced from every other
 *   launch) and removed after the run, its sessions kept for the task first.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { validModelId } from "./provider.js";

/** The operator's own choices a no-model build keeps. */
export type ProviderDefaults = { model?: string; alwaysThinking?: boolean; effort?: string };

const EFFORT = /^[a-z]{1,16}$/;

export function claudeConfigDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  return env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
}

export function codexHomeDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  return env["CODEX_HOME"] || join(home, ".codex");
}

/** Claude's user settings: its `model` and `alwaysThinkingEnabled`, when valid. */
export function claudeDefaults(configDir: string): ProviderDefaults {
  let settings: unknown;
  try { settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")); } catch { return {}; }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return {};
  const { model, alwaysThinkingEnabled } = settings as Record<string, unknown>;
  return {
    ...(typeof model === "string" && model !== "" && validModelId(model) ? { model } : {}),
    ...(typeof alwaysThinkingEnabled === "boolean" ? { alwaysThinking: alwaysThinkingEnabled } : {}),
  };
}

/** Codex's config.toml: its top-level `model` and `model_reasoning_effort`, or the selected profile's. */
export function codexDefaults(codexHome: string): ProviderDefaults {
  let text: string;
  try { text = readFileSync(join(codexHome, "config.toml"), "utf8"); } catch { return {}; }
  const tables = new Map<string, Record<string, string>>([["", {}]]);
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header !== null) { table = header[1]!.replace(/"/g, ""); if (!tables.has(table)) tables.set(table, {}); continue; }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line);
    if (pair !== null) tables.get(table)![pair[1]!] = pair[2]!;
  }
  const top = tables.get("")!;
  const profile = top["profile"] === undefined ? {} : tables.get(`profiles.${top["profile"]}`) ?? {};
  const model = profile["model"] ?? top["model"];
  const effort = profile["model_reasoning_effort"] ?? top["model_reasoning_effort"];
  return {
    ...(model !== undefined && model !== "" && validModelId(model) ? { model } : {}),
    ...(effort !== undefined && EFFORT.test(effort) ? { effort } : {}),
  };
}

/** A Codex launch's own CODEX_HOME. `keep` saves its sessions for its task (after the run, before `cleanup`). */
export type CodexHome = { dir: string; keep: () => void; cleanup: () => void };

/** How much of a task's sessions is kept between its launches: bounded, so a run can't fill the disk through it. */
const SESSIONS_MAX_BYTES = 512 * 1024 * 1024;
const SESSIONS_MAX_ENTRIES = 20_000;
const SESSIONS_MAX_DEPTH = 8;
/** A name Codex gives a session file or folder (`2026/11/25/rollout-….jsonl`): nothing else is carried. */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * One Codex launch's CODEX_HOME: a private folder holding a copy of the operator's sign-in (never a link to it) and
 * a sessions folder of its own, filled from `options.sessions` (this task's kept sessions, a folder of Toolroll's own
 * that no launch reaches) when given. A missing `auth.json` stays missing (an API-key build needs none); one that
 * isn't a plain file refuses.
 */
export function isolatedCodexHome(source: string, root: string = tmpdir(), options: { signIn: boolean; sessions?: string | null } = { signIn: true }): CodexHome {
  const dir = mkdtempSync(join(root, "so-codex-"));
  // The home's real path as Toolroll made it: what its sessions are proven against when they are kept.
  const home = realpathSync(dir);
  const sessions = join(dir, "sessions");
  try {
    chmodSync(dir, 0o700);
    // Only a Codex build signs in with it: an OpenRouter build carries its own key and never gets the ChatGPT sign-in.
    if (options.signIn) {
      const auth = signInBytes(join(source, "auth.json"));
      if (auth !== null) writeFileSync(join(dir, "auth.json"), auth, { mode: 0o600, flag: "wx" });
    }
    mkdirSync(sessions, { mode: 0o700 });
    if (options.sessions != null) copySessions(options.sessions, sessions);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    // Best effort: a task whose sessions couldn't be kept resumes in a fresh session's place (its next launch finds none).
    keep: () => { if (options.sessions != null) { const kept = options.sessions; try { withCodexSessionsLock(dirname(kept), () => keepSessions(sessions, home, kept)); } catch { /* not kept */ } } },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The operator's sign-in as it is now: its bytes, or null when there is none. A sign-in that isn't a plain file
 * (a folder, a pipe) refuses: the build would otherwise start signed out, or hang reading it. */
function signInBytes(path: string): Buffer | null {
  let real: string;
  try { real = realpathSync(path); } catch { return null; }
  const fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const held = fstatSync(fd);
    if (!held.isFile() || held.size > 1024 * 1024) throw new Error("the Codex sign-in isn't a plain file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** One file under `root`, read only as the very file found there: opened without following a link, and proven after
 * the open to be the same file at the same place (so a folder on its way swapped for a link while it was read is
 * caught: the file opened through the link isn't the one found there again). Null when it isn't. */
function provenFile(root: string, path: string, limit: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch { return null; }
  try {
    const held = fstatSync(fd);
    // One name only: a hard link the run made to a file outside its folder is the outside file.
    if (!held.isFile() || held.size > limit || held.nlink !== 1) return null;
    const there = lstatSync(path);
    if (!there.isFile() || there.nlink !== 1 || there.ino !== held.ino || there.dev !== held.dev) return null;
    const inside = relative(root, realpathSync(dirname(path)));
    if (inside.startsWith("..") || inside.startsWith("/")) return null;
    const bytes = Buffer.alloc(held.size);
    let read = 0;
    while (read < held.size) { const got = readSync(fd, bytes, read, held.size - read, read); if (got === 0) break; read += got; }
    return bytes.subarray(0, read);
  } catch { return null; } finally { closeSync(fd); }
}

/** A folder as found at `path`: a real folder (never a link), whose real path is `expected`. */
function provenFolder(path: string, expected: string): boolean {
  try {
    const held = lstatSync(path);
    return held.isDirectory() && !held.isSymbolicLink() && realpathSync(path) === expected;
  } catch { return false; }
}

/**
 * Every plain file under `root` (Codex's session names only, bounded), written under `to`. `root` is a real path the
 * caller proved; each folder on the walk is proven a real folder at its own place before and after it is listed (a
 * folder swapped for a link in between is caught and skipped whole), and each file is read only as provenFile reads it.
 */
function copyTree(root: string, to: string): void {
  let entries = 0, bytes = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > SESSIONS_MAX_DEPTH) return;
    const here = join(root, dir);
    if (!provenFolder(here, here)) return;
    let names: string[];
    try { names = readdirSync(here); } catch { return; }
    if (!provenFolder(here, here)) return;
    for (const name of names) {
      if (!SESSION_NAME.test(name) || ++entries > SESSIONS_MAX_ENTRIES) continue;
      const rel = join(dir, name);
      let held: import("node:fs").Stats;
      try { held = lstatSync(join(root, rel)); } catch { continue; }
      if (held.isDirectory()) {
        mkdirSync(join(to, rel), { recursive: true, mode: 0o700 });
        walk(rel, depth + 1);
      } else if (held.isFile()) {
        const content = provenFile(root, join(root, rel), SESSIONS_MAX_BYTES - bytes);
        if (content === null) continue;
        bytes += content.length;
        mkdirSync(join(to, dir), { recursive: true, mode: 0o700 });
        writeFileSync(join(to, rel), content, { mode: 0o600, flag: "wx" });
      }
    }
  };
  walk("", 0);
}

/** A task's kept sessions into a launch's own sessions folder. */
function copySessions(kept: string, into: string): void {
  let root: string;
  try { root = realpathSync(kept); } catch { return; }
  if (!provenFolder(kept, root)) return;
  copyTree(root, into);
}

/** A launch's sessions, after its run, as its task's kept sessions: copied (never moved: the launch's folder may still
 * be written by what it left running) into a fresh folder of Toolroll's own, then put in place of the earlier ones. */
function keepSessions(from: string, home: string, kept: string): void {
  // The sessions folder must still be the one made in the launch's own home: a run that swapped it (or the home) for
  // a link to anything else gets nothing kept, rather than Toolroll copying what the link leads to.
  const expected = join(home, "sessions");
  if (!provenFolder(from, expected)) throw new Error("the launch's sessions folder isn't the one Toolroll made");
  const parent = dirname(kept);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tag = randomBytes(8).toString("hex");
  const next = `${kept}.new-${tag}`;
  const old = `${kept}.old-${tag}`;
  mkdirSync(next, { mode: 0o700 });
  try {
    copyTree(expected, next);
    let had = false;
    try { renameSync(kept, old); had = true; } catch { had = false; }
    renameSync(next, kept);
    if (had) rmSync(old, { recursive: true, force: true });
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Removes every kept-sessions folder under `root` whose name isn't in `keep` (the open tasks of this database, by
 * codexSessionsName): a closed task's, a deleted one's, and any left by an earlier database in the same folder. A copy
 * half made by a launch keeping its sessions right now (`.new-…`) or one being replaced (`.old-…`) is removed only when
 * its task isn't kept either. Best effort, never following a link (rm removes a link itself).
 */
export function pruneCodexSessions(root: string, keep: ReadonlySet<string>): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (name.startsWith(CODEX_SESSIONS_LOCK)) continue;
    const task = /^([0-9a-f]{32})(?:\.(?:new|old)-[0-9a-f]{16})?$/.exec(name)?.[1];
    if (task !== undefined && keep.has(task)) continue;
    try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* the next launch tries again */ }
  }
}

/** The kept-sessions folder's lock file (with SQLite's own journal beside it). */
const CODEX_SESSIONS_LOCK = ".lock";

/**
 * Runs `work` holding the kept-sessions folder's lock: an exclusive SQLite lock on `<root>/.lock`, the operating
 * system's own, held across processes (a runner beside the console). Pruning with the snapshot it prunes against,
 * a launch's copy-in and a launch's copy-out each run under it, so a folder a launch is filling or keeping is never
 * pruned from under it. `work` is synchronous: the lock is never held across an await, so one process never waits on
 * itself. A lock that can't be had within the wait refuses (throws).
 */
export function withCodexSessionsLock<T>(root: string, work: () => T, waitMs = 30_000): T {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, CODEX_SESSIONS_LOCK);
  try { if (lstatSync(file).isSymbolicLink()) throw new Error("the Codex sessions lock is a link"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { DatabaseSync: Sqlite } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
  const db = new Sqlite(file);
  try {
    chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(waitMs))}; BEGIN EXCLUSIVE`);
    try { return work(); } finally { db.exec("ROLLBACK"); }
  } finally { db.close(); }
}
