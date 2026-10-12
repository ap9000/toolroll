/**
 * Landed work (reconcile, and `toolroll storage clean --landed` for what piled up before): a finished result whose
 * work is already in main is marked complete by Toolroll, with a ledger entry saying why, and its clean checkout and
 * local build and plan branches go.
 *
 * Landed means, for the exact current result: its pull request merged for that commit, its commit is reachable from
 * the local main, or every path it changed since it left main has the same committed entry in main (both sides of a
 * rename; a file it deleted is deleted there too). Anything missing or ambiguous, and every git error, is "not
 * proven", and nothing happens. Remotes are never fetched or changed, and tags are never touched.
 *
 * Teardown is crash-safe: the completion and the teardown intent (each checkout and branch, with the commit it must
 * still be at) are written in one transaction before anything is removed. Each removal is checked again right before
 * it happens and recorded right after; a crash in between leaves its item pending, the next reconcile finishes it, and
 * a resource already gone finishes its item.
 *
 * Never removed: a checkout with changes (untracked files count), one in use, or one whose HEAD moved past the landed
 * work; a branch that moved, is checked out anywhere, or that an unfinished task uses.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { assignmentOf, owedAcceptance, type AssignmentSnapshot } from "./assignment.js";
import { noteAssignmentStatus } from "./assignment-status.js";
import { checkoutKeepWhy, taskStatuses, whyWords, type KeepWhy } from "./checkout-cleanup.js";
import { run, type ExecResult } from "./exec.js";
import { taskBranches } from "./names.js";
import { COMPLETION_ACTION, LANDED_ACTOR, familyChangedFiles } from "./result-completion.js";
import type { Store, WorktreeRow } from "./store.js";
import { WORKTREE_TIMEOUT_MS, type Runner, type WorktreePool } from "./worktree.js";

const DAY_MS = 86_400_000;
/** `storage clean --landed` takes only what has waited at least this long. */
export const BACKLOG_DAYS = 7;
/** The local branches the one-time pass looks at: Toolroll's build and plan branches, under either name. */
export const BACKLOG_PREFIXES: readonly string[] = ["toolroll/", "toolroll-plan/", "standing-orders/"];
/** The ledger action that closes a teardown. */
export const LANDED_CLEANED_ACTION = "landed work cleaned up";
/** Reconcile looks at most this many results and finishes at most this many items a pass; the pass by hand has no cap. */
export const AUTO_LOOKS = 20;
export const AUTO_ITEMS = 40;
const MAIN = "refs/heads/main";
const SHA = /^[0-9a-f]{40}$/;

