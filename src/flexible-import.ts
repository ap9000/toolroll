/**
 * The controlled import for Flexible threads, slice F4 (the Flexible plan v2 §1 "Controlled import (the only road into
 * the real repository)", with Codex round 2's required change 6 and the F2 breakdown's enable gate 2, binding): how a
 * thread's committed work enters the project's repository, and nothing else does.
 *
 * The rules this module keeps:
 * - Nothing here checks the interactive agent threads' switch (flexible-available.ts): inspecting a thread's candidate
 *   and the quarantined import of it are a person's recovery of past work, allowed while threads are off. What grants
 *   anything after it (arming a Ship, its merge) checks the switch in its own transaction (flexible-ship.ts).
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
 *   all; refused before anything else is checked), within the commit, object, per-file and on-disk limits; and then on
 *   EVERY commit between them, not just the net change (a later commit can't take back what an earlier one carries into
 *   the project's history): no submodule; none of Toolroll's placeholder files (the
 *   bytes flexible-thread.ts reserves protected names with: `git add -f` can commit one, so the thread's exclude list is
 *   no import boundary); no protected name (agent-fence.ts protectedChanges) and no link at one (protectedLinks); no
 *   link that leads out of the project or into a `.git`, resolved against that commit's tree following every link on
 *   the way; and the existing secret check on each commit's diff (evidence.ts scanPatchForSecrets). Each refusal says what it found, in words, and leaves the project's refs exactly as they were.
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
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { FLEXIBLE_UNAVAILABLE } from "./flexible.js";
import { flexibleProjectKnown, flexibleThread, flexibleThreadBranch, flexibleThreadPaths, withFlexibleThreadLock, type FlexibleThreadPaths, type FlexibleThreadRow } from "./flexible-thread.js";
import { readProjectRefs, refsChangedOutside, refSnapshotOf, saveRefSnapshot } from "./flexible-refs.js";
import { PROTECTED_FILES, protectedChanges, protectedLinks } from "./agent-fence.js";
import { scanPatchForSecrets } from "./evidence.js";
import { PROOF_LIMITS } from "./proof.js";
import { run, type ExecResult } from "./exec.js";
import { hardenedGit, recordedCommonDir } from "./teardown-git.js";
import type { Store } from "./store.js";
import type { Runner } from "./worktree.js";

// ---- refusals ---------------------------------------------------------------------------------------------------------

/** What the quarantine found, each said in words: the import is refused (`import-refused`) and no ref moved. */
export type FlexibleImportCheck = "candidate-unreadable" | "candidate-changed" | "nothing-to-send" | "not-descendant" | "merge" | "too-large" | "bad-path"
  | "submodule" | "placeholder" | "protected" | "symlink" | "secret" | "unreadable" | "import-exists" | "branch-moved" | "default-branch" | "fetch-failed"
  | "ambiguous" | "timed-out";
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
  "ambiguous": `Two names in the change are the same name on a computer that ignores case or accents. ${NOTHING}`,
  "timed-out": `Checking the change took longer than Toolroll allows for one import. ${NOTHING}`,
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
  /** Entries in the thread's objects folder walked for links, counted as they are read. */
  objectEntries: 500_000,
  /** Everything new, uncompressed, summed object by object. */
  inflatedBytes: 512 * 1024 * 1024,
  /** Entries in one commit's whole tree, as listed for names and links (bounded while it is listed). */
  treeEntries: 200_000,
  /** The whole import: every check and the fetch, one deadline. */
  importMs: 300_000,
});
export type FlexibleImportLimits = { readonly [K in keyof typeof FLEXIBLE_IMPORT_LIMITS]: number };
const limitsOf = (over: Partial<FlexibleImportLimits> | undefined): FlexibleImportLimits => ({ ...FLEXIBLE_IMPORT_LIMITS, ...(over ?? {}) });

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

type Git = (cwd: string, args: readonly string[], options?: { maxBuffer?: number; timeoutMs?: number; stdin?: string }) => Promise<ExecResult>;
/** The import's one deadline passed (every check and the fetch share it). */
class DeadlinePassed extends Error {}
/** Fixed on every import git call, ahead of its own arguments: no replace refs, and no commit graph or multi-pack index
 * trusted (one in the thread's objects folder could lie about parents). */
