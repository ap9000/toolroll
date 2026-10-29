/**
 * The approved commit's files, written by Toolroll itself from a repository's object store (docs/plans/approval-policy.md
 * §1.7): the release runs the deployment script from what this writes, never from the candidate's checkout.
 *
 * No conversion of any kind: `git cat-file --batch` hands back each object's stored bytes, and this code hashes the
 * commit, every tree and every blob itself against the ids that name them and parses the trees itself, so no filter, smudge, textconv, export-subst, export-ignore or other attribute (from the repository's
 * config, `info/attributes` or the tree's own `.gitattributes`) can change or add a byte. Before any read the
 * repository's own config is refused if it names a command or includes another file (teardown-git.ts), and git runs
 * with no system or global config, no replacement objects, no lazy fetch, no hooks and no fsmonitor. Only regular
 * files are written (mode 644, or 755 when the tree says executable), each at a normalized path inside the folder;
 * symlinks, submodules and any other entry refuse the whole extraction.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { checkoutGitEnv, HARDENED_GIT_ARGS } from "./agent-fence.js";
import { commandSetting, lazyFetchSupported, viewedGitSync } from "./teardown-git.js";

export type Extraction = { ok: true; files: number } | { ok: false; message: string };

const MAX_BYTES = 1024 * 1024 * 1024;

/** What one extraction may hold, all checked before anything is written: the bytes written (every path, a blob shared
 * by many paths counted once per path), the files, the tree entries walked and how deep the trees nest. */
export type ExtractionLimits = { bytes: number; files: number; entries: number; depth: number };
export const EXTRACTION_LIMITS: ExtractionLimits = Object.freeze({ bytes: MAX_BYTES, files: 50_000, entries: 200_000, depth: 64 });

/** A tree path that stays where it says: relative, no empty, `.` or `..` part, no backslash or control character. */
export function normalizedTreePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\u0000-\u001f\\]/.test(path)) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** The object id Git gives `<type> <size>\0<bytes>` in this repository's object format. */
export const objectIdOf = (format: "sha1" | "sha256", type: string, bytes: Buffer): string =>
  createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

type TreeEntry = { mode: string; name: string; id: string };

/** A tree object's entries, parsed from its verified bytes: `<mode> <name>\0<raw id>` each. Null when malformed. */
export function parseTree(bytes: Buffer, idBytes: number): TreeEntry[] | null {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at), nul = space < 0 ? -1 : bytes.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 1 + idBytes > bytes.length) return null;
    entries.push({ mode: bytes.subarray(at, space).toString("latin1"), name: bytes.subarray(space + 1, nul).toString("utf8"), id: bytes.subarray(nul + 1, nul + 1 + idBytes).toString("hex") });
    at = nul + 1 + idBytes;
  }
  return entries;
}

/** Write commit `sha` of the repository whose Git directory is `gitDir` (a realpath Toolroll took from its own
 * records) into `dest`, an empty folder this process made. Every object on the way — the commit, each tree, each
 * blob — is hashed here and must be the id that names it: Git's own answer about an id is never taken on trust, so a
 * corrupted or replaced object in a store a build could write to refuses the extraction. */
