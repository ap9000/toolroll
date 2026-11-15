/**
 * Flexible threads, slice F2a (the Flexible plan v2 §1 and §2, with Codex round 2's required change 3, binding): each
 * thread's own repository, the ref that keeps its base alive in the project's repository, and the fence every thread
 * launch runs in.
 *
 * The rules this module keeps:
 * - Nothing here works while FLEXIBLE_AVAILABLE is false (flexible-available.ts): every entry point refuses with
 *   `not-available` before it reads or writes anything.
 * - A thread never writes the person's repository. Toolroll (outside any fence, with the hardened git runner) makes
 *   `<state>/threads/<id>/repo`: a fresh repository, not a worktree, with no remotes, whose objects/info/alternates
 *   names the project's real `objects` folder, on branch `toolroll/code-<id>` at the recorded base. Its new objects
 *   land in its own `objects`. The only write to the project's repository is Toolroll's own create-only keep-ref
 *   (refs/toolroll/threads/<id>/base), so a person's `gc` can't prune the base; removing the thread removes it by
 *   compare-and-swap. Import into the project's repository is a later slice (F4), never the thread.
 * - Every path comes from Toolroll's own records (the flexible_thread row, the store's project list, the database's
 *   folder), resolved with realpath and proven to be the real folders they were; the thread's folder is attacker input
 *   once a thread has run in it.
 * - The thread fence is the agent fence (agent-fence.ts fenceFor), with what a thread must never have taken away: no
 *   keychain, no network but the run's proxy, credential paths and every provider's sign-in denied by name, Toolroll's
 *   state, every checkout pool and every other thread denied, the project's repository denied but its `objects`
 *   (read-only), other registered projects denied, and writes only to the thread's repository, temp and cache. Full
 *   access never widens it: it is the same fence at every level, and it covers everything the agent starts.
 * - Containment that can't be had refuses: the spawn goes through exec.ts `confined` (no sandbox here: nothing runs,
 *   and the unconfined-agents setting is never consulted), the launch's own terms are checked (no keychain, proxy
 *   only), and a probe runs in exactly those terms first and must be refused Toolroll's canaries, or the thread doesn't
 *   start.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { FLEXIBLE_UNAVAILABLE } from "./flexible.js";
import { buildCacheEnv, fenceFor, FLEXIBLE_THREADS_DIR, grantFolder, PROTECTED_DIRS, PROTECTED_FILES, runFolders, srtTermsOf, type FenceGrants, type LaunchFence, type TaskBoundary } from "./agent-fence.js";
import { ACP_AGENTS, ACP_PROVIDER_IDS } from "./acp-agents.js";
import { confined, ContainmentRefusal, run } from "./exec.js";
import type { ProtectedStorage } from "./protected-storage.js";
import { SANDBOX_LAUNCH_SPEC, SEATBELT_NO_KEYCHAIN, type SandboxLaunchSpec } from "./sandbox-runtime.js";
import { hardenedGit, lazyFetchSetting, recordedCommonDir } from "./teardown-git.js";
import { withCheckoutLock } from "./git-views.js";
import { processMayBeAlive } from "./process-liveness.js";
import { startIdentityOf, type CustodyIO } from "./flexible-custody.js";
import type { FlexibleClock } from "./flexible-turns.js";
import { defaultCustodyIO, holdLaunch, recordGateShut, recordLive, recordNeverStarted, recordSpawning, settleLaunch, unsettledLaunch, type FlexibleLaunchMeta, type SettleResult } from "./flexible-launch.js";
import { projectRowKnown, type Store } from "./store.js";
import { poolRootOf, type Runner } from "./worktree.js";

// ---- records ----------------------------------------------------------------------------------------------------------

export const FLEXIBLE_THREAD_ID = /^[0-9a-f]{32}$/;
export type FlexibleThreadState = "preparing" | "ready" | "removing" | "removed" | "failed";
export type FlexibleThreadRow = { id: string; repo: string; baseSha: string; keepRef: string; folder: string; createdBy: string; createdAt: string; state: FlexibleThreadState; endedAt: string | null; endDetail: string | null;
  /** The process group leader of the thread's last launch, registered as it was spawned; null when none was. */
  livePid: number | null };

/** The ref in the project's repository that keeps a thread's base alive. */
export const flexibleKeepRef = (id: string): string => `refs/toolroll/threads/${id}/base`;
/** The thread's branch, in its own repository (and, once imported in F4, in the project's). */
export const flexibleThreadBranch = (id: string): string => `toolroll/code-${id}`;

/** A thread's folders, all under the state folder's `threads`: its repository (the agent's working folder), its own
 * temp and package caches, and the agent's configuration home (read-only to the thread: what is there is launch
 * configuration Toolroll writes). */
export type FlexibleThreadPaths = { root: string; folder: string; repo: string; tmp: string; cache: string; home: string };
export function flexibleThreadPaths(state: string, id: string): FlexibleThreadPaths {
  const root = join(state, FLEXIBLE_THREADS_DIR);
  const folder = join(root, id);
  return { root, folder, repo: join(folder, "repo"), tmp: join(folder, "tmp"), cache: join(folder, "cache"), home: join(folder, "home") };
}

function readThread(row: Record<string, unknown> | undefined): FlexibleThreadRow | null {
  if (row === undefined) return null;
  return { id: String(row["id"]), repo: String(row["repo"]), baseSha: String(row["base_sha"]), keepRef: String(row["keep_ref"]), folder: String(row["folder"]), createdBy: String(row["created_by"]),
    createdAt: String(row["created_at"]), state: String(row["state"]) as FlexibleThreadState, endedAt: row["ended_at"] === null ? null : String(row["ended_at"]),
    endDetail: row["end_detail"] === null ? null : String(row["end_detail"]), livePid: row["live_pid"] === null || row["live_pid"] === undefined ? null : Number(row["live_pid"]) };
}

