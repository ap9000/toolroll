/**
 * The approved commit's files, written by Toolroll itself from a repository's object store (docs/plans/approval-policy.md
 * §1.7): the release runs the deployment script from what this writes, never from the candidate's checkout.
 *
 * No conversion of any kind: `git ls-tree -r -z` lists the tree and `git cat-file --batch` hands back each blob's
 * stored bytes, so no filter, smudge, textconv, export-subst, export-ignore or other attribute (from the repository's
 * config, `info/attributes` or the tree's own `.gitattributes`) can change or add a byte. Before any read the
 * repository's own config is refused if it names a command or includes another file (teardown-git.ts), and git runs
 * with no system or global config, no replacement objects, no lazy fetch, no hooks and no fsmonitor. Only regular
 * files are written (mode 644, or 755 when the tree says executable), each at a normalized path inside the folder;
 * symlinks, submodules and any other entry refuse the whole extraction.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { checkoutGitEnv, HARDENED_GIT_ARGS } from "./agent-fence.js";
import { commandSetting } from "./teardown-git.js";

export type Extraction = { ok: true; files: number } | { ok: false; message: string };

const SHA = /^[0-9a-f]{40}$/;
const MAX_BYTES = 1024 * 1024 * 1024;

/** A tree path that stays where it says: relative, no empty, `.` or `..` part, no backslash or control character. */
export function normalizedTreePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\u0000-\u001f\\]/.test(path)) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Write commit `sha` of the repository whose Git directory is `gitDir` (a realpath Toolroll took from its own
 * records) into `dest`, an empty folder this process made. */
export function extractCommit(gitDir: string, sha: string, dest: string): Extraction {
  const refuse = (message: string): Extraction => ({ ok: false, message });
  if (!SHA.test(sha)) return refuse(`${sha} isn't a full commit SHA.`);
  const env = { ...checkoutGitEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1" };
  const git = (args: readonly string[], input?: Buffer) =>
    spawnSync("git", ["--git-dir", gitDir, "--no-replace-objects", ...HARDENED_GIT_ARGS, ...args], { env, input, maxBuffer: MAX_BYTES, timeout: 300_000 });
  // The repository's own config, read without includes, must name no command and include nothing.
  const config = git(["config", "--list", "--no-includes", "--show-scope", "-z"]);
  if (config.status !== 0) return refuse("The project's Git config couldn't be read.");
  const command = commandSetting(config.stdout.toString("utf8"));
  if (command !== null) return refuse(`The project's Git config sets ${command}, which can run a command.`);
  const tree = git(["ls-tree", "-r", "-z", "--full-tree", sha]);
  if (tree.status !== 0) return refuse(`The commit ${sha.slice(0, 7)} couldn't be listed.`);
  const entries: { mode: "100644" | "100755"; blob: string; path: string }[] = [];
  for (const line of tree.stdout.toString("utf8").split("\0")) {
    if (line === "") continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(line);
    if (match === null) return refuse("The commit's tree couldn't be read.");
    const [, mode, type, blob, path] = match;
    if (mode === "120000") return refuse(`The commit holds a symlink (${path}); a deployment never runs one.`);
    if (mode === "160000") return refuse(`The commit holds a submodule (${path}); a deployment never runs one.`);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) return refuse(`The commit holds an entry that isn't a plain file (${path}).`);
    if (!normalizedTreePath(path!)) return refuse(`The commit holds a path that isn't normalized (${JSON.stringify(path)}).`);
    entries.push({ mode, blob: blob!, path: path! });
  }
  if (entries.length === 0) return refuse(`The commit ${sha.slice(0, 7)} holds no files.`);
  // Every blob's stored bytes in one batch: "<sha> blob <size>\n<bytes>\n" each, in the order asked.
  const batch = git(["cat-file", "--batch"], Buffer.from(entries.map(one => `${one.blob}\n`).join(""), "utf8"));
  if (batch.status !== 0) return refuse("The commit's files couldn't be read.");
  const out = batch.stdout;
  const root = realpathSync(dest);
  let at = 0;
  for (const entry of entries) {
    const newline = out.indexOf(0x0a, at);
    if (newline < 0) return refuse("The commit's files couldn't be read.");
    const header = out.subarray(at, newline).toString("utf8").split(" ");
    if (header.length !== 3 || header[0] !== entry.blob || header[1] !== "blob" || !/^\d+$/.test(header[2]!)) return refuse(`The file ${entry.path} couldn't be read.`);
    const size = Number(header[2]);
    const start = newline + 1, end = start + size;
    if (end + 1 > out.length || out[end] !== 0x0a) return refuse(`The file ${entry.path} couldn't be read whole.`);
    const target = join(root, ...entry.path.split("/"));
    if (!target.startsWith(root + sep)) return refuse(`The path ${entry.path} leaves the folder.`);
    try {
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o755 });
      // "wx": never over anything already there (no file twice, no file where a folder is).
      writeFileSync(target, out.subarray(start, end), { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
    } catch (error) { return refuse(`The file ${entry.path} couldn't be written: ${(error as Error).message}`); }
    at = end + 1;
  }
  return { ok: true, files: entries.length };
}
