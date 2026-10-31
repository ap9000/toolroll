/**
 * Reads of a person's own folders, kept off the console's thread.
 *
 * A folder can stop answering: a drive that disconnected without unmounting, a folder macOS keeps in iCloud (Desktop &
 * Documents), or one behind a privacy prompt nobody has answered. Opening it then blocks until the system answers, and
 * a synchronous read on the console's thread freezes every page with it (the 0.9.82 deploy, 2026-10-31: the console
 * listened for twenty minutes without answering, its main thread inside a directory read). So every such read runs in a
 * child process, the same read it always was, and the console waits for it only as long as a deadline allows: a folder
 * that didn't answer degrades the one thing that needed it, in plain words, and the next look tries again.
 *
 * A look never goes into another mounted drive, /Volumes, or the protected folders under ~/Library, unless that is the
 * folder the person chose. Its answers are filesystem data, read exactly as before (directory names, a repository's
 * `.git/config` as a plain bounded file never followed through a link), and the caller still checks every path against
 * its own ceiling.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";

/** How long the console waits for a look before saying the folder didn't answer. */
export const FOLDER_LOOK_MS = 4_000;

/** The `url` of `[remote "origin"]` in a git config's text. Plain JavaScript with no outside names: the look's child
 * runs this same function (its source is sent along), so the parent and the child read a config one way. */
export function originUrlIn(config: string): string | null {
  let inOrigin = false;
  for (const line of config.split("\n")) {
    if (/^\s*\[/.test(line)) {
      inOrigin = /^\s*\[remote "origin"\]\s*$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const url = /^\s*url\s*=\s*(.+)$/.exec(line)?.[1];
    if (url !== undefined) return url.trim();
  }
  return null;
}

export type FolderLookRequest =
  /** One folder's sub-folders, as the browse page shows them: at most 400 kept of 2,000 entries read, links resolved
   * and kept only inside a root. */
  | { op: "list"; path: string; roots: readonly string[]; home: string }
  /** The origin of each registered project, and of each repository directly in a root (at most 400 folders a root). */
  | { op: "origins"; registered: readonly string[]; roots: readonly string[]; home: string }
  /** Whether a project folder answers: the folder, its git folder's listing and its config can be read. */
  | { op: "probe"; path: string };

/** Runs one look and resolves with its JSON answer (or rejects). Production starts a child process; tests pass their own. */
export type FolderLookRunner = (request: FolderLookRequest, deadlineMs: number) => Promise<unknown>;

export type FolderLook<T> = { ok: true; value: T } | { ok: false; why: "no-answer" | "failed" };

/**
 * The child's script: plain CommonJS, given the request as its one argument, printing one JSON answer. Mount points,
 * /Volumes and ~/Library are left alone unless the person chose a folder there (a root inside them).
 */
const LOOK_SCRIPT = `"use strict";
const fs = require("fs"), path = require("path");
const originUrlIn = ${originUrlIn.toString()};
const request = JSON.parse(process.argv[1]);
const within = (p, root) => p === root || p.startsWith(root === "/" ? "/" : root + "/");
const home = request.home || "/nonexistent";
const fenced = [path.join(home, "Library"), "/Volumes", "/System/Volumes", "/Network", "/net", "/private/var/automount"];
// A place the look never enters unless the person chose a folder in it.
const offLimits = (p, roots) => fenced.some(one => within(p, one) && !roots.some(root => within(root, one)));
// The origin from a repository's own .git/config, bounded by construction (ghlist review, finding 1): never through a
// link (lstat + O_NOFOLLOW), a regular file under 1 MiB, at most 64 KiB read, so a sparse monster or a FIFO costs nothing.
function origin(repo) {
  const file = path.join(repo, ".git", "config");
  let fd = null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return originUrlIn(buffer.toString("utf8", 0, read));
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}
function children(folder, roots, links) {
  const out = [];
  const folderDev = fs.statSync(folder).dev;
  const dir = fs.opendirSync(folder);
  try {
    for (let seen = 0; seen < 2000 && out.length < 400; seen++) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (!(entry.isDirectory() || (links && entry.isSymbolicLink()))) continue;
      const spelled = path.join(folder, entry.name);
      if (offLimits(spelled, roots)) continue;
      let real, stat;
      try { real = fs.realpathSync(spelled); } catch { continue; }
      if (offLimits(real, roots) || !roots.some(root => within(real, root))) continue;
      try { stat = fs.statSync(real); } catch { continue; }
      if (!stat.isDirectory()) continue;
      // Another drive mounted here: not entered unless it is itself a chosen folder.
      if (stat.dev !== folderDev && !roots.includes(real)) continue;
      out.push({ name: entry.name, path: real });
    }
  } finally { dir.closeSync(); }
  return out;
}
function look() {
  if (request.op === "probe") {
    const dir = fs.opendirSync(request.path); dir.readSync(); dir.closeSync();
    const dotGit = path.join(request.path, ".git");
    let common = dotGit;
    const held = fs.lstatSync(dotGit);
    if (!held.isDirectory()) {
      if (!held.isFile()) return { answered: true };
      const named = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, "utf8").slice(0, 4096));
      if (named === null) return { answered: true };
      common = path.resolve(request.path, named[1].trim());
    }
    fs.readdirSync(common);
    try { fs.closeSync(fs.openSync(path.join(common, "config"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)); } catch {}
    return { answered: true };
  }
  const roots = request.roots;
  if (request.op === "list") {
    const at = fs.realpathSync(request.path);
    if (!fs.statSync(at).isDirectory() || !roots.some(root => within(at, root)) || offLimits(at, roots)) return { at: null, entries: [] };
    const entries = children(at, roots, true)
      .filter(one => !one.name.startsWith(".") && one.name !== "node_modules")
      .map(one => ({ name: one.name, path: one.path, git: fs.existsSync(path.join(one.path, ".git")) }));
    return { at, entries };
  }
  const registered = request.registered.map(repo => ({ path: repo, url: origin(repo) }));
  const found = [];
  for (const root of roots) {
    let listed = [];
    try { listed = children(root, roots, false); } catch { continue; }
    for (const child of listed) {
      if (!fs.existsSync(path.join(child.path, ".git"))) continue;
      found.push({ path: child.path, url: origin(child.path) });
    }
  }
  return { registered, found };
}
let answer;
try { answer = { ok: true, value: look() }; } catch (error) { answer = { ok: false, code: error && error.code || null }; }
process.stdout.write(JSON.stringify(answer));
`;

/** The production look: the script above in a child process of this same Node (or Electron as Node), killed at its
 * deadline. Its environment carries nothing of this process's (no NODE_OPTIONS, no secrets). */
export const childLook: FolderLookRunner = (request, deadlineMs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", LOOK_SCRIPT, JSON.stringify(request)], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
    timeout: deadlineMs,
    killSignal: "SIGKILL",
  });
  // A child stuck in the kernel is never waited for: it holds nothing open in this process.
  child.unref();
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) { child.kill("SIGKILL"); return; }
    chunks.push(chunk);
  });
  child.once("error", reject);
  child.once("close", code => {
    if (code !== 0) { reject(new Error(`the look ended with ${code}`)); return; }
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
  });
});