/** The thread's record, or null (an id that isn't one is never looked up). */
export function flexibleThread(store: Store, id: string): FlexibleThreadRow | null {
  if (!FLEXIBLE_THREAD_ID.test(id)) return null;
  return readThread(store.handle.prepare("SELECT * FROM flexible_thread WHERE id = ?").get(id) as Record<string, unknown> | undefined);
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type FlexibleThreadRefusalReason = "not-available" | "no-state-folder" | "not-a-project" | "repository-unusable" | "base-unknown" | "setup-failed"
  | "thread-unknown" | "thread-not-ready" | "thread-folder-changed" | "network-required" | "containment" | "thread-running" | "codex-unsupported";
export type FlexibleThreadRefusal = { ok: false; reason: FlexibleThreadRefusalReason; message: string };

const WORDS: Readonly<Record<FlexibleThreadRefusalReason, string>> = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "no-state-folder": "Toolroll has no state folder to keep the thread's repository in, so no thread was started.",
  "not-a-project": "That folder isn't a project in Toolroll, so no thread was started.",
  "repository-unusable": "This project's repository can't hold a thread safely, so no thread was started.",
  "base-unknown": "The starting commit couldn't be found in this project's repository, so no thread was started.",
  "setup-failed": "The thread's repository couldn't be made. Nothing was left behind.",
  "thread-unknown": "There's no such thread.",
  "thread-not-ready": "This thread's repository isn't ready, so it can't run.",
  "thread-folder-changed": "This thread's folder isn't the one Toolroll made, so it can't run.",
  "network-required": "A thread can only run through its own network proxy, and it wasn't given one.",
  "containment": "The sandbox couldn't hold this thread, so it didn't run.",
  "thread-running": "This thread's agent may still be running, so its repository was left as it is.",
  "codex-unsupported": "Codex's own sandbox can't keep a Flexible thread away from threads and files made after it starts, so a Codex thread can't run in it.",
});
const refuse = (reason: FlexibleThreadRefusalReason, detail?: string): FlexibleThreadRefusal =>
  ({ ok: false, reason, message: detail === undefined ? WORDS[reason] : `${WORDS[reason]} (${detail})` });

// ---- paths and git ------------------------------------------------------------------------------------------------------

const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (child: string, parent: string): boolean => { const rel = relative(parent, child); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };

/** The state folder beside the database, as its real path; null for an in-memory store. */
function stateFolderOf(store: Store): string | null {
  const file = store.databaseFile();
  if (file === null || file === "" || file === ":memory:") return null;
  try { return dirname(realpathSync(file)); } catch { return null; }
}

/** A folder of this user's own, really itself: not a link, nor reached through one, owner-only. */
function ownFolder(path: string): boolean {
  try {
    const held = lstatSync(path);
    const uid = process.getuid?.();
    return held.isDirectory() && !held.isSymbolicLink() && (uid === undefined || held.uid === uid) && (held.mode & 0o077) === 0 && realpathSync(path) === join(realpathSync(dirname(path)), basename(path));
  } catch { return false; }
}

/** The threads root beside the database: made owner-only if absent, then proven a private folder of this user's. */
function ensureThreadsRoot(state: string): string {
  const root = join(state, FLEXIBLE_THREADS_DIR);
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!ownFolder(root)) throw new Error(`${root} isn't a private folder of yours`);
  return root;
}

/** Git for Toolroll's own setup of a fresh, empty folder it just made: no system or global config, no template, no
 * hooks, no network. Only `init` runs this way; every other git goes through the shared hardened runner. */
function freshInit(repo: string, branch: string): void {
  const ran = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "init", "-q", "--template=", "-b", branch, repo], {
    cwd: dirname(repo), encoding: "utf8", timeout: 30_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C" },
  });
  if (ran.status !== 0) throw new Error(`git init failed${ran.stderr ? `: ${ran.stderr.trim().slice(0, 200)}` : ""}`);
}

type Git = (cwd: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
/** The shared hardened runner (teardown-git.ts), bound to the repository it runs in (the project's from its record, or
 * the thread's own), with replace refs off. */
function gitIn(inner: Runner, mode: "build" | "read"): Git {
  return async (cwd, args) => hardenedGit(inner, mode, { repo: cwd })("git", ["--no-replace-objects", ...args], { cwd, timeoutMs: 60_000 });
}

/** What a base may be named as: a full commit id, or a branch or ref name that can't be read as an option. */
const BASE_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|(?!-)[A-Za-z0-9._/-]{1,200})$/;

/** The project's repository as a thread may read from it: its own real `.git` folder (no commondir, no link), not a
 * partial clone (objects fetched on demand would reach a remote), and no alternates of its own. Throws why not. */
async function usableRepository(repo: string, read: Git): Promise<{ common: string; objects: string }> {
  const common = recordedCommonDir(repo);
  const objects = join(common, "objects");
  if (!ownObjects(objects)) throw new Error("its objects folder isn't a real folder");
  if (existsSync(join(objects, "info", "alternates")) || existsSync(join(objects, "info", "http-alternates"))) throw new Error("it borrows objects from another repository");
  const listing = await read(repo, ["config", "--list", "--show-scope", "-z"]);
  if (listing.code !== 0) throw new Error("its git config couldn't be read");
  if (lazyFetchSetting(listing.stdout) !== null) throw new Error("it is a partial clone");
  return { common, objects: realpathSync(objects) };
}
const ownObjects = (path: string): boolean => { try { const held = lstatSync(path); return held.isDirectory() && !held.isSymbolicLink(); } catch { return false; } };

// ---- protected names -------------------------------------------------------------------------------------------------------

/** The names at a thread repository's top that a provider or the next tool run loads (agent-fence.ts PROTECTED_FILES
 * and PROTECTED_DIRS, less `.git`'s own, which the fence holds by their own names). */
const TOP_PROTECTED: readonly { name: string; dir: boolean }[] = [...PROTECTED_FILES.filter(name => !name.startsWith(".git/")).map(name => ({ name, dir: false })),
  ...PROTECTED_DIRS.filter(name => !name.startsWith(".git/")).map(name => ({ name, dir: true }))];

/** Whether every component of `name` under `top` is a real entry (no link anywhere on the way), and the last one is a
 * plain file (or folder for `dir`); "absent" when it isn't there at all. */
