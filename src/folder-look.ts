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
import { resolve } from "node:path";

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
  /** Where each path really is (its real path, when that is a folder): a project's identity, resolved off the thread. */
  | { op: "identities"; paths: readonly string[] }
  /** A project's own `.mcp.json`, read as a plain bounded file and parsed (null when absent or not a JSON object). */
  | { op: "projectMcp"; path: string };

/** One look under way: its answer, and when its process has ended (a stuck child can outlive its answer). */
export type FolderLookRun = { answer: Promise<unknown>; ended: Promise<void> };
/** Starts one look. Production starts a child process; tests pass their own. */
export type FolderLookRunner = (request: FolderLookRequest, deadlineMs: number) => FolderLookRun;

export type FolderLook<T> = { ok: true; value: T } | { ok: false; why: "no-answer" | "failed" };

/** At most this many look processes at once, stuck ones included: a folder that never answers costs one each. */
export const FOLDER_LOOK_CHILDREN = 8;

/**
 * The child's script: plain CommonJS, given the request as its one argument, printing one JSON answer. Every file it
 * reads is opened without following a link and without waiting on a FIFO, checked to be a regular file under its cap
 * on the open descriptor, and read only up to its limit; every folder is read through a bounded iterator.
 */
const LOOK_SCRIPT = `"use strict";
const fs = require("fs"), path = require("path");
const originUrlIn = ${originUrlIn.toString()};
const request = JSON.parse(process.argv[1]);
const within = (p, root) => p === root || p.startsWith(root === "/" ? "/" : root + "/");
const home = request.home || "/nonexistent";
const fenced = [path.join(home, "Library"), "/Volumes", "/System/Volumes", "/Network", "/net", "/private/var/automount"];
// A place the look never enters, unless the path is inside a folder the person chose there (that root itself, not any
// root that happens to lie in the same protected tree).
const offLimits = (p, roots) => fenced.some(one => within(p, one) && !roots.some(root => within(root, one) && within(p, root)));
const rootOf = (p, roots) => roots.filter(root => within(p, root)).sort((a, b) => b.length - a.length)[0];
// A plain file read bounded by construction (ghlist review, finding 1): never through a link (O_NOFOLLOW), never
// waiting on a FIFO (O_NONBLOCK), a regular file under the cap by the opened descriptor, at most the limit read.
function readBounded(file, cap, limit) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > cap) return null;
    const buffer = Buffer.alloc(Math.min(limit, stat.size));
    const read = buffer.length === 0 ? 0 : fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, read);
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}
function origin(repo) {
  const config = readBounded(path.join(repo, ".git", "config"), 1024 * 1024, 64 * 1024);
  return config === null ? null : originUrlIn(config);
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
  if (request.op === "projectMcp") {
    const text = readBounded(path.join(request.path, ".mcp.json"), 1024 * 1024, 1024 * 1024);
    if (text === null) return { config: null };
    try { const parsed = JSON.parse(text); return { config: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null }; }
    catch { return { config: null }; }
  }
  if (request.op === "identities") {
    return { paths: request.paths.slice(0, 500).map(one => {
      try { const real = fs.realpathSync(path.resolve(one)); return { path: one, real: fs.statSync(real).isDirectory() ? real : null }; }
      catch { return { path: one, real: null }; }
    }) };
  }
  const roots = request.roots;
  if (request.op === "list") {
    const at = fs.realpathSync(request.path);
    const root = rootOf(at, roots);
    if (root === undefined || offLimits(at, roots) || !fs.statSync(at).isDirectory()) return { at: null, entries: [] };
    // A folder on another drive than the root that allows it is not entered (the root itself may be one).
    if (at !== root && fs.statSync(at).dev !== fs.statSync(root).dev) return { at: null, entries: [] };
    const entries = children(at, roots, true)
      .filter(one => !one.name.startsWith(".") && one.name !== "node_modules")
      .map(one => ({ name: one.name, path: one.path, git: fs.existsSync(path.join(one.path, ".git")) }));
    return { at, entries };
  }
  const registered = request.registered.slice(0, 500).map(repo => ({ path: repo, url: origin(repo) }));
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
 * deadline. Its environment carries nothing of this process's (no NODE_OPTIONS, no secrets). At the deadline its pipe
 * is closed and nothing of it keeps this process alive; `ended` settles only when the process has really gone. */
export const childLook: FolderLookRunner = (request, deadlineMs) => {
  const child = spawn(process.execPath, ["-e", LOOK_SCRIPT, JSON.stringify(request)], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
    killSignal: "SIGKILL",
  });
  child.unref();
  const ended = new Promise<void>(resolveEnded => {
    child.once("exit", () => resolveEnded());
    child.once("error", () => resolveEnded());
  });
  const answer = new Promise<unknown>((resolveAnswer, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // A child stuck in the kernel can't be reaped yet: its pipe is closed now, so it holds nothing here.
      child.stdout.destroy();
      reject(new Error("the look didn't answer"));
    }, deadlineMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { child.kill("SIGKILL"); child.stdout.destroy(); return; }
      chunks.push(chunk);
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`the look ended with ${code}`)); return; }
      try { resolveAnswer(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
    });
  });
  answer.catch(() => {});
  return { answer, ended };
};

/** Looks whose process hasn't ended, by request: callers asking the same thing share one; each holds a child slot
 * until its process is gone. */
const inFlight = new Map<string, FolderLookRun>();

/** The same request however its paths were spelled: resolved paths, roots in order. */
function lookKey(request: FolderLookRequest): string {
  const sorted = (paths: readonly string[]) => paths.map(one => resolve(one)).sort();
  switch (request.op) {
    case "list": return JSON.stringify([request.op, resolve(request.path), sorted(request.roots), request.home]);
    case "origins": return JSON.stringify([request.op, sorted(request.registered), sorted(request.roots), request.home]);
    case "identities": return JSON.stringify([request.op, sorted(request.paths)]);
    case "projectMcp": return JSON.stringify([request.op, resolve(request.path)]);
  }
}

/** How many look processes are running now (stuck ones included). */
export function folderLooksRunning(): number {
  return inFlight.size;
}

/**
 * One look, answered within `deadlineMs` whatever the folder does: its value, or that the folder didn't answer (it ran
 * past the deadline, the same look is still stuck, or every child slot is held) or the look failed. A look already
 * under way for the same request is joined, never started twice.
 */
export async function lookFolders(request: FolderLookRequest, options: { runner?: FolderLookRunner; deadlineMs?: number } = {}): Promise<FolderLook<unknown>> {
  const deadlineMs = options.deadlineMs ?? FOLDER_LOOK_MS;
  const key = lookKey(request);
  let run = inFlight.get(key);
  if (run === undefined) {
    if (inFlight.size >= FOLDER_LOOK_CHILDREN) return { ok: false, why: "no-answer" };
    try { run = (options.runner ?? childLook)(request, deadlineMs); } catch { return { ok: false, why: "failed" }; }
    const mine = run;
    inFlight.set(key, mine);
    const forget = () => { if (inFlight.get(key) === mine) inFlight.delete(key); };
    mine.ended.then(forget, forget);
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">(resolveLate => { timer = setTimeout(() => resolveLate("late"), deadlineMs); });
  try {
    const first = await Promise.race([run.answer.then(value => ({ value }), () => "failed" as const), late]);
    if (first === "late") return { ok: false, why: "no-answer" };
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
export type FolderLookOptions = { runner?: FolderLookRunner; deadlineMs?: number; home?: string };

/** A folder's sub-folders for the browse page (null `at`: outside every root, or not a folder). */
export async function listFolder(path: string, roots: readonly string[], options: FolderLookOptions = {}): Promise<FolderLook<{ at: string | null; entries: FolderEntry[] }>> {
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
export async function localOrigins(registered: readonly string[], roots: readonly string[], options: FolderLookOptions = {}): Promise<FolderLook<{ registered: { path: string; url: string | null }[]; found: { path: string; url: string | null }[] }>> {
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

/** Each path's identity (its real path when that is a folder, else null), resolved off the thread. */
export async function lookIdentities(paths: readonly string[], options: FolderLookOptions = {}): Promise<FolderLook<Map<string, string | null>>> {
  const looked = await lookFolders({ op: "identities", paths: [...paths] }, options);
  if (!looked.ok) return looked;
  const value = looked.value as { paths?: unknown } | null;
  if (value === null || typeof value !== "object" || !Array.isArray(value.paths)) return { ok: false, why: "failed" };
  const out = new Map<string, string | null>();
  for (const one of value.paths as unknown[]) {
    const row = one as { path?: unknown; real?: unknown } | null;
    if (row !== null && typeof row === "object" && text(row.path) && (row.real === null || text(row.real))) out.set(row.path, row.real as string | null);
  }
  return { ok: true, value: out };
}

/** A project's own `.mcp.json` (parsed object, or null when absent or not one), read off the thread. */
export async function lookProjectMcp(repo: string, options: FolderLookOptions = {}): Promise<FolderLook<Record<string, unknown> | null>> {
  const looked = await lookFolders({ op: "projectMcp", path: repo }, options);
  if (!looked.ok) return looked;
  const value = looked.value as { config?: unknown } | null;
  if (value === null || typeof value !== "object") return { ok: false, why: "failed" };
  const config = value.config;
  return { ok: true, value: config !== null && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : null };
}
