/**
 * Shared dependencies: one installed node_modules per (project, lockfile, setup, node) under the state folder
 * (`deps/<key>`), linked into each new checkout instead of a fresh `npm ci` there. Measured Oct 2: a checkout of
 * Toolroll is 20,500 files and 18,066 of them were its own node_modules; forty checkouts created and deleted ~800k
 * files, most of the churn behind a bloated fseventsd, and each install cost time.
 *
 * The first checkout with a new key runs the approved setup itself; its node_modules then moves (one rename, same
 * volume) into `deps/<key>`, is made read-only, and is linked back. Later checkouts link it: symlinks, else an
 * APFS/reflink clone, else the plain setup as before. A linked node_modules is a real folder holding one symlink per
 * top-level entry (a few hundred files, not tens of thousands), so caches tools write there stay the checkout's own.
 * Only a setup that installs and does nothing else is shared (`npm ci`, `npm install`): skipping any other command
 * would skip its other effects.
 *
 * The link is read-only to the build. A checkout whose package.json or lockfile no longer matches the copy it links
 * gets its own install (the link goes, the approved setup runs there) and the shared copy is never touched; a copy
 * whose installed tree changed anyway is retired, never linked again. `toolroll storage clean` removes a copy no
 * checkout links or matches; the plane's daily storage sweep removes one no checkout has used for a week.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { markNeverIndex } from "./never-index.js";

export const DEPS_FOLDER = "deps";
const READY = "ready.json";
const RETIRED = "retired";
/** In a linked node_modules: the shared copy it links. */
const LINK_NOTE = ".toolroll-shared";
const NODE_MODULES = "node_modules";
/** A copy linked or made this recently is never removed by a clean-up: a lease may be about to link it. */
export const SHARED_GRACE_MS = 60 * 60_000;
/** The daily storage sweep removes a copy no checkout uses and none has linked for this long. */
export const SHARED_UNUSED_MS = 7 * 24 * 60 * 60_000;
/** A half-made copy (a crash mid-promotion) is debris after this long. */
const PARTIAL_STALE_MS = 24 * 60 * 60_000;

export type SharedCopy = {
  key: string;
  /** The copy's folder, holding node_modules and ready.json. */
  dir: string;
  repo: string;
  /** sha256 of the lockfile and package.json it was installed from. */
  lock: string;
  node: string;
  createdAt: string;
  /** Last linked (ready.json's modification time). */
  usedAt: string;
  /** Its installed tree changed after it was made: never linked again. */
  retired: boolean;
};

type Ready = { version: 1; repo: string; key: string; lock: string; node: string; setup: string; tree: string | null; createdAt: string };

export function sharedDepsRoot(databaseFile: string): string {
  return join(dirname(databaseFile), DEPS_FOLDER);
}

/** A setup whose whole effect is node_modules: `npm ci` or `npm install`, with plain flags only. */
export function installsOnly(command: string): boolean {
  return /^\s*npm\s+(?:ci|install|i)(?:\s+--?[A-Za-z][\w-]*(?:=[\w.@/:+-]+)?)*\s*$/.test(command);
}

/**
 * The checkout's dependency identity: its npm lockfile and package.json, hashed together. null when there is no
 * lockfile, or the lockfile links local folders (workspaces, `file:`), whose links would point into the shared
 * folder instead of the checkout.
 */
export function lockDigest(checkout: string): string | null {
  let lock: Buffer | null = null;
  for (const name of ["npm-shrinkwrap.json", "package-lock.json"]) {
    try { lock = readFileSync(join(checkout, name)); break; } catch { lock = null; }
  }
  if (lock === null) return null;
  let manifest: Buffer;
  try { manifest = readFileSync(join(checkout, "package.json")); } catch { return null; }
  if (/"link"\s*:\s*true/.test(lock.toString("utf8"))) return null;
  return createHash("sha256").update(lock).update("\u0000").update(manifest).digest("hex");
}