function protectedEntry(top: string, name: string, dir: boolean): "ok" | "absent" | "bad" {
  let at = top;
  const parts = name.split("/");
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    let held: import("node:fs").Stats;
    try { held = lstatSync(at); } catch { return "absent"; }
    const last = index === parts.length - 1;
    if (held.isSymbolicLink() || (!last && !held.isDirectory()) || (last && (dir ? !held.isDirectory() : !held.isFile()))) return "bad";
  }
  return "ok";
}

/**
 * Every protected name at the repository's top made present, so the fence can hold it read-only on every backend: a
 * sandbox holds an existing path read-only everywhere, but a missing one only on some (bubblewrap and Codex's own can't
 * keep a name that isn't there from being made). Each the project doesn't have becomes a reserved placeholder (an empty
 * file, `{}` for JSON, or an empty folder), listed in the thread's own .git/info/exclude so it never shows as work.
 * A project with a link (or a file where a folder belongs) at one of them is refused: the fence would hold the link's
 * target, not the name.
 */
function reserveProtectedNames(repo: string): void {
  const reserved: string[] = [];
  for (const { name, dir } of TOP_PROTECTED) {
    const found = protectedEntry(repo, name, dir);
    if (found === "bad") throw new Error(`the project has a link or an unexpected entry at ${name}`);
    if (found === "ok") continue;
    const path = join(repo, name);
    mkdirSync(dir ? path : dirname(path), { recursive: true, mode: 0o755 });
    if (protectedEntry(repo, name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ".", true) === "bad") throw new Error(`the project has a link on the way to ${name}`);
    if (!dir) writeFileSync(path, name.endsWith(".json") ? "{}\n" : "", { mode: 0o644, flag: "wx" });
    reserved.push(dir ? `/${name}/` : `/${name}`);
  }
  mkdirSync(join(repo, ".git", "info"), { recursive: true, mode: 0o755 });
  writeFileSync(join(repo, ".git", "info", "exclude"), ["# Toolroll: placeholders that hold protected names (flexible-thread.ts)", ...reserved, ""].join("\n"), { mode: 0o644, flag: "wx" });
}

// ---- making and removing a thread's repository -------------------------------------------------------------------------

/**
 * Make a thread's own repository for a registered project, at `base` (a commit id or a branch of the project's
 * repository, resolved there by Toolroll). Written in order: the record (preparing), the thread's folders, a fresh
 * repository with alternates to the project's objects, the keep-ref in the project's repository (create-only), the
 * thread's branch and its checkout, then the record ready. Any failure undoes what this call made (the keep-ref only
 * when this call made it) and ends the record failed. Who may start a thread and at what level is the start's own
 * check (F2c), made before this runs.
 */
export async function prepareFlexibleThread(store: Store, input: { repo: string; base: string; by: string; now: Date; runner?: Runner }):
  Promise<{ ok: true; thread: FlexibleThreadRow; paths: FlexibleThreadPaths } | FlexibleThreadRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const state = stateFolderOf(store);
  if (state === null) return refuse("no-state-folder");
  if (!projectRowKnown(store, input.repo)) return refuse("not-a-project");
  if (!BASE_NAME.test(input.base) || input.base.includes("..")) return refuse("base-unknown");
  const inner = input.runner ?? run;
  const read = gitIn(inner, "read");
  let project: string, objects: string;
  try { project = realpathSync(input.repo); ({ objects } = await usableRepository(project, read)); }
  catch (error) { return refuse("repository-unusable", error instanceof Error ? error.message : undefined); }
  const resolved = await read(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.base}^{commit}`]);
  const baseSha = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha)) return refuse("base-unknown");

  const id = randomBytes(16).toString("hex");
  const paths = flexibleThreadPaths(state, id);
  const keepRef = flexibleKeepRef(id);
  store.transact(() => {
    store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing')`)
      .run(id, input.repo, baseSha, keepRef, paths.folder, input.by, input.now.toISOString());
  });
  const zero = "0".repeat(baseSha.length);
  let madeFolder = false, madeRef = false;
  const build = gitIn(inner, "build");
  try {
    ensureThreadsRoot(state);
    mkdirSync(paths.folder, { mode: 0o700 }); // exclusive: a folder already there is never taken over
    madeFolder = true;
    for (const folder of [paths.repo, paths.tmp, paths.cache, paths.home]) mkdirSync(folder, { mode: 0o700 });
    freshInit(paths.repo, flexibleThreadBranch(id));
    const gitdir = join(paths.repo, ".git");
    // Held read-only in the fence on every platform, so present (an empty hooks folder: git init made none).
    mkdirSync(join(gitdir, "hooks"), { mode: 0o755 });
    mkdirSync(join(gitdir, "objects", "info"), { recursive: true, mode: 0o755 });
    writeFileSync(join(gitdir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o644, flag: "wx" });
    const kept = await build(project, ["update-ref", "--no-deref", "-m", "toolroll: keep a Flexible thread's base", keepRef, baseSha, zero]);
    if (kept.code !== 0) throw new Error("the project's repository refused the thread's keep-ref");
    madeRef = true;
    const branch = await build(paths.repo, ["update-ref", "--no-deref", `refs/heads/${flexibleThreadBranch(id)}`, baseSha, zero]);
    if (branch.code !== 0) throw new Error("the thread's branch couldn't be written");
    const checkout = await build(paths.repo, ["reset", "-q", "--hard", baseSha]);
    if (checkout.code !== 0) throw new Error("the thread's files couldn't be checked out");
    reserveProtectedNames(paths.repo);
    const ready = store.transact(() => {
      const moved = store.handle.prepare("UPDATE flexible_thread SET state = 'ready' WHERE id = ? AND state = 'preparing'").run(id);
      if (Number(moved.changes) !== 1) return false;
      store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: input.repo, taskId: null, runId: null, source: "policy", action: "flexible thread repository made", outcome: "ready",
        detail: `thread ${id} · base ${baseSha} · ${keepRef}` });
      return true;
    });
    if (!ready) throw new Error("the thread's record changed while it was being made");
    return { ok: true, thread: flexibleThread(store, id)!, paths };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (madeRef) await build(project, ["update-ref", "--no-deref", "-d", keepRef, baseSha]);
    if (madeFolder) rmSync(paths.folder, { recursive: true, force: true });
    store.transact(() => {
      store.handle.prepare("UPDATE flexible_thread SET state = 'failed', ended_at = ?, end_detail = ? WHERE id = ? AND state = 'preparing'").run(input.now.toISOString(), why.slice(0, 2000), id);
    });
    return refuse("setup-failed", why);
  }
}