const IMPORT_FLAGS: readonly string[] = ["--no-replace-objects", "-c", "core.commitGraph=false", "-c", "core.multiPackIndex=false"];
/** The shared hardened runner (teardown-git.ts), bound to the repository it runs in: the quarantine or the project. */
function gitIn(inner: Runner, mode: "build" | "read", deadline = Number.POSITIVE_INFINITY): Git {
  return async (cwd, args, options = {}) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new DeadlinePassed("the import's time ran out");
    const ran = await hardenedGit(inner, mode, { repo: cwd })("git", [...IMPORT_FLAGS, ...args],
      { cwd, timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 60_000, left)), ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin, processGroup: true }) });
    if (ran.timedOut && Date.now() >= deadline) throw new DeadlinePassed("the import's time ran out");
    return ran;
  };
}

// ---- names as a filesystem sees them ------------------------------------------------------------------------------

/** Characters HFS+ ignores in a name (git's own protectHFS list). */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/** One path component as a case-insensitive, normalising filesystem (macOS, Windows) sees it: NFC, no characters HFS+
 * ignores, lower case, no trailing dots or spaces (Windows drops them). Two names that fold alike are one name there. */
export function foldName(part: string): string {
  return part.normalize("NFC").replace(HFS_IGNORABLE, "").toLowerCase().replace(/[. ]+$/, "");
}
const foldPath = (path: string): string => path.split("/").map(foldName).join("/");

// ---- the thread's side, read as plain bytes ---------------------------------------------------------------------------

type Source = { thread: FlexibleThreadRow; project: string; objects: string; paths: FlexibleThreadPaths; threadObjects: string; format: "sha1" | "sha256" };

/** Why the thread's objects folder isn't the plain one Toolroll made, or null: its repository a plain one (its own
 * `.git` folder, no commondir, no reftable), its objects folder a real folder whose alternates name exactly the
 * project's objects and nothing over HTTP, and nothing in it a link or anything but a file or folder (a link would lead
 * the quarantine to another project's objects). */
/** The largest alternates file Toolroll reads (the one it writes is a single path): anything bigger isn't its own. */
const ALTERNATES_MAX = 4096;
/** threadObjectsProblem's answer when the import's deadline passed while it walked. */
const WALK_TIMED_OUT = "the import's time ran out while its objects were walked";

