/**
 * The controlled import for Flexible threads, slice F4 (the Flexible plan v2 §1 "Controlled import (the only road into
 * the real repository)", with Codex round 2's required change 6 and the F2 breakdown's enable gate 2, binding): how a
 * thread's committed work enters the project's repository, and nothing else does.
 *
 * The rules this module keeps:
 * - Nothing here works while FLEXIBLE_AVAILABLE is false: every entry point refuses with `not-available` before it
 *   reads or writes anything.
 * - Toolroll does it, never the agent, and the thread's repository is attacker input: no git ever runs in it, so its
 *   config, hooks, attributes and refs-by-command are never read. Toolroll reads the thread's branch tip from its ref
 *   file (or packed-refs) as plain bytes, proves the thread's objects folder is the plain folder it made (no link
 *   anywhere in it, its alternates exactly the project's objects), and then works in a QUARANTINE: a repository Toolroll
 *   writes by hand (no git init, no template) beside the threads, in the folder every launch is denied, whose only
 *   object sources are the project's objects and the thread's (its alternates, both pinned by realpath), whose config
 *   is Toolroll's own (commit graphs and multi-pack indexes off, so a hostile one in the thread's objects is never
 *   trusted), with no replace refs and no grafts. Every git call goes through the shared hardened runner
 *   (teardown-git.ts hardenedGit: no system or global config, no hooks, no fsmonitor, no network, attributes from the
 *   empty tree).
 * - Every check runs in that quarantine BEFORE ANY REF MOVES in the project's repository: the candidate is a commit that
 *   descends from the thread's recorded base, with no merge commit between them (none from outside, by default none at
 *   all), within the commit, object, per-file and on-disk limits; no submodule; none of Toolroll's placeholder files (the
 *   bytes flexible-thread.ts reserves protected names with: `git add -f` can commit one, so the thread's exclude list is
 *   no import boundary); no protected name (agent-fence.ts protectedChanges) and no link at one (protectedLinks); no
 *   link that leads out of the project or into a `.git`; and the existing secret check on the diff (evidence.ts
 *   scanPatchForSecrets). Each refusal says what it found, in words, and leaves the project's refs exactly as they were.
 * - Only then is the candidate fetched from the quarantine into the project's repository, at
 *   refs/toolroll/import/<thread>/<n> (create-only, `transfer.fsckObjects`, no tags, no FETCH_HEAD, no submodules, a
 *   time limit), and the thread's branch toolroll/code-<thread> moved to it by compare-and-swap from exactly what the
 *   previous import left (create-only for the first). The project's default branch is never touched. The candidate's
 *   check task branch is made at the thread's base by the Ship (flexible-ship.ts), from the same import.
 * - The ref audit (flexible-refs.ts): the project's refs are read before the fetch and compared with the thread's last
 *   snapshot; a ref outside refs/toolroll/ that changed while the thread ran is said, as changed by someone else. It
 *   decides nothing.
 * - Disclosed in the Ship terms, not prevented here: a thread reads the project's real `objects` folder (read-only), so
 *   it could read history beyond its base (flexible-ship.ts HISTORY_WORDS).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { FLEXIBLE_UNAVAILABLE } from "./flexible.js";
import { flexibleThread, flexibleThreadBranch, flexibleThreadPaths, withFlexibleThreadLock, type FlexibleThreadPaths, type FlexibleThreadRow } from "./flexible-thread.js";
import { readProjectRefs, refsChangedOutside, refSnapshotOf, saveRefSnapshot } from "./flexible-refs.js";
import { PROTECTED_FILES, protectedChanges, protectedLinks } from "./agent-fence.js";
import { scanPatchForSecrets } from "./evidence.js";
import { PROOF_LIMITS } from "./proof.js";
import { run, type ExecResult } from "./exec.js";
import { hardenedGit, recordedCommonDir } from "./teardown-git.js";
import { projectRowKnown, type Store } from "./store.js";
import type { Runner } from "./worktree.js";

// ---- refusals ---------------------------------------------------------------------------------------------------------

/** What the quarantine found, each said in words: the import is refused (`import-refused`) and no ref moved. */
export type FlexibleImportCheck = "candidate-unreadable" | "candidate-changed" | "nothing-to-send" | "not-descendant" | "merge" | "too-large" | "bad-path"
  | "submodule" | "placeholder" | "protected" | "symlink" | "secret" | "unreadable" | "import-exists" | "branch-moved" | "default-branch" | "fetch-failed";