/**
 * Remove a thread's repository: the record moves ready → removing, the keep-ref goes by compare-and-swap (only while it
 * still names the recorded base; a ref someone moved is left and said), the thread's folder goes (only the real folder
 * the record names, under the threads root), and the record ends removed. An agent still running refuses (stop it
 * first, stopFlexibleThreadAgent); processes a stopped or crashed launch left behind are found and stopped first, and
 * nothing is removed until the whole tree's exit is verified (F2c custody).
 */
export async function removeFlexibleThread(store: Store, input: { id: string; by: string; now: Date; runner?: Runner; io?: CustodyIO }): Promise<{ ok: true; keepRef: "removed" | "already-gone" | "moved" } | FlexibleThreadRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!FLEXIBLE_THREAD_ID.test(input.id)) return refuse("thread-unknown");
  // The thread's lock (withThreadLock), taken before anything else: a launch admitted, probed and spawned under it is
  // wholly before this removal (whose check then sees its process) or wholly after it (and finds the thread gone).
  return withThreadLock(input.id, () => removeLocked(store, input));
}

async function removeLocked(store: Store, input: { id: string; by: string; now: Date; runner?: Runner; io?: CustodyIO }): Promise<{ ok: true; keepRef: "removed" | "already-gone" | "moved" } | FlexibleThreadRefusal> {
  const state = stateFolderOf(store);
  if (state === null) return refuse("no-state-folder");
  const thread = flexibleThread(store, input.id);
  if (thread === null) return refuse("thread-unknown");
  // Custody first (F2c): an agent still running refuses (stop it first); a launch whose agent is gone but may have left
  // processes behind (a setsid or double-forked descendant, a crash) has them found and stopped, and its exit verified,
  // before anything is removed. Nothing of the thread's is removed while custody is unresolved.
  const paths = flexibleThreadPaths(state, thread.id);
  const launch = unsettledLaunch(store, thread.id);
  if (launch !== null) {
    const leaderRuns = launch.leaderPid !== null && launch.state === "live" && processMayBeAlive(launch.leaderPid, true);
    if (leaderRuns) return refuse("thread-running");
    const settled = await settleLaunch(store, { thread: thread.id, folder: paths.folder, reason: "the thread is being removed", stop: true, clock: () => input.now, ...(input.io === undefined ? {} : { io: input.io }) });
    if (!settled.ok) return refuse("thread-running", settled.why);
  }
  // A group registered without a launch record (a build before custody): its files stay while it may run.
  const after = flexibleThread(store, thread.id)!;
  if (after.livePid !== null && processMayBeAlive(after.livePid, true)) return refuse("thread-running");
  const claimed = store.transact(() => Number(store.handle.prepare("UPDATE flexible_thread SET state = 'removing', live_pid = NULL, live_since = NULL WHERE id = ? AND state IN ('ready', 'removing') AND live_pid IS ? AND NOT EXISTS (SELECT 1 FROM flexible_thread_launch WHERE thread = ? AND state <> 'exited')")
    .run(thread.id, after.livePid, thread.id).changes) === 1);
  if (!claimed) return refuse("thread-not-ready");
  const inner = input.runner ?? run;
  const build = gitIn(inner, "build"), read = gitIn(inner, "read");
  let keepRef: "removed" | "already-gone" | "moved" = "already-gone";
  let project: string | null = null;
  try { project = realpathSync(thread.repo); recordedCommonDir(project); } catch { project = null; }
  if (project !== null) {
    const removed = await build(project, ["update-ref", "--no-deref", "-d", thread.keepRef, thread.baseSha]);
    if (removed.code === 0) keepRef = "removed";
    else keepRef = (await read(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", thread.keepRef])).code === 0 ? "moved" : "already-gone";
  }
  // Only the folder the record names, as the real folder under the threads root it was made as: a link planted in its
  // place is removed as a link, never followed.
  if (thread.folder === paths.folder && ownFolder(paths.root)) rmSync(paths.folder, { recursive: true, force: true });
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_thread SET state = 'removed', ended_at = ?, end_detail = ? WHERE id = ? AND state = 'removing'")
      .run(input.now.toISOString(), keepRef === "moved" ? "the keep-ref had been moved by someone else and was left as it was" : null, thread.id);
    store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: thread.repo, taskId: null, runId: null, source: "policy", action: "flexible thread repository removed", outcome: "removed",
      detail: `thread ${thread.id} · keep-ref ${keepRef}` });
  });
  return { ok: true, keepRef };
}

// ---- the thread fence -----------------------------------------------------------------------------------------------------

/** Credentials at home, denied to every thread by name, present or not (plan §2): defense in depth beside the keychain
 * and SSH-agent denial, not the boundary. Each under `.config/` also under $XDG_CONFIG_HOME. */
export const THREAD_CREDENTIAL_PATHS: readonly string[] = Object.freeze([
  ".ssh", ".aws", ".config/gh", ".git-credentials", ".netrc", ".docker/config.json", ".npmrc", ".pypirc", ".kube", ".gnupg",
  ".config/gcloud", ".azure", ".oci", ".config/doctl", ".terraform.d/credentials.tfrc.json", ".cargo/credentials", ".cargo/credentials.toml",
  ".gem/credentials", ".m2/settings.xml", ".gradle/gradle.properties", ".config/hub", ".config/glab-cli", ".config/op", ".password-store",
  ".vault-token", ".config/git/credentials", ".subversion/auth",
  // Every provider's own sign-in and configuration: a thread signs in through Toolroll (the Codex harness, the Claude
  // relay), never with the person's own, so none is exempt.
  ".claude", ".claude.json", ".codex", ".gemini", ".config/claude",
  ...ACP_PROVIDER_IDS.flatMap(id => ACP_AGENTS[id].home),
]);