const nodeSeen = new Map<string, string | null>();
/** The node a setup on this PATH would install with: version, platform and architecture (native modules differ). */
export function nodeIdentity(path = process.env["PATH"] ?? ""): string | null {
  if (nodeSeen.has(path)) return nodeSeen.get(path)!;
  const found = spawnSync("node", ["-p", "process.version + ' ' + process.platform + ' ' + process.arch"], {
    encoding: "utf8", timeout: 15_000, env: { PATH: path, HOME: process.env["HOME"] ?? "" }, shell: process.platform === "win32",
  });
  const identity = found.status === 0 && /^v\d+\.\d+\.\d+ \S+ \S+$/.test(found.stdout.trim()) ? found.stdout.trim() : null;
  nodeSeen.set(path, identity);
  return identity;
}

export function depsKey(repo: string, setupDigest: string, lock: string, node: string): string {
  return createHash("sha256").update([repo, setupDigest, lock, node].join("\u0000"), "utf8").digest("hex").slice(0, 24);
}

/** What a checkout would share: its key and the facts behind it, or null when it can't share. */
export function sharingFor(args: { repo: string; worktree: string; setup: { command: string; digest: string } }): { key: string; lock: string; node: string } | null {
  if (!installsOnly(args.setup.command)) return null;
  const lock = lockDigest(args.worktree);
  if (lock === null) return null;
  const node = nodeIdentity();
  if (node === null) return null;
  return { key: depsKey(args.repo, args.setup.digest, lock, node), lock, node };
}

function readReady(dir: string): Ready | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, READY), "utf8")) as Ready;
    return parsed.version === 1 && typeof parsed.key === "string" && typeof parsed.lock === "string" ? parsed : null;
  } catch { return null; }
}

/** npm's record of what it installed: changes when anything installs or removes a package in the tree. */
function treeDigest(nodeModules: string): string | null {
  try { return createHash("sha256").update(readFileSync(join(nodeModules, ".package-lock.json"))).digest("hex"); } catch { return null; }
}

/** The shared node_modules for a key, when one is ready and unchanged since it was made. A changed one is retired. */
export function readyCopy(root: string, key: string): string | null {
  const dir = join(root, key);
  const ready = readReady(dir);
  if (ready === null || ready.key !== key || existsSync(join(dir, RETIRED)) || !existsSync(join(dir, NODE_MODULES))) return null;
  if (ready.tree !== treeDigest(join(dir, NODE_MODULES))) { retire(dir); return null; }
  return join(dir, NODE_MODULES);
}

/**
 * Take a changed copy out of use. It stays where it is, so a checkout still linking it keeps working; no new
 * checkout links it, and a clean-up removes it once nothing links it.
 */
function retire(dir: string): void {
  try { writeFileSync(join(dir, RETIRED), `${new Date().toISOString()}\n`, "utf8"); } catch { /* the next look retires it */ }
}

/**
 * The shared copy a checkout's node_modules links, or null (none, or its own install). A linked node_modules is a
 * small real folder: one link per top-level entry of the shared copy and a note naming it. Tools that write a cache
 * there (`node_modules/.vite`, `.cache`) write into the checkout's own folder, never the shared copy.
 */