export type FlexibleImportRefusal =
  | { ok: false; reason: "not-available" | "thread-unknown" | "thread-not-ready" | "not-a-project" | "repository-unusable" | "thread-folder-changed"; message: string }
  | { ok: false; reason: "import-refused"; check: FlexibleImportCheck; message: string };

const NOTHING = "Nothing was imported.";
const PRE_WORDS = {
  "not-available": FLEXIBLE_UNAVAILABLE,
  "thread-unknown": "There's no such thread.",
  "thread-not-ready": "This thread's repository isn't ready, so nothing was imported.",
  "not-a-project": "That thread's project isn't in Toolroll any more, so nothing was imported.",
  "repository-unusable": "This project's repository can't take an import safely, so nothing was imported.",
  "thread-folder-changed": "This thread's folder isn't the one Toolroll made, so nothing was imported.",
} as const;
const CHECK_WORDS: Readonly<Record<FlexibleImportCheck, string>> = Object.freeze({
  "candidate-unreadable": `The thread's branch couldn't be read safely. ${NOTHING}`,
  "candidate-changed": `The thread's branch moved since these terms were shown. ${NOTHING} Review the new terms.`,
  "nothing-to-send": `The thread has no committed changes to send. ${NOTHING}`,
  "not-descendant": `The thread's branch doesn't build on the commit it started from. ${NOTHING}`,
  "merge": `The thread's commits include a merge. Only the thread's own commits on top of its starting commit can be imported. ${NOTHING}`,
  "too-large": `The change is bigger than Toolroll imports at once. ${NOTHING}`,
  "bad-path": `A changed file has a name Toolroll can't import safely. ${NOTHING}`,
  "submodule": `The change adds a submodule. ${NOTHING}`,
  "placeholder": `The change commits one of the placeholder files Toolroll put in the thread. ${NOTHING}`,
  "protected": `The change touches a file Toolroll protects: settings, hooks or startup files that run for whoever opens the project next. ${NOTHING}`,
  "symlink": `The change adds a link that leads outside the project or into its Git folder. ${NOTHING}`,
  "secret": `An added line looks like a real key. ${NOTHING} If it's a real key, rotate it and take it out of the thread's commits.`,
  "unreadable": `The thread's commits couldn't be read safely. ${NOTHING}`,
  "import-exists": `An import with this number is already in your repository. ${NOTHING}`,
  "branch-moved": `The thread's branch in your repository was changed by someone else. ${NOTHING}`,
  "default-branch": `The thread's branch is your repository's checked-out branch. ${NOTHING}`,
  "fetch-failed": `Git refused the thread's commits: they failed its object checks or took too long. ${NOTHING}`,
});
const pre = (reason: keyof typeof PRE_WORDS, detail?: string): FlexibleImportRefusal =>
  ({ ok: false, reason, message: detail === undefined ? PRE_WORDS[reason] : `${PRE_WORDS[reason]} (${detail})` });
const refused = (check: FlexibleImportCheck, detail?: string): FlexibleImportRefusal =>
  ({ ok: false, reason: "import-refused", check, message: detail === undefined ? CHECK_WORDS[check] : `${CHECK_WORDS[check]} (${detail})` });

// ---- limits -----------------------------------------------------------------------------------------------------------

/** What one import may carry. Past any of them the import is refused, never truncated. */
export const FLEXIBLE_IMPORT_LIMITS = Object.freeze({
  commits: 1_000,
  objects: 50_000,
  /** Any one file, uncompressed. */
  blobBytes: 16 * 1024 * 1024,
  /** Everything new, as stored on disk (compressed). */
  diskBytes: 256 * 1024 * 1024,
  /** The diff the secret check reads. */
  patchBytes: 64 * 1024 * 1024,
  /** The fetch into the project's repository. */
  fetchMs: 120_000,
  /** Entries in the thread's objects folder walked for links. */
  objectEntries: 500_000,
});

// ---- paths ------------------------------------------------------------------------------------------------------------

/** Quarantines live here, under the threads folder: denied whole to every launch (agent-fence.ts), threads included
 * (each thread's fence reads back only its own folder). */
export const FLEXIBLE_IMPORTS_DIR = ".imports";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const flexibleImportRef = (thread: string, seq: number): string => `refs/toolroll/import/${thread}/${seq}`;

/** A folder of this user's own, really itself: not a link, nor reached through one, owner-only. */
function ownFolder(path: string): boolean {
  try {
    const held = lstatSync(path);
    const uid = process.getuid?.();
    return held.isDirectory() && !held.isSymbolicLink() && (uid === undefined || held.uid === uid) && (held.mode & 0o077) === 0 && realpathSync(path) === join(realpathSync(dirname(path)), basename(path));
  } catch { return false; }
}
const plainDir = (path: string): boolean => { try { const held = lstatSync(path); return held.isDirectory() && !held.isSymbolicLink(); } catch { return false; } };