/** THREAD_CREDENTIAL_PATHS under `home` (and $XDG_CONFIG_HOME), as absolute paths. */
export function threadCredentialPaths(home: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const xdg = env["XDG_CONFIG_HOME"];
  return [...new Set(THREAD_CREDENTIAL_PATHS.flatMap(name => [join(home, name), ...(name.startsWith(".config/") && xdg !== undefined && isAbsolute(xdg) ? [join(xdg, name.slice(".config/".length))] : [])]))].sort();
}

/** What a thread's launch needs that the fence doesn't make: the run's own proxy (always: an open-network project's
 * proxy admits every host, the sandbox still allows nothing else), and the storage check, awaited. The fence is the
 * same whatever agent runs in it: no provider's own sign-in is exempt. */
export type FlexibleThreadLaunchInput = { id: string; network: { proxyPort: number; token: string }; storage: ProtectedStorage };

/** The thread's folder as Toolroll made it: every folder the real one it was (no link anywhere from the threads root
 * down), its repository a plain one (its own `.git` folder, no commondir), its alternates exactly the project's real
 * objects folder. Null when it is; else what changed. */
function folderChanged(paths: FlexibleThreadPaths, recorded: string, objects: string): string | null {
  if (recorded !== paths.folder) return "its record names another folder";
  for (const folder of [paths.root, paths.folder]) if (!ownFolder(folder)) return `${basename(folder)} isn't a private folder of yours`;
  for (const folder of [paths.repo, paths.tmp, paths.cache, paths.home]) if (grantFolder(folder, false) !== folder) return `its ${basename(folder)} folder isn't a real folder`;
  const gitdir = join(paths.repo, ".git");
  try {
    const held = lstatSync(gitdir);
    if (!held.isDirectory() || held.isSymbolicLink() || existsSync(join(gitdir, "commondir"))) return "its repository isn't a plain one";
    const alternates = join(gitdir, "objects", "info", "alternates");
    const named = lstatSync(alternates);
    if (!named.isFile() || named.isSymbolicLink() || readFileSync(alternates, "utf8") !== `${objects}\n`) return "its alternates changed";
  } catch { return "its repository can't be read"; }
  for (const { name, dir } of TOP_PROTECTED) if (protectedEntry(paths.repo, name, dir) !== "ok") return `its ${name} isn't the one Toolroll held`;
  return null;
}

/** Names in the thread's repository no launch writes (beside what the sandbox runtime denies at the working folder):
 * its config, hooks, object alternates (only the file: gc writes its commit graph beside it) and exclude list, and the
 * protected names at its top (settings, MCP servers, hooks and tool settings a provider or the next tool run would
 * load), each present on every platform (reserveProtectedNames; folderChanged proves it at every launch). */
function threadReadOnly(paths: FlexibleThreadPaths): string[] {
  const gitdir = join(paths.repo, ".git");
  return [join(gitdir, "config"), join(gitdir, "hooks"), join(gitdir, "objects", "info", "alternates"), join(gitdir, "info", "exclude"), paths.home,
    ...TOP_PROTECTED.map(one => join(paths.repo, one.name))].sort();
}

/**
 * The fence one thread launch runs in (plan §1 and §2, Codex round 2 item 3), from Toolroll's records only, or why it
 * can't be made. The same at every level: Full access removes the provider's prompts inside it, never any of it.
 */
export function flexibleThreadFence(store: Store, input: FlexibleThreadLaunchInput):
  { ok: true; launch: LaunchFence; paths: FlexibleThreadPaths; thread: FlexibleThreadRow } | FlexibleThreadRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const network = input.network;
  if (!Number.isSafeInteger(network.proxyPort) || network.proxyPort < 1 || network.proxyPort > 65_535 || typeof network.token !== "string" || network.token === "") return refuse("network-required");
  const databaseFile = store.databaseFile();
  const state = stateFolderOf(store);
  if (state === null || databaseFile === null) return refuse("no-state-folder");
  const thread = flexibleThread(store, input.id);
  if (thread === null) return refuse("thread-unknown");
  if (thread.state !== "ready") return refuse("thread-not-ready");
  if (!projectRowKnown(store, thread.repo)) return refuse("not-a-project");
  let project: string, objects: string;
  try {
    project = realpathSync(thread.repo);
    const common = recordedCommonDir(project);
    if (!ownObjects(join(common, "objects"))) throw new Error("objects");
    objects = realpathSync(join(common, "objects"));
  } catch { return refuse("repository-unusable"); }
  const paths = flexibleThreadPaths(state, thread.id);
  const changed = folderChanged(paths, thread.folder, objects);
  if (changed !== null) return refuse("thread-folder-changed", changed);
  if (inside(project, paths.folder) || inside(paths.folder, project) || project === paths.folder) return refuse("repository-unusable");

  const home = real(homedir());
  const credentials = threadCredentialPaths(home);
  // The database and the coding catalog by name, read and write; the whole state folder (whatever it is: Toolroll's own,
  // or a shared one the database was put in) unread below, the thread's own folder read back inside it as its one
  // exception, so an entry or a thread made there after the launch starts is denied too.
  const stateDenies = ["", "-wal", "-shm", "-journal", ".coding.sqlite", ".coding.sqlite-wal", ".coding.sqlite-shm"].map(suffix => `${real(databaseFile)}${suffix}`);
  // Every other registered project, whole: a thread's starter may not have access to them.
  const others = store.listProjects().map(one => real(one.path)).filter(path => path !== project);
  const poolRoots = [paths.root, join(state, "worktrees"), join(state, "coding-worktrees"), join(state, "live-worktrees"), ...store.listWorktrees().map(record => poolRootOf(record.path, record.repo))];
  const boundary: TaskBoundary = { protectedShell: [...input.storage.names], shell: credentials.filter(path => existsSync(path)), fileTools: [], readOnly: [], lookup: [], homeNames: credentials };
  const made = fenceFor("build", {
    storage: input.storage, databaseFile, worktree: paths.folder, boundary, binding: null, runFolders: runFolders(null), poolRoots, home, policy: 2,
    extra: [project, ...others, ...stateDenies],
    writes: { writes: { subpaths: [paths.repo, paths.tmp, paths.cache], prefixes: [] }, readOnly: threadReadOnly(paths) },
    network: { mode: "allowlist", proxyPort: network.proxyPort, brokerPorts: [], loopback: "proxy-only", socketRoots: [], token: network.token },
  });
  // No keychain (a build's agent alone keeps it, and a thread is never one); every pool unread, other threads among them;
  // the project's objects read back inside its denied repository, as one exact grant (never its .git around it).
  const { keychain: _never, pool, ...rest } = made.fenceGrants;
  const unread = pool === undefined ? undefined : (({ readable: _read, ...held }) => held)(pool);
  const grants: FenceGrants = { ...rest, readable: [...rest.readable, objects], exactFiles: [...rest.exactFiles ?? [], objects], noSharedTemp: true, readDenyOnly: [state],
    // The thread's own folder read back by its parts, never whole: bubblewrap would otherwise bind the folder read-only
    // over its writable repository, temp and caches.
    ownReadBack: [paths.repo, paths.tmp, paths.cache, paths.home],
    ...(unread === undefined ? {} : { pool: unread }) };
  return { ok: true, launch: { ...made, fenceGrants: grants }, paths, thread };
}

