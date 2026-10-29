/**
 * How the deployment script runs git on a repository a build can write (the project's Git directory, or the build's
 * checkout): never a fetch (eval-harness review 1, finding 5, and its security scan). Every run takes git's own
 * hardening (no replacement objects, hooks or fsmonitor) and refuses every transport on the command line, the general
 * `protocol.allow` and each named transport's own `protocol.<name>.allow` (a repository's `protocol.file.allow=always`
 * would otherwise outrank the general setting; a command-line value wins over the repository's for the same key). Git
 * 2.45+ also takes `--no-lazy-fetch`. An older git has no such flag (and 2.41.0 ignores GIT_NO_LAZY_FETCH): there, the
 * repository is refused before each command when its own config — read without includes, an include itself refused —
 * names anything that could make a lazy fetch possible or reach a transport (lazyFetchKey).
 */
import { spawnSync } from "node:child_process";

/** Every transport git knows by name, each refused on the command line. */
export const TRANSPORTS = ["file", "git", "ssh", "http", "https", "ext", "fd"];
export const PINNED_PROTOCOLS = ["-c", "protocol.allow=never", ...TRANSPORTS.flatMap(name => ["-c", `protocol.${name}.allow=never`])];
export const SAFE_GIT_BASE = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...PINNED_PROTOCOLS];

/**
 * The key of a `git config --list --no-includes --show-scope -z` listing that makes a lazy fetch or a transport
 * possible on a git without --no-lazy-fetch, or null: an include (whose file this never read), any `protocol.*`,
 * `extensions.partialClone`, a remote's `promisor` (unless plainly false), `partialCloneFilter` or `vcs`. A listing that
 * can't be read names a key (fail closed).
 */
export function lazyFetchKey(listing) {
  if (typeof listing !== "string") return "a config that couldn't be read";
  const fields = listing.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    // The repository's own settings; the command line's (this script's pins) are listed too, as scope "command".
    if (fields[at] !== "local" && fields[at] !== "worktree") continue;
    const entry = fields[at + 1];
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline < 0 ? "true" : entry.slice(newline + 1).trim();
    if (key.startsWith("include.") || key.startsWith("includeif.")) return key;
    if (key.startsWith("protocol.")) return key;
    if (key === "extensions.partialclone") return key;
    if (key.startsWith("remote.")) {
      const variable = key.slice(key.lastIndexOf(".") + 1);
      if (variable === "partialclonefilter" || variable === "vcs") return key;
      if (variable === "promisor" && !/^(false|no|off|0)$/i.test(value)) return key;
    }
  }
  return null;
}

let lazyFlag;
/** Whether the installed git takes --no-lazy-fetch (2.45+), asked once with no system or global config. */
export function lazyFetchFlagSupported(env) {
  if (lazyFlag === undefined) lazyFlag = spawnSync("git", ["--no-lazy-fetch", "version"], { cwd: "/", env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).status === 0;
  return lazyFlag;
}

/**
 * The arguments for one git command on `repo` (its `-C <dir>` or `--git-dir <dir>`): the hardening, and on git 2.45+
 * `--no-lazy-fetch`; on older git the repository's own config is checked first, and a key lazyFetchKey names refuses
 * the command (throws).
 */
export function safeGitArgs(repo, env, supported = lazyFetchFlagSupported(env)) {
  if (supported) return ["--no-lazy-fetch", ...SAFE_GIT_BASE, ...repo];
  const listed = spawnSync("git", [...SAFE_GIT_BASE, ...repo, "config", "--list", "--no-includes", "--show-scope", "-z"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const key = listed.status === 0 ? lazyFetchKey(listed.stdout) : "a config that couldn't be read";
  if (key !== null) throw Error(`The repository's git config sets ${key}, which this git (no --no-lazy-fetch) can't read past safely; deploy with git 2.45 or newer, or remove it.`);
  return [...SAFE_GIT_BASE, ...repo];
}

// ---- reading a commit with no filter, attribute or textconv (security scan of deploy-git.mjs) ------------------------
// `git archive`, `git show <rev>:<path>` and `git status` would apply the repository's attributes (its worktree
// .gitattributes, its info/attributes) and the filter, textconv or diff programs its config names: a build that can
// write the project's Git directory could make the deployment run a command. These reads use only `ls-tree` and
// `cat-file --batch`, which hand back stored bytes, and hash every object here against the id that names it; the
// cleanliness check hashes the working files itself. Nothing here applies an attribute.

/** The empty tree's id, and the attribute isolation every read here also takes. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const NO_ATTRIBUTES = [`--attr-source=${EMPTY_TREE}`, "-c", "core.attributesFile=/dev/null", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "core.alternateRefsCommand="];

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const objectId = (format, type, bytes) => createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const run = (args, env, input) => {
  const ran = spawnSync("git", args, { env, input, maxBuffer: 1024 * 1024 * 1024, timeout: 300_000, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (ran.status !== 0) throw Error(`git ${args.find(one => !one.startsWith("-") && !one.includes("=")) ?? ""} failed: ${String(ran.stderr ?? "").trim().slice(0, 300)}`);
  return ran.stdout;
};
/** A tree path that stays where it says. */
const plainPath = path => path !== "" && !path.startsWith("/") && !/[\u0000-\u001f\\]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");

/** Every entry of `commit`'s tree (recursive), from `ls-tree -r -z --full-tree`: mode, type, id, path. */
export function treeOf(repo, commit, env) {
  const out = run([...safeGitArgs(repo, env), ...NO_ATTRIBUTES, "ls-tree", "-r", "-z", "--full-tree", commit], env).toString("utf8");
  return out.split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    const [mode, type, id] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    if (!plainPath(path) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id ?? "")) throw Error(`The commit's tree names a path or object this can't read: ${JSON.stringify(path)}`);
    return { mode, type, id, path };
  });
}

