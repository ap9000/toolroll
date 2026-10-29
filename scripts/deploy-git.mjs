/**
 * How the deployment script reads a repository a build can write (the project's Git directory, or the build's
 * checkout): never a fetch, never a filter, and never the repository's own config (eval-harness review 2, findings 2
 * and 3).
 *
 * Git never reads the repository's config here. Each read runs against a Git directory of this script's own (a view):
 * a config it writes itself (only the object format and ref storage, taken from a copy of the repository's config read
 * once as a plain file, no include followed), HEAD copied, and links to the repository's objects and refs. So no
 * `protocol.<name>.allow`, promisor remote, partial-clone extension, include or command the repository names — however
 * and whenever it changes — reaches git: there is no check that a later read could race. Every run also refuses every
 * transport (`protocol.allow=never`), takes no system or global config, no replacement objects, hooks or fsmonitor, and
 * on git 2.45+ `--no-lazy-fetch` (asked of the very executable that runs).
 *
 * The scripts can't load Toolroll's own reader (src/commit-extract.ts): run by hand, from a checkout, there may be no
 * built dist; under the release, from its extraction of the approved commit, there is none; and the installed runtime
 * the script trusts predates any change made here. So the verification is a port of commit-extract.ts — every object
 * (the commit, each tree, each blob) hashed here against its id, trees parsed here from their verified bytes — and
 * test/attacks/checkout-git-deploy-reads.test.ts holds the two equal.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

/** Every transport git knows by name, each refused on the command line, and the general setting. */
export const TRANSPORTS = ["file", "git", "ssh", "http", "https", "ext", "fd"];
export const PINNED_PROTOCOLS = ["-c", "protocol.allow=never", ...TRANSPORTS.flatMap(name => ["-c", `protocol.${name}.allow=never`])];
/** The empty tree's id, and the attribute isolation every read here also takes. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const NO_ATTRIBUTES = [`--attr-source=${EMPTY_TREE}`, "-c", "core.attributesFile=/dev/null", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "core.alternateRefsCommand="];
export const SAFE_GIT_BASE = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.commitGraph=false", ...PINNED_PROTOCOLS, ...NO_ATTRIBUTES];

/** What one read may hold (src/commit-extract.ts EXTRACTION_LIMITS). */
export const LIMITS = Object.freeze({ bytes: 1024 * 1024 * 1024, files: 50_000, entries: 200_000, depth: 64 });

/** The git executable `env`'s PATH names, as a real path: the one probed is the one that runs. */
export function gitExecutable(env) {
  for (const dir of String(env?.PATH ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, "git");
    try { accessSync(candidate, fsConstants.X_OK); const real = realpathSync(candidate); if (lstatSync(real).isFile()) return real; } catch { /* next */ }
  }
  throw Error("No git on the deployment's PATH.");
}