/** The environment a thread's agent starts with, exactly (never merged over Toolroll's own): a few plain settings, its
 * own temp and caches, git that asks nobody, and the run's proxy. No SSH agent socket, token, key or provider
 * variable of Toolroll's reaches it. */
export function flexibleThreadEnv(paths: FlexibleThreadPaths, proxy: Record<string, string>, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const kept = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "TZ", "USER", "LOGNAME", "SHELL", "COLORTERM"];
  return {
    ...Object.fromEntries(kept.flatMap(name => base[name] === undefined ? [] : [[name, base[name]!]])),
    HOME: real(homedir()), TMPDIR: paths.tmp, ...buildCacheEnv(paths.cache),
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    ...proxy,
  };
}

/**
 * The environment the process that makes the sandbox starts with. On Linux that is the launch helper (sandbox-launch.ts),
 * which makes the runtime's network relay sockets in its own temp folder: a unix socket path must fit in about 108
 * bytes, and a thread's temp folder (deep under the state folder) leaves too little room, so the relays never start. The
 * helper keeps Toolroll's own temp folder (where every other launch's relays are made, and which no thread writes);
 * inside the sandbox the runtime sets TMPDIR to the thread's own temp itself (CLAUDE_CODE_TMPDIR, from the launch's
 * `temp`). On a Mac the runtime's command sets it the same way, so nothing changes there.
 */
function outerEnv(env: Record<string, string>, platform: NodeJS.Platform): Record<string, string> {
  return platform === "linux" ? { ...env, TMPDIR: tmpdir() } : env;
}

/** Why `launch`'s own terms would let a thread out, or null: a keychain, or a network other than the proxy. */
function termsProblem(launch: LaunchFence): string | null {
  const terms = srtTermsOf(launch.fence, launch.fenceGrants);
  if (terms.keychain === true) return "its sandbox would reach the keychain";
  if (terms.network.kind !== "proxy" || terms.network.localServices || terms.network.unixSockets.length > 0) return "its sandbox would reach a network other than its proxy";
  return null;
}

/** Why the spawn the sandbox runtime made would let a thread out, or null (checked on what will actually run). */
function spawnProblem(spawned: { file: string; args: string[]; env: Record<string, string> }, platform: NodeJS.Platform): string | null {
  if (platform === "darwin") {
    const command = spawned.args.at(-1) ?? "";
    if (!command.includes("/usr/bin/sandbox-exec") || !command.includes(SEATBELT_NO_KEYCHAIN)) return "its sandbox profile doesn't deny the keychain";
    return null;
  }
  try {
    const spec = JSON.parse(spawned.env[SANDBOX_LAUNCH_SPEC] ?? "") as SandboxLaunchSpec;
    return spec.terms.keychain === true || spec.terms.network.kind !== "proxy" ? "its sandbox would reach the keychain or the network" : null;
  } catch { return "its sandbox launch can't be read"; }
}

/** The containment probe: in exactly the launch's terms, write a canary into the threads root and read one Toolroll
 * put there. Both must be refused and the probe must run; anything else is a containment failure. */
async function probeContainment(launch: LaunchFence, paths: FlexibleThreadPaths, env: Record<string, string>, platform: NodeJS.Platform): Promise<string | null> {
  const token = randomBytes(16).toString("hex");
  const readable = join(paths.root, `.probe-${token}`);
  const writable = join(paths.root, `.probe-${token}-written`);
  writeFileSync(readable, token, { mode: 0o600, flag: "wx" });
  try {
    // Judged by the real disk, read from outside: on Linux the runtime hides a read-denied folder under an in-memory one
    // of the launch's own, so the write can succeed in there and reach nothing; what counts is that no canary appears on
    // this computer's disk and the planted secret never comes back.
    const script = '(: > "$1") 2>/dev/null; cat "$2" 2>/dev/null; echo; echo probe-ran';
    let spawned: { file: string; args: string[]; env: Record<string, string> };
    try { spawned = confined("/bin/sh", ["-c", script, "probe", writable, readable], { fence: launch.fence, fenceGrants: launch.fenceGrants, confinement: "required", cwd: paths.repo, temp: paths.tmp }); }
    catch (error) { return error instanceof ContainmentRefusal ? error.message : "the sandbox couldn't be made"; }
    const problem = spawnProblem(spawned, platform);
    if (problem !== null) return problem;
    const ran = await new Promise<{ code: number | null; stdout: string }>(done => {
      const child = spawn(spawned.file, spawned.args, { cwd: paths.repo, env: { ...outerEnv(env, platform), ...spawned.env }, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.stdout.on("data", chunk => { if (stdout.length < 4096) stdout += String(chunk); });
      child.on("error", () => { clearTimeout(timer); done({ code: null, stdout }); });
      child.on("close", code => { clearTimeout(timer); done({ code, stdout }); });
    });
    if (existsSync(writable) || ran.stdout.includes(token)) return "the sandbox let the probe reach Toolroll's state";
    if (ran.code !== 0 || ran.stdout.trim() !== "probe-ran") return "the sandbox didn't start";
    return null;
  } finally {
    rmSync(readable, { force: true });
    rmSync(writable, { force: true });
  }
}

/** One thread's lock (git-views.ts lockCheckout: a file made exclusively in the folder every fence denies, holding this
 * process's id; across Toolroll's processes): launch admission, the spawn and its registration, and removal each run
 * wholly under it, so none of them sees the thread half-changed by another. */
function withThreadLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  return withCheckoutLock(real(homedir()), `flexible-thread:${id}`, work);
}

/** Run `work` under one thread's lock (the same one its launches, stops and removal take; re-entrant within this call),
 * so a level change and a turn start are wholly before or wholly after each other. */
export async function withFlexibleThreadLock<T>(id: string, work: () => Promise<T>): Promise<T | FlexibleThreadRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!FLEXIBLE_THREAD_ID.test(id)) return refuse("thread-unknown");
  return withThreadLock(id, work);
}