export type Git = (cwd: string, args: readonly string[]) => Promise<ExecResult>;
export function gitOf(runner: Runner = run): Git {
  return (cwd, args) => runner("git", ["--no-optional-locks", ...args], { cwd, timeoutMs: WORKTREE_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
}

export type LandedHow = "merged" | "in-main" | "content-in-main";
export type LandedProof = { landed: true; how: LandedHow; reason: string } | { landed: false; why: string };
/** What Toolroll last saw of the result's pull request. */
export type PullRequestFact = { merged: boolean; headSha: string | null; number: number | null };

const notProven = (why: string): LandedProof => ({ landed: false, why });

/** The commit a ref names, null when it doesn't exist, or "error" when git couldn't say. */
async function commitOf(git: Git, repo: string, ref: string): Promise<string | null | "error"> {
  const found = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (found.code === 1 && found.stdout.trim() === "") return null;
  const oid = found.stdout.trim();
  return found.code === 0 && SHA.test(oid) ? oid : "error";
}

/** Whether `older` is `newer` or one of its ancestors; null when git couldn't say. */
async function within(git: Git, repo: string, older: string, newer: string): Promise<boolean | null> {
  if (older === newer) return true;
  const asked = await git(repo, ["merge-base", "--is-ancestor", older, newer]);
  return asked.code === 0 ? true : asked.code === 1 ? false : null;
}

/** Every committed entry of a commit's tree, path → "mode oid"; null on a git error. */
async function treeOf(git: Git, repo: string, commit: string): Promise<Map<string, string> | null> {
  const listed = await git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (listed.code !== 0) return null;
  const entries = new Map<string, string>();
  for (const line of listed.stdout.split("\0")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const [mode, , oid] = line.slice(0, tab).split(" ");
    if (tab < 0 || mode === undefined || oid === undefined) return null;
    entries.set(line.slice(tab + 1), `${mode} ${oid}`);
  }
  return entries;
}

/**
 * Whether this commit's work landed, read from what Toolroll recorded and the local repository only. Fails closed:
 * every doubt is "not proven", with the reason in a few words.
 */
export async function landedProof(git: Git, repo: string, head: string | null, pullRequest: PullRequestFact | null = null): Promise<LandedProof> {
  if (head === null || !SHA.test(head)) return notProven("it has no saved commit");
  if (pullRequest !== null && pullRequest.merged && pullRequest.headSha === head) {
    return { landed: true, how: "merged", reason: pullRequest.number === null ? "its pull request merged" : `pull request #${pullRequest.number} merged` };
  }
  const main = await commitOf(git, repo, MAIN);
  if (main === "error") return notProven("git couldn't read main");
  if (main === null) return notProven("the project has no local main branch");
  const exists = await git(repo, ["cat-file", "-e", `${head}^{commit}`]);
  if (exists.code !== 0) return notProven("its commit isn't in the repository");
  const reachable = await within(git, repo, head, main);
  if (reachable === null) return notProven("git couldn't compare it with main");
  if (reachable) return { landed: true, how: "in-main", reason: "its commits are in main" };
  const forked = await git(repo, ["merge-base", head, main]);
  const base = forked.stdout.trim();
  if (forked.code !== 0 || !SHA.test(base)) return notProven(forked.code === 1 ? "it shares no history with main" : "git couldn't compare it with main");
  // Every path it changed since it left main, both sides of a rename (no rename detection: a rename is a delete and an add).
  const changed = await git(repo, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", base, head]);
  if (changed.code !== 0) return notProven("git couldn't list its changes");
  const paths = [...new Set(changed.stdout.split("\0").filter(path => path !== ""))];
  if (paths.length === 0) return notProven("it changed nothing main lacks");
  const [ours, theirs] = await Promise.all([treeOf(git, repo, head), treeOf(git, repo, main)]);
  if (ours === null || theirs === null) return notProven("git couldn't read its files");
  const differs = paths.find(path => ours.get(path) !== theirs.get(path));
  if (differs !== undefined) return notProven("its changes aren't all in main");
  return { landed: true, how: "content-in-main", reason: "its changes are already in main" };
}

// ---- finding landed results ------------------------------------------------

export type LandedTarget = { kind: "checkout" | "branch"; target: string; expect: string };
export type LandedKeep = { repo: string; what: string; why: string };
export type LandedCandidate = {
  repo: string; taskId: string; rootId: string; runId: number; receipt: string; head: string; finishedAt: string;
  /** False when it is already complete: only its teardown is left. */
  completes: boolean;
  how: LandedHow; reason: string;
  targets: LandedTarget[];
  keeps: LandedKeep[];
};

/** Every local branch: name → commit and when it was last committed to (unix seconds). */
async function localBranches(git: Git, repo: string): Promise<Map<string, { oid: string; at: number }> | null> {
  const listed = await git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", "refs/heads/"]);
  if (listed.code !== 0) return null;
  const out = new Map<string, { oid: string; at: number }>();
  for (const line of listed.stdout.split("\n")) {
    const [ref, oid, at] = line.split("\0");
    if (ref === undefined || oid === undefined || !ref.startsWith("refs/heads/") || !SHA.test(oid)) continue;
    out.set(ref.slice("refs/heads/".length), { oid, at: Number(at) || 0 });
  }
  return out;
}

/** A path as the file system names it (git reports /private/var for /var on macOS). */
const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

/** The branch each working tree of the repository has checked out: branch → path. */
async function checkedOut(git: Git, repo: string): Promise<Map<string, string> | null> {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return null;
  const out = new Map<string, string>();
  let path = "";
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) out.set(line.slice("branch refs/heads/".length), path);
  }
  return out;
}

/** Only the exact build and plan names owned by this family's versions. A run can record any branch. */
function familyBranches(versions: readonly { id: string }[]): Set<string> {
  const names = new Set<string>();
  for (const version of versions) {
    for (const name of [...taskBranches(version.id), `toolroll-plan/${version.id}`]) names.add(name);
  }
  return names;
}

type Row = { id: string; ref: number; run: number; head: string | null; finishedAt: string; completed: boolean };

/** Finished results in a project whose family is settled on them (the current version, done), newest first, that no
 * teardown has taken yet. */
function settledResults(store: Store, repo: string): Row[] {
  return store.handle.prepare(`SELECT r.external_id AS id, r.id AS ref, res.id AS run, res.head_revision AS head, res.finished_at AS finished_at,
      EXISTS (SELECT 1 FROM action_ledger a WHERE a.run_id = res.id AND a.action = ? AND a.source = 'work') AS completed
    FROM task_ref r JOIN task t ON t.id = r.external_id AND r.backend = 'built-in'
    JOIN run res ON res.id = (SELECT MAX(x.id) FROM run x WHERE x.task_ref = r.id AND x.finished_at IS NOT NULL AND x.role IN ('builder','scout'))
    WHERE r.repo = ? AND t.state = 'done' AND res.role = 'builder'
      AND NOT EXISTS (SELECT 1 FROM task_ref c WHERE c.backend = r.backend AND c.revision_of = r.external_id AND c.repo IS r.repo)
      AND NOT EXISTS (SELECT 1 FROM landed_cleanup lc WHERE lc.run_id = res.id)
    ORDER BY res.id DESC`).all(COMPLETION_ACTION, repo).map(row => ({
    id: String(row["id"]), ref: Number(row["ref"]), run: Number(row["run"]), head: row["head"] === null ? null : String(row["head"]),
    finishedAt: String(row["finished_at"]), completed: Number(row["completed"]) === 1,
  }));
}

function pullRequestOf(store: Store, runId: number): PullRequestFact | null {
  const publication = store.publicationForRun(runId);
  if (publication === null) return null;
  const follow = store.handle.prepare("SELECT merged_at FROM pull_request_follow WHERE publication = ?").get(publication.id);
  const merged = publication.state === "opened" && (publication.remoteState === "MERGED" || (follow?.["merged_at"] ?? null) !== null);
  return { merged, headSha: publication.headSha, number: publication.prNumber };
}

/** A base commit is not work this run landed, even if it is already in main. */
function resultProblem(store: Store, runId: number, head: string | null): string | null {
  const run = store.getRun(runId);
  if (run === null || run.role !== "builder" || run.finishedAt === null || head === null || run.headRevision !== head) return "its result couldn't be read";
  return run.outcome === "no-change" || run.baseRevision === head ? "its result has no new work" : null;
}

/** Use the current manual completion guards. Only a recorded merge of this exact result can settle them. */
function completionProblem(store: Store, assignment: AssignmentSnapshot, root: string): string | null {
  if (assignment.state !== "ready-to-check" && assignment.state !== "complete") return "it needs a decision first";
  if (assignment.state === "complete") return null;
  const receipt = assignment.receipt!;
  const pr = pullRequestOf(store, receipt.runId);
  if (pr?.merged === true && pr.headSha === receipt.head) return null;
  const blockers = assignment.readiness?.blockers ?? [];
  if (blockers.length > 0) return blockers.map(one => one.message).join(" ");
  if (owedAcceptance(receipt, blockers) !== null) return "a person still needs to accept its result";
  return store.protectedResultProblem(receipt.taskId, familyChangedFiles(store, receipt.taskId, receipt.runId, root), null);
}

/** Results Reconcile found not landed, by what they were read against: read again only once something changed. */
const notLanded = new Map<string, string>();

/**
 * Results in a project whose work landed, with what their teardown would remove and what stays. Reads only.
 * `limit` caps how many results are read against git (reconcile's bound; results read before and unchanged since
 * don't count); `before` takes only results finished before it (the one-time pass's seven days).
 */
export async function landedResults(store: Store, git: Git, repo: string, root: string, now: Date,
  options: { limit?: number; before?: string; memo?: boolean } = {}): Promise<{ found: LandedCandidate[]; kept: LandedKeep[] }> {
  const found: LandedCandidate[] = [], kept: LandedKeep[] = [];
  if (!existsSync(repo)) return { found, kept };
  const [branches, inUse, main] = await Promise.all([localBranches(git, repo), checkedOut(git, repo), commitOf(git, repo, MAIN)]);
  if (branches === null || inUse === null) return { found, kept: [{ repo, what: repo, why: "git couldn't read the project" }] };
  const worktrees = store.listWorktrees().filter(row => row.repo === repo);
  let looked = 0;
  for (const row of settledResults(store, repo)) {
    if (options.before !== undefined && row.finishedAt >= options.before) { kept.push({ repo, what: row.id, why: `finished less than ${BACKLOG_DAYS} days ago` }); continue; }
    const problem = resultProblem(store, row.run, row.head);
    if (problem !== null) { kept.push({ repo, what: row.id, why: problem }); continue; }
    const family = store.taskFamilyOf(row.id, null, true);
    if (family === null || family.current.id !== row.id) continue;
    const names = familyBranches(family.versions);
    const checkouts = worktrees.filter(one => names.has(one.branch));
    const present = [...names].filter(name => branches.has(name));
    // Complete and nothing left to remove: nothing to do.
    if (row.completed && present.length === 0 && checkouts.length === 0) continue;
    const pullRequest = pullRequestOf(store, row.run);
    const key = `${repo}\u0000${row.run}`;
    const seen = `${row.head}:${main}:${pullRequest?.merged === true}:${pullRequest?.headSha}:${row.completed}`;
    if (options.memo === true && notLanded.get(key) === seen) continue;
    if (options.limit !== undefined && looked >= options.limit) break;
    looked++;
    const proof = await landedProof(git, repo, row.head, pullRequest);
    if (!proof.landed) {
      if (options.memo === true) notLanded.set(key, seen);
      kept.push({ repo, what: row.id, why: proof.why });
      continue;
    }
    notLanded.delete(key);
    const assignment = assignmentOf(store, row.id, now, { principal: "operator", repos: null, includeUnplaced: true }, root);
    const receipt = assignment?.receipt ?? null;
    if (assignment === null || receipt === null || receipt.runId !== row.run || receipt.head !== row.head) { kept.push({ repo, what: row.id, why: "its result couldn't be read" }); continue; }
    const completionHold = completionProblem(store, assignment, root);
    if (completionHold !== null) { kept.push({ repo, what: row.id, why: completionHold }); continue; }
    const targets: LandedTarget[] = [], keeps: LandedKeep[] = [];
    for (const one of checkouts) targets.push({ kind: "checkout", target: one.path, expect: row.head! });
    for (const name of present) {
      const tip = branches.get(name)!.oid;
      const inside = await within(git, repo, tip, row.head!) || (main !== null && main !== "error" && await within(git, repo, tip, main));
      const elsewhere = inUse.get(name);
      if (!inside) keeps.push({ repo, what: name, why: "it has commits that didn't land" });
      else if (elsewhere !== undefined && !checkouts.some(one => real(one.path) === real(elsewhere))) keeps.push({ repo, what: name, why: `it is checked out at ${elsewhere}` });
      else targets.push({ kind: "branch", target: name, expect: tip });
    }
    found.push({ repo, taskId: row.id, rootId: assignment.rootId, runId: row.run, receipt: receipt.digest, head: row.head!, finishedAt: row.finishedAt,
      completes: assignment.state === "ready-to-check", how: proof.how, reason: proof.reason, targets, keeps });
  }
  return { found, kept };
}

// ---- the intent ------------------------------------------------------------

/**
 * Mark a landed result complete (unless it already is) and record its teardown, in one transaction, bound to the
 * exact result read: refused when the result changed since. The completion's ledger entry says why. Returns the
 * teardown's id; a result already taken returns its existing teardown.
 */
export function recordLandedIntent(store: Store, candidate: LandedCandidate, now: Date, root: string, actor: string = LANDED_ACTOR): { ok: true; id: number; completed: boolean } | { ok: false; why: string } {
  return store.transact(() => {
    const existing = store.handle.prepare("SELECT id FROM landed_cleanup WHERE run_id = ?").get(candidate.runId);
    if (existing !== undefined) return { ok: true as const, id: Number(existing["id"]), completed: false };
    const assignment = assignmentOf(store, candidate.taskId, now, { principal: "operator", repos: null, includeUnplaced: true }, root);
    if (assignment === null || assignment.receipt?.digest !== candidate.receipt || assignment.receipt.runId !== candidate.runId || assignment.receipt.head !== candidate.head || assignment.repo !== candidate.repo || assignment.activeTaskId !== candidate.taskId) {
      return { ok: false as const, why: "its result changed since it was read" };
    }
    const problem = resultProblem(store, candidate.runId, candidate.head) ?? completionProblem(store, assignment, root);
    if (problem !== null) return { ok: false as const, why: problem };
    const completes = assignment.state === "ready-to-check";
    if (completes) {
      store.recordAction({ at: now.toISOString(), actor: LANDED_ACTOR, repo: candidate.repo, taskId: assignment.rootId, runId: candidate.runId,
        action: COMPLETION_ACTION, outcome: candidate.receipt, source: "work", detail: candidate.reason });
      const ref = store.lookupRef(assignment.rootId);
      if (ref !== null) store.noteTaskAct(ref.id, "completed", now, undefined, { account: LANDED_ACTOR, lead: false });
      store.bumpWake();
    }
    const id = Number(store.handle.prepare(`INSERT INTO landed_cleanup (repo, task_id, run_id, receipt, head, how, reason, completed, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(candidate.repo, assignment.rootId, candidate.runId, candidate.receipt, candidate.head,
      candidate.how, candidate.reason, completes ? 1 : 0, actor, now.toISOString()).lastInsertRowid);
    addItems(store, id, candidate.repo, candidate.targets);
    if (completes) noteAssignmentStatus(store, assignmentOf(store, assignment.rootId, now, { principal: "operator", repos: null, includeUnplaced: true }, root)!, now);
    return { ok: true as const, id, completed: completes };
  });
}

function addItems(store: Store, cleanup: number, repo: string, targets: readonly LandedTarget[]): void {
  const insert = store.handle.prepare("INSERT OR IGNORE INTO landed_cleanup_item (cleanup, kind, repo, target, expect) VALUES (?, ?, ?, ?, ?)");
  // Checkouts first: a branch goes only once nothing has it checked out.
  for (const one of [...targets].sort((a, b) => (a.kind === "checkout" ? 0 : 1) - (b.kind === "checkout" ? 0 : 1))) insert.run(cleanup, one.kind, repo, one.target, one.expect);
}

/** A landed branch no task names: its teardown, on its own. */
export type LandedBranch = { repo: string; branch: string; oid: string; how: LandedHow; reason: string; checkout: string | null };

export function recordBranchIntent(store: Store, branch: LandedBranch, now: Date, actor: string): number {
  return store.transact(() => {
    const id = Number(store.handle.prepare(`INSERT INTO landed_cleanup (repo, task_id, run_id, receipt, head, how, reason, completed, actor, created_at)
      VALUES (?, NULL, NULL, NULL, ?, ?, ?, 0, ?, ?)`).run(branch.repo, branch.oid, branch.how, branch.reason, actor, now.toISOString()).lastInsertRowid);
    addItems(store, id, branch.repo, [...(branch.checkout === null ? [] : [{ kind: "checkout" as const, target: branch.checkout, expect: branch.oid }]),
      { kind: "branch", target: branch.branch, expect: branch.oid }]);
    return id;
  });
}

/** Every name prefix a task's own build or plan branch may have. */
const TASK_PREFIXES: readonly string[] = ["toolroll/", "standing-orders/", "toolroll-plan/", "standing-orders-plan/"];

/** Who uses a branch, and how: what any task's runs recorded on it, or the task its name belongs to (a plan
 * branch is named after its task too). The strongest reason to keep it wins; undefined when no task names it. */
function branchUser(store: Store, statuses: ReturnType<typeof taskStatuses>, name: string): { taskId: string; keep: KeepWhy | null } | undefined {
  let found = statuses.byBranch.get(name);
  for (const prefix of TASK_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const ref = store.lookupRef(name.slice(prefix.length));
    const status = ref === null ? undefined : statuses.byRef.get(ref.id);
    if (status !== undefined && (found === undefined || (found.keep === null && status.keep !== null))) found = status;
  }
  return found;
}

// ---- the teardown ----------------------------------------------------------

export type LandedStep = { kind: "checkout" | "branch"; repo: string; target: string; taskId: string | null; outcome: "removed" | "already gone" | "waits" | "kept"; why: string | null };

type Item = { id: number; cleanup: number; kind: "checkout" | "branch"; repo: string; target: string; expect: string;
  taskId: string | null; runId: number | null; head: string; reason: string; actor: string };

/** Validate persisted targets too: an older intent may name an arbitrary run branch. */
function allowedBranch(store: Store, item: Item, name: string): boolean {
  if (name === "main" || name === "master") return false;
  if (item.taskId === null) return item.runId === null && BACKLOG_PREFIXES.some(prefix => name.startsWith(prefix));
  const family = store.taskFamilyOf(item.taskId, null, true);
  return item.runId !== null && family !== null && family.current.repo === item.repo && familyBranches(family.versions).has(name);
}

/** Same local default as the builder protects: origin HEAD, then the parent checkout's branch. */
async function isDefaultBranch(git: Git, repo: string, name: string): Promise<boolean | null> {
  if (name === "main" || name === "master") return true;
  const origin = await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (origin.code === 0) {
    const ref = origin.stdout.trim();
    return ref.startsWith("refs/remotes/origin/") ? name === ref.slice("refs/remotes/origin/".length) : null;
  }
  if (origin.code !== 1) return null;
  const parent = await git(repo, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = parent.stdout.trim();
  return parent.code === 0 && ref.startsWith("refs/heads/") ? name === ref.slice("refs/heads/".length) : null;
}

/** Whether a teardown's result is still its task's current result; null for a branch no task names. */
function stillCurrent(store: Store, item: Item): boolean {
  if (item.taskId === null || item.runId === null) return item.taskId === null && item.runId === null;
  const family = store.taskFamilyOf(item.taskId, null, true);
  if (family === null) return false;
  const latest = store.handle.prepare("SELECT MAX(id) AS id FROM run WHERE task_ref = ? AND finished_at IS NOT NULL AND role IN ('builder','scout')").get(family.current.refId);
  return family.current.state === "done" && Number(latest?.["id"]) === item.runId;
}

/** An intent is not a lasting landing proof: main and the recorded PR fact can both change. */
async function landingProblem(store: Store, git: Git, item: Item): Promise<string | null> {
  if (!stillCurrent(store, item)) return "its task has newer work";
  if (item.runId !== null) {
    const problem = resultProblem(store, item.runId, item.head);
    if (problem !== null) return problem;
  }
  const proof = await landedProof(git, item.repo, item.head, item.runId === null ? null : pullRequestOf(store, item.runId));
  if (!proof.landed) return proof.why;
  // A family's older branch can carry commits beyond this result that were in main at preview time.
  const inside = await within(git, item.repo, item.expect, item.head);
  if (inside === null) return "git couldn't compare its commits";
  if (!inside) {
    const targetProof = await landedProof(git, item.repo, item.expect);
    if (!targetProof.landed) return targetProof.why;
  }
  return null;
}

/** Read immediately before ref deletion, after all asynchronous Git reads. A lease may precede its run or checkout. */
function branchUseProblem(store: Store, item: Item, now: Date): string | null {
  if (!stillCurrent(store, item)) return "its task has newer work";
  if (store.listWorktrees().some(row => row.repo === item.repo && row.branch === item.target)) return "a recorded checkout uses it";
  const refs = new Set(store.handle.prepare("SELECT DISTINCT task_ref FROM run WHERE branch = ?").all(item.target).map(row => Number(row["task_ref"])));
  for (const prefix of TASK_PREFIXES) {
    if (!item.target.startsWith(prefix)) continue;
    const ref = store.lookupRef(item.target.slice(prefix.length));
    if (ref !== null) refs.add(ref.id);
  }
  if ([...refs].some(ref => store.currentLiveLease(ref, now) !== null)) return "a live lease uses it";
  if (store.handle.prepare("SELECT 1 FROM run WHERE branch = ? AND finished_at IS NULL").get(item.target) !== undefined) return "an unfinished run uses it";
  const status = branchUser(store, taskStatuses(store, now), item.target);
  return status !== undefined && status.keep !== null ? `${status.taskId} uses it (${whyWords({ why: status.keep })})` : null;
}

/**
 * Finish what teardowns intended: pending items, oldest first (checkouts before branches). Each is checked again
 * right before it goes, and recorded right after. Doubt leaves it pending for the next pass; a branch that moved, or
 * a result that has newer work, is kept for good. `only` limits it to these teardowns.
 */
export async function finishLanded(store: Store, pool: WorktreePool, git: Git, now: () => Date,
  options: { repo?: string; limit?: number; only?: ReadonlySet<number> } = {}): Promise<LandedStep[]> {
  const items = store.handle.prepare(`SELECT i.id, i.cleanup, i.kind, i.repo, i.target, i.expect, c.task_id, c.run_id, c.head, c.reason, c.actor
      FROM landed_cleanup_item i JOIN landed_cleanup c ON c.id = i.cleanup
      WHERE i.state = 'pending' AND (? IS NULL OR i.repo = ?) ORDER BY i.cleanup, i.kind = 'branch', i.id`).all(options.repo ?? null, options.repo ?? null)
    .map(row => ({ id: Number(row["id"]), cleanup: Number(row["cleanup"]), kind: row["kind"] === "branch" ? "branch" as const : "checkout" as const,
      repo: String(row["repo"]), target: String(row["target"]), expect: String(row["expect"]), taskId: row["task_id"] === null ? null : String(row["task_id"]),
      runId: row["run_id"] === null ? null : Number(row["run_id"]), head: String(row["head"]), reason: String(row["reason"]), actor: String(row["actor"]) }))
    .filter(item => options.only === undefined || options.only.has(item.cleanup));
  const steps: LandedStep[] = [];
  const touched = new Set<number>();
  const mark = (item: Item, state: "pending" | "done" | "kept", why: string | null) => {
    store.handle.prepare("UPDATE landed_cleanup_item SET state = ?, why = ?, done_at = ? WHERE id = ? AND state = 'pending'")
      .run(state, why, state === "pending" ? null : now().toISOString(), item.id);
    touched.add(item.cleanup);
  };
  const source = (item: Item) => item.actor === LANDED_ACTOR ? "work" as const : "request" as const;
  for (const item of items) {
    if (options.limit !== undefined && steps.length >= options.limit) break;
    const step = (outcome: LandedStep["outcome"], why: string | null) => {
      steps.push({ kind: item.kind, repo: item.repo, target: item.target, taskId: item.taskId, outcome, why });
      mark(item, outcome === "waits" ? "pending" : outcome === "kept" ? "kept" : "done", why);
    };
    if (!stillCurrent(store, item)) { step("kept", "its task has newer work"); continue; }
    if (item.kind === "checkout") {
      const outcome = await removeCheckout(store, pool, git, item, now);
      if (outcome.outcome === "removed") store.recordAction({ at: now().toISOString(), actor: item.actor, repo: item.repo, taskId: item.taskId, runId: null,
        action: "checkout removed", outcome: "removed", source: source(item), detail: `${basename(item.target)}: its work landed (${item.reason})` });
      step(outcome.outcome, outcome.why);
      continue;
    }
    if (!allowedBranch(store, item, item.target)) { step("kept", "it isn't a task build or plan branch"); continue; }
    const firstOut = store.handle.prepare("SELECT 1 FROM landed_cleanup_item WHERE cleanup = ? AND kind = 'checkout' AND state = 'pending'").get(item.cleanup);
    if (firstOut !== undefined) { step("waits", "its checkout goes first"); continue; }
    const outcome = await deleteBranch(store, git, item, now);
    if (outcome.outcome === "removed") store.recordAction({ at: now().toISOString(), actor: item.actor, repo: item.repo, taskId: item.taskId, runId: null,
      action: "branch deleted", outcome: "removed", source: source(item), detail: `${item.target} at ${item.expect.slice(0, 12)}: its work landed (${item.reason})` });
    step(outcome.outcome, outcome.why);
  }
  // A teardown with nothing pending is finished: one ledger entry says what it did.
  for (const cleanup of touched) {
    const left = store.handle.prepare("SELECT state, COUNT(*) AS n FROM landed_cleanup_item WHERE cleanup = ? GROUP BY state").all(cleanup);
    const count = (state: string) => Number(left.find(row => row["state"] === state)?.["n"] ?? 0);
    if (count("pending") > 0) continue;
    store.transact(() => {
      const row = store.handle.prepare("SELECT repo, task_id, actor, reason FROM landed_cleanup WHERE id = ? AND finished_at IS NULL").get(cleanup);
      if (row === undefined) return;
      store.handle.prepare("UPDATE landed_cleanup SET finished_at = ? WHERE id = ?").run(now().toISOString(), cleanup);
      store.recordAction({ at: now().toISOString(), actor: String(row["actor"]), repo: String(row["repo"]), taskId: row["task_id"] === null ? null : String(row["task_id"]), runId: null,
        action: LANDED_CLEANED_ACTION, outcome: count("kept") > 0 ? "partial" : "removed", source: String(row["actor"]) === LANDED_ACTOR ? "work" : "request",
        detail: `${String(row["reason"])}: ${count("done")} removed${count("kept") > 0 ? `, ${count("kept")} kept` : ""}` });
    });
  }
  return steps;
}

async function removeCheckout(store: Store, pool: WorktreePool, git: Git, item: Item, now: () => Date): Promise<{ outcome: LandedStep["outcome"]; why: string | null }> {
  const row = store.getWorktree(item.target);
  if (row === null) return { outcome: "already gone", why: null };
  if (row.repo !== item.repo || !allowedBranch(store, item, row.branch)) return { outcome: "kept", why: "it isn't a task build or plan branch" };
  const protectedBranch = await isDefaultBranch(git, item.repo, row.branch);
  if (protectedBranch === null) return { outcome: "waits", why: "git couldn't read the project's default branch" };
  if (protectedBranch) return { outcome: "kept", why: "it is the project's default branch" };
  if (row.releasedAt === null || row.runner !== null) return { outcome: "waits", why: "in use" };
  if (!existsSync(row.path)) {
    store.transact(() => { const still = store.getWorktree(row.path); if (still !== null && still.runner === null && still.releasedAt === row.releasedAt) store.forgetWorktree(row.path); });
    return { outcome: "already gone", why: null };
  }
  const actual = await git(row.path, ["symbolic-ref", "--quiet", "HEAD"]);
  if (actual.code !== 0 || actual.stdout.trim() !== `refs/heads/${row.branch}`) return { outcome: "waits", why: "its checked-out branch changed" };
  // Its HEAD must still be the landed work (or behind it): anything newer didn't land.
  const head = await commitOf(git, row.path, "HEAD");
  if (head === null || head === "error") return { outcome: "waits", why: "git couldn't read it" };
  const inside = await within(git, item.repo, head, item.expect);
  if (inside === null) return { outcome: "waits", why: "git couldn't read it" };
  if (!inside) return { outcome: "kept", why: "it has commits that didn't land" };
  let landingHold: string | null = null;
  const wanted = async (fresh: WorktreeRow, again: boolean) => {
    if (!again) return true;
    // Prune calls this after inspecting the checkout, immediately before removal.
    landingHold = await landingProblem(store, git, item);
    const current = store.getWorktree(fresh.path);
    return landingHold === null && current !== null && current.repo === item.repo && current.branch === fresh.branch
      && current.releasedAt === fresh.releasedAt && allowedBranch(store, item, current.branch)
      && checkoutKeepWhy(pool, current, taskStatuses(store, now()), now()) === null;
  };
  const first = checkoutKeepWhy(pool, row, taskStatuses(store, now()), now());
  if (first !== null) return { outcome: "waits", why: whyWords({ why: first }) };
  const pruned = await pool.prune([row], wanted, 1);
  if (pruned.removed.length === 1) return { outcome: "removed", why: null };
  const kept = pruned.kept[0];
  return { outcome: "waits", why: landingHold ?? (kept === undefined ? "in use" : whyWords({ why: kept.why })) };
}

async function deleteBranch(store: Store, git: Git, item: Item, now: () => Date): Promise<{ outcome: LandedStep["outcome"]; why: string | null }> {
  if (!allowedBranch(store, item, item.target)) return { outcome: "kept", why: "it isn't a task build or plan branch" };
  const ref = `refs/heads/${item.target}`;
  const tip = await commitOf(git, item.repo, ref);
  if (tip === null) return { outcome: "already gone", why: null };
  if (tip === "error") return { outcome: "waits", why: "git couldn't read it" };
  if (tip !== item.expect) return { outcome: "kept", why: "it moved since" };
  const protectedBranch = await isDefaultBranch(git, item.repo, item.target);
  if (protectedBranch === null) return { outcome: "waits", why: "git couldn't read the project's default branch" };
  if (protectedBranch) return { outcome: "kept", why: "it is the project's default branch" };
  const firstOut = await checkedOut(git, item.repo);
  if (firstOut === null) return { outcome: "waits", why: "git couldn't read it" };
  if (firstOut.has(item.target)) return { outcome: "waits", why: `it is checked out at ${firstOut.get(item.target)}` };
  const landingHold = await landingProblem(store, git, item);
  if (landingHold !== null) return { outcome: "waits", why: landingHold };
  const out = await checkedOut(git, item.repo);
  if (out === null) return { outcome: "waits", why: "git couldn't read it" };
  if (out.has(item.target)) return { outcome: "waits", why: `it is checked out at ${out.get(item.target)}` };
  const use = branchUseProblem(store, item, now());
  if (use !== null) return { outcome: "waits", why: use };
  // Deleted only while it still names the expected commit: git checks that and the deletion in one step.
  const gone = await git(item.repo, ["update-ref", "--no-deref", "-d", ref, item.expect]);
  if (gone.code === 0) return { outcome: "removed", why: null };
  return (await commitOf(git, item.repo, ref)) === null ? { outcome: "already gone", why: null } : { outcome: "waits", why: "git refused" };
}

// ---- reconcile -------------------------------------------------------------

/**
 * Reconcile's part: finish teardowns a crash cut short, then find newly landed results (a bounded few), mark them
 * complete and tear them down.
 */
export async function reconcileLanded(store: Store, pool: WorktreePool, git: Git, repo: string, root: string, now: () => Date): Promise<{ completed: string[]; steps: LandedStep[] }> {
  const steps = await finishLanded(store, pool, git, now, { repo, limit: AUTO_ITEMS });
  const { found } = await landedResults(store, git, repo, root, now(), { limit: AUTO_LOOKS, memo: true });
  const completed: string[] = [];
  const fresh = new Set<number>();
  for (const one of found) {
    const recorded = recordLandedIntent(store, one, now(), root);
    if (!recorded.ok) continue;
    fresh.add(recorded.id);
    if (recorded.completed) completed.push(one.taskId);
  }
  if (fresh.size > 0) steps.push(...await finishLanded(store, pool, git, now, { repo, limit: AUTO_ITEMS, only: fresh }));
  return { completed, steps };
}

// ---- Settings → Storage ----------------------------------------------------

export type LandedSummary = {
  completed: number; checkouts: number; branches: number;
  /** What a teardown still waits on, and why. */
  waiting: { target: string; why: string | null }[];
};

/** What landed-work teardowns did so far, and what they still wait on (Settings → Storage). Reads only. */
export function landedSummary(store: Store): LandedSummary {
  const count = (sql: string) => Number(store.handle.prepare(sql).get()?.["n"] ?? 0);
  return {
    completed: count("SELECT COUNT(*) AS n FROM landed_cleanup WHERE completed = 1"),
    checkouts: count("SELECT COUNT(*) AS n FROM landed_cleanup_item WHERE kind = 'checkout' AND state = 'done'"),
    branches: count("SELECT COUNT(*) AS n FROM landed_cleanup_item WHERE kind = 'branch' AND state = 'done'"),
    waiting: store.handle.prepare("SELECT target, why FROM landed_cleanup_item WHERE state = 'pending' ORDER BY id LIMIT 50").all()
      .map(row => ({ target: String(row["target"]), why: row["why"] === null ? null : String(row["why"]) })),
  };
}

// ---- the one-time pass -----------------------------------------------------

export type LandedPlan = {
  at: string; cutoff: string;
  results: LandedCandidate[];
  branches: LandedBranch[];
  kept: LandedKeep[];
  /** Items an earlier teardown still has to finish. */
  pending: number;
};

/**
 * What `storage clean --landed` would do now, across every project: landed results finished at least a week ago,
 * and Toolroll's own branches (toolroll/, toolroll-plan/, standing-orders/) no task uses whose last commit is at
 * least a week old and landed in main. Reads only.
 */
export async function landedBacklog(store: Store, git: Git, root: string, now: Date, options: { repos?: readonly string[] } = {}): Promise<LandedPlan> {
  const cutoff = new Date(now.getTime() - BACKLOG_DAYS * DAY_MS).toISOString();
  const plan: LandedPlan = { at: now.toISOString(), cutoff, results: [], branches: [], kept: [], pending: 0 };
  plan.pending = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM landed_cleanup_item WHERE state = 'pending'").get()?.["n"] ?? 0);
  const statuses = taskStatuses(store, now);
  const pendingTargets = new Set(store.handle.prepare("SELECT repo, target FROM landed_cleanup_item WHERE state = 'pending'").all().map(row => `${String(row["repo"])}\u0000${String(row["target"])}`));
  for (const repo of (options.repos ?? store.knownRepos()).filter(one => existsSync(one))) {
    const results = await landedResults(store, git, repo, root, now, { before: cutoff });
    plan.results.push(...results.found);
    plan.kept.push(...results.kept, ...results.found.flatMap(one => one.keeps));
    const taken = new Set([...results.found.flatMap(one => [...one.targets.map(target => target.target), ...one.keeps.map(keep => keep.what)])]);
    // A result that stays already says why: its branches don't say it again.
    const staying = new Set(results.kept.map(one => one.what));
    const [branches, out] = await Promise.all([localBranches(git, repo), checkedOut(git, repo)]);
    if (branches === null || out === null) { plan.kept.push({ repo, what: repo, why: "git couldn't read the project" }); continue; }
    const worktrees = store.listWorktrees().filter(row => row.repo === repo);
    for (const [name, tip] of branches) {
      if (!BACKLOG_PREFIXES.some(prefix => name.startsWith(prefix)) || taken.has(name) || pendingTargets.has(`${repo}\u0000${name}`)) continue;
      const status = branchUser(store, statuses, name);
      if (status !== undefined && staying.has(status.taskId)) continue;
      if (status !== undefined && status.keep !== null) { plan.kept.push({ repo, what: name, why: `${status.taskId} uses it (${whyWords({ why: status.keep })})` }); continue; }
      if (tip.at * 1000 > Date.parse(cutoff)) { plan.kept.push({ repo, what: name, why: `its last commit is less than ${BACKLOG_DAYS} days old` }); continue; }
      const checkout = worktrees.find(row => row.branch === name) ?? null;
      const elsewhere = out.get(name);
      if (elsewhere !== undefined && (checkout === null || real(checkout.path) !== real(elsewhere))) { plan.kept.push({ repo, what: name, why: `it is checked out at ${elsewhere}` }); continue; }
      const proof = await landedProof(git, repo, tip.oid);
      if (!proof.landed) { plan.kept.push({ repo, what: name, why: proof.why }); continue; }
      plan.branches.push({ repo, branch: name, oid: tip.oid, how: proof.how, reason: proof.reason, checkout: checkout?.path ?? null });
    }
  }
  return plan;
}

/** Act on a preview: record every teardown first, then carry them out. Refuses nothing it previewed silently: what
 * changed since is reported as kept. */
export async function cleanLandedBacklog(store: Store, pool: WorktreePool, git: Git, root: string, now: () => Date, plan: LandedPlan, actor: string): Promise<{ completed: string[]; steps: LandedStep[]; refused: LandedKeep[] }> {
  const ids = new Set<number>();
  const completed: string[] = [];
  const refused: LandedKeep[] = [];
  for (const one of plan.results) {
    const recorded = recordLandedIntent(store, one, now(), root, actor);
    if (!recorded.ok) { refused.push({ repo: one.repo, what: one.taskId, why: recorded.why }); continue; }
    ids.add(recorded.id);
    if (recorded.completed) completed.push(one.taskId);
  }
  for (const one of plan.branches) ids.add(recordBranchIntent(store, one, now(), actor));
  // Earlier teardowns a crash cut short finish too.
  const earlier = store.handle.prepare("SELECT DISTINCT cleanup FROM landed_cleanup_item WHERE state = 'pending'").all().map(row => Number(row["cleanup"]));
  for (const id of earlier) ids.add(id);
  const steps = await finishLanded(store, pool, git, now, { only: ids });
  return { completed, steps, refused };
}