const lazyFlag = new Map();
/** Whether this git executable takes --no-lazy-fetch (2.45+), asked once per executable with no system or global config. */
export function lazyFetchFlagSupported(git) {
  if (!lazyFlag.has(git)) {
    lazyFlag.set(git, spawnSync(git, ["--no-lazy-fetch", "version"], { cwd: "/", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).status === 0);
  }
  return lazyFlag.get(git);
}

/** One file, read only as the regular file it is (never through a link, never blocking on a FIFO, bounded), or null. */
function regularFile(path) {
  let fd = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const held = fstatSync(fd);
    if (!held.isFile() || held.size > 1024 * 1024) return null;
    return readFileSync(fd, "utf8");
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** The repository's git directory and common directory from `repo` (`["--git-dir", dir]` or `["-C", checkout]`), as
 * git finds them: a `.git` folder, or a one-line `gitdir: ` file; a `commondir` names the common one. */
function gitDirsOf(repo) {
  if (!Array.isArray(repo) || repo.length !== 2 || (repo[0] !== "--git-dir" && repo[0] !== "-C") || typeof repo[1] !== "string") throw Error("Name the repository as --git-dir <dir> or -C <checkout>.");
  let gitdir = resolve(repo[1]);
  if (repo[0] === "-C") {
    gitdir = join(gitdir, ".git");
    let held;
    try { held = lstatSync(gitdir); } catch { throw Error("The checkout has no .git."); }
    if (!held.isDirectory()) {
      const text = (regularFile(gitdir) ?? "").replace(/\r?\n$/, "");
      const pointer = text.startsWith("gitdir: ") && !/[\r\n]/.test(text) ? text.slice("gitdir: ".length) : "";
      if (pointer === "" || pointer !== pointer.trim()) throw Error("The checkout's .git isn't one git reads.");
      gitdir = resolve(repo[1], pointer);
    }
  }
  const named = regularFile(join(gitdir, "commondir"))?.trim();
  return { gitdir, common: named === undefined || named === "" ? gitdir : resolve(gitdir, named) };
}

/**
 * A Git directory of this script's own over `repo`, for reads only: its config written here (no remote, no protocol,
 * no include, no command; only the object format and ref storage the repository's config names, read once from a copy
 * of it), HEAD a copy, and links to the repository's real `objects`, `refs`, `packed-refs` and `reftable`. Returns its
 * path, object format and a disposer; throws when it can't be made.
 */
export function repositoryView(repo, git) {
  const { gitdir, common } = gitDirsOf(repo);
  let objects;
  try { objects = realpathSync(join(common, "objects")); if (!lstatSync(objects).isDirectory()) throw Error(); } catch { throw Error("The repository has no object store."); }
  const view = realpathSync(mkdtempSync(join(tmpdir(), "so-deploy-git-")));
  const dispose = () => rmSync(view, { recursive: true, force: true });
  try {
    const config = regularFile(join(common, "config"));
    if (config === null) throw Error("The repository's config couldn't be read as a plain file.");
    // Only parsed (no include followed, nothing run): a copy, read with git's own parser and no other config.
    const copy = join(view, "repository-config");
    writeFileSync(copy, config, { mode: 0o600 });
    const get = key => {
      const got = spawnSync(git, ["config", "--file", copy, "--no-includes", "--get", key], { cwd: "/", encoding: "utf8", timeout: 10_000,
        env: { PATH: "/usr/bin:/bin", HOME: view, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] });
      if (got.status === 1) return "";
      if (got.status !== 0) throw Error("The repository's config couldn't be read.");
      return got.stdout.trim().toLowerCase();
    };
    const format = get("extensions.objectformat") || "sha1", refs = get("extensions.refstorage") || "files";
    if (!["sha1", "sha256"].includes(format) || !["files", "reftable"].includes(refs)) throw Error(`The repository's format (${format}, ${refs} refs) isn't one this reads.`);
    rmSync(copy);
    const v1 = format !== "sha1" || refs !== "files";
    writeFileSync(join(view, "config"), `[core]\n\trepositoryformatversion = ${v1 ? 1 : 0}\n\tbare = true\n`
      + (v1 ? `[extensions]\n${format !== "sha1" ? `\tobjectformat = ${format}\n` : ""}${refs !== "files" ? `\trefstorage = ${refs}\n` : ""}` : ""), { mode: 0o600 });
    const head = regularFile(join(gitdir, "HEAD"));
    if (head === null || !/^(ref: refs\/[^\s]+|[0-9a-f]{40}|[0-9a-f]{64})\n?$/.test(head)) throw Error("The repository's HEAD couldn't be read.");
    writeFileSync(join(view, "HEAD"), head.endsWith("\n") ? head : `${head}\n`, { mode: 0o600 });
    symlinkSync(objects, join(view, "objects"));
    for (const name of ["refs", "packed-refs", "reftable"]) {
      let there = false;
      try { lstatSync(join(common, name)); there = true; } catch { there = false; }
      if (there) symlinkSync(join(common, name), join(view, name));
      else if (name === "refs") mkdirSync(join(view, "refs"));
    }
    return { dir: view, format, dispose };
  } catch (error) { dispose(); throw error; }
}

/** One git command on a view: no repository config, no system or global config, an environment of only these. */
function viewRun(view, git, args, env, input) {
  const ran = spawnSync(git, ["--git-dir", view.dir, ...(lazyFetchFlagSupported(git) ? ["--no-lazy-fetch"] : []), ...SAFE_GIT_BASE, ...args], {
    cwd: view.dir, input, maxBuffer: LIMITS.bytes + 64 * 1024 * 1024, timeout: 300_000, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { PATH: String(env?.PATH ?? "/usr/bin:/bin"), HOME: view.dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" },
  });
  if (ran.status !== 0) throw Error(`git ${args.find(one => !one.startsWith("-") && !one.includes("=")) ?? ""} failed: ${String(ran.stderr ?? ran.error ?? "").trim().slice(0, 300)}`);
  return ran.stdout;
}

/** Run `fn(view, git)` on a fresh view of `repo`, disposed after. */
function withView(repo, env, fn) {
  const git = gitExecutable(env);
  const view = repositoryView(repo, git);
  try { return fn(view, git); } finally { view.dispose(); }
}

/** The commit `repo`'s HEAD names, read through a view (nothing of the repository's config applies). */
export function headOf(repo, env) {
  return withView(repo, env, (view, git) => {
    const out = viewRun(view, git, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], env).toString("utf8").trim();
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(out)) throw Error("The repository's HEAD names no commit.");
    return out;
  });
}

// ---- verified reading: the port of src/commit-extract.ts ------------------------------------------------------------

const objectId = (format, type, bytes) => createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

/** A tree path that stays where it says (commit-extract.ts normalizedTreePath). */
export function normalizedTreePath(path) {
  if (path === "" || path.startsWith("/") || /[\u0000-\u001f\\]/.test(path)) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** A tree object's entries from its verified bytes (commit-extract.ts parseTree). Null when malformed. */
export function parseTree(bytes, idBytes) {
  const entries = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at), nul = space < 0 ? -1 : bytes.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 1 + idBytes > bytes.length) return null;
    entries.push({ mode: bytes.subarray(at, space).toString("latin1"), name: bytes.subarray(space + 1, nul).toString("utf8"), id: bytes.subarray(nul + 1, nul + 1 + idBytes).toString("hex") });
    at = nul + 1 + idBytes;
  }
  return entries;
}

