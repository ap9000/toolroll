/**
 * Adding and removing projects: the ONE road for the command line, the lead
 * and the console's own "Add a project". A project is admitted when its
 * folder is proved to be a Git repository, canonicalized to its checkout
 * root, saved in the store's project list, and enrolled in the machine's
 * locked project registry; a running `up` adopts it from there without a
 * restart. Each change is one ledger row naming who made it and from where.
 *
 * Removing is reversible: the project leaves the lists and the builder, and
 * its tasks, results and settings stay saved. Deleting everything Toolroll
 * holds for a project is project-delete.ts, behind its own confirmation.
 */

import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { run } from "./exec.js";
import { canonicalProject, projectName, sameRepo, type ProjectExec } from "./project.js";
import { remoteUrlProblem } from "./remote-main.js";
import { addRepos, loadProjectRegistry, removeRepos, updateProjectRegistry, updateRepos, type ProjectRegistry } from "./repos.js";
import type { Store } from "./store.js";
import { FolderUnavailable } from "./folder-gate.js";

/** Where an addition or removal came from, as the ledger says it. */
export type AdmissionOrigin = "cli" | "lead" | "console";
/** Who made it: the ledger's actor (an account, `lead for <owner>`, or this computer's user) and the road. */
export type AdmissionActor = { label: string; origin: AdmissionOrigin };

export type AdmissionFailure = {
  ok: false;
  reason: "unavailable" | "not-git" | "locked" | "registry" | "abandoned" | "failed" | "moved" | "incomplete";
  message: string;
};
/** `remote`: the origin URL this add recorded as the project's trusted remote (null: none), and why one wasn't. */
/** `enrolled`: this call wrote the project's line in the registry (it wasn't there before). */
export type Admitted = { ok: true; repo: string; name: string; added: boolean; remote: { url: string | null; why: string | null }; enrolled?: boolean };
export type Released = { ok: true; repo: string; name: string; removed: boolean };

const ADMISSION_GIT = {
  envAllowlist: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
  env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" },
};

export const PROJECT_ADDED = "project added";
/** A failed admission whose registry line couldn't be taken back: recorded, and said to the person. */
export const PROJECT_ADD_INCOMPLETE = "project add incomplete";

/** A folder's real path (a folder), null (not one), or "no-answer" (it didn't answer in time). */
export type FolderResolver = (path: string) => Promise<string | null | "no-answer">;
export const PROJECT_REMOVED = "project removed";

/** The checkout root a folder belongs to, canonical; never a shell. */
export async function proveProjectRoot(path: string, exec: ProjectExec = run, resolveFolder?: FolderResolver): Promise<{ ok: true; repo: string } | AdmissionFailure> {
  if (path.trim() === "" || path.length > 4096 || /[\x00-\x1f]/.test(path)) {
    return { ok: false, reason: "unavailable", message: "Choose a valid project folder." };
  }
  // The console resolves both folders off its thread (project-identity.ts resolveNow): its thread never waits on one.
  const canon = async (one: string): Promise<string | null | "no-answer"> => resolveFolder === undefined ? canonicalProject(one) : resolveFolder(one);
  const didntAnswer = (one: string): AdmissionFailure => ({ ok: false, reason: "unavailable", message: `${one} didn't answer. It may be on a drive that's disconnected, or waiting on macOS; try again in a moment.` });
  const canonical = await canon(path);
  if (canonical === "no-answer") return didntAnswer(path);
  if (canonical === null) return { ok: false, reason: "unavailable", message: `${path} isn't a folder on this computer.` };
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: canonical, timeoutMs: 5_000, ...ADMISSION_GIT });
  const topReal = top.code === 0 ? await canon(top.stdout.trim()) : null;
  if (topReal === "no-answer") return didntAnswer(top.stdout.trim());
  const repo = topReal;
  if (repo === null) return { ok: false, reason: "not-git", message: `${path} isn't a Git repository. Run git init there first, or choose a folder inside one.` };
  return { ok: true, repo };
}

