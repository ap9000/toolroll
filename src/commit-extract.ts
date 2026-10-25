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
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { checkoutGitEnv, HARDENED_GIT_ARGS } from "./agent-fence.js";
import { commandSetting } from "./teardown-git.js";

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
  const env = { ...checkoutGitEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1" };
  const git = (args: readonly string[], input?: Buffer) =>
    spawnSync("git", ["--git-dir", gitDir, "--no-replace-objects", ...HARDENED_GIT_ARGS, ...args], { env, input, maxBuffer: MAX_BYTES, timeout: 300_000 });
  // The repository's own config, read without includes, must name no command and include nothing.
  const config = git(["config", "--list", "--no-includes", "--show-scope", "-z"]);
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