function threadObjectsProblem(paths: FlexibleThreadPaths, recorded: string, objects: string, limits: FlexibleImportLimits, deadline: number): string | null {
  if (recorded !== paths.folder) return "its record names another folder";
  if (!ownFolder(paths.root) || !ownFolder(paths.folder)) return "its folder isn't a private folder of yours";
  const gitdir = join(paths.repo, ".git");
  const threadObjects = join(gitdir, "objects");
  if (!plainDir(paths.repo) || !plainDir(gitdir) || !plainDir(threadObjects)) return "its repository isn't a plain one";
  if (existsSync(join(gitdir, "commondir")) || existsSync(join(gitdir, "reftable"))) return "its repository isn't a plain one";
  try { if (realpathSync(threadObjects) !== join(realpathSync(paths.folder), "repo", ".git", "objects")) return "its objects folder isn't its own"; } catch { return "its objects folder can't be read"; }
  // The alternates file read with a bound and without following a link: never read whole when it's bigger than the
  // one path Toolroll wrote.
  try {
    const alternates = join(threadObjects, "info", "alternates");
    const held = lstatSync(alternates);
    if (!held.isFile() || held.isSymbolicLink()) return "its alternates changed";
    if (held.size > ALTERNATES_MAX) return "its alternates file is too large to be the one Toolroll wrote";
    const fd = openSync(alternates, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > ALTERNATES_MAX) return "its alternates file is too large to be the one Toolroll wrote";
      const bytes = Buffer.alloc(ALTERNATES_MAX + 1);
      const read = readSync(fd, bytes, 0, bytes.length, 0);
      if (read > ALTERNATES_MAX || bytes.subarray(0, read).toString("utf8") !== `${objects}\n`) return "its alternates changed";
    } finally { closeSync(fd); }
  } catch { return "its alternates can't be read"; }
  if (existsSync(join(threadObjects, "info", "http-alternates"))) return "it borrows objects over the network";
  // Walked one entry at a time, counting as it goes: a folder too big to list is refused before it is listed whole.
  let seen = 0;
  const folders = [threadObjects];
  while (folders.length > 0) {
    const folder = folders.pop()!;
    let handle: import("node:fs").Dir;
    try { handle = opendirSync(folder); } catch { return "its objects can't be listed"; }
    try {
      for (let one = handle.readSync(); one !== null; one = handle.readSync()) {
        if (++seen > limits.objectEntries) return "it holds too many object files";
        // The import's one deadline holds here too: a walk that runs past it stops.
        if (Date.now() >= deadline) return WALK_TIMED_OUT;
        if (one.isDirectory()) folders.push(join(folder, one.name));
        else if (!one.isFile()) return `its objects folder has a link or special file (${join(folder, one.name).slice(threadObjects.length + 1)})`;
      }
    } catch { return "its objects can't be listed"; }
    finally { handle.closeSync(); }
  }
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
function sourceOf(store: Store, id: string, limits: FlexibleImportLimits, deadline: number): Source | FlexibleImportRefusal {
  const thread = flexibleThread(store, id);
  if (thread === null) return pre("thread-unknown");
  if (thread.state !== "ready") return pre("thread-not-ready");
  if (!flexibleProjectKnown(store, thread.repo)) return pre("not-a-project");
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
  const problem = threadObjectsProblem(paths, thread.folder, objects, limits, deadline);
  if (problem === WALK_TIMED_OUT) return refused("timed-out");
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
export async function readFlexibleCandidate(store: Store, input: { thread: string; runner?: Runner; limits?: Partial<FlexibleImportLimits> }):
  Promise<{ ok: true; candidate: string; base: string; changedPaths: string[] } | FlexibleImportRefusal> {
  const limits = limitsOf(input.limits);
  const deadline = Date.now() + limits.importMs;
  const source = sourceOf(store, input.thread, limits, deadline);
  if ("ok" in source) return source;
  const candidate = threadBranchTip(source.paths, source.thread.id);
  if (candidate === null || candidate.length !== source.thread.baseSha.length) return refused("candidate-unreadable");
  if (candidate === source.thread.baseSha) return refused("nothing-to-send");
  const read = gitIn(input.runner ?? run, "read", deadline);
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
  try { return await work(); } catch (error) {
    if (error instanceof DeadlinePassed) return refused("timed-out");
    return refused("unreadable", error instanceof Error ? error.message.slice(0, 200) : undefined);
  }
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
    if (foldName(part) === ".git") return true;
    parts.push(part);
  }
  return false;
}

/** `log --raw -z --format=commit:%H` output, parsed strictly into each commit's own changes; null when it isn't
 * exactly that. */
function parseRawLog(stdout: string): { commit: string; entries: DiffEntry[] }[] | null {
  const fields = stdout.split("\0").map(field => field.replace(/^\n/, ""));
  if (fields.at(-1) === "") fields.pop();
  const commits: { commit: string; entries: DiffEntry[] }[] = [];
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at]!;
    const header = /^commit:([0-9a-f]{40}|[0-9a-f]{64})$/.exec(field);
    if (header !== null) { commits.push({ commit: header[1]!, entries: [] }); continue; }
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([ADMT])$/.exec(field);
    const path = fields[at + 1];
    if (meta === null || path === undefined || commits.length === 0) return null;
    commits.at(-1)!.entries.push({ oldMode: meta[1]!, newMode: meta[2]!, oldSha: meta[3]!, newSha: meta[4]!, status: meta[5]!, path });
    at++;
  }
  return commits;
}

type TreeEntry = { path: string; mode: string; sha: string };

/**
 * One commit's whole tree (folders included), keyed by each path as a case-insensitive, normalising filesystem sees it
 * (foldName), listed with a bound on its size while it is listed. Refuses two entries that are one name there (`a` and
 * `A`, an NFC and an NFD spelling): such a tree checks out as something else than what was checked.
 */
async function treeOf(read: Git, repo: string, commit: string, limits: FlexibleImportLimits): Promise<Map<string, TreeEntry> | FlexibleImportRefusal> {
  const listed = await read(repo, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit], { maxBuffer: limits.treeEntries * 160 });
  if (listed.code !== 0) return listed.stdout.length >= limits.treeEntries * 150 ? refused("too-large", "its tree has too many entries") : refused("unreadable", "its tree couldn't be listed");
  const tree = new Map<string, TreeEntry>();
  const entries = listed.stdout.split("\0").filter(one => one !== "");
  if (entries.length > limits.treeEntries) return refused("too-large", "its tree has too many entries");
  for (const entry of entries) {
    const found = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
    if (found === null) return refused("unreadable", "its tree couldn't be read");
    const path = found[4]!, folded = foldPath(path);
    const other = tree.get(folded);
    if (other !== undefined && other.path !== path) return refused("ambiguous", `${other.path} and ${path}, in commit ${commit.slice(0, 12)}`);
    tree.set(folded, { path, mode: found[1]!, sha: found[3]! });
  }
  return tree;
}