export function extractCommit(gitDir: string, sha: string, dest: string, limits: ExtractionLimits = EXTRACTION_LIMITS): Extraction {
  const refuse = (message: string): Extraction => ({ ok: false, message });
  const git = protectedGit(gitDir, {}, []);
  // The repository's own config, read without includes, must name no command and include nothing.
  const config = git(["config", "--list", "--no-includes", "--show-scope", "-z"]);
  if (config.refused !== null) return refuse(`The project's Git directory can't be read safely: ${config.refused}.`);
  if (config.status !== 0) return refuse("The project's Git config couldn't be read.");
  const listing = config.stdout.toString("utf8");
  const command = commandSetting(listing);
  if (command !== null) return refuse(`The project's Git config sets ${command}, which can run a command.`);
  const format: "sha1" | "sha256" = /(?:^|\0)local\0extensions\.objectformat\nsha256(?:\0|$)/i.test(listing) ? "sha256" : "sha1";
  const hexLength = format === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${hexLength}}$`).test(sha)) return refuse(`${sha} isn't a full commit id.`);

  /** Objects by id, each read raw (`cat-file --batch`: "<id> <type> <size>\n<bytes>\n") and hashed here. */
  const read = (ids: readonly string[]): Map<string, { type: string; bytes: Buffer }> | string => {
    const batch = git(["cat-file", "--batch"], Buffer.from(ids.map(id => `${id}\n`).join(""), "utf8"));
    if (batch.status !== 0) return "the objects couldn't be read";
    const out = batch.stdout, found = new Map<string, { type: string; bytes: Buffer }>();
    let at = 0;
    for (const id of ids) {
      const newline = out.indexOf(0x0a, at);
      if (newline < 0) return "the objects couldn't be read";
      const header = out.subarray(at, newline).toString("utf8").split(" ");
      if (header.length !== 3 || header[0] !== id || !/^\d+$/.test(header[2]!)) return `object ${id.slice(0, 12)} is missing or unreadable`;
      const start = newline + 1, end = start + Number(header[2]);
      if (end + 1 > out.length || out[end] !== 0x0a) return `object ${id.slice(0, 12)} couldn't be read whole`;
      const bytes = out.subarray(start, end);
      if (objectIdOf(format, header[1]!, bytes) !== id) return `object ${id.slice(0, 12)} doesn't hash to its id`;
      found.set(id, { type: header[1]!, bytes });
      at = end + 1;
    }
    return found;
  };

  const commit = read([sha]);
  if (typeof commit === "string") return refuse(`The approved commit couldn't be verified: ${commit}.`);
  const commitObject = commit.get(sha)!;
  if (commitObject.type !== "commit") return refuse(`${sha.slice(0, 7)} isn't a commit.`);
  const treeLine = new RegExp(`^tree ([0-9a-f]{${hexLength}})\n`).exec(commitObject.bytes.toString("utf8"));
  if (treeLine === null) return refuse("The approved commit names no tree.");

  // Walk the trees from their verified bytes, level by level; collect every file.
  const files: { mode: "100644" | "100755"; id: string; path: string }[] = [];
  let level: { id: string; prefix: string }[] = [{ id: treeLine[1]!, prefix: "" }];
  let depth = 0, walked = 0;
  while (level.length > 0) {
    if (++depth > limits.depth) return refuse(`The commit's folders nest deeper than ${limits.depth}.`);
    const trees = read(level.map(one => one.id));
    if (typeof trees === "string") return refuse(`The approved commit couldn't be verified: ${trees}.`);
    const next: { id: string; prefix: string }[] = [];
    for (const { id, prefix } of level) {
      const tree = trees.get(id)!;
      if (tree.type !== "tree") return refuse(`The approved commit's tree ${id.slice(0, 12)} isn't a tree.`);
      const entries = parseTree(tree.bytes, hexLength / 2);
      if (entries === null) return refuse(`The approved commit's tree ${id.slice(0, 12)} couldn't be read.`);
      walked += entries.length;
      if (walked > limits.entries) return refuse(`The commit's trees hold more than ${limits.entries} entries.`);
      for (const entry of entries) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.name.includes("/") || !normalizedTreePath(path)) return refuse(`The commit holds a path that isn't normalized (${JSON.stringify(path)}).`);
        if (entry.mode === "40000") next.push({ id: entry.id, prefix: path });
        else if (entry.mode === "120000") return refuse(`The commit holds a symlink (${path}); a deployment never runs one.`);
        else if (entry.mode === "160000") return refuse(`The commit holds a submodule (${path}); a deployment never runs one.`);
        else if (entry.mode === "100644" || entry.mode === "100755") {
          files.push({ mode: entry.mode, id: entry.id, path });
          if (files.length > limits.files) return refuse(`The commit holds more than ${limits.files} files.`);
        }
        else return refuse(`The commit holds an entry that isn't a plain file (${path}).`);
      }
    }
    level = next;
  }
  if (files.length === 0) return refuse(`The commit ${sha.slice(0, 7)} holds no files.`);

  const blobs = read([...new Set(files.map(one => one.id))]);
  if (typeof blobs === "string") return refuse(`The approved commit couldn't be verified: ${blobs}.`);
  // What would be written, every path counted (a blob shared by many paths is written once per path).
  let total = 0;
  for (const file of files) {
    total += blobs.get(file.id)!.bytes.length;
    if (total > limits.bytes) return refuse(`The commit's files come to more than ${limits.bytes} bytes.`);
  }
  const root = realpathSync(dest);
  for (const file of files) {
    const blob = blobs.get(file.id)!;
    if (blob.type !== "blob") return refuse(`${file.path} isn't a file in the commit.`);
    const target = join(root, ...file.path.split("/"));
    if (!target.startsWith(root + sep)) return refuse(`The path ${file.path} leaves the folder.`);
    try {
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o755 });
      // "wx": never over anything already there (no file twice, no file where a folder is).
      writeFileSync(target, blob.bytes, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
    } catch (error) { return refuse(`The file ${file.path} couldn't be written: ${(error as Error).message}`); }
  }
  return { ok: true, files: files.length };
}