/** The state folder beside the database, as its real path; null for an in-memory store. */
function stateFolderOf(store: Store): string | null {
  const file = store.databaseFile();
  if (file === null || file === "" || file === ":memory:") return null;
  try { return dirname(realpathSync(file)); } catch { return null; }
}

// ---- git --------------------------------------------------------------------------------------------------------------

type Git = (cwd: string, args: readonly string[], options?: { maxBuffer?: number; timeoutMs?: number }) => Promise<ExecResult>;
/** Fixed on every import git call, ahead of its own arguments: no replace refs, and no commit graph or multi-pack index
 * trusted (one in the thread's objects folder could lie about parents). */
const IMPORT_FLAGS: readonly string[] = ["--no-replace-objects", "-c", "core.commitGraph=false", "-c", "core.multiPackIndex=false"];
/** The shared hardened runner (teardown-git.ts), bound to the repository it runs in: the quarantine or the project. */
function gitIn(inner: Runner, mode: "build" | "read"): Git {
  return async (cwd, args, options = {}) => hardenedGit(inner, mode, { repo: cwd })("git", [...IMPORT_FLAGS, ...args],
    { cwd, timeoutMs: options.timeoutMs ?? 60_000, ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }) });
}

// ---- the thread's side, read as plain bytes ---------------------------------------------------------------------------

type Source = { thread: FlexibleThreadRow; project: string; objects: string; paths: FlexibleThreadPaths; threadObjects: string; format: "sha1" | "sha256" };

/** Why the thread's objects folder isn't the plain one Toolroll made, or null: its repository a plain one (its own
 * `.git` folder, no commondir, no reftable), its objects folder a real folder whose alternates name exactly the
 * project's objects and nothing over HTTP, and nothing in it a link or anything but a file or folder (a link would lead
 * the quarantine to another project's objects). */
function threadObjectsProblem(paths: FlexibleThreadPaths, recorded: string, objects: string): string | null {
  if (recorded !== paths.folder) return "its record names another folder";
  if (!ownFolder(paths.root) || !ownFolder(paths.folder)) return "its folder isn't a private folder of yours";
  const gitdir = join(paths.repo, ".git");
  const threadObjects = join(gitdir, "objects");
  if (!plainDir(paths.repo) || !plainDir(gitdir) || !plainDir(threadObjects)) return "its repository isn't a plain one";
  if (existsSync(join(gitdir, "commondir")) || existsSync(join(gitdir, "reftable"))) return "its repository isn't a plain one";
  try { if (realpathSync(threadObjects) !== join(realpathSync(paths.folder), "repo", ".git", "objects")) return "its objects folder isn't its own"; } catch { return "its objects folder can't be read"; }
  try {
    const alternates = join(threadObjects, "info", "alternates");
    const held = lstatSync(alternates);
    if (!held.isFile() || held.isSymbolicLink() || readFileSync(alternates, "utf8") !== `${objects}\n`) return "its alternates changed";
  } catch { return "its alternates can't be read"; }
  if (existsSync(join(threadObjects, "info", "http-alternates"))) return "it borrows objects over the network";
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(threadObjects, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[]; } catch { return "its objects can't be listed"; }
  if (entries.length > FLEXIBLE_IMPORT_LIMITS.objectEntries) return "it holds too many object files";
  const odd = entries.find(one => !one.isFile() && !one.isDirectory());
  if (odd !== undefined) return `its objects folder has a link or special file (${join(odd.parentPath, odd.name).slice(threadObjects.length + 1)})`;
  return null;
}

/** The thread's branch tip, read from its loose ref file or packed-refs as plain bytes (no git runs in the thread's
 * repository, so nothing there can name a command), or null when it isn't exactly a commit id there. */