/** Read only on first CLI admission; never rediscover trust from an existing project's config. */
async function originOf(repo: string, exec: ProjectExec): Promise<{ url: string | null; why: string | null }> {
  const read = await exec("git", ["config", "--local", "--no-includes", "--get", "remote.origin.url"], { cwd: repo, timeoutMs: 5_000, ...ADMISSION_GIT });
  const url = read.code === 0 ? read.stdout.trim() : "";
  if (url === "") return { url: null, why: "it has no origin remote" };
  const problem = remoteUrlProblem(url);
  return problem === null ? { url, why: null } : { url: null, why: problem };
}

/** Registry first, then the project and its audit records in one transaction. Re-adds preserve trust. */
export async function admitProject(store: Store, input: {
  /** null: a console with no machine registry (a bare `serve`) keeps only the project list. */
  registryFile: string | null; path: string; actor: AdmissionActor; now: Date; exec?: ProjectExec;
  /** Only the authorized CLI add opts in; console/open/onboarding never discover a remote. */
  captureOrigin?: boolean;
  /** Explicit value from the owner/instance-operator CLI boundary. */
  remoteUrl?: string;
  /** The caller's authority, asked again about the proved repo inside the locked registry update and inside the
   * database transaction (the console: nothing it proved before an await moved, and the repo is still visible). */
  stillAllowed?: (repo: string) => boolean;
  /** How the folder and its checkout root are resolved (the console: off its thread, under a deadline). Absent:
   * canonicalProject. */
  resolveFolder?: FolderResolver;
  /** Asked under the registry's own lock with the registry as it is there (its repositories and projects folders): a
   * caller whose authority is the registry itself (the sample from the command line) decides on it, not on a copy. */
  registryAllowed?: (repo: string, registry: ProjectRegistry) => boolean;
  /** The caller's own writes, inside the admission's transaction (the sample's check): if one throws, nothing stands. */
  withinAdmission?: (repo: string) => void;
}): Promise<Admitted | AdmissionFailure> {
  const proved = await proveProjectRoot(input.path, input.exec, input.resolveFolder);
  if (!proved.ok) return proved;
  const { repo } = proved;
  if (input.remoteUrl !== undefined && (input.actor.origin === "console" || remoteUrlProblem(input.remoteUrl) !== null)) {
    return { ok: false, reason: "failed", message: "Only an owner or instance operator can record a network remote with repos add --remote <url>. Use an HTTPS or SSH URL without credentials." };
  }
  const before = input.registryFile === null ? null : await loadProjectRegistry(input.registryFile);
  const known = store.projectAdmissionKnown(repo) || (before !== null && !("error" in before) && before.repos.includes(repo));
  const discovered = !known && input.captureOrigin === true && input.actor.origin !== "console"
    ? await originOf(repo, input.exec ?? run) : null;
  let remote = { url: store.projectRemote(repo), why: null as string | null };
  // Whether this call wrote the registry line (it wasn't there under the lock): only that line is ever taken back.
  let enrolledHere = false;
  const allowed = (): boolean => input.stillAllowed === undefined || input.stillAllowed(repo);
  const moved: AdmissionFailure = { ok: false, reason: "moved", message: `${projectName(repo)} wasn't added: a project folder changed while it was being checked. Try again.` };
  if (input.registryFile !== null) {
    let refused = false;
    let had = false;
    // The whole registry under its lock (repositories AND projects folders): `registryAllowed` decides on it as it is now.
    const enrolled = await updateProjectRegistry(input.registryFile, current => {
      had = current.repos.includes(repo);
      if (!allowed() || (input.registryAllowed !== undefined && !input.registryAllowed(repo, current))) { refused = true; return current; }
      return { ...current, repos: addRepos(current.repos, [repo]) };
    });
    if (!enrolled.ok) return { ok: false, reason: enrolled.reason, message: `${projectName(repo)} wasn't added: ${enrolled.message}` };
    if (refused) return moved;
    enrolledHere = !had;
  }
  /** Take back the registry line this call wrote, if it wrote one; a give-back that fails is said, never swallowed: the
   * person hears it (an `incomplete` failure naming the line) and the ledger records it. */
  const giveBack = async (failure: AdmissionFailure): Promise<AdmissionFailure> => {
    if (input.registryFile === null || !enrolledHere) return failure;
    let problem: string | null;
    try {
      // Under the registry's lock, and only while the line is still nobody's: once another admission committed the
      // project (its row is saved), the line is that admission's and stays.
      const removed = await updateProjectRegistry(input.registryFile, current =>
        !current.repos.includes(repo) || store.listProjects().some(one => one.path === repo) ? current : { ...current, repos: removeRepos(current.repos, [repo]) });
      problem = removed.ok ? null : removed.message;
    } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    if (problem === null) return failure;
    let unrecorded = "";
    try {
      store.recordAction({ at: input.now.toISOString(), actor: input.actor.label, repo, taskId: null, runId: null, action: PROJECT_ADD_INCOMPLETE, outcome: "rollback-failed", source: "access",
        detail: `its line in the project list couldn't be taken back: ${problem}` });
    } catch (error) {
      // Said, not swallowed: the person hears that the ledger couldn't record it either.
      unrecorded = ` It couldn't be recorded in the history either (${error instanceof Error ? error.message : String(error)}).`;
    }
    return { ok: false, reason: "incomplete", message: `${projectName(repo)} wasn't added, and its line in the project list couldn't be taken back (${problem}). Remove it with \`toolroll repos remove ${repo}\`.${unrecorded}` };
  };
  let added: boolean | null;
  try {
    added = store.transact(() => {
      // Re-asked with the write; a refusal writes nothing here and takes back the registry line this call added below.
      if (!allowed()) return null;
      const rowHad = store.listProjects().some(one => one.path === repo);
      const previous = store.projectRemote(repo);
      const first = !known && !store.projectAdmissionKnown(repo);
      remote = input.remoteUrl !== undefined ? { url: input.remoteUrl, why: null }
        : first && discovered !== null ? discovered : { url: previous, why: previous === null ? "no remote recorded; use repos add --remote <url>" : null };
      store.upsertProject(repo, projectName(repo), input.now, { remoteUrl: remote.url });
      if (input.remoteUrl !== undefined) store.recordProjectRemote(input.actor.label, repo, previous, input.remoteUrl, input.now);
      // The caller's own writes for this admission, in this transaction: all of them or none.
      input.withinAdmission?.(repo);

      if (rowHad && !enrolledHere) return false;
      store.recordAction({ at: input.now.toISOString(), actor: input.actor.label, repo, taskId: null, runId: null, action: PROJECT_ADDED, outcome: "added", source: "access", detail: `from ${input.actor.origin}` });
      return true;
    });
  } catch (error) {
    // A write refused under it (a local sign-in that lapsed) or the caller's own write failing: nothing of the
    // transaction stands, and the registry line this call wrote goes too.
    return giveBack({ ok: false, reason: "failed", message: `${projectName(repo)} wasn't added: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (added === null) return giveBack(moved);
  return { ok: true, repo, name: projectName(repo), added, remote, enrolled: enrolledHere };
}

/**
 * Remove one project from the lists and the builder. Its tasks, results and
 * settings stay saved; adding it again brings it back. A path that isn't a
 * saved project changes nothing.
 */
export async function releaseProject(store: Store, input: {
  registryFile: string | null; path: string; actor: AdmissionActor; now: Date;
}): Promise<Released | AdmissionFailure> {
  // Removing only narrows: a folder the console's gate holds back (folder-gate.ts) is removed by its exact saved path,
  // and matches no other spelling.
  // Latched for the whole removal: once its folder was unavailable, a later answer (during an await below) never
  // widens it to other spellings.
  const unavailable = (error: unknown): boolean => error instanceof FolderUnavailable;
  let asked: string, exactOnly = false;
  try { asked = canonicalProject(input.path) ?? resolve(input.path); } catch (error) { if (!unavailable(error)) throw error; asked = resolve(input.path); exactOnly = true; }
  const same = (one: string): boolean => {
    if (exactOnly) return false;
    try { return sameRepo(one, asked); } catch (error) { if (unavailable(error)) { exactOnly = true; return false; } throw error; }
  };
  const loaded = input.registryFile === null ? { repos: [] } : await loadProjectRegistry(input.registryFile);
  if ("error" in loaded) return { ok: false, reason: "registry", message: loaded.error };
  const entries = loaded.repos.filter(one => one === asked || same(one));
  const rows = store.listProjects().filter(one => one.path === asked || same(one.path)).map(one => one.path);
  const repo = entries[0] ?? rows[0] ?? asked;
  if (entries.length === 0 && rows.length === 0) return { ok: true, repo, name: projectName(repo), removed: false };
  if (entries.length > 0 && input.registryFile !== null) {
    const written = await updateRepos(input.registryFile, repos => removeRepos(repos, entries));
    if (!written.ok) return { ok: false, reason: written.reason, message: `${projectName(repo)} wasn't removed: ${written.message}` };
  }
  store.transact(() => {
    for (const path of rows) store.forgetProject(path);
    store.recordAction({ at: input.now.toISOString(), actor: input.actor.label, repo, taskId: null, runId: null, action: PROJECT_REMOVED, outcome: "removed", source: "access", detail: `from ${input.actor.origin}` });
  });
  return { ok: true, repo, name: projectName(repo), removed: true };
}

/** The registry `up` watches: beside the database, so an isolated database never enrolls into another's list. */
export function registryBeside(databaseFile: string): string {
  return join(dirname(databaseFile), "repos.json");
}

/**
 * Who is adding from the command line. Running it on this computer against
 * a database this user owns is the owner's authority; a lead token acts as
 * `lead for <owner>`, and only for an owner who may manage every project.
 * Any other credential is refused rather than read as the owner.
 */
export function commandLineActor(store: Store, input: { databaseFile: string; leadToken?: string; user?: string }): AdmissionActor | AdmissionFailure {
  if (input.leadToken !== undefined) {
    const lead = store.leadFor(input.leadToken);
    if (lead === null) return { ok: false, reason: "failed", message: "That lead token isn't valid (revoked, replaced, or its owner can no longer approve). The owner mints a new one with: toolroll lead token" };
    if (!store.isInstanceOperator(lead.owner)) return { ok: false, reason: "failed", message: `${lead.owner} can't add or remove projects: their account is limited to listed projects.` };
    return { label: `lead for ${lead.owner}`, origin: "lead" };
  }
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const owner = statSync(input.databaseFile, { throwIfNoEntry: false })?.uid;
    if (owner !== undefined && owner !== uid) return { ok: false, reason: "failed", message: "Only the user who owns this Toolroll database, or its lead, can add or remove projects." };
  }
  return { label: input.user ?? userInfo().username, origin: "cli" };
}

/** Whether a builder is running now (its heartbeat is a minute apart), so an addition is in the console within seconds. */
export function consoleRunning(store: Store, now: Date): boolean {
  return store.listRunners().some(one => one.retiredAt === null && now.getTime() - Date.parse(one.heartbeatAt) < 3 * 60_000);
}

/** The one plain line after an addition: where the project is now. */
export function addedWords(name: string, added: boolean, running: boolean): string {
  const where = running ? "it is in the console now" : "run `toolroll` to start working on it";
  return added ? `Added ${name}; ${where}.` : `${name} was already added; ${where}.`;
}

/**
 * Whether a registry entry carries an admission this boundary recorded:
 * its project row. `up` adopts a project added after it started only with
 * this record, so a hand-edited registry line is not authority by itself.
 */
export function admissionRecorded(store: Store, repo: string): boolean {
  return store.listProjects().some(one => one.path === repo);
}