// ------------------------------------------------------------------------------------------------------------------
// Verified reads for one approval per release (docs/plans/release-once.md): the carry preflight reads commits, their
// ancestry and what changed between two trees only from objects this code hashed itself, from the project's own Git
// directory as Toolroll records it. Nothing here runs anything from a commit; replace refs, grafts and shallow history
// refuse the read rather than being trusted or quietly ignored, and git never fetches a missing object.

/** A commit read from its verified bytes: its tree and its parents, in order. */
export type VerifiedCommit = { id: string; tree: string; parents: string[]; message: string };
/** One entry of a verified tree, at its full path: a file (100644, 100755), a symlink (120000) or a submodule (160000). */
export type VerifiedEntry = { path: string; mode: string; id: string };
/** One path that differs between two verified trees, with its line counts when both sides are text. */
export type TreeChange = {
  path: string;
  kind: "added" | "modified" | "deleted";
  before: VerifiedEntry | null;
  after: VerifiedEntry | null;
  added: number;
  deleted: number;
  binary: boolean;
};
type VerifiedReader = { format: "sha1" | "sha256"; hexLength: number; read(ids: readonly string[]): Map<string, { type: string; bytes: Buffer }> | string;
  /** Git itself, hardened as above, for listings whose every id is then read through `read`. */
  git(args: readonly string[]): GitAnswer };
export type Verified<T> = { ok: true; value: T } | { ok: false; message: string };

/** Which Git runs and with what environment: the release path's fixed absolute Git and its own environment, or by
 * default the checkout Git environment's. The hardening settings are added over either. */
export type GitRunner = { git?: string; env?: NodeJS.ProcessEnv };

/** One protected git run: its exit (null when it didn't end on its own), its output, and why it was refused before it
 * ran (a frozen view's refusal), else null. */
type GitAnswer = { status: number | null; stdout: Buffer; refused: string | null };

/**
 * How the protected readers run git on the project's Git directory (eval-harness review 1, finding 5): never a fetch.
 * Every run denies every transport (`protocol.allow=never`, which outranks the repository's own protocol settings, and
 * reaches a lazy fetch's child through git's own -c propagation). A git with `--no-lazy-fetch` (2.45+) takes it, so a
 * missing object is never fetched. An older git — whose GIT_NO_LAZY_FETCH only some patch releases honor (2.41.0 doesn't)
 * — runs every command through a frozen view of the repository (teardown-git.ts viewedGitSync): its config read once
 * into a folder of the plane's own, includes refused, a partial clone refused from that same listing, which is the
 * config git then runs with, so nothing can turn lazy fetching on between the check and the read.
 */