/** The first of `links` (paths of links in a commit's tree) that leads out of the tree or into a `.git`, resolved
 * against that tree and following every link on the way (links already there and links the same change adds), each
 * name looked up as a case-insensitive, normalising filesystem would; or null when none does. A name that matches only
 * when folded (`EXT` for `ext`), a chain longer than 40 steps, or a target that can't be read, counts as leading out. */
async function linkEscaping(read: Git, repo: string, tree: ReadonlyMap<string, TreeEntry>, links: readonly string[]): Promise<string | null> {
  const targets = new Map<string, string | null>();
  const targetOf = async (entry: TreeEntry): Promise<string | null> => {
    if (!targets.has(entry.sha)) {
      const blob = await read(repo, ["cat-file", "blob", entry.sha], { maxBuffer: 8192 });
      targets.set(entry.sha, blob.code !== 0 || blob.stdout.length > 4096 ? null : blob.stdout);
    }
    return targets.get(entry.sha)!;
  };
  for (const link of links) {
    const entry = tree.get(foldPath(link));
    if (entry === undefined || entry.path !== link || entry.mode !== "120000") return link;
    const start = await targetOf(entry);
    if (start === null || linkLeadsOut(link, start)) return link;
    // Walk the resolved path one name at a time; a name that is itself a link is replaced by where it leads.
    const stack = link.split("/").slice(0, -1);
    let queue = start.split("/");
    let steps = 0;
    let escaped = false;
    while (queue.length > 0 && !escaped) {
      const part = queue.shift()!;
      if (part === "" || part === ".") continue;
      if (part === "..") { if (stack.length === 0) escaped = true; else stack.pop(); continue; }
      if (foldName(part) === ".git") { escaped = true; continue; }
      stack.push(part);
      const here = stack.join("/");
      const found = tree.get(foldPath(here));
      if (found === undefined) continue;
      // Only the same name when folded: on a case-insensitive or normalising filesystem it's that entry, so a check of
      // the spelling as written would be a check of something else.
      if (found.path !== here) { escaped = true; continue; }
      if (found.mode !== "120000") continue;
      if (++steps > 40) { escaped = true; continue; }
      const next = await targetOf(found);
      if (next === null || next === "" || /[\0\\]/.test(next) || isAbsolute(next) || /^[A-Za-z]:/.test(next)) { escaped = true; continue; }
      stack.pop();
      queue = [...next.split("/"), ...queue];
    }
    if (escaped) return link;
  }
  return null;
}