function threadBranchTip(paths: FlexibleThreadPaths, id: string): string | null {
  const gitdir = join(paths.repo, ".git");
  const name = `refs/heads/${flexibleThreadBranch(id)}`;
  let at = gitdir;
  let loose = true;
  for (const part of ["refs", "heads", "toolroll"]) {
    at = join(at, part);
    let held: import("node:fs").Stats;
    try { held = lstatSync(at); } catch { loose = false; break; }
    if (!held.isDirectory() || held.isSymbolicLink()) return null;
  }
  if (loose) {
    const file = join(gitdir, name);
    let held: import("node:fs").Stats | null = null;
    try { held = lstatSync(file); } catch { held = null; }
    if (held !== null) {
      if (!held.isFile() || held.isSymbolicLink() || held.size > 200) return null;
      const read = /^([0-9a-f]{40}|[0-9a-f]{64})\n?$/.exec(readFileSync(file, "utf8"));
      return read === null ? null : read[1]!;
    }
  }
  const packed = join(gitdir, "packed-refs");
  let held: import("node:fs").Stats;
  try { held = lstatSync(packed); } catch { return null; }
  if (!held.isFile() || held.isSymbolicLink() || held.size > 32 * 1024 * 1024) return null;
  for (const line of readFileSync(packed, "utf8").split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 0 || line.slice(space + 1) !== name) continue;
    const sha = line.slice(0, space);
    return SHA.test(sha) ? sha : null;
  }
  return null;
}

/** The thread and its project, from Toolroll's records, proven: ready, its project registered and a plain repository,
 * the thread's folder and objects the ones Toolroll made. */
function sourceOf(store: Store, id: string): Source | FlexibleImportRefusal {
  const thread = flexibleThread(store, id);
  if (thread === null) return pre("thread-unknown");
  if (thread.state !== "ready") return pre("thread-not-ready");
  if (!projectRowKnown(store, thread.repo)) return pre("not-a-project");
  const state = stateFolderOf(store);
  if (state === null) return pre("repository-unusable", "no state folder");
  let project: string, objects: string;
  try {
    project = realpathSync(thread.repo);
    const common = recordedCommonDir(project);
    if (!plainDir(join(common, "objects"))) throw new Error("objects");
    if (existsSync(join(common, "objects", "info", "alternates")) || existsSync(join(common, "objects", "info", "http-alternates"))) throw new Error("alternates");
    objects = realpathSync(join(common, "objects"));
  } catch { return pre("repository-unusable"); }
  const paths = flexibleThreadPaths(state, thread.id);
  const problem = threadObjectsProblem(paths, thread.folder, objects);
  if (problem !== null) return pre("thread-folder-changed", problem);
  return { thread, project, objects, paths, threadObjects: realpathSync(join(paths.repo, ".git", "objects")), format: thread.baseSha.length === 64 ? "sha256" : "sha1" };
}

// ---- the quarantine ---------------------------------------------------------------------------------------------------

/**
 * A repository Toolroll writes by hand (no git runs to make it, so no template, hook or global setting enters), in a
 * fresh folder under the threads folder's `.imports`: HEAD, a config of Toolroll's own, empty refs, and objects whose
 * only sources are the project's and the thread's (alternates, both real paths). Removed when `work` ends.
 */