function protectedGit(gitDir: string, runner: GitRunner, extra: readonly string[]): (args: readonly string[], input?: Buffer) => GitAnswer {
  const base = ["--no-replace-objects", "-c", "protocol.allow=never", ...extra];
  if (lazyFetchSupported()) {
    const env = { ...(runner.env ?? checkoutGitEnv()), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    return (args, input) => {
      const ran = spawnSync(runner.git ?? "git", ["--git-dir", gitDir, "--no-lazy-fetch", ...base, ...HARDENED_GIT_ARGS, ...args], { cwd: "/", env, input, maxBuffer: MAX_BYTES, timeout: 300_000 });
      return { status: ran.error === undefined ? ran.status : null, stdout: ran.stdout ?? Buffer.alloc(0), refused: null };
    };
  }
  // The view is of a checkout: the project's own `.git` folder, as Toolroll records it.
  const checkout = basename(gitDir) === ".git" ? dirname(gitDir) : null;
  return (args, input) => {
    if (checkout === null) return { status: null, stdout: Buffer.alloc(0), refused: "it isn't a checkout's .git folder, which this git can only read through a view" };
    try {
      const ran = viewedGitSync(checkout, [...base, ...args], { buffer: true, timeoutMs: 300_000, maxBuffer: MAX_BYTES, ...(input === undefined ? {} : { input }), ...(runner.git === undefined ? {} : { git: runner.git }) });
      return { status: ran.status, stdout: ran.stdout, refused: null };
    } catch (error) { return { status: null, stdout: Buffer.alloc(0), refused: error instanceof Error ? error.message : "it couldn't be read" }; }
  };
}

/** A reader over the project's object store that hashes every object it hands back, or why it can't be one. */
function verifiedReader(gitDir: string, runner: GitRunner = {}): Verified<VerifiedReader> {
  const refuse = (message: string): Verified<VerifiedReader> => ({ ok: false, message });
  // The commit-graph file is a cache a build can write: parents come from the objects themselves, never from it.
  const git = protectedGit(gitDir, runner, ["-c", "core.commitGraph=false"]);
  // History a build could have rewritten around the objects: a shallow boundary, grafts, or replacement refs. Each is
  // refused outright, so no reader here ever has to decide whether to believe one.
  if (existsSync(join(gitDir, "shallow"))) return refuse("The project's history is shallow, so the commits between the approval and this one can't all be read.");
  if (existsSync(join(gitDir, "info", "grafts"))) return refuse("The project's Git directory has grafts, which rewrite history; they are refused.");
  const replaced = git(["for-each-ref", "--format=%(refname)", "refs/replace/"]);
  if (replaced.refused !== null) return refuse(`The project's Git directory can't be read safely: ${replaced.refused}.`);
  if (replaced.status !== 0) return refuse("The project's refs couldn't be read.");
  if (replaced.stdout.toString("utf8").trim() !== "") return refuse("The project's Git directory has replacement refs, which swap objects; they are refused.");
  const config = git(["config", "--list", "--no-includes", "--show-scope", "-z"]);
  if (config.status !== 0) return refuse("The project's Git config couldn't be read.");
  const listing = config.stdout.toString("utf8");
  const command = commandSetting(listing);
  if (command !== null) return refuse(`The project's Git config sets ${command}, which can run a command.`);
  const format: "sha1" | "sha256" = /(?:^|\0)local\0extensions\.objectformat\nsha256(?:\0|$)/i.test(listing) ? "sha256" : "sha1";
  const hexLength = format === "sha1" ? 40 : 64;
  const read = (ids: readonly string[]): Map<string, { type: string; bytes: Buffer }> | string => {
    const found = new Map<string, { type: string; bytes: Buffer }>();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return found;
    if (wanted.some(id => !new RegExp(`^[0-9a-f]{${hexLength}}$`).test(id))) return "an object id isn't a full id";
    const batch = git(["cat-file", "--batch"], Buffer.from(wanted.map(id => `${id}\n`).join(""), "utf8"));
    if (batch.status !== 0) return "the objects couldn't be read";
    const out = batch.stdout;
    let at = 0;
    for (const id of wanted) {
      const newline = out.indexOf(0x0a, at);
      if (newline < 0) return "the objects couldn't be read";
      const header = out.subarray(at, newline).toString("utf8").split(" ");
      if (header.length !== 3 || header[0] !== id || !/^\d+$/.test(header[2]!)) return `object ${id.slice(0, 12)} is missing or unreadable`;
      const start = newline + 1, end = start + Number(header[2]);
      if (end + 1 > out.length || out[end] !== 0x0a) return `object ${id.slice(0, 12)} couldn't be read whole`;
      const bytes = out.subarray(start, end);
      if (objectIdOf(format, header[1]!, bytes) !== id) return `object ${id.slice(0, 12)} doesn't hash to its id`;
      found.set(id, { type: header[1]!, bytes });
      at = end + 1;
    }
    return found;
  };
  return { ok: true, value: { format, hexLength, read, git } };
}

/** Parse a commit from its verified bytes: tree, parents, message. Null when malformed. */
function parseCommit(id: string, bytes: Buffer, hexLength: number): VerifiedCommit | null {
  const text = bytes.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split < 0 ? text : text.slice(0, split);
  const lines = head.split("\n");
  const tree = new RegExp(`^tree ([0-9a-f]{${hexLength}})$`).exec(lines[0] ?? "");
  if (tree === null) return null;
  const parents: string[] = [];
  for (const line of lines.slice(1)) {
    const parent = new RegExp(`^parent ([0-9a-f]{${hexLength}})$`).exec(line);
    if (parent === null) break;
    parents.push(parent[1]!);
  }
  return { id, tree: tree[1]!, parents, message: split < 0 ? "" : text.slice(split + 2) };
}

/** One commit, hashed here and parsed from its own bytes. */
export function readVerifiedCommit(gitDir: string, sha: string): Verified<VerifiedCommit> {
  const reader = verifiedReader(gitDir);
  if (!reader.ok) return reader;
  return readCommitWith(reader.value, sha);
}

function readCommitWith(reader: VerifiedReader, sha: string): Verified<VerifiedCommit> {
  const got = reader.read([sha]);
  if (typeof got === "string") return { ok: false, message: `Commit ${sha.slice(0, 7)} couldn't be verified: ${got}.` };
  const object = got.get(sha)!;
  if (object.type !== "commit") return { ok: false, message: `${sha.slice(0, 7)} isn't a commit.` };
  const commit = parseCommit(sha, object.bytes, reader.hexLength);
  return commit === null ? { ok: false, message: `Commit ${sha.slice(0, 7)} couldn't be read.` } : { ok: true, value: commit };
}

/**
 * The commits from `from` back to `until` along first parents, newest first, `until` itself left out. Refuses when
 * `until` isn't reached within `max` commits (it isn't an ancestor, or too much lies between), and hands back each
 * commit's full parent list so a caller can refuse merges.
 */
export function verifiedFirstParentWalk(gitDir: string, from: string, until: string, max = 200): Verified<VerifiedCommit[]> {
  const reader = verifiedReader(gitDir);
  if (!reader.ok) return reader;
  const commits: VerifiedCommit[] = [];
  let at = from;
  while (at !== until) {
    if (commits.length >= max) return { ok: false, message: `${until.slice(0, 7)} isn't within ${max} commits before ${from.slice(0, 7)}.` };
    const commit = readCommitWith(reader.value, at);
    if (!commit.ok) return commit;
    commits.push(commit.value);
    const parent = commit.value.parents[0];
    if (parent === undefined) return { ok: false, message: `${until.slice(0, 7)} isn't an ancestor of ${from.slice(0, 7)}.` };
    at = parent;
  }
  return { ok: true, value: commits };
}

/** Every entry of a verified tree at its full path, symlinks and submodules included (a caller decides on them). An
 * unnormalized path, or one a tree lists twice, refuses the whole read. */
export function verifiedTreeEntries(gitDir: string, tree: string, limits: ExtractionLimits = EXTRACTION_LIMITS): Verified<VerifiedEntry[]> {
  const reader = verifiedReader(gitDir);
  if (!reader.ok) return reader;
  return treeEntriesWith(reader.value, tree, limits);
}

function treeEntriesWith(reader: VerifiedReader, root: string, limits: ExtractionLimits): Verified<VerifiedEntry[]> {
  const refuse = (message: string): Verified<VerifiedEntry[]> => ({ ok: false, message });
  const entries: VerifiedEntry[] = [];
  let level: { id: string; prefix: string }[] = [{ id: root, prefix: "" }];
  let depth = 0, walked = 0;
  const seen = new Set<string>();
  while (level.length > 0) {
    if (++depth > limits.depth) return refuse(`The commit's folders nest deeper than ${limits.depth}.`);
    const trees = reader.read(level.map(one => one.id));
    if (typeof trees === "string") return refuse(`A tree couldn't be verified: ${trees}.`);
    const next: { id: string; prefix: string }[] = [];
    for (const { id, prefix } of level) {
      const tree = trees.get(id)!;
      if (tree.type !== "tree") return refuse(`${id.slice(0, 12)} isn't a tree.`);
      const parsed = parseTree(tree.bytes, reader.hexLength / 2);
      if (parsed === null) return refuse(`Tree ${id.slice(0, 12)} couldn't be read.`);
      walked += parsed.length;
      if (walked > limits.entries) return refuse(`The trees hold more than ${limits.entries} entries.`);
      for (const entry of parsed) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.name.includes("/") || !normalizedTreePath(path)) return refuse(`A tree holds a path that isn't normalized (${JSON.stringify(path)}).`);
        if (seen.has(path)) return refuse(`A tree lists ${path} twice.`);
        seen.add(path);
        if (entry.mode === "40000") next.push({ id: entry.id, prefix: path });
        else if (["100644", "100755", "120000", "160000"].includes(entry.mode)) entries.push({ path, mode: entry.mode, id: entry.id });
        else return refuse(`A tree holds an entry of an unknown kind (${path}).`);
        if (entries.length > limits.files) return refuse(`The tree holds more than ${limits.files} entries.`);
      }
    }
    level = next;
  }
  return { ok: true, value: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/** Whether bytes look binary: a NUL in the first 8000 bytes, as Git judges. */
export const looksBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0);