/** Objects by id from one view, each read raw (`cat-file --batch`) and hashed here against its id; throws otherwise. */
function readObjects(view, git, ids, env) {
  const wanted = [...new Set(ids)];
  const found = new Map();
  if (wanted.length === 0) return found;
  const hex = view.format === "sha1" ? 40 : 64;
  if (wanted.some(id => !new RegExp(`^[0-9a-f]{${hex}}$`).test(id))) throw Error("An object id isn't a full id.");
  const out = viewRun(view, git, ["cat-file", "--batch"], env, Buffer.from(wanted.map(id => `${id}\n`).join("")));
  let at = 0;
  for (const id of wanted) {
    const newline = out.indexOf(0x0a, at);
    if (newline < 0) throw Error("The objects couldn't be read.");
    const header = out.subarray(at, newline).toString("utf8").split(" ");
    if (header.length !== 3 || header[0] !== id || !/^\d+$/.test(header[2])) throw Error(`Object ${id.slice(0, 12)} is missing or unreadable.`);
    const start = newline + 1, end = start + Number(header[2]);
    if (end + 1 > out.length || out[end] !== 0x0a) throw Error(`Object ${id.slice(0, 12)} couldn't be read whole.`);
    const bytes = out.subarray(start, end);
    if (objectId(view.format, header[1], bytes) !== id) throw Error(`Object ${id.slice(0, 12)} doesn't hash to its id.`);
    found.set(id, { type: header[1], bytes });
    at = end + 1;
  }
  return found;
}

/**
 * Every entry of `commit`'s tree at its full path — files, symlinks (type blob) and submodules (type commit) — from
 * the commit and every tree, each hashed here against its id and parsed here (commit-extract.ts extractCommit's walk):
 * an unnormalized path, a path twice, an unknown mode or a tree past the limits refuses (throws).
 */
function walk(view, git, commit, env, limits = LIMITS) {
  const hex = view.format === "sha1" ? 40 : 64;
  if (typeof commit !== "string" || !new RegExp(`^[0-9a-f]{${hex}}$`).test(commit)) throw Error(`${commit} isn't a full commit id.`);
  const head = readObjects(view, git, [commit], env).get(commit);
  if (head.type !== "commit") throw Error(`${commit.slice(0, 7)} isn't a commit.`);
  const treeLine = new RegExp(`^tree ([0-9a-f]{${hex}})\n`).exec(head.bytes.toString("utf8"));
  if (treeLine === null) throw Error("The commit names no tree.");
  const entries = [], seen = new Set();
  let level = [{ id: treeLine[1], prefix: "" }], depth = 0, walked = 0;
  while (level.length > 0) {
    if (++depth > limits.depth) throw Error(`The commit's folders nest deeper than ${limits.depth}.`);
    const trees = readObjects(view, git, level.map(one => one.id), env);
    const next = [];
    for (const { id, prefix } of level) {
      const tree = trees.get(id);
      if (tree.type !== "tree") throw Error(`The commit's tree ${id.slice(0, 12)} isn't a tree.`);
      const parsed = parseTree(tree.bytes, hex / 2);
      if (parsed === null) throw Error(`The commit's tree ${id.slice(0, 12)} couldn't be read.`);
      walked += parsed.length;
      if (walked > limits.entries) throw Error(`The commit's trees hold more than ${limits.entries} entries.`);
      for (const entry of parsed) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.name.includes("/") || !normalizedTreePath(path)) throw Error(`The commit's tree names a path or object this can't read: ${JSON.stringify(path)}`);
        if (seen.has(path)) throw Error(`The commit's tree lists ${path} twice.`);
        seen.add(path);
        if (entry.mode === "40000") next.push({ id: entry.id, prefix: path });
        else if (["100644", "100755", "120000"].includes(entry.mode)) entries.push({ mode: entry.mode, type: "blob", id: entry.id, path });
        else if (entry.mode === "160000") entries.push({ mode: entry.mode, type: "commit", id: entry.id, path });
        else throw Error(`The commit holds an entry of an unknown kind (${path}).`);
        if (entries.length > limits.files) throw Error(`The commit holds more than ${limits.files} entries.`);
      }
    }
    level = next;
  }
  return entries;
}