async function withQuarantine<T>(source: Source, work: (repo: string) => Promise<T>): Promise<T> {
  const imports = join(source.paths.root, FLEXIBLE_IMPORTS_DIR);
  try { mkdirSync(imports, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!ownFolder(imports)) throw new Error(`${imports} isn't a private folder of yours`);
  const folder = mkdtempSync(join(imports, `${source.thread.id}-`));
  try {
    const repo = join(folder, "repo");
    const gitdir = join(repo, ".git");
    for (const dir of [repo, gitdir, join(gitdir, "objects"), join(gitdir, "objects", "info"), join(gitdir, "objects", "pack"), join(gitdir, "refs"), join(gitdir, "refs", "heads"), join(gitdir, "refs", "tags"), join(gitdir, "info")]) mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/quarantine\n", { mode: 0o600, flag: "wx" });
    const sha256 = source.format === "sha256";
    writeFileSync(join(gitdir, "config"), [
      "[core]", `\trepositoryformatversion = ${sha256 ? 1 : 0}`, "\tfilemode = true", "\tbare = false", "\tlogallrefupdates = false",
      "\tcommitGraph = false", "\tmultiPackIndex = false",
      ...(sha256 ? ["[extensions]", "\tobjectFormat = sha256"] : []), "",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    writeFileSync(join(gitdir, "objects", "info", "alternates"), `${source.objects}\n${source.threadObjects}\n`, { mode: 0o600, flag: "wx" });
    return await work(repo);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// ---- reading the candidate --------------------------------------------------------------------------------------------

type DiffEntry = { oldMode: string; newMode: string; oldSha: string; newSha: string; status: string; path: string };

/** `diff-tree -r -z --raw` output, parsed strictly; null when it isn't exactly that. */
function parseRawDiff(stdout: string): DiffEntry[] | null {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return null;
  const entries: DiffEntry[] = [];
  for (let at = 0; at < fields.length; at += 2) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([ADMT])$/.exec(fields[at]!);
    if (meta === null) return null;
    entries.push({ oldMode: meta[1]!, newMode: meta[2]!, oldSha: meta[3]!, newSha: meta[4]!, status: meta[5]!, path: fields[at + 1]! });
  }
  return entries;
}

/** The candidate's changed paths against the base, read in the quarantine (bounded, strict); or why not. */
async function changedEntries(read: Git, repo: string, base: string, candidate: string): Promise<DiffEntry[] | FlexibleImportRefusal> {
  const listed = await read(repo, ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-commit-id", base, candidate], { maxBuffer: 32 * 1024 * 1024 });
  if (listed.code !== 0) return refused("unreadable", "its changes couldn't be listed");
  const entries = parseRawDiff(listed.stdout);
  if (entries === null) return refused("unreadable", "its changes couldn't be listed");
  if (entries.length > PROOF_LIMITS.changed) return refused("too-large", `${entries.length} changed files`);
  for (const one of entries) if (one.path === "" || Buffer.byteLength(one.path) > PROOF_LIMITS.changedPath || /[\x00-\x1f\x7f]/.test(one.path) || one.path.split("/").some(part => part === "" || part === "." || part === "..")) return refused("bad-path");
  return entries;
}

/** The thread's committed candidate and its changed files, read in a quarantine (nothing of the thread's runs, and no
 * ref moves anywhere): what the Ship terms show. Refuses as the import would for a candidate that isn't a commit
 * descending from the base. */
export async function readFlexibleCandidate(store: Store, input: { thread: string; runner?: Runner }):
  Promise<{ ok: true; candidate: string; base: string; changedPaths: string[] } | FlexibleImportRefusal> {
  if (!FLEXIBLE_AVAILABLE) return pre("not-available");
  const source = sourceOf(store, input.thread);
  if ("ok" in source) return source;
  const candidate = threadBranchTip(source.paths, source.thread.id);
  if (candidate === null || candidate.length !== source.thread.baseSha.length) return refused("candidate-unreadable");
  if (candidate === source.thread.baseSha) return refused("nothing-to-send");
  const read = gitIn(input.runner ?? run, "read");
  return guarded(() => withQuarantine(source, async repo => {
    const lineage = await descends(read, repo, source.thread.baseSha, candidate);
    if (lineage !== null) return lineage;
    const entries = await changedEntries(read, repo, source.thread.baseSha, candidate);
    if (!Array.isArray(entries)) return entries;
    if (entries.length === 0) return refused("nothing-to-send");
    return { ok: true as const, candidate, base: source.thread.baseSha, changedPaths: entries.map(one => one.path).sort() };
  }));
}

/** Anything unexpected while working in the quarantine (a folder that can't be made, a read that throws) is a plain
 * refusal, never an exception that leaves a send half-recorded. */
async function guarded<T>(work: () => Promise<T>): Promise<T | FlexibleImportRefusal> {
  try { return await work(); } catch (error) { return refused("unreadable", error instanceof Error ? error.message.slice(0, 200) : undefined); }
}

async function descends(read: Git, repo: string, base: string, candidate: string): Promise<FlexibleImportRefusal | null> {
  const type = await read(repo, ["cat-file", "-t", candidate]);
  if (type.code !== 0 || type.stdout.trim() !== "commit") return refused("candidate-unreadable", "it isn't a commit Toolroll can read");
  const lineage = await read(repo, ["merge-base", "--is-ancestor", base, candidate]);
  if (lineage.code === 1) return refused("not-descendant");
  if (lineage.code !== 0) return refused("unreadable");
  return null;
}

// ---- the checks -------------------------------------------------------------------------------------------------------

/** The blob ids of the placeholder bytes flexible-thread.ts reserves protected names with (an empty file, `{}` for
 * JSON), in this repository's object format. */
function placeholderBlobs(format: "sha1" | "sha256"): Set<string> {
  return new Set(["", "{}\n"].map(text => createHash(format === "sha256" ? "sha256" : "sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`, "utf8").digest("hex")));
}
/** The protected names a thread's repository holds placeholders for at its top (flexible-thread.ts TOP_PROTECTED's
 * files). */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(PROTECTED_FILES.filter(name => !name.startsWith(".git/")));

/** Whether a link at `path` (relative, inside the tree) to `target` leads out of the tree or into a `.git`. */
export function linkLeadsOut(path: string, target: string): boolean {
  if (target === "" || /[\0\\]/.test(target) || isAbsolute(target) || /^[A-Za-z]:/.test(target)) return true;
  const parts = path.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (parts.length === 0) return true; parts.pop(); continue; }
    if (part.toLowerCase() === ".git") return true;
    parts.push(part);
  }
  return false;
}

/** Every check, in the quarantine, before any ref moves: null when the candidate may be imported; else the refusal. */
async function quarantineChecks(read: Git, repo: string, source: Source, candidate: string): Promise<FlexibleImportRefusal | null> {
  const base = source.thread.baseSha;
  if (candidate === base) return refused("nothing-to-send");
  const lineage = await descends(read, repo, base, candidate);
  if (lineage !== null) return lineage;
  // No merge commit between the base and the candidate: one would bring history from outside the thread.
  const merges = await read(repo, ["rev-list", "--merges", "--max-count=1", `${base}..${candidate}`]);
  if (merges.code !== 0) return refused("unreadable");
  if (merges.stdout.trim() !== "") return refused("merge", `commit ${merges.stdout.trim().slice(0, 12)}`);
  const counted = await read(repo, ["rev-list", "--count", `${base}..${candidate}`]);
  const commits = Number(counted.stdout.trim());
  if (counted.code !== 0 || !Number.isSafeInteger(commits)) return refused("unreadable");
  if (commits > FLEXIBLE_IMPORT_LIMITS.commits) return refused("too-large", `${commits} commits`);
  // Every new object, and no file past the per-file limit (rev-list names an omitted one with a leading ~).
  const objects = await read(repo, ["rev-list", "--objects", "--no-object-names", `--filter=blob:limit=${FLEXIBLE_IMPORT_LIMITS.blobBytes}`, "--filter-print-omitted", `${base}..${candidate}`],
    { maxBuffer: (FLEXIBLE_IMPORT_LIMITS.objects + 1) * 70 });
  if (objects.code !== 0) return refused(objects.stdout.length > FLEXIBLE_IMPORT_LIMITS.objects * 60 ? "too-large" : "unreadable");
  const listed = objects.stdout.split("\n").filter(line => line !== "");
  if (listed.some(line => line.startsWith("~"))) return refused("too-large", "a file is over 16 MB");
  if (listed.length > FLEXIBLE_IMPORT_LIMITS.objects) return refused("too-large", `${listed.length} objects`);
  const disk = await read(repo, ["rev-list", "--objects", "--disk-usage", `${base}..${candidate}`]);
  const bytes = Number(disk.stdout.trim());
  if (disk.code !== 0 || !Number.isSafeInteger(bytes)) return refused("unreadable");
  if (bytes > FLEXIBLE_IMPORT_LIMITS.diskBytes) return refused("too-large", `${Math.round(bytes / 1024 / 1024)} MB`);
  const entries = await changedEntries(read, repo, base, candidate);
  if (!Array.isArray(entries)) return entries;
  if (entries.length === 0) return refused("nothing-to-send");
  const added = entries.filter(one => one.status !== "D");
  const submodule = added.find(one => one.newMode === "160000");
  if (submodule !== undefined) return refused("submodule", submodule.path);
  // Placeholder bytes before the protected-name rule, so the words say what it is.
  const placeholders = placeholderBlobs(source.format);
  const placeholder = added.find(one => PLACEHOLDER_NAMES.has(one.path) && placeholders.has(one.newSha));
  if (placeholder !== undefined) return refused("placeholder", placeholder.path);
  const named = protectedChanges(entries.map(one => one.path));
  if (named.length > 0) return refused("protected", named.slice(0, 3).join(", "));
  const links = added.filter(one => one.newMode === "120000");
  const linkedProtected = protectedLinks(links.map(one => one.path));
  if (linkedProtected.length > 0) return refused("protected", linkedProtected.slice(0, 3).join(", "));
  for (const link of links) {
    const target = await read(repo, ["cat-file", "blob", link.newSha], { maxBuffer: 8192 });
    if (target.code !== 0 || target.stdout.length > 4096 || linkLeadsOut(link.path, target.stdout)) return refused("symlink", link.path);
  }
  // The existing secret check on the diff (evidence.ts): only added lines count; documented placeholders aren't keys.
  const patch = await read(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", base, candidate], { maxBuffer: FLEXIBLE_IMPORT_LIMITS.patchBytes });
  if (patch.code !== 0) return refused(patch.stdout.length >= FLEXIBLE_IMPORT_LIMITS.patchBytes ? "too-large" : "unreadable", "its diff couldn't be read whole");
  const hits = scanPatchForSecrets(patch.stdout);
  if (hits.length > 0) return refused("secret", hits.slice(0, 3).map(hit => `${hit.file}:${hit.fileLine} (${hit.name})`).join(", "));
  return null;
}

// ---- the import -------------------------------------------------------------------------------------------------------

export type FlexibleImported = { ok: true; candidate: string; importRef: string; branch: string; branchBefore: string | null;
  /** Refs outside refs/toolroll/ that changed since the thread started (or its last import): said, decides nothing. */
  refsChanged: string[] | null };

/**
 * Import a thread's committed candidate into its project's repository as send `seq` (the Ship's own numbering): every
 * check in a quarantine first, then the fetch to refs/toolroll/import/<thread>/<seq>, then the thread's branch
 * toolroll/code-<thread> moved from exactly `branchBefore` (null: it must not exist yet) to the candidate. `expected` is
 * the candidate the person's terms named: a branch that moved since is refused. Runs under the thread's lock; the
 * thread's agent must not be running (the Ship checks that first). A refusal leaves every ref of the project's as it was.
 */
export async function importFlexibleCandidate(store: Store, input: { thread: string; seq: number; expected: string; branchBefore: string | null; by: string; now: Date; runner?: Runner }):
  Promise<FlexibleImported | FlexibleImportRefusal> {
  if (!FLEXIBLE_AVAILABLE) return pre("not-available");
  const locked = await withFlexibleThreadLock(input.thread, () => guarded(() => importLocked(store, input)));
  if (locked.ok === false && (locked.reason === "not-available" || locked.reason === "thread-unknown")) return pre(locked.reason);
  return locked as FlexibleImported | FlexibleImportRefusal;
}

async function importLocked(store: Store, input: { thread: string; seq: number; expected: string; branchBefore: string | null; by: string; now: Date; runner?: Runner }): Promise<FlexibleImported | FlexibleImportRefusal> {
  if (!Number.isSafeInteger(input.seq) || input.seq < 1 || !SHA.test(input.expected) || (input.branchBefore !== null && !SHA.test(input.branchBefore))) return refused("unreadable", "the import's own terms aren't valid");
  const source = sourceOf(store, input.thread);
  if ("ok" in source) return source;
  const inner = input.runner ?? run;
  const read = gitIn(inner, "read"), build = gitIn(inner, "build");
  const candidate = threadBranchTip(source.paths, source.thread.id);
  if (candidate === null || candidate.length !== source.thread.baseSha.length) return refused("candidate-unreadable");
  if (candidate !== input.expected) return refused("candidate-changed");
  const importRef = flexibleImportRef(source.thread.id, input.seq);
  const branch = flexibleThreadBranch(source.thread.id);
  const zero = "0".repeat(candidate.length);
  return withQuarantine(source, async repo => {
    const problem = await quarantineChecks(read, repo, source, candidate);
    if (problem !== null) return problem;
    // The project's side, read before anything is written there: the import's ref must be new, the thread's branch
    // must hold exactly what the previous import left, and it must not be the project's checked-out branch.
    if ((await read(source.project, ["rev-parse", "--verify", "--quiet", "--end-of-options", importRef])).code === 0) return refused("import-exists");
    const current = await read(source.project, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}`]);
    const held = current.code === 0 ? current.stdout.trim() : null;
    if (held !== input.branchBefore) return refused("branch-moved");
    const head = await read(source.project, ["symbolic-ref", "-q", "HEAD"]);
    if (head.code === 0 && head.stdout.trim() === `refs/heads/${branch}`) return refused("default-branch");
    // The ref audit (detection only).
    const before = await readProjectRefs(read, source.project);
    const snapshot = refSnapshotOf(store, source.thread.id);
    const refsChanged = before === null || snapshot === null ? null : refsChangedOutside(snapshot, before);
    // The quarantine's own ref, so the fetch names a ref it advertises (never a bare id from the thread).
    const named = await build(repo, ["update-ref", "--no-deref", "refs/heads/candidate", candidate, zero]);
    if (named.code !== 0) return refused("unreadable", "the quarantine couldn't name the candidate");
    // The first write to the project's repository: a create-only ref, objects checked as they arrive, nothing else.
    const fetched = await build(source.project, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "-c", "fetch.writeCommitGraph=false",
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", `--negotiation-tip=${source.thread.baseSha}`, "--", repo, `refs/heads/candidate:${importRef}`],
      { timeoutMs: FLEXIBLE_IMPORT_LIMITS.fetchMs });
    const landed = await read(source.project, ["rev-parse", "--verify", "--quiet", "--end-of-options", importRef]);
    if (fetched.code !== 0 || landed.code !== 0 || landed.stdout.trim() !== candidate) {
      if (landed.code === 0) await build(source.project, ["update-ref", "--no-deref", "-d", importRef, landed.stdout.trim()]);
      return refused("fetch-failed");
    }
    const moved = await build(source.project, ["update-ref", "--no-deref", "-m", `toolroll: Flexible import ${input.seq}`, `refs/heads/${branch}`, candidate, input.branchBefore ?? zero]);
    if (moved.code !== 0) {
      await build(source.project, ["update-ref", "--no-deref", "-d", importRef, candidate]);
      return refused("branch-moved");
    }
    const after = await readProjectRefs(read, source.project);
    store.transact(() => {
      if (after !== null) saveRefSnapshot(store, source.thread.id, after, input.now);
      if (refsChanged !== null && refsChanged.length > 0) {
        store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: source.thread.repo, taskId: null, runId: null, source: "policy", action: "flexible refs changed", outcome: "changed-by-someone-else",
          detail: `thread ${source.thread.id} · while it ran: ${refsChanged.slice(0, 20).join(", ")}${refsChanged.length > 20 ? ` and ${refsChanged.length - 20} more` : ""}`.slice(0, 2000) });
      }
      store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: source.thread.repo, taskId: null, runId: null, source: "policy", action: "flexible import", outcome: "imported",
        detail: `thread ${source.thread.id} · send ${input.seq} · ${candidate} · ${importRef} · ${branch}` });
    });
    return { ok: true as const, candidate, importRef, branch, branchBefore: input.branchBefore, refsChanged };
  });
}

/**
 * Take an import back that has no task (the Ship's "remove"): the import's ref goes by compare-and-swap, and the thread's
 * branch goes back to what it held before that import (removed when it held nothing), only while it still holds this
 * import's candidate. A branch someone moved is left and said.
 */
export async function removeFlexibleImportRefs(store: Store, input: { thread: string; seq: number; candidate: string; branchBefore: string | null; runner?: Runner }):
  Promise<{ ok: true } | FlexibleImportRefusal> {
  if (!FLEXIBLE_AVAILABLE) return pre("not-available");
  const locked = await withFlexibleThreadLock(input.thread, async (): Promise<{ ok: true } | FlexibleImportRefusal> => {
    const thread = flexibleThread(store, input.thread);
    if (thread === null) return pre("thread-unknown");
    if (!SHA.test(input.candidate) || (input.branchBefore !== null && !SHA.test(input.branchBefore))) return refused("unreadable");
    let project: string;
    try { project = realpathSync(thread.repo); recordedCommonDir(project); } catch { return pre("repository-unusable"); }
    const inner = input.runner ?? run;
    const read = gitIn(inner, "read"), build = gitIn(inner, "build");
    const branch = `refs/heads/${flexibleThreadBranch(thread.id)}`;
    const current = await read(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", branch]);
    if (current.code !== 0 || current.stdout.trim() !== input.candidate) return refused("branch-moved");
    const back = input.branchBefore === null ? await build(project, ["update-ref", "--no-deref", "-d", branch, input.candidate])
      : await build(project, ["update-ref", "--no-deref", "-m", "toolroll: Flexible import removed", branch, input.branchBefore, input.candidate]);
    if (back.code !== 0) return refused("branch-moved");
    await build(project, ["update-ref", "--no-deref", "-d", flexibleImportRef(thread.id, input.seq), input.candidate]);
    return { ok: true };
  });
  if (locked.ok === false && (locked.reason === "not-available" || locked.reason === "thread-unknown")) return pre(locked.reason);
  return locked as { ok: true } | FlexibleImportRefusal;
}

/**
 * Make (create-only) or take back (compare-and-swap) a check task's branch in a thread's project at the thread's base:
 * the Ship's verify-only task starts there and installs the imported candidate as its prepared commit (builder.ts),
 * never anything newer.
 */
export async function flexibleTaskBranch(store: Store, input: { thread: string; branch: string; at: string; make: boolean; runner?: Runner }): Promise<boolean> {
  if (!FLEXIBLE_AVAILABLE) return false;
  const thread = flexibleThread(store, input.thread);
  if (thread === null || !SHA.test(input.at) || !/^toolroll\/flexible-[0-9a-f]{32}$/.test(input.branch)) return false;
  let project: string;
  try { project = realpathSync(thread.repo); recordedCommonDir(project); } catch { return false; }
  const build = gitIn(input.runner ?? run, "build");
  const ref = `refs/heads/${input.branch}`;
  const done = input.make ? await build(project, ["update-ref", "--no-deref", "--create-reflog", "-m", "toolroll: Flexible check task", ref, input.at, "0".repeat(input.at.length)])
    : await build(project, ["update-ref", "--no-deref", "-d", ref, input.at]);
  return done.code === 0;
}