/** The lines added and deleted from `before` to `after`, by the shortest edit (Myers): each counted once, stopped at
 * `cap` total edits (the counts then add up to more than `cap`, which every limit here refuses). */
export function lineChanges(before: Buffer, after: Buffer, cap = 100_000): { added: number; deleted: number } {
  const split = (bytes: Buffer) => { const text = bytes.toString("utf8"); if (text === "") return []; const lines = text.split("\n"); if (lines[lines.length - 1] === "") lines.pop(); return lines; };
  const a = split(before), b = split(after);
  // Trim the common start and end first: most changes are small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n === 0 || m === 0) return { added: m, deleted: n };
  const max = Math.min(n + m, cap);
  const v = new Int32Array(2 * max + 2);
  const off = max + 1;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        const common = (n + m - d) / 2;
        return { added: m - common, deleted: n - common };
      }
    }
  }
  // Past the cap: report everything as changed, which is more than any limit allows.
  return { added: m, deleted: n };
}

/**
 * What differs between two verified trees, path by path (no rename pairing: a moved file is a deletion and an
 * addition). Text files get their added and deleted lines; a binary side, a symlink or a submodule is marked so a caller
 * can refuse it.
 */
export function verifiedTreeDiff(gitDir: string, beforeTree: string, afterTree: string): Verified<TreeChange[]> {
  const reader = verifiedReader(gitDir);
  if (!reader.ok) return reader;
  const before = treeEntriesWith(reader.value, beforeTree, EXTRACTION_LIMITS);
  if (!before.ok) return before;
  const after = treeEntriesWith(reader.value, afterTree, EXTRACTION_LIMITS);
  if (!after.ok) return after;
  const was = new Map(before.value.map(one => [one.path, one]));
  const now = new Map(after.value.map(one => [one.path, one]));
  const paths = [...new Set([...was.keys(), ...now.keys()])].sort();
  const differing = paths.filter(path => { const a = was.get(path), b = now.get(path); return a === undefined || b === undefined || a.id !== b.id || a.mode !== b.mode; });
  const blobIds = differing.flatMap(path => [was.get(path), now.get(path)]).filter((one): one is VerifiedEntry => one !== undefined && (one.mode === "100644" || one.mode === "100755")).map(one => one.id);
  const blobs = reader.value.read(blobIds);
  if (typeof blobs === "string") return { ok: false, message: `A changed file couldn't be verified: ${blobs}.` };
  const changes: TreeChange[] = [];
  for (const path of differing) {
    const a = was.get(path) ?? null, b = now.get(path) ?? null;
    const bytesOf = (entry: VerifiedEntry | null): Buffer | null => {
      if (entry === null || (entry.mode !== "100644" && entry.mode !== "100755")) return null;
      const blob = blobs.get(entry.id);
      return blob !== undefined && blob.type === "blob" ? blob.bytes : null;
    };
    const fileLike = (entry: VerifiedEntry | null) => entry === null || entry.mode === "100644" || entry.mode === "100755";
    const ab = bytesOf(a), bb = bytesOf(b);
    if ((a !== null && fileLike(a) && ab === null) || (b !== null && fileLike(b) && bb === null)) return { ok: false, message: `${path} isn't a file in its commit.` };
    const binary = !fileLike(a) || !fileLike(b) || (ab !== null && looksBinary(ab)) || (bb !== null && looksBinary(bb));
    const counted = binary ? { added: 0, deleted: 0 } : lineChanges(ab ?? Buffer.alloc(0), bb ?? Buffer.alloc(0));
    changes.push({ path, kind: a === null ? "added" : b === null ? "deleted" : "modified", before: a, after: b, ...counted, binary });
  }
  return { ok: true, value: changes };
}