export function linkedKey(worktree: string, root: string): string | null {
  let target: string;
  try { target = resolve(readFileSync(join(worktree, NODE_MODULES, LINK_NOTE), "utf8").trim()); } catch { return null; }
  const inside = relative(resolve(root), target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  const [key, folder, ...rest] = inside.split(/[\\/]/);
  return key !== undefined && folder === NODE_MODULES && rest.length === 0 ? key : null;
}

/** Remove a checkout's linked node_modules (its links and caches, never what they point to). True when there was one. */
export function detachShared(worktree: string, root: string): boolean {
  if (linkedKey(worktree, root) === null) return false;
  // rm removes a link itself; it never follows one into the shared copy.
  rmSync(join(worktree, NODE_MODULES), { recursive: true, force: true });
  return true;
}

function writable(path: string, on: boolean): void {
  if (process.platform === "win32") return;
  spawnSync("chmod", ["-R", on ? "u+w" : "a-w", path], { timeout: 120_000 });
}

/**
 * Put a shared copy into a checkout that has no node_modules: links (a junction per folder on Windows), else a
 * copy-on-write clone the build owns. null: neither worked, and the caller runs the plain setup.
 */
export function linkInto(worktree: string, shared: string): "link" | "clone" | null {
  const at = join(worktree, NODE_MODULES);
  if (existsSync(at) || isLink(at)) return null;
  try {
    mkdirSync(at);
    for (const entry of readdirSync(shared, { withFileTypes: true })) {
      symlinkSync(join(shared, entry.name), join(at, entry.name), entry.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file");
    }
    writeFileSync(join(at, LINK_NOTE), `${shared}\n`, "utf8");
    markNeverIndex(at);
    touch(dirname(shared));
    return "link";
  } catch {
    rmSync(at, { recursive: true, force: true });
  }
  const cloned = process.platform === "darwin" ? spawnSync("cp", ["-c", "-R", shared, at], { timeout: 600_000 })
    : process.platform === "linux" ? spawnSync("cp", ["--reflink=always", "-R", shared, at], { timeout: 600_000 })
    : null;
  if (cloned !== null && cloned.status === 0) { writable(at, true); touch(dirname(shared)); return "clone"; }
  try { writable(at, true); rmSync(at, { recursive: true, force: true }); } catch { /* a partial clone stays for a person */ }
  return null;
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function touch(dir: string): void {
  const now = new Date();
  try { utimesSync(join(dir, READY), now, now); } catch { /* the age only guards a clean-up */ }
}

/**
 * After the approved setup succeeded in a checkout with no copy for its key: move its node_modules into
 * `deps/<key>` (one rename), make it read-only and link it back. Returns how the checkout now has it, or null when it
 * kept its own install (a different volume, a setup that rewrote the lockfile, a race lost cleanly).
 */
export function promoteInstall(args: { root: string; repo: string; worktree: string; key: string; lock: string; node: string; setupDigest: string; now: Date }): "link" | "clone" | null {
  const own = join(args.worktree, NODE_MODULES);
  try { if (!lstatSync(own).isDirectory()) return null; } catch { return null; }
  if (lockDigest(args.worktree) !== args.lock) return null;
  const partial = join(args.root, `${args.key}.partial-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(partial, { recursive: true });
    // Spotlight leaves shared installs alone (never-index.ts).
    markNeverIndex(args.root);
    renameSync(own, join(partial, NODE_MODULES));
  } catch {
    rmSync(partial, { recursive: true, force: true });
    return null;
  }
  const ready: Ready = { version: 1, repo: args.repo, key: args.key, lock: args.lock, node: args.node, setup: args.setupDigest, tree: treeDigest(join(partial, NODE_MODULES)), createdAt: args.now.toISOString() };
  writeFileSync(join(partial, READY), `${JSON.stringify(ready)}\n`, "utf8");
  writable(join(partial, NODE_MODULES), false);
  let shared: string | null = null;
  try {
    renameSync(partial, join(args.root, args.key));
    shared = join(args.root, args.key, NODE_MODULES);
  } catch {
    // Another checkout made this copy first: use theirs.
    shared = readyCopy(args.root, args.key);
  }
  const linked = shared === null ? null : linkInto(args.worktree, shared);
  if (linked === null && !existsSync(partial) && shared === join(args.root, args.key, NODE_MODULES) && !existsSync(own)) {
    // Ours became the shared copy but couldn't be linked: it goes back to being this checkout's own install.
    writable(shared, true);
    try { renameSync(shared, own); rmSync(join(args.root, args.key), { recursive: true, force: true }); } catch { /* left for a clean-up */ }
    return null;
  }
  if (existsSync(partial)) {
    // Lost the race: ours goes back if nothing else could be linked, else it's removed.
    if (linked === null && !existsSync(own)) { writable(join(partial, NODE_MODULES), true); try { renameSync(join(partial, NODE_MODULES), own); } catch { /* left for a clean-up */ } }
    removeTree(partial);
  }
  return linked;
}

function removeTree(path: string): void {
  writable(path, true);
  rmSync(path, { recursive: true, force: true });
}

/** Every shared copy on disk, newest first. */
export function sharedCopies(root: string): SharedCopy[] {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { names = []; }
  const copies: SharedCopy[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{24}$/.test(name)) continue;
    const ready = readReady(join(root, name));
    if (ready === null) continue;
    let usedAt = ready.createdAt;
    try { usedAt = statSync(join(root, name, READY)).mtime.toISOString(); } catch { /* createdAt stands */ }
    copies.push({ key: name, dir: join(root, name), repo: ready.repo, lock: ready.lock, node: ready.node, createdAt: ready.createdAt, usedAt, retired: existsSync(join(root, name, RETIRED)) });
  }
  return copies.sort((a, b) => b.usedAt.localeCompare(a.usedAt));
}

export type SharedUse = SharedCopy & { checkouts: string[] };

/** Which checkouts use each copy: those linking it, and those whose lockfile it was installed from. */
export function sharedUse(root: string, checkouts: readonly { path: string; repo: string }[]): SharedUse[] {
  const copies = sharedCopies(root);
  const users = new Map<string, Set<string>>(copies.map(one => [one.key, new Set<string>()]));
  for (const checkout of checkouts) {
    const linked = linkedKey(checkout.path, root);
    if (linked !== null) { users.get(linked)?.add(checkout.path); continue; }
    if (!existsSync(checkout.path)) continue;
    const lock = lockDigest(checkout.path);
    if (lock === null) continue;
    for (const copy of copies) if (!copy.retired && copy.repo === checkout.repo && copy.lock === lock) users.get(copy.key)!.add(checkout.path);
  }
  return copies.map(one => ({ ...one, checkouts: [...users.get(one.key)!].sort() }));
}

/** Half-made copies under deps/ (a crash mid-promotion), old enough that nothing is still making them. */
export function sharedDebris(root: string, now: Date): string[] {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter(name => {
    if (!/\.partial-/.test(name)) return false;
    try { return now.getTime() - statSync(join(root, name)).mtime.getTime() > PARTIAL_STALE_MS; } catch { return false; }
  }).map(name => join(root, name));
}

/** What `storage clean` removes: copies no checkout uses and none linked within the grace period, plus debris. */
export function unusedShared(root: string, checkouts: readonly { path: string; repo: string }[], now: Date): { copies: SharedUse[]; debris: string[] } {
  const copies = sharedUse(root, checkouts).filter(one => one.checkouts.length === 0 && now.getTime() - Date.parse(one.usedAt) > SHARED_GRACE_MS);
  return { copies, debris: sharedDebris(root, now) };
}

/** Remove one copy or debris folder (read-only on disk, so made writable first). */
export function removeShared(path: string): boolean {
  if (basename(dirname(path)) !== DEPS_FOLDER) return false;
  try { removeTree(path); return !existsSync(path); } catch { return false; }
}

/**
 * The daily sweep: remove each copy no checkout uses and none has linked for `unusedMs` (a week), and old debris.
 * Right before a copy goes, who uses it and when it was last linked are read again; a copy a checkout picked up in
 * between stays.
 */
export function pruneUnusedShared(root: string, checkouts: () => readonly { path: string; repo: string }[], now: Date, unusedMs = SHARED_UNUSED_MS): { removed: SharedUse[]; failed: string[] } {
  const stale = (one: SharedUse) => one.checkouts.length === 0 && now.getTime() - Date.parse(one.usedAt) > unusedMs;
  const removed: SharedUse[] = [];
  const failed: string[] = [];
  for (const one of sharedUse(root, checkouts()).filter(stale)) {
    const fresh = sharedUse(root, checkouts()).find(other => other.key === one.key);
    if (fresh === undefined || !stale(fresh)) continue;
    if (removeShared(fresh.dir)) removed.push(fresh); else failed.push(fresh.dir);
  }
  for (const debris of sharedDebris(root, now)) if (!removeShared(debris)) failed.push(debris);
  return { removed, failed };
}