/** Every entry of `commit`'s tree (recursive), verified: mode, type, id, path. */
export function treeOf(repo, commit, env) {
  return withView(repo, env, (view, git) => walk(view, git, commit, env));
}

/** Objects by id, read raw through a view and each hashed here against its id. */
export function objectsOf(repo, ids, env) {
  return withView(repo, env, (view, git) => readObjects(view, git, ids, env));
}

/**
 * Why a commit's file paths can't all be written as separate regular files, or null (the same rules as
 * src/commit-extract.ts writtenPathsProblem, kept equal by test): a `.git` part, a path twice, two paths that are one
 * on a case-insensitive or Unicode-normalizing file system (macOS), or a path that is both a file and a folder.
 */
export function writtenPathsProblem(paths) {
  const folded = new Map();
  for (const path of paths) {
    if (!normalizedTreePath(path)) return `${JSON.stringify(path)} isn't a plain relative path`;
    if (path.split("/").some(part => part.toLowerCase() === ".git")) return `${path} names a .git folder`;
    const key = path.normalize("NFC").toLowerCase();
    if (folded.has(key)) return folded.get(key) === path ? `${path} is listed twice` : `${path} and ${folded.get(key)} are the same file on this computer`;
    folded.set(key, path);
  }
  for (const key of folded.keys()) {
    const parts = key.split("/");
    for (let at = 1; at < parts.length; at++) {
      const folder = parts.slice(0, at).join("/");
      if (folded.has(folder)) return `${folded.get(folder)} is both a file and a folder`;
    }
  }
  return null;
}

/**
 * Write `commit`'s files into `dest` (an empty folder this process made), stored bytes only, as commit-extract.ts
 * extractCommit writes a release's: the commit, every tree and every blob verified, regular files only — a symlink or
 * submodule refuses the whole extraction, so nothing is ever written through a link — every path checked first
 * (writtenPathsProblem), every parent folder under `dest` proved a real folder before each write, and each file created
 * new (O_CREAT|O_EXCL|O_NOFOLLOW).
 */
export function extractTree(repo, commit, dest, env) {
  return withView(repo, env, (view, git) => {
    const entries = walk(view, git, commit, env);
    for (const one of entries) {
      if (one.mode === "120000") throw Error(`The commit holds a symlink (${one.path}); a deployment never writes one.`);
      if (one.mode === "160000" || one.type !== "blob" || (one.mode !== "100644" && one.mode !== "100755")) throw Error(`The commit holds an entry that isn't a plain file (${one.path}).`);
    }
    if (entries.length === 0) throw Error(`The commit ${commit.slice(0, 7)} holds no files.`);
    const problem = writtenPathsProblem(entries.map(one => one.path));
    if (problem !== null) throw Error(`The commit's files can't be written: ${problem}.`);
    const blobs = readObjects(view, git, entries.map(one => one.id), env);
    let total = 0;
    for (const one of entries) {
      if (blobs.get(one.id).type !== "blob") throw Error(`${one.path} isn't a file in the commit.`);
      total += blobs.get(one.id).bytes.length;
      if (total > LIMITS.bytes) throw Error(`The commit's files come to more than ${LIMITS.bytes} bytes.`);
    }
    const root = realpathSync(dest);
    for (const one of entries) {
      const parts = one.path.split("/");
      let at = root;
      for (const part of parts.slice(0, -1)) {
        at = join(at, part);
        try { mkdirSync(at, { mode: 0o755 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
        if (!lstatSync(at).isDirectory()) throw Error(`${one.path}: ${at} isn't a real folder.`);
      }
      const target = join(at, parts.at(-1));
      if (!target.startsWith(root + sep)) throw Error(`${one.path} leaves the folder.`);
      const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, one.mode === "100755" ? 0o755 : 0o644);
      try { writeSync(fd, blobs.get(one.id).bytes); } finally { closeSync(fd); }
    }
    return entries.length;
  });
}

/** One path's stored bytes at `commit`, or null when the commit has no such file. */
const trees = new Map();
export function blobAt(repo, commit, path, env) {
  const key = JSON.stringify([repo, commit]);
  if (!trees.has(key)) trees.set(key, new Map(treeOf(repo, commit, env).map(entry => [entry.path, entry])));
  const one = trees.get(key).get(path);
  if (one === undefined || one.type !== "blob" || one.mode === "120000") return null;
  const blob = objectsOf(repo, [one.id], env).get(one.id);
  if (blob.type !== "blob") throw Error(`${path} isn't a file in the commit.`);
  return blob.bytes;
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