/** The ids of verified blobs at these paths of a tree (absent paths left out): a digest's inputs, read without
 * running anything. */
export function verifiedBlobs(gitDir: string, tree: string, paths: readonly string[]): Verified<Map<string, { id: string; bytes: Buffer }>> {
  const reader = verifiedReader(gitDir);
  if (!reader.ok) return reader;
  const entries = treeEntriesWith(reader.value, tree, EXTRACTION_LIMITS);
  if (!entries.ok) return entries;
  const wanted = entries.value.filter(one => paths.includes(one.path) && (one.mode === "100644" || one.mode === "100755"));
  const blobs = reader.value.read(wanted.map(one => one.id));
  if (typeof blobs === "string") return { ok: false, message: `A file couldn't be verified: ${blobs}.` };
  return { ok: true, value: new Map(wanted.map(one => [one.path, { id: one.id, bytes: blobs.get(one.id)!.bytes }])) };
}

/**
 * The commits reachable from `to` and not from `from`, as Git lists them (newest first), each read from its own verified
 * bytes: what a release card says changed (release-card.ts). Git only names them. Each is hashed here and its parents
 * checked against Git's listing; every commit the range stops at (a parent outside it) must be reached from `from`
 * through verified parents within `reach` commits, so history a build rewrote around the objects can't shorten the
 * list. A shallow boundary, grafts or replacement refs refuse (verifiedReader), as does a range longer than `max`.
 */