/** Objects by id, read raw with `cat-file --batch` and each hashed here against its id. */
export function objectsOf(repo, ids, env) {
  const wanted = [...new Set(ids)];
  const found = new Map();
  if (wanted.length === 0) return found;
  const out = run([...safeGitArgs(repo, env), ...NO_ATTRIBUTES, "cat-file", "--batch"], env, Buffer.from(wanted.map(id => `${id}\n`).join("")));
  let at = 0;
  for (const id of wanted) {
    const newline = out.indexOf(0x0a, at);
    const header = out.subarray(at, newline).toString("utf8").split(" ");
    if (newline < 0 || header.length !== 3 || header[0] !== id) throw Error(`Object ${id.slice(0, 12)} is missing or unreadable.`);
    const start = newline + 1, end = start + Number(header[2]);
    const bytes = out.subarray(start, end);
    if (objectId(id.length === 40 ? "sha1" : "sha256", header[1], bytes) !== id) throw Error(`Object ${id.slice(0, 12)} doesn't hash to its id.`);
    found.set(id, { type: header[1], bytes });
    at = end + 1;
  }
  return found;
}

/** Write `commit`'s files into `dest` (an empty folder), stored bytes only: regular files and symlinks; a submodule is
 * left out as `git archive` leaves it. */
export function extractTree(repo, commit, dest, env) {
  const entries = treeOf(repo, commit, env);
  const blobs = objectsOf(repo, entries.filter(one => one.type === "blob").map(one => one.id), env);
  for (const one of entries) {
    if (one.type === "commit") continue;
    const target = join(dest, ...one.path.split("/"));
    if (!target.startsWith(dest + sep)) throw Error(`${one.path} leaves the folder.`);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = blobs.get(one.id).bytes;
    if (one.mode === "120000") symlinkSync(bytes.toString("utf8"), target);
    else if (one.mode === "100644" || one.mode === "100755") writeFileSync(target, bytes, { flag: "wx", mode: one.mode === "100755" ? 0o755 : 0o644 });
    else throw Error(`${one.path} has mode ${one.mode}, which isn't a file.`);
  }
  return entries.length;
}

/** One path's stored bytes at `commit`, or null when the commit has no such file. */
const trees = new Map();
export function blobAt(repo, commit, path, env) {
  const key = JSON.stringify([repo, commit]);
  if (!trees.has(key)) trees.set(key, new Map(treeOf(repo, commit, env).map(entry => [entry.path, entry])));
  const one = trees.get(key).get(path);
  if (one === undefined || one.type !== "blob") return null;
  return objectsOf(repo, [one.id], env).get(one.id).bytes;
}

/** The tracked files of `checkout` whose working bytes differ from `commit`'s (or are missing), hashed here with no
 * filter: what `git status --untracked-files=no` would call changed, without running anything it names. */
export function trackedChanges(checkout, commit, env) {
  const changed = [];
  for (const one of treeOf(["-C", checkout], commit, env)) {
    if (one.type !== "blob") continue;
    const path = join(checkout, ...one.path.split("/"));
    let bytes = null;
    try {
      const held = lstatSync(path);
      if (one.mode === "120000") bytes = held.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : null;
      else bytes = held.isFile() ? readFileSync(path) : null;
    } catch { bytes = null; }
    if (bytes === null || objectId(one.id.length === 40 ? "sha1" : "sha256", "blob", bytes) !== one.id) changed.push(one.path);
  }
  return changed;
}