/** The start gate every thread launch runs behind (inside the sandbox): the agent itself runs only once Toolroll writes
 * `start` on its input, which it does only after the launch is registered. If Toolroll dies first, or the registration
 * fails, the input closes and the gate exits without running anything: a crash between the spawn and its registration
 * leaves no agent. The agent reads the rest of its input as its own. */
export const FLEXIBLE_START_GATE = 'IFS= read -r gate || exit 125; [ "$gate" = start ] || exit 125; exec "$@"';

/** A digest of exactly the terms a launch runs in (its fence and grants), recorded with the launch: a turn whose fence
 * would differ starts a new launch rather than reuse it. */
export function flexibleFenceDigest(launch: LaunchFence): string {
  return createHash("sha256").update(`standing-orders:flexible-fence:${JSON.stringify({ fence: launch.fence, grants: launch.fenceGrants })}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * Stop a launch whose start gate never opened: its whole process group, not just the leader. On Linux the leader is the
 * launch helper (sandbox-launch.ts), and the network relays it started (and bubblewrap) share its group; killing the
 * leader alone leaves them running, since only the helper stops them. The group is signalled by number only while the
 * leader is Toolroll's own child and not yet reaped (checked in the same synchronous step, before any reaping can run):
 * the group's number is then provably this launch's. Once the leader has been reaped, nothing is signalled by number;
 * whatever is left is the custody scan's to find.
 */
function stopUnopenedLaunch(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}

/** Test seams (a parameter, never a setting): what to do right after the spawn, before the registration (a test
 * throws here to prove a spawned-then-failed launch leaves nothing running), and the OS custody reads. */
export type FlexibleThreadSpawnSeams = { afterSpawn?: (pid: number) => void; io?: CustodyIO };
export type FlexibleThreadSpawnInput = FlexibleThreadLaunchInput & { proxyEnv: Record<string, string>; launch: FlexibleLaunchMeta;
  /** What the agent's own adapter adds to the thread's environment (its relay and its configuration folder); never
   * replaces a variable the thread's environment already sets. */
  agentEnv?: Record<string, string>;
  /** Run under the thread's lock after the launch is registered and immediately before its start gate opens: a reason to
   * keep the gate shut (the caller's authority or level no longer holds), or null. */
  beforeOpen?: () => string | null;
  /** What the agent's adapter adds once the launch has its id (its relay grant, bound to exactly this launch): run after
   * the launch is recorded, before the spawn; never replaces a variable already set. */
  agentEnvFor?: (launchId: string) => Record<string, string> };
export type FlexibleThreadSpawned = { ok: true; pid: number; launchId: string; launch: LaunchFence; fenceDigest: string; child: ChildProcess };

/**
 * Start `file args` as a thread's agent, inside the thread fence, with exactly the thread's environment, or say why not.
 * All of it runs under the thread's lock (withThreadLock), so a removal can't slip between the checks and the spawn:
 * the fence is made from the record, its terms checked (no keychain, proxy only), a probe runs in exactly those terms
 * and must be refused Toolroll's canaries, the record and the fence are made again and must be unchanged, and the thread
 * must have no launch left unsettled (custody). Then the launch is recorded (`spawning`), Toolroll itself spawns it as
 * a process group of its own behind the start gate, registers the leader's pid and start identity (the launch goes
 * live, the thread names the group) and only then opens the gate. Nothing the caller passes spawns anything: a spawn
 * that fails to register is killed with its gate still shut, and its record ends as never started.
 */
export async function flexibleThreadSpawn(store: Store, input: FlexibleThreadSpawnInput, file: string, args: readonly string[],
  platform: NodeJS.Platform = process.platform, seams: FlexibleThreadSpawnSeams = {}): Promise<FlexibleThreadSpawned | FlexibleThreadRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!FLEXIBLE_THREAD_ID.test(input.id)) return refuse("thread-unknown");
  return withThreadLock(input.id, () => spawnLocked(store, input, file, args, platform, seams));
}

async function spawnLocked(store: Store, input: FlexibleThreadSpawnInput, file: string, args: readonly string[], platform: NodeJS.Platform,
  seams: FlexibleThreadSpawnSeams): Promise<FlexibleThreadSpawned | FlexibleThreadRefusal> {
  const fenced = flexibleThreadFence(store, input);
  if (!fenced.ok) return fenced;
  const { launch, paths } = fenced;
  const terms = termsProblem(launch);
  if (terms !== null) return refuse("containment", terms);
  const base = flexibleThreadEnv(paths, input.proxyEnv);
  const env = { ...Object.fromEntries(Object.entries(input.agentEnv ?? {}).filter(([name]) => !(name in base))), ...base };
  const probed = await probeContainment(launch, paths, env, platform);
  if (probed !== null) return refuse("containment", probed);
  // At the moment of use: the record still ready and unchanged, and its folder still the one Toolroll made (the fence is
  // made again from them; the spawn uses the terms the probe ran in).
  const again = flexibleThreadFence(store, input);
  if (!again.ok) return again;
  if (JSON.stringify(again.thread) !== JSON.stringify(fenced.thread)) return refuse("thread-not-ready", "it changed while the sandbox was checked");
  // Custody: no earlier launch of this thread may be unsettled (its processes are stopped and verified gone first).
  if (unsettledLaunch(store, input.id) !== null) return refuse("thread-running");
  if (again.thread.livePid !== null && processMayBeAlive(again.thread.livePid, true)) return refuse("thread-running");
  let spawned: { file: string; args: string[]; env: Record<string, string> };
  try { spawned = confined("/bin/sh", ["-c", FLEXIBLE_START_GATE, "toolroll-start-gate", file, ...args], { fence: launch.fence, fenceGrants: launch.fenceGrants, confinement: "required", cwd: paths.repo, temp: paths.tmp }); }
  catch (error) { return refuse("containment", error instanceof Error ? error.message : undefined); }
  const problem = spawnProblem(spawned, platform);
  if (problem !== null) return refuse("containment", problem);
  const io = seams.io ?? defaultCustodyIO();
  const fenceDigest = flexibleFenceDigest(launch);
  const record = recordSpawning(store, { thread: input.id, meta: input.launch, fenceDigest, bootId: io.bootId() });
  let launchEnv: Record<string, string>;
  try { launchEnv = Object.fromEntries(Object.entries(input.agentEnvFor?.(record.id) ?? {}).filter(([name]) => !(name in env))); }
  catch (error) {
    recordNeverStarted(store, record.id, `the agent's launch couldn't be prepared: ${error instanceof Error ? error.message : String(error)}`);
    return refuse("setup-failed", "the agent's launch couldn't be prepared");
  }
  let child: ChildProcess;
  try {
    child = spawn(spawned.file, spawned.args, { cwd: paths.repo, env: { ...outerEnv({ ...launchEnv, ...env }, platform), ...spawned.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (error) {
    recordNeverStarted(store, record.id, `the agent couldn't be started: ${error instanceof Error ? error.message : String(error)}`);
    return refuse("containment", "the agent couldn't be started");
  }
  child.on("error", () => { /* a spawn that failed has no pid: handled below */ });
  child.stdin?.on("error", () => { /* a gate whose reader is gone */ });
  const pid = child.pid;
  // Anything that goes wrong from here (no pid, a test's injected failure, an unreadable start, a record that moved, the
  // write itself throwing) closes the gate for good and kills the group: nothing of the agent ever ran, and the record
  // says so. A crash here leaves the row `spawning` and the gate's pipe closed with this process, so the same holds.
  try {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) throw new Error("the agent's process didn't start");
    seams.afterSpawn?.(pid);
    const start = startIdentityOf(pid, io);
    if (start === null) throw new Error("the agent's process couldn't be identified");
    recordLive(store, { launch: record.id, thread: input.id, pid, start });
    holdLaunch(record.id, child);
  } catch (error) {
    try { child.stdin?.destroy(); } catch { /* already closed */ }
    stopUnopenedLaunch(child);
    try { recordNeverStarted(store, record.id, `stopped before it ran: ${error instanceof Error ? error.message : String(error)}`); } catch { /* left spawning: settleLaunch ends it */ }
    return refuse("containment", "the agent's process couldn't be registered, so it was stopped before it ran");
  }
  // At the moment of use: the caller's own re-check (its turn, its level, its authority), with the gate still shut.
  let shut: string | null;
  try { shut = input.beforeOpen?.() ?? null; } catch (error) { shut = error instanceof Error ? error.message : "the start couldn't be re-checked"; }
  if (shut !== null) {
    try { child.stdin?.destroy(); } catch { /* already closed */ }
    stopUnopenedLaunch(child);
    recordGateShut(store, { launch: record.id, thread: input.id, pid: pid!, detail: `stopped before it ran: ${shut}` });
    return refuse("thread-not-ready", shut);
  }
  child.stdin!.write("start\n");
  return { ok: true, pid: pid!, launchId: record.id, launch, fenceDigest, child };
}