export function verifiedRange(gitDir: string, from: string, to: string, options: GitRunner & { max?: number; reach?: number } = {}): Verified<VerifiedCommit[]> {
  const { max = 1_000, reach = 5_000 } = options;
  const reader = verifiedReader(gitDir, options);
  if (!reader.ok) return reader;
  const { git, read, hexLength } = reader.value;
  const id = new RegExp(`^[0-9a-f]{${hexLength}}$`);
  if (!id.test(from) || !id.test(to)) return { ok: false, message: "A commit id isn't a full id." };
  /** Git's listing: each line's commit (`-` marks a boundary) and the parents it names. */
  const listing = (args: readonly string[]): { id: string; boundary: boolean; parents: string[] }[] | null => {
    const listed = git(["rev-list", "--parents", ...args]);
    if (listed.status !== 0) return null;
    const rows = String(listed.stdout).split("\n").filter(line => line !== "").map(line => {
      const [first = "", ...parents] = line.split(" ");
      return { id: first.replace(/^-/, ""), boundary: first.startsWith("-"), parents };
    });
    return rows.every(row => id.test(row.id) && row.parents.every(one => id.test(one))) ? rows : null;
  };
  const range = listing(["--boundary", `${from}..${to}`, "--"]);
  if (range === null) return { ok: false, message: "The commits between the releases couldn't be listed." };
  const inside = range.filter(row => !row.boundary), stops = new Set(range.filter(row => row.boundary).map(row => row.id));
  if (inside.length > max) return { ok: false, message: `More than ${max} commits lie between the releases.` };
  const objects = read(inside.map(row => row.id));
  if (typeof objects === "string") return { ok: false, message: `A commit couldn't be verified: ${objects}.` };
  const listed = new Set(inside.map(row => row.id));
  const commits: VerifiedCommit[] = [];
  for (const row of inside) {
    const object = objects.get(row.id)!;
    const commit = object.type === "commit" ? parseCommit(row.id, object.bytes, hexLength) : null;
    if (commit === null) return { ok: false, message: `${row.id.slice(0, 7)} isn't a commit.` };
    // Git's parents must be the commit's own, and each one inside the range or where it stops.
    if (commit.parents.join(" ") !== row.parents.join(" ")) return { ok: false, message: `Git's history of ${row.id.slice(0, 7)} isn't its own.` };
    if (commit.parents.some(parent => !listed.has(parent) && !stops.has(parent))) return { ok: false, message: `The history of ${row.id.slice(0, 7)} is incomplete.` };
    commits.push(commit);
  }
  if (inside.length > 0 && !listed.has(to)) return { ok: false, message: `${to.slice(0, 7)} isn't in its own range.` };
  // Where the range stops: each must be `from` or one of its verified ancestors. An empty range says `to` is already in
  // the last release: that too is proved, never taken from Git's listing.
  const wanted = [...stops, ...(inside.length === 0 ? [to] : [])].filter(one => one !== from);
  if (wanted.length === 0) return { ok: true, value: commits };
  const before = listing([`--max-count=${reach}`, from, "--"]);
  if (before === null) return { ok: false, message: "The last release's history couldn't be listed." };
  const ancestry = read(before.map(row => row.id));
  if (typeof ancestry === "string") return { ok: false, message: `The last release's history couldn't be verified: ${ancestry}.` };
  const reached = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const object = ancestry.get(queue.shift()!);
    const commit = object === undefined || object.type !== "commit" ? null : parseCommit("", object.bytes, hexLength);
    for (const parent of commit?.parents ?? []) if (!reached.has(parent)) { reached.add(parent); queue.push(parent); }
  }
  const unreached = wanted.find(one => !reached.has(one));
  return unreached === undefined ? { ok: true, value: commits } : { ok: false, message: `${unreached.slice(0, 7)} isn't verified as part of the last release's history.` };
}