/** Looks still running past their deadline, by request: one stuck look per folder, never a pile of them. */
const stuck = new Map<string, Promise<unknown>>();

/**
 * One look, answered within `deadlineMs` whatever the folder does: its value, or that the folder didn't answer (it ran
 * past the deadline, or the same look from before still hasn't ended) or the look failed.
 */
export async function lookFolders(request: FolderLookRequest, options: { runner?: FolderLookRunner; deadlineMs?: number } = {}): Promise<FolderLook<unknown>> {
  const deadlineMs = options.deadlineMs ?? FOLDER_LOOK_MS;
  const key = JSON.stringify(request);
  if (stuck.has(key)) return { ok: false, why: "no-answer" };
  const runner = options.runner ?? childLook;
  const running = Promise.resolve().then(() => runner(request, deadlineMs));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">(resolveLate => { timer = setTimeout(() => resolveLate("late"), deadlineMs); });
  try {
    const first = await Promise.race([running.then(value => ({ value }), () => "failed" as const), late]);
    if (first === "late") {
      stuck.set(key, running);
      running.then(() => stuck.delete(key), () => stuck.delete(key));
      return { ok: false, why: "no-answer" };
    }
    if (first === "failed") return { ok: false, why: "failed" };
    const answer = first.value as { ok?: unknown; value?: unknown } | null;
    if (answer === null || typeof answer !== "object" || answer.ok !== true) return { ok: false, why: "failed" };
    return { ok: true, value: answer.value };
  } finally {
    clearTimeout(timer);
  }
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");

export type FolderEntry = { name: string; path: string; git: boolean };

/** A folder's sub-folders for the browse page (null `at`: outside every root, or not a folder). */
export async function listFolder(path: string, roots: readonly string[], options: { runner?: FolderLookRunner; deadlineMs?: number; home?: string } = {}): Promise<FolderLook<{ at: string | null; entries: FolderEntry[] }>> {
  const looked = await lookFolders({ op: "list", path, roots: [...roots], home: options.home ?? homedir() }, options);
  if (!looked.ok) return looked;
  const value = looked.value as { at?: unknown; entries?: unknown } | null;
  if (value === null || typeof value !== "object" || !(value.at === null || text(value.at)) || !Array.isArray(value.entries)) return { ok: false, why: "failed" };
  const entries = value.entries.flatMap((one: unknown) => {
    const row = one as { name?: unknown; path?: unknown; git?: unknown } | null;
    return row !== null && typeof row === "object" && text(row.name) && text(row.path) && typeof row.git === "boolean" ? [{ name: row.name, path: row.path, git: row.git }] : [];
  });
  return { ok: true, value: { at: value.at as string | null, entries } };
}

/** The origin URL of each registered project, and the repositories directly in each root with theirs. */
export async function localOrigins(registered: readonly string[], roots: readonly string[], options: { runner?: FolderLookRunner; deadlineMs?: number; home?: string } = {}): Promise<FolderLook<{ registered: { path: string; url: string | null }[]; found: { path: string; url: string | null }[] }>> {
  const looked = await lookFolders({ op: "origins", registered: [...registered], roots: [...roots], home: options.home ?? homedir() }, options);
  if (!looked.ok) return looked;
  const value = looked.value as { registered?: unknown; found?: unknown } | null;
  if (value === null || typeof value !== "object" || !Array.isArray(value.registered) || !Array.isArray(value.found)) return { ok: false, why: "failed" };
  const rows = (list: unknown[]) => list.flatMap((one: unknown) => {
    const row = one as { path?: unknown; url?: unknown } | null;
    return row !== null && typeof row === "object" && text(row.path) && (row.url === null || text(row.url)) ? [{ path: row.path, url: row.url as string | null }] : [];
  });
  return { ok: true, value: { registered: rows(value.registered), found: rows(value.found) } };
}

/** Whether a project folder answers now (its folder, git folder and config can be read), within the deadline. */
export async function folderAnswers(path: string, options: { runner?: FolderLookRunner; deadlineMs?: number } = {}): Promise<boolean> {
  return (await lookFolders({ op: "probe", path }, options)).ok;
}