/**
 * Stop a thread's agent and prove it stopped (F2c custody), under the thread's lock: its proxy and relay closed at once,
 * every process of it found (its group, its Linux pid namespaces, every descendant seen, anything of it working in the
 * thread's folder) and stopped, and the whole tree's exit verified. Then the launch is exited, the thread's live_pid
 * cleared and its running turn interrupted. When the exit can't be verified, the launch stays unresolved: no new turn,
 * relaunch or removal until a later stop proves it.
 */
export async function stopFlexibleThreadAgent(store: Store, input: { id: string; reason: string; clock?: FlexibleClock; io?: CustodyIO; keepTurn?: string; holderGone?: boolean }): Promise<SettleResult | FlexibleThreadRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!FLEXIBLE_THREAD_ID.test(input.id)) return refuse("thread-unknown");
  return withThreadLock(input.id, async () => {
    const state = stateFolderOf(store);
    if (state === null) return refuse("no-state-folder");
    const thread = flexibleThread(store, input.id);
    if (thread === null) return refuse("thread-unknown");
    return settleLaunch(store, { thread: thread.id, folder: flexibleThreadPaths(state, thread.id).folder, reason: input.reason, stop: true, ...(input.clock === undefined ? {} : { clock: input.clock }), ...(input.io === undefined ? {} : { io: input.io }),
      ...(input.keepTurn === undefined ? {} : { keepTurn: input.keepTurn }), ...(input.holderGone === true ? { holderGone: true } : {}) });
  });
}

/**
 * Codex's own command sandbox can't hold a thread's fence: it can't deny a folder and still reach inside it, so the
 * threads root and the state folder become read-only ancestors with their entries denied one by one at launch, and a
 * thread or state file made after that is readable (Codex round 1 on F2a, finding 2b). A Codex thread is refused until
 * it runs inside an outer sandbox the runtime makes (F2c).
 */
export function flexibleThreadCodexProfile(store: Store, input: FlexibleThreadLaunchInput): FlexibleThreadRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  void store; void input;
  return refuse("codex-unsupported");
}