/** Every check, in the quarantine, before any ref moves: null when the candidate may be imported; else the refusal. */
async function quarantineChecks(read: Git, repo: string, source: Source, candidate: string, limits: FlexibleImportLimits): Promise<FlexibleImportRefusal | null> {
  const base = source.thread.baseSha;
  if (candidate === base) return refused("nothing-to-send");
  const lineage = await descends(read, repo, base, candidate);
  if (lineage !== null) return lineage;
  // No merge commit between the base and the candidate: one would bring history from outside the thread, and a change
  // made only inside a merge has no diff of its own. Refused here, before any per-commit check, never skipped.
  const merges = await read(repo, ["rev-list", "--min-parents=2", "--max-count=1", `${base}..${candidate}`]);
  if (merges.code !== 0) return refused("unreadable");
  if (merges.stdout.trim() !== "") return refused("merge", `commit ${merges.stdout.trim().slice(0, 12)}`);
  const counted = await read(repo, ["rev-list", "--count", `${base}..${candidate}`]);
  const commits = Number(counted.stdout.trim());
  if (counted.code !== 0 || !Number.isSafeInteger(commits)) return refused("unreadable");
  if (commits > limits.commits) return refused("too-large", `${commits} commits`);
  // Every new object, and no file past the per-file limit (rev-list names an omitted one with a leading ~). The listing
  // is bounded while it runs: past the object limit its output overflows and git is stopped.
  const objects = await read(repo, ["rev-list", "--objects", "--no-object-names", `--filter=blob:limit=${limits.blobBytes}`, "--filter-print-omitted", `${base}..${candidate}`],
    { maxBuffer: (limits.objects + 1) * 70 });
  if (objects.code !== 0) return refused(objects.stdout.length >= limits.objects * 41 ? "too-large" : "unreadable", "too many objects, or they couldn't be listed");
  const listed = objects.stdout.split("\n").filter(line => line !== "");
  if (listed.some(line => line.startsWith("~"))) return refused("too-large", `a file is over ${Math.round(limits.blobBytes / 1024 / 1024)} MB`);
  if (listed.length > limits.objects) return refused("too-large", `${listed.length} objects`);
  if (listed.some(line => !SHA.test(line))) return refused("unreadable");
  // Their sizes uncompressed, summed: a small pack can inflate to far more.
  if (listed.length > 0) {
    const sized = await read(repo, ["cat-file", "--batch-check=%(objectsize)"], { stdin: `${listed.join("\n")}\n`, maxBuffer: (listed.length + 1) * 24 });
    const sizes = sized.code === 0 ? sized.stdout.split("\n").filter(line => line !== "") : null;
    if (sizes === null || sizes.length !== listed.length || sizes.some(one => !/^\d{1,15}$/.test(one))) return refused("unreadable", "its objects' sizes couldn't be read");
    const inflated = sizes.reduce((sum, one) => sum + Number(one), 0);
    if (inflated > limits.inflatedBytes) return refused("too-large", `${Math.round(inflated / 1024 / 1024)} MB uncompressed`);
  }
  const disk = await read(repo, ["rev-list", "--objects", "--disk-usage", `${base}..${candidate}`]);
  const bytes = Number(disk.stdout.trim());
  if (disk.code !== 0 || !Number.isSafeInteger(bytes)) return refused("unreadable");
  if (bytes > limits.diskBytes) return refused("too-large", `${Math.round(bytes / 1024 / 1024)} MB`);
  // The net change (what the terms show): bounded, every name importable.
  const net = await changedEntries(read, repo, base, candidate);
  if (!Array.isArray(net)) return net;
  const netSubmodule = net.find(one => one.status !== "D" && one.newMode === "160000");
  if (netSubmodule !== undefined) return refused("submodule", netSubmodule.path);
  // Then EVERY commit between the base and the candidate, not just the net change: a later commit can't take back what
  // an earlier one carries into the project's history (a key, a protected file, a link, a submodule).
  // Belts: every commit's diff against its first parent (a merge, were one to get here, shows its own change), and the
  // commits seen must be exactly the range's, in order, each with its own diff.
  const range = await read(repo, ["rev-list", "--reverse", `${base}..${candidate}`], { maxBuffer: (limits.commits + 1) * 70 });
  const inRange = range.code === 0 ? range.stdout.split("\n").filter(line => line !== "") : null;
  if (inRange === null || inRange.length !== commits || inRange.some(one => !SHA.test(one))) return refused("unreadable", "its commits couldn't be listed");
  const logged = await read(repo, ["log", "--reverse", "--no-renames", "--diff-merges=first-parent", "--ignore-submodules=none", "--raw", "-z", "--no-abbrev", "--format=commit:%H", `${base}..${candidate}`], { maxBuffer: 64 * 1024 * 1024 });
  const perCommit = logged.code === 0 ? parseRawLog(logged.stdout) : null;
  if (perCommit === null || perCommit.length !== inRange.length || perCommit.some((one, at) => one.commit !== inRange[at])) return refused("unreadable", "its commits couldn't be listed one by one");
  const placeholders = placeholderBlobs(source.format);
  for (const { commit, entries } of perCommit) {
    const at = `in commit ${commit.slice(0, 12)}`;
    for (const one of entries) if (one.path === "" || Buffer.byteLength(one.path) > PROOF_LIMITS.changedPath || /[\x00-\x1f\x7f]/.test(one.path) || one.path.split("/").some(part => part === "" || part === "." || part === "..")) return refused("bad-path", at);
    const added = entries.filter(one => one.status !== "D");
    const submodule = added.find(one => one.newMode === "160000");
    if (submodule !== undefined) return refused("submodule", `${submodule.path}, ${at}`);
    // Placeholder bytes before the protected-name rule, so the words say what it is.
    const placeholder = added.find(one => PLACEHOLDER_NAMES.has(one.path) && placeholders.has(one.newSha));
    if (placeholder !== undefined) return refused("placeholder", `${placeholder.path}, ${at}`);
    // Names as a case-insensitive, normalising filesystem sees them: `.GIT`, `.git.` and `.Git<zero-width>` are `.git`.
    const gitNamed = entries.find(one => one.path.split("/").some(part => foldName(part) === ".git"));
    if (gitNamed !== undefined) return refused("protected", `${gitNamed.path}, ${at}`);
    const named = protectedChanges(entries.map(one => foldPath(one.path)));
    if (named.length > 0) return refused("protected", `${named.slice(0, 3).join(", ")}, ${at}`);
    const links = added.filter(one => one.newMode === "120000");
    const linkedProtected = protectedLinks(links.map(one => foldPath(one.path)));
    if (linkedProtected.length > 0) return refused("protected", `${linkedProtected.slice(0, 3).join(", ")}, ${at}`);
    if (links.length > 0) {
      const tree = await treeOf(read, repo, commit, limits);
      if (!(tree instanceof Map)) return tree;
      const escaping = await linkEscaping(read, repo, tree, links.map(one => one.path));
      if (escaping !== null) return refused("symlink", `${escaping}, ${at}`);
    }
  }
  // The existing secret check (evidence.ts), on every commit's own diff: only added lines count; documented
  // placeholders aren't keys.
  const patch = await read(repo, ["log", "-p", "--reverse", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--diff-merges=first-parent", "--ignore-submodules=none", "--format=commit %H", `${base}..${candidate}`], { maxBuffer: limits.patchBytes });
  if (patch.code !== 0) return refused(patch.stdout.length >= limits.patchBytes ? "too-large" : "unreadable", "its commits' diffs couldn't be read whole");
  const patched = [...patch.stdout.matchAll(/^commit ([0-9a-f]{40}|[0-9a-f]{64})$/gm)].map(match => match[1]!);
  if (patched.length !== inRange.length || patched.some((one, at) => one !== inRange[at])) return refused("unreadable", "its commits' diffs couldn't be read one by one");
  const hits = scanPatchForSecrets(patch.stdout);
  if (hits.length > 0) return refused("secret", hits.slice(0, 3).map(hit => `${hit.file}:${hit.fileLine} (${hit.name})`).join(", "));
  // The candidate's whole tree, as it will be checked out: no two names that are one name on macOS or Windows.
  const whole = await treeOf(read, repo, candidate, limits);
  if (!(whole instanceof Map)) return whole;
  // Only after every commit was checked: a history whose net change is empty still carried what it carried.
  if (net.length === 0) return refused("nothing-to-send");
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
export async function importFlexibleCandidate(store: Store, input: { thread: string; seq: number; expected: string; branchBefore: string | null; by: string; now: Date; runner?: Runner;
  /** A test seam (a parameter, never a setting): tighter limits than FLEXIBLE_IMPORT_LIMITS. */
  limits?: Partial<FlexibleImportLimits> }):
  Promise<FlexibleImported | FlexibleImportRefusal> {
  const locked = await withFlexibleThreadLock(input.thread, () => guarded(() => importLocked(store, input)));
  if (locked.ok === false && (locked.reason === "not-available" || locked.reason === "thread-unknown")) return pre(locked.reason);
  return locked as FlexibleImported | FlexibleImportRefusal;
}

async function importLocked(store: Store, input: { thread: string; seq: number; expected: string; branchBefore: string | null; by: string; now: Date; runner?: Runner; limits?: Partial<FlexibleImportLimits> }): Promise<FlexibleImported | FlexibleImportRefusal> {
  const limits = limitsOf(input.limits);
  // One deadline for the whole import: every check in the quarantine and the fetch.
  const deadline = Date.now() + limits.importMs;
  if (!Number.isSafeInteger(input.seq) || input.seq < 1 || !SHA.test(input.expected) || (input.branchBefore !== null && !SHA.test(input.branchBefore))) return refused("unreadable", "the import's own terms aren't valid");
  const source = sourceOf(store, input.thread, limits, deadline);
  if ("ok" in source) return source;
  const inner = input.runner ?? run;
  const read = gitIn(inner, "read", deadline), build = gitIn(inner, "build", deadline);
  const candidate = threadBranchTip(source.paths, source.thread.id);
  if (candidate === null || candidate.length !== source.thread.baseSha.length) return refused("candidate-unreadable");
  if (candidate !== input.expected) return refused("candidate-changed");
  const importRef = flexibleImportRef(source.thread.id, input.seq);
  const branch = flexibleThreadBranch(source.thread.id);
  const zero = "0".repeat(candidate.length);
  return withQuarantine(source, async repo => {
    const problem = await quarantineChecks(read, repo, source, candidate, limits);
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
    // From the fetch on, the writes and clean-ups always finish (no deadline cuts them off half way): a fetch the deadline
    // stopped is read back and taken away like a failed one.
    const settle = gitIn(inner, "read"), finish = gitIn(inner, "build");
    let fetched: ExecResult | null = null;
    try {
      fetched = await build(source.project, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "-c", "fetch.writeCommitGraph=false",
        "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", `--negotiation-tip=${source.thread.baseSha}`, "--", repo, `refs/heads/candidate:${importRef}`],
        { timeoutMs: limits.fetchMs });
    } catch (error) { if (!(error instanceof DeadlinePassed)) throw error; }
    const landed = await settle(source.project, ["rev-parse", "--verify", "--quiet", "--end-of-options", importRef]);
    if (fetched === null || fetched.code !== 0 || landed.code !== 0 || landed.stdout.trim() !== candidate) {
      if (landed.code === 0) await finish(source.project, ["update-ref", "--no-deref", "-d", importRef, landed.stdout.trim()]);
      return refused(fetched === null ? "timed-out" : "fetch-failed");
    }
    const moved = await finish(source.project, ["update-ref", "--no-deref", "-m", `toolroll: Flexible import ${input.seq}`, `refs/heads/${branch}`, candidate, input.branchBefore ?? zero]);
    if (moved.code !== 0) {
      await finish(source.project, ["update-ref", "--no-deref", "-d", importRef, candidate]);
      return refused("branch-moved");
    }
    const after = await readProjectRefs(settle, source.project);
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

/**
 * Settle an import a crash interrupted (the Ship's reconciler, under the thread's lock, for a send left `approved`): its
 * import ref goes when it holds exactly this import's candidate, and the thread's branch goes back to what it held
 * before (removed when it held nothing) when it holds exactly this candidate. Each by compare-and-swap; a ref someone
 * else moved is left as it is and said.
 */
export async function settleInterruptedImport(store: Store, input: { thread: string; seq: number; candidate: string; branchBefore: string | null; runner?: Runner }):
  Promise<{ ok: true; importRef: "removed" | "absent" | "moved"; branch: "restored" | "untouched" | "moved" } | FlexibleImportRefusal> {
  const thread = flexibleThread(store, input.thread);
  if (thread === null) return pre("thread-unknown");
  if (!SHA.test(input.candidate) || (input.branchBefore !== null && !SHA.test(input.branchBefore))) return refused("unreadable");
  let project: string;
  try { project = realpathSync(thread.repo); recordedCommonDir(project); } catch { return pre("repository-unusable"); }
  const inner = input.runner ?? run;
  const read = gitIn(inner, "read"), build = gitIn(inner, "build");
  const value = async (ref: string) => { const out = await read(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]); return out.code === 0 ? out.stdout.trim() : null; };
  const importRef = flexibleImportRef(thread.id, input.seq);
  const branch = `refs/heads/${flexibleThreadBranch(thread.id)}`;
  const heldImport = await value(importRef);
  let importState: "removed" | "absent" | "moved" = heldImport === null ? "absent" : "moved";
  if (heldImport === input.candidate && (await build(project, ["update-ref", "--no-deref", "-d", importRef, input.candidate])).code === 0) importState = "removed";
  const heldBranch = await value(branch);
  let branchState: "restored" | "untouched" | "moved" = heldBranch === input.branchBefore ? "untouched" : "moved";
  if (heldBranch === input.candidate && input.candidate !== input.branchBefore) {
    const back = input.branchBefore === null ? await build(project, ["update-ref", "--no-deref", "-d", branch, input.candidate])
      : await build(project, ["update-ref", "--no-deref", "-m", "toolroll: interrupted Flexible import put back", branch, input.branchBefore, input.candidate]);
    if (back.code === 0) branchState = "restored";
  }
  return { ok: true, importRef: importState, branch: branchState };
}
