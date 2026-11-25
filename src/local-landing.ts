/**
 * Land accepted work on a local project's branch (everyday-8 #1, the Codex-refined build spec; owner defaults of
 * 2026-11-25): a separate act after Accept, for a project with no pull-request publishing. Fast-forward only, tasks
 * only, into a destination Toolroll records (the project's own repository and an exact branch ref), shown before the
 * person says yes.
 *
 * The rules, each enforced here and tried by local-landing.attack.test.ts:
 * - Only a completed task whose completion is today's exact receipt; checks passed on exactly the candidate commit,
 *   or the project has no check command at all (the screen then says "No check ran").
 * - The candidate is the result's recorded head commit, never anything a checkout says. It lands as ONE new commit
 *   (everyday-9 A1, "squash"): the candidate's exact tree on top of the destination's current commit, made with
 *   `commit-tree`, so rejected attempts' commits never reach the branch. Only when the destination's commit is an
 *   ancestor of the candidate (the fast-forward condition), so nothing on the branch is ever dropped; when the branch
 *   moved past the work's start, nothing lands and the person is told to bring the task up to date first. The
 *   candidate, the family's start, the destination's commit, the tree, the check policy and "squash" are all in what
 *   the person says yes to and in the recovery record; the commit made is recorded before the branch moves.
 * - Every git call goes through the hardened helper (teardown-git.ts: no hooks, no config includes or commands, no
 *   global or system config), bound to the project's recorded main checkout. A repository whose config names a
 *   command, or whose files need Git filters (Git LFS, encodings) or hold submodules, is refused, never altered.
 * - Where the destination stands decides how it moves (everyday-9 A1): checked out nowhere, only the branch moves. Checked
 *   out in the project folder itself, with that folder completely clean (nothing staged, changed or untracked, no
 *   merge, rebase or other git operation in progress, HEAD on exactly that branch at the commit read), Toolroll moves
 *   the branch (the same compare-and-swap) and then brings the folder's index and files along with `read-tree -m -u`,
 *   which refuses to overwrite any file git doesn't track (ignored ones included); if that fails the branch goes back.
 *   Anywhere else (changes in the folder, another folder), Toolroll touches no checkout: it makes the commit, keeps it
 *   at refs/toolroll/land/<task> and shows the exact `git -C <folder> merge --ff-only <commit>`. Nothing is ever
 *   stashed, forced or reset. A symbolic destination (a ref that names another branch) is refused at the look, before
 *   the lock and right before the write.
 * - The promotion is `update-ref --no-deref` from the exact commit read (expected old), after a last check, in one
 *   transaction, that the authority, the pull-request policy, the exact receipt and the check bindings (command, quick
 *   command, setup and check access) are still the ones the person read. Every landing writes its intent first and its
 *   outcome after (the recovery record); an intent left unsettled by a crash is settled only from what the
 *   (non-symbolic) branch shows, never by touching files, and only for someone who may land in that project.
 * - Undo makes a new commit that reverts exactly the landed commit, on the branch as it is now, and lands it the same
 *   way: history is never rewritten.
 *
 * A Toolroll lock (one unsettled intent per project) keeps Toolroll's own writers apart; it can't keep an editor or
 * another git out, so the checkout is read again right before the swap, and the swap itself refuses a moved branch.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./backend.js";
import { run as execRun } from "./exec.js";
import { hardenedGit } from "./teardown-git.js";
import type { Store } from "./store.js";
import { assignmentOf } from "./assignment.js";
import { projectCheckSet, quickVerifyKey } from "./check-levels.js";
import { recordActionWhole } from "./action-ledger.js";
import { reproveApprover, verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { localActNow, LOCAL_OWNER_LAPSED } from "./local-owner.js";
import { publishingOf } from "./pull-request-flow.js";
import { wholeChangeBaseOf } from "./task-base.js";

export const LAND_DESTINATION = "land destination";
export const LAND_INTENT = "land intent";
export const LAND_SETTLED = "land settled";
/** A landing commit made for the person to bring in themselves (the destination was checked out with changes). */
export const LAND_HANDOFF = "land handoff";

/** Who lands: a person proved by password (or a browser session's approver), or this computer's local owner acting as
 * exactly `land-task` (the same authority as Accept on a solo install). */
export type LandAuthority = { kind: "person"; who: VerifiedApprover } | { kind: "local" };

export type LandingPlan = {
  kind: "land" | "undo";
  taskId: string; rootId: string; runId: number; receipt: string;
  repo: string; ref: string; branch: string;
  /** The branch's commit now (the expected old value of the swap). */
  old: string;
  /** land: the result's commit, whose exact tree lands. undo: null until the revert commit is made at the act. */
  candidate: string | null;
  /** land: the one commit it makes (everyday-9 A1): the candidate's tree on `old`, its message, the family's start the
   * reviewed change ran from, and what it changes. Null for undo. */
  squash: Squash | null;
  /** ref: no checkout has the branch; only it moves. files: the project folder has it checked out, completely clean;
   * the branch moves and the folder's files come along. handoff: checked out with changes, or elsewhere; Toolroll makes
   * the commit and shows the command, touching no checkout. */
  mode: "ref" | "files" | "handoff";
  /** handoff: the folder the command runs in, and why Toolroll won't update it. */
  handoff?: { folder: string; why: string };
  /** passed: checks passed on exactly the candidate; none: the project has no check command. Undo: none. */
  checks: "passed" | "none";
  /** The destination is Toolroll's record (true), or proposed now and recorded by the yes (false). */
  recorded: boolean;
  /** undo: the landing it reverts. */
  reverts?: { intent: number; old: string; landed: string };
  /** What the check eligibility rests on, read at the look: re-read in the transaction right before the write. */
  bindings: CheckBindings;
  /** A short pin of everything above: the yes names it, and a stale one refuses. */
  key: string;
};
export type Squash = { policy: "squash"; base: string | null; tree: string; message: string; files: string[]; fileCount: number; added: number; removed: number };
export type CheckBindings = { full: string | null; quick: string | null; setup: string | null; access: string };
/** The project's check command, quick command, setup and check access as they stand now. */
function checkBindingsOf(store: Store, repo: string): CheckBindings {
  return { full: store.liveVerifyCommand(repo)?.digest ?? null, quick: store.liveVerifyCommand(quickVerifyKey(repo))?.digest ?? null,
    setup: store.liveWorktreeSetup(repo)?.digest ?? null, access: String(store.projectCheckAccess(repo)) };
}
export type LandingRead =
  | { ok: true; plan: LandingPlan }
  | { ok: true; landed: { at: string; ref: string; commit: string; mode: "files" | "ref" } }
  | { ok: false; reason: LandRefusal; message: string };
export type LandRefusal = "pull-requests" | "not-found" | "not-complete" | "checks" | "destination" | "moved" | "occupied" | "dirty" | "unsupported" | "git" | "busy" | "stale" | "authority" | "nothing";
export type LandResult =
  | { ok: true; replayed: boolean; kind: "land" | "undo"; ref: string; branch: string; commit: string; old: string; mode: "files" | "ref" | "handoff"; warning: string | null;
      /** handoff: where the commit is kept and the exact command that brings it onto the branch. */
      handoff: { ref: string; command: string } | null }
  | { ok: false; reason: LandRefusal; message: string };

type Options = { root: string; git?: Runner; scratch?: string };
const OID = /^[0-9a-f]{40}$/;
const refuse = (reason: LandRefusal, message: string) => ({ ok: false as const, reason, message });
const short = (oid: string) => oid.slice(0, 7);
const keyOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** A branch name as a destination may be: plain characters, no `..`, no part starting with a dot or `-`, never a
 * Toolroll work branch. */
export function landableBranch(name: string): boolean {
  if (name === "" || name === "HEAD" || name.startsWith("-") || name.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith("toolroll/")) return false;
  return name.split("/").every(part => part !== "" && !part.startsWith(".") && !part.startsWith("-") && !part.endsWith(".lock") && !part.endsWith(".")) && !name.includes("..");
}

/** The project's main checkout's real `.git` folder, or null (a link, a pointer file, missing). */
function commonDirOf(repo: string): string | null {
  try {
    const dotgit = join(realpathSync(repo), ".git");
    const held = lstatSync(dotgit);
    return held.isDirectory() && !held.isSymbolicLink() ? realpathSync(dotgit) : null;
  } catch { return null; }
}

/** The git runner every landing call uses: hardened, bound to the project's recorded main checkout. */
function gitFor(repo: string, given?: Runner) {
  const git = hardenedGit(given ?? execRun, "build", { repo });
  return (args: readonly string[], cwd = repo, timeoutMs = 60_000) => git("git", args, { cwd, timeoutMs });
}
type Git = ReturnType<typeof gitFor>;

type LedgerRow = { id: number; at: string; actor: string; outcome: string; detail: Record<string, unknown> };
function rows(store: Store, where: string, args: (string | number)[]): LedgerRow[] {
  return store.handle.prepare(`SELECT id,at,actor,outcome,detail FROM action_ledger WHERE ${where} ORDER BY id DESC`).all(...args).flatMap(row => {
    try {
      const detail = JSON.parse(String(row["detail"] ?? "null")) as unknown;
      return detail !== null && typeof detail === "object" ? [{ id: Number(row["id"]), at: String(row["at"]), actor: String(row["actor"]), outcome: String(row["outcome"]), detail: detail as Record<string, unknown> }] : [];
    } catch { return []; }
  });
}
/** The destination Toolroll recorded for this project (its newest), or null. */
export function recordedDestination(store: Store, repo: string): { ref: string; common: string } | null {
  const row = rows(store, "repo = ? AND action = ? AND source = 'request'", [repo, LAND_DESTINATION])[0];
  const ref = row?.detail["ref"], common = row?.detail["common"];
  return typeof ref === "string" && typeof common === "string" ? { ref, common } : null;
}
/** A landing's recovery record. `commit` is what the branch moves to (a squash landing's one commit, an undo's revert
 * commit, or an earlier version's fast-forwarded candidate); `candidate` the result's commit it carries (the commit itself
 * for an intent recorded before squash landing). */
type Intent = { id: number; at: string; repo: string; task: string; run: number; kind: "land" | "undo"; ref: string; old: string; commit: string; candidate: string; mode: "files" | "ref"; key: string; reverts: number | null };
function intentOf(row: LedgerRow & { repo: string; task: string; run: number }): Intent | null {
  const d = row.detail;
  if (d["v"] !== 1 || typeof d["ref"] !== "string" || typeof d["old"] !== "string" || typeof d["commit"] !== "string" || !OID.test(d["old"]) || !OID.test(d["commit"])
    || (d["mode"] !== "files" && d["mode"] !== "ref") || typeof d["key"] !== "string" || (d["kind"] !== "land" && d["kind"] !== "undo")) return null;
  const candidate = typeof d["candidate"] === "string" && OID.test(d["candidate"]) ? d["candidate"] : d["commit"];
  return { id: row.id, at: row.at, repo: row.repo, task: row.task, run: row.run, kind: d["kind"], ref: d["ref"], old: d["old"], commit: d["commit"], candidate, mode: d["mode"], key: d["key"],
    reverts: typeof d["reverts"] === "number" ? d["reverts"] : null };
}
function intents(store: Store, where: string, args: (string | number)[]): Intent[] {
  return store.handle.prepare(`SELECT id,at,actor,outcome,detail,repo,task_id,run_id FROM action_ledger WHERE ${where} AND action = ? ORDER BY id DESC`).all(...args, LAND_INTENT).flatMap(row => {
    try {
      const detail = JSON.parse(String(row["detail"] ?? "null")) as Record<string, unknown>;
      const one = intentOf({ id: Number(row["id"]), at: String(row["at"]), actor: String(row["actor"]), outcome: String(row["outcome"]), detail,
        repo: String(row["repo"]), task: String(row["task_id"]), run: Number(row["run_id"]) });
      return one === null ? [] : [one];
    } catch { return []; }
  });
}
/** How an intent settled (its newest settle row), or null while unsettled. */
function settledOf(store: Store, intent: number): { outcome: string; at: string; detail: Record<string, unknown> } | null {
  const row = rows(store, "action = ? AND outcome LIKE ?", [LAND_SETTLED, `${intent}:%`])[0];
  return row === undefined ? null : { outcome: row.outcome.slice(String(intent).length + 1), at: row.at, detail: row.detail };
}
/** The landing a task's result has, settled as landed (newest), and whether it was undone since. */
export function landingOf(store: Store, rootId: string): { intent: Intent; at: string; undone: boolean } | null {
  const all = intents(store, "task_id = ?", [rootId]);
  const landed = all.find(one => one.kind === "land" && settledOf(store, one.id)?.outcome.startsWith("landed") === true);
  if (landed === undefined) return null;
  const undone = all.some(one => one.kind === "undo" && one.reverts === landed.id && settledOf(store, one.id)?.outcome.startsWith("landed") === true);
  return { intent: landed, at: settledOf(store, landed.id)!.at, undone };
}

/** Whether a tree can land without a Git filter, a submodule or an encoding Toolroll won't run. */
async function treeProblem(git: Git, commit: string): Promise<string | null> {
  const listed = await git(["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (listed.code !== 0) return "its files couldn't be read";
  for (const entry of listed.stdout.split("\0")) {
    if (entry === "") continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(entry);
    if (match === null) return "its files couldn't be read";
    const [, mode, , oid, path] = match;
    if (mode === "160000") return "it holds a submodule";
    if (path === ".gitattributes" || path!.endsWith("/.gitattributes")) {
      const blob = await git(["cat-file", "blob", oid!]);
      if (blob.code !== 0) return "its .gitattributes couldn't be read";
      if (/\b(filter|working-tree-encoding)\s*=/.test(blob.stdout) || /(^|\s)filter(\s|$)/m.test(blob.stdout)) return "its files use a Git filter (like Git LFS) or an encoding";
    }
    if (path === ".gitmodules") return "it holds a submodule";
  }
  return null;
}

/** The checkouts of this repository standing on `ref`, as real paths. */
async function checkoutsOn(git: Git, ref: string): Promise<string[] | null> {
  const listed = await git(["worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0) return null;
  const found: string[] = [];
  let path: string | null = null;
  for (const line of listed.stdout.split("\0")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch ${ref}` && path !== null) { try { found.push(realpathSync(path)); } catch { found.push(path); } }
  }
  return found;
}

/** Where the destination stands now. `old`, when given, is the commit it must be at. */
type Place =
  | { kind: "problem"; reason: LandRefusal; message: string }
  | { kind: "free" }
  | { kind: "here" }
  | { kind: "busy"; folder: string; why: string };

/** Git operations whose files in the git folder mean one is in progress (or the index is locked). */
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "sequencer", "index.lock"];

/** Whether the project folder can take the landing in place: HEAD names exactly `ref` at `old`, no git operation is in
 * progress, and nothing is staged, changed or untracked. Null when it can; else why not, in words. */
async function folderProblem(git: Git, project: { repo: string; common: string }, ref: string, old: string): Promise<string | null> {
  const head = await git(["symbolic-ref", "-q", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== ref) return "it's on another branch now";
  const at = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (at.code !== 0 || at.stdout.trim() !== old) return "its branch moved";
  for (const name of IN_PROGRESS) {
    try { lstatSync(join(project.common, name)); return name === "index.lock" ? "git is busy in it (an index lock)" : "a merge, rebase or other git operation is in progress there"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "its git folder couldn't be read"; }
  }
  const status = await git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return "its changes couldn't be read";
  if (status.stdout !== "") return "it has changes of its own (staged, changed or untracked files)";
  return null;
}

/** A file the change from `from` to `to` adds that something git doesn't track (an ignored file, a link, a folder)
 * already occupies in the project folder, or a folder on its way that isn't a plain folder: git's `read-tree -u` would
 * overwrite it, so the folder can't take the change in place. Null when nothing is in the way; else the path. */
async function inTheWay(git: Git, project: { repo: string }, from: string, to: string): Promise<string | null> {
  const added = await git(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", from, to]);
  if (added.code !== 0) return "(the change couldn't be read)";
  const folder = realpathSync(project.repo);
  for (const path of added.stdout.split("\0")) {
    if (path === "") continue;
    const parts = path.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      let held: ReturnType<typeof lstatSync>;
      try { held = lstatSync(join(folder, ...parts.slice(0, depth))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; return path; }
      if (depth === parts.length || !held.isDirectory() || held.isSymbolicLink()) return path;
    }
  }
  return null;
}

/** Where `ref` stands: symbolic, moved from `old`, or unreadable is a problem; else free (checked out nowhere), here
 * (checked out only in the project folder, which can take it in place) or busy (checked out with changes, or in
 * another folder). */
async function placeOf(git: Git, project: { repo: string; common: string }, ref: string, old: string | null, to: string | null = null): Promise<Place> {
  const branch = ref.slice("refs/heads/".length);
  const symbolic = await git(["symbolic-ref", "-q", ref]);
  if (symbolic.code === 0) return { kind: "problem", reason: "destination", message: `${branch} points at another branch (${symbolic.stdout.trim().replace(/^refs\/heads\//, "")}), so Toolroll won't move it. Land it with git yourself.` };
  if (symbolic.code !== 1) return { kind: "problem", reason: "git", message: `Toolroll couldn't read ${branch}.` };
  const read = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  const now = read.stdout.trim();
  if (old !== null && (read.code !== 0 || now !== old)) return { kind: "problem", reason: "moved", message: `${branch} moved since you looked. Look again, then land it.` };
  const on = await checkoutsOn(git, ref);
  if (on === null) return { kind: "problem", reason: "git", message: "Toolroll couldn't list this project's checkouts." };
  if (on.length === 0) return { kind: "free" };
  let repoReal = project.repo;
  try { repoReal = realpathSync(project.repo); } catch { /* compared as recorded */ }
  if (on.length !== 1 || on[0] !== repoReal) return { kind: "busy", folder: on.find(one => one !== repoReal) ?? on[0]!, why: `${branch} is checked out in another folder` };
  const blocked = to === null ? null : await inTheWay(git, project, old ?? now, to);
  const problem = await folderProblem(git, project, ref, old ?? now) ?? (blocked === null ? null : `a file it adds is already there, not tracked (${blocked})`);
  return problem === null ? { kind: "here" } : { kind: "busy", folder: project.repo, why: `your project folder has ${branch} checked out and ${problem}` };
}

/** The handoff ref for a task's landing commit: refs/toolroll/land/<task>, the id made ref-safe. */
export function handoffRefOf(taskId: string): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(taskId) && !taskId.includes("..") && !taskId.endsWith(".lock") && !taskId.endsWith(".") ? taskId
    : createHash("sha256").update(taskId).digest("hex").slice(0, 16);
  return `refs/toolroll/land/${safe}`;
}

/** The project's main checkout, as Toolroll recorded it, with its repository folder. */
function projectOf(store: Store, repo: string | null): { repo: string; common: string } | null {
  if (repo === null || !store.knownRepos().includes(repo)) return null;
  const common = commonDirOf(repo);
  return common === null ? null : { repo, common };
}

/** Whether this project's work goes through pull requests (any publication grant at all, read fail-closed): then local
 * landing would put work on its branch around that road and its checks, so it never lands or undoes here. */
export function publishesThroughPullRequests(store: Store, repo: string): boolean {
  try { return publishingOf(store, repo).on || store.publicationGrantFor(repo) !== null; } catch { return true; }
}
export const PULL_REQUESTS_INSTEAD = "This project publishes through pull requests; open one from the task instead.";

const ALREADY_MSG = (ref: string, commit: string) => `Already on ${ref.replace(/^refs\/heads\//, "")} (${short(commit)}).`;

/**
 * What landing this task's accepted result would do, read now; nothing is written. `into` names another branch than
 * the recorded (or proposed) one; the yes then records it.
 */
export async function readLanding(store: Store, taskId: string, access: { repos: readonly string[] | null }, now: Date, options: Options & { into?: string; undo?: boolean }): Promise<LandingRead> {
  const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: access.repos, includeUnplaced: false }, options.root);
  if (assignment === null) return refuse("not-found", `No task \`${taskId}\` in your projects.`);
  if (assignment.repo !== null && publishesThroughPullRequests(store, assignment.repo)) return refuse("pull-requests", PULL_REQUESTS_INSTEAD);
  const project = projectOf(store, assignment.repo);
  if (project === null) return refuse("destination", "This task's project isn't a local Git folder Toolroll can land in.");
  const git = gitFor(project.repo, options.git);
  if (options.undo === true) return readUndo(store, assignment.rootId, project, git, options);
  const receipt = assignment.receipt;
  if (assignment.state !== "complete" || assignment.completion === null || receipt === null) return refuse("not-complete", "Accept it first: only accepted work lands.");
  if (assignment.completion.digest !== receipt.digest) return refuse("checks", "Its checks read differently since you accepted it. Run checks again, then land it.");
  const candidate = receipt.head;
  if (candidate === null || !OID.test(candidate) || receipt.completionKind === "research-report") return refuse("nothing", "This result has no commit to land.");
  const landed = landingOf(store, assignment.rootId);
  if (landed !== null && !landed.undone && landed.intent.candidate === candidate) return { ok: true, landed: { at: landed.at, ref: landed.intent.ref, commit: landed.intent.commit, mode: landed.intent.mode } };
  // Exactly checked: the sealed receipt's check passed on this commit (verification-evidence.ts binds it to the head), or
  // the project has no check command at all.
  const checks = receipt.checks.status === "passed" ? "passed" as const : !projectCheckSet(store, project.repo) && receipt.checks.status === "not-run" ? "none" as const : null;
  if (checks === null) return refuse("checks", receipt.checks.status === "failed" ? "Its checks failed. Only work whose checks passed on its exact commit lands." : "Its checks haven't passed on its exact commit. Run checks, then land it.");
  const destination = await destinationOf(store, project, git, options.into);
  if (!destination.ok) return destination;
  // The family's start the reviewed change ran from (task-base.ts), from Toolroll's run record: bound, for the record.
  const run = store.getRun(receipt.runId);
  const base = run === null || run.branch === null ? null : wholeChangeBaseOf(store, run.taskRef, run.branch) ?? run.baseRevision;
  return planFor(git, project, destination, { kind: "land", taskId: receipt.taskId, rootId: assignment.rootId, runId: receipt.runId, receipt: receipt.digest, candidate, checks,
    bindings: checkBindingsOf(store, project.repo) }, { base, message: squashMessage(store.getTask(receipt.taskId)?.title ?? null, receipt.taskId) });
}

async function destinationOf(store: Store, project: { repo: string; common: string }, git: Git, into: string | undefined): Promise<{ ok: true; ref: string; recorded: boolean } | { ok: false; reason: LandRefusal; message: string }> {
  const recorded = recordedDestination(store, project.repo);
  if (into !== undefined) {
    if (!landableBranch(into)) return refuse("destination", `\`${into}\` isn't a branch Toolroll can land on.`);
    const ref = `refs/heads/${into}`;
    return { ok: true, ref, recorded: recorded?.ref === ref && recorded.common === project.common };
  }
  if (recorded !== null && recorded.common === project.common) return { ok: true, ref: recorded.ref, recorded: true };
  // Nothing recorded: propose the branch the project's folder stands on. It is only a proposal: the person sees it, and
  // their yes records exactly it.
  const head = await git(["symbolic-ref", "-q", "HEAD"]);
  const ref = head.stdout.trim();
  if (head.code !== 0 || !ref.startsWith("refs/heads/") || !landableBranch(ref.slice("refs/heads/".length))) {
    return refuse("destination", "Your project folder isn't on a branch Toolroll can land on. Name one: --into <branch>.");
  }
  return { ok: true, ref, recorded: false };
}

// eslint-disable-next-line no-control-regex
const UNSAFE_MESSAGE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;
/** The one landed commit's message: "<task title> (Toolroll task <id>)", one plain line. */
function squashMessage(title: string | null, taskId: string): string {
  // Every character that could restyle or reorder what a terminal shows (UNSAFE_SHOWN, the backslash aside) becomes a
  // space, so `git log` in the person's terminal is as safe as the yes.
  const plain = (text: string) => text.replace(UNSAFE_MESSAGE, " ").replace(/\s+/g, " ").trim();
  const line = plain(title ?? "").slice(0, 200), id = plain(taskId).slice(0, 100);
  return line === "" ? `Toolroll task ${id}` : `${line} (Toolroll task ${id})`;
}

/** What landing `candidate` on `old` changes, file by file: names, count and lines added and removed. */
async function changesOf(git: Git, old: string, candidate: string): Promise<Pick<Squash, "files" | "fileCount" | "added" | "removed"> | null> {
  const stat = await git(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", old, candidate]);
  if (stat.code !== 0) return null;
  const files: string[] = [];
  let added = 0, removed = 0;
  for (const entry of stat.stdout.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (match === null) continue;
    added += match[1] === "-" ? 0 : Number(match[1]);
    removed += match[2] === "-" ? 0 : Number(match[2]);
    files.push(match[3]!);
  }
  return { files: files.slice(0, 20), fileCount: files.length, added, removed };
}

async function planFor(git: Git, project: { repo: string; common: string }, destination: { ref: string; recorded: boolean },
  fixed: Pick<LandingPlan, "kind" | "taskId" | "rootId" | "runId" | "receipt" | "candidate" | "checks" | "reverts" | "bindings">,
  squashing: { base: string | null; message: string } | null = null): Promise<LandingRead> {
  const { ref } = destination;
  const branch = ref.slice("refs/heads/".length);
  const read = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  const old = read.stdout.trim();
  if (read.code !== 0 || !OID.test(old)) return refuse("destination", `There's no branch \`${branch}\` in this project.`);
  if (fixed.candidate !== null) {
    if (old === fixed.candidate) return refuse("nothing", ALREADY_MSG(ref, old));
    const type = await git(["cat-file", "-t", fixed.candidate]);
    if (type.code !== 0 || type.stdout.trim() !== "commit") return refuse("git", `This result's commit ${short(fixed.candidate)} is no longer in the project.`);
    const ancestor = await git(["merge-base", "--is-ancestor", old, fixed.candidate]);
    if (ancestor.code === 1) {
      return refuse("moved", `${branch} moved on since this work started (it's at ${short(old)} now): bring this task up to date first. `
        + `Send it back to build on the current ${branch}; landing it as it is would drop or mix in changes nobody checked together.`);
    }
    if (ancestor.code !== 0) return refuse("git", "Toolroll couldn't compare the commits.");
    const problem = await treeProblem(git, fixed.candidate) ?? await treeProblem(git, old);
    if (problem !== null) return refuse("unsupported", `This project can't be landed by Toolroll: ${problem}. Land it with git yourself.`);
  }
  let squash: Squash | null = null;
  if (fixed.candidate !== null) {
    const tree = await git(["rev-parse", "--verify", "-q", `${fixed.candidate}^{tree}`]);
    const changes = await changesOf(git, old, fixed.candidate);
    if (tree.code !== 0 || !OID.test(tree.stdout.trim()) || changes === null) return refuse("git", `Toolroll couldn't read what ${short(fixed.candidate)} changes.`);
    squash = { policy: "squash", base: squashing?.base ?? null, tree: tree.stdout.trim(), message: squashing?.message ?? `Toolroll task ${fixed.taskId}`, ...changes };
  }
  const place = await placeOf(git, project, ref, old, fixed.candidate ?? fixed.reverts!.old);
  if (place.kind === "problem") return refuse(place.reason, place.message);
  // An undo over a busy checkout: the person reverts it there (Toolroll touches no checkout with changes).
  if (place.kind === "busy" && fixed.kind === "undo") return refuse("occupied", `${place.why[0]!.toUpperCase()}${place.why.slice(1)}, so Toolroll won't touch its files. To do it yourself there: git -C ${place.folder} revert --no-edit ${fixed.reverts!.old}..${fixed.reverts!.landed}`);
  const mode = place.kind === "free" ? "ref" as const : place.kind === "here" ? "files" as const : "handoff" as const;
  const plan: Omit<LandingPlan, "key"> = { ...fixed, squash, repo: project.repo, ref, branch, old, mode, ...(place.kind === "busy" ? { handoff: { folder: place.folder, why: place.why } } : {}), recorded: destination.recorded };
  return { ok: true, plan: { ...plan, key: keyOf({ v: 1, ...plan, common: project.common }) } };
}

async function readUndo(store: Store, rootId: string, project: { repo: string; common: string }, git: Git, options: Options): Promise<LandingRead> {
  void options;
  const landed = landingOf(store, rootId);
  if (landed === null || landed.undone) return refuse("nothing", landed === null ? "This task hasn't landed, so there's nothing to undo." : "This landing was already undone.");
  const destination = { ref: landed.intent.ref, recorded: true };
  return planFor(git, project, destination, { kind: "undo", taskId: landed.intent.task, rootId, runId: landed.intent.run, receipt: landed.intent.key, candidate: null, checks: "none",
    reverts: { intent: landed.intent.id, old: landed.intent.old, landed: landed.intent.commit }, bindings: checkBindingsOf(store, project.repo) });
}

/** Characters that could restyle, reorder or rewrite what a person reads before saying yes (terminal escapes, C0/C1
 * controls, DEL, line and paragraph separators, bidi and zero-width marks). */
// eslint-disable-next-line no-control-regex
const UNSAFE_SHOWN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\\]/g;
/** A file name or folder as the yes shows it: every such character (and the backslash) written as a visible escape, so
 * nothing in an agent-written name can spoof the screen. Display only: the key binds the raw names. */
export function shownName(name: string): string {
  return name.replace(UNSAFE_SHOWN, ch => ch === "\\" ? "\\\\" : `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}

/** The lines a person reads before saying yes. */
export function landingWords(plan: LandingPlan): string[] {
  const how = plan.mode === "files" ? `your project folder is on ${plan.branch} with no changes of its own, so its files are updated too`
    : plan.mode === "handoff" ? `${shownName(plan.handoff!.why)}, so Toolroll won't touch its files: Land makes the commit and shows the one git command to bring it in`
    : `no folder has ${plan.branch} checked out; only the branch moves`;
  if (plan.kind === "undo") {
    return [`Undo the landing of ${short(plan.reverts!.landed)} on ${plan.branch} in ${shownName(plan.repo)} (${how}).`,
      "A new commit reverts exactly what it changed; nothing is rewritten. No check runs on the undo."];
  }
  const squash = plan.squash!;
  const names = squash.files.slice(0, 3).map(shownName).join(", ") + (squash.fileCount > 3 ? ` and ${squash.fileCount - 3} more` : "");
  return [`Lands 1 commit on ${plan.branch}: ${squash.fileCount === 0 ? "no file changes" : names} (+${squash.added} −${squash.removed}).`,
    `"${shownName(squash.message)}", on top of ${short(plan.old)} in ${shownName(plan.repo)} (${how}).`,
    plan.checks === "passed" ? `Checks passed on ${short(plan.candidate!)}, whose files it lands exactly.` : "No check ran: this project has no check command.",
    ...(plan.recorded ? [] : [`Toolroll remembers ${plan.branch} as where this project's work lands.`])];
}

/** Settle intents an earlier landing left unsettled (a crash between git and the record), from what the branch shows
 * now: only recorded, never repaired (no checkout's files are touched). A symbolic destination, or a branch neither
 * before nor after, is left to the person. Only `land` calls it, after proving the caller may land in this project. */
async function settleUnfinished(store: Store, repo: string, now: Date, options: Options): Promise<void> {
  const project = projectOf(store, repo);
  if (project === null) return;
  const git = gitFor(repo, options.git);
  for (const intent of intents(store, "repo = ?", [repo]).filter(one => settledOf(store, one.id) === null)) {
    const symbolic = await git(["symbolic-ref", "-q", intent.ref]);
    const read = await git(["rev-parse", "--verify", "-q", `${intent.ref}^{commit}`]);
    const at = read.stdout.trim();
    let outcome: string, words: string;
    if (symbolic.code !== 1) { outcome = "needs-person"; words = `${intent.ref.replace(/^refs\/heads\//, "")} now points at another branch or can't be read. Look at ${repo} with git log.`; }
    else if (at === intent.old) { outcome = "abandoned"; words = "It stopped before the branch moved; nothing changed."; }
    // A landing that also moves the folder's files: recorded as landed only when the folder reads clean on that branch
    // (its files came along); otherwise its files are the person's to look at. Read only: nothing is repaired.
    else if (at === intent.commit && intent.mode === "files") {
      const clean = await folderProblem(git, project, intent.ref, intent.commit) === null;
      if (clean) { outcome = "landed:recovered"; words = "It had finished, files included; recorded now."; }
      else { outcome = "needs-person"; words = `The branch moved to ${short(intent.commit)}; check your folder's files with git status in ${repo}.`; }
    }
    else if (at === intent.commit) { outcome = "landed:recovered"; words = "It had finished; recorded now."; }
    else { outcome = "needs-person"; words = `The branch is at ${OID.test(at) ? short(at) : "an unreadable commit"} now, neither before nor after the landing. Look at ${repo} with git log.`; }
    recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo, taskId: intent.task, runId: intent.run, action: LAND_SETTLED, outcome: `${intent.id}:${outcome}`, source: "work" }, { v: 1, words });
  }
}

/** Who stands behind the act right now (re-read at the moment of use), or why not. */
function standing(store: Store, authority: LandAuthority, repo: string): { ok: true; actor: string } | { ok: false; reason: LandRefusal; message: string } {
  if (authority.kind === "local") {
    const local = localActNow(store, "land-task");
    if (local === null) return refuse("authority", LOCAL_OWNER_LAPSED);
    const proved = verifyApproverStanding(store, local.account, local.accountGeneration, store.knownRepos().filter(one => store.accountCanAccess(local.account, one)));
    if (!proved.ok || !store.accountCanAccess(local.account, repo)) return refuse("authority", LOCAL_OWNER_LAPSED);
    return { ok: true, actor: `operator:${local.account}` };
  }
  const proved = reproveApprover(store, authority.who);
  if (!proved.ok || !authority.who.repos.includes(repo) || !store.accountCanAccess(authority.who.name, repo)) return refuse("authority", "Your access changed. Sign in again.");
  return { ok: true, actor: `operator:${authority.who.name}` };
}

const projectLocks = new Map<string, Promise<unknown>>();
/** One landing at a time per project in this process (the durable lock is the unsettled intent). */
async function locked<T>(repo: string, body: () => Promise<T>): Promise<T> {
  const before = projectLocks.get(repo) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  const chained = before.then(() => mine);
  projectLocks.set(repo, chained);
  await before.catch(() => undefined);
  try { return await body(); } finally { release(); if (projectLocks.get(repo) === chained) projectLocks.delete(repo); }
}

/**
 * The yes: land (or undo) exactly the plan whose `key` the person read. Everything is read again; a different key is
 * stale. The same key after it landed answers "already" and writes nothing.
 */
export async function land(store: Store, taskId: string, input: { key: string; into?: string; undo?: boolean }, authority: LandAuthority, access: { repos: readonly string[] | null },
  now: Date, options: Options): Promise<LandResult> {
  if (!/^[0-9a-f]{16}$/.test(input.key)) return refuse("stale", "That landing isn't the one on screen. Look again, then land it.");
  const ref = store.lookupRef(taskId);
  const repo = ref?.repo ?? null;
  if (repo === null || (access.repos !== null && !access.repos.includes(repo))) return refuse("not-found", `No task \`${taskId}\` in your projects.`);
  // Who may land here, before anything is read from git or settled: a person without this project never even triggers
  // another landing's recovery.
  const first = standing(store, authority, repo);
  if (!first.ok) return first;
  if (publishesThroughPullRequests(store, repo)) return refuse("pull-requests", PULL_REQUESTS_INSTEAD);
  // A symbolic destination, refused before the lock too (and at the look, and right before the write).
  const named = input.into !== undefined && landableBranch(input.into) ? `refs/heads/${input.into}` : recordedDestination(store, repo)?.ref ?? null;
  if (named !== null && projectOf(store, repo) !== null) {
    const symbolic = await gitFor(repo, options.git)(["symbolic-ref", "-q", named]);
    if (symbolic.code === 0) return refuse("destination", `${named.replace(/^refs\/heads\//, "")} points at another branch, so Toolroll won't move it. Land it with git yourself.`);
  }
  return locked(repo, async (): Promise<LandResult> => {
    // The same yes again: recognised from its record, re-proved, writing nothing.
    const done = intents(store, "repo = ? AND task_id IS NOT NULL", [repo]).find(one => one.key === input.key);
    if (done !== undefined) {
      const settled = settledOf(store, done.id);
      if (settled?.outcome.startsWith("landed") === true) {
        const who = standing(store, authority, repo);
        if (!who.ok) return who;
        return { ok: true, replayed: true, kind: done.kind, ref: done.ref, branch: done.ref.slice("refs/heads/".length), commit: done.commit, old: done.old, mode: done.mode, warning: null, handoff: null };
      }
    }
    // The same yes to a handoff: the commit it made, kept, and its command again (the key pins the task and destination).
    const handedOff = handoffsOf(store, repo).find(one => one.key === input.key);
    if (handedOff !== undefined) {
      const who = standing(store, authority, repo);
      if (!who.ok) return who;
      return { ok: true, replayed: true, kind: "land", ref: handedOff.ref, branch: handedOff.ref.slice("refs/heads/".length), commit: handedOff.commit, old: handedOff.old, mode: "handoff", warning: null,
        handoff: { ref: handedOff.keep, command: handoffCommand(handedOff.folder, handedOff.commit) } };
    }
    await settleUnfinished(store, repo, now, options);
    const read = await readLanding(store, taskId, access, now, { ...options, ...(input.into === undefined ? {} : { into: input.into }), ...(input.undo === true ? { undo: true } : {}) });
    if (!read.ok) return read;
    if (!("plan" in read)) return refuse("nothing", ALREADY_MSG(read.landed.ref, read.landed.commit));
    const plan = read.plan;
    if (plan.key !== input.key) return refuse("stale", "Something changed since you looked (the branch, the checks or the result). Look again, then land it.");
    const project = projectOf(store, plan.repo)!;
    const git = gitFor(plan.repo, options.git);
    /** Everything the yes rests on, read again (inside the caller's transaction): the person's authority, the
     * pull-request policy, the exact receipt (or the landing an undo reverts) and the check bindings. */
    const stillStands = (): { ok: true; actor: string } | { ok: false; reason: LandRefusal; message: string } => {
      const who = standing(store, authority, plan.repo);
      if (!who.ok) return who;
      if (publishesThroughPullRequests(store, plan.repo)) return refuse("pull-requests", PULL_REQUESTS_INSTEAD);
      if (plan.kind === "land") {
        const again = assignmentOf(store, taskId, now, { principal: "operator", repos: access.repos }, options.root);
        if (again?.state !== "complete" || again.receipt?.digest !== plan.receipt || again.completion?.digest !== plan.receipt) return refuse("stale", "This result changed since you looked. Look again, then land it.");
      } else {
        const landed = landingOf(store, plan.rootId);
        if (landed === null || landed.undone || landed.intent.id !== plan.reverts?.intent) return refuse("stale", "That landing changed since you looked. Look again.");
      }
      if (JSON.stringify(checkBindingsOf(store, plan.repo)) !== JSON.stringify(plan.bindings)) return refuse("stale", "The project's checks changed since you looked. Look again, then land it.");
      return who;
    };
    // The commit the branch moves to is made now, from what the person read, only for someone who may land here
    // (proved again with the intent below): a landing's one commit (the candidate's tree on the branch's commit, no
    // checkout involved), or the undo's revert, in a temporary checkout of its own.
    const pre = standing(store, authority, plan.repo);
    if (!pre.ok) return pre;
    const made = plan.kind === "undo" ? await revertCommit(git, plan, options.scratch) : await squashCommit(git, plan);
    if (!made.ok) return made;
    const commit = made.commit;
    // Checked out with changes (or elsewhere): no checkout is touched. The commit is kept at the handoff ref, recorded,
    // and the person brings it in with the exact command; the destination itself never moves here.
    if (plan.mode === "handoff") {
      const place = await placeOf(git, project, plan.ref, plan.old);
      if (place.kind !== "busy") return refuse(place.kind === "problem" ? place.reason : "stale", place.kind === "problem" ? place.message : "Your project folder changed since you looked. Look again, then land it.");
      const keep = handoffRefOf(plan.rootId);
      try {
        store.transact(() => {
          const who = stillStands();
          if (!who.ok) throw new Refused(who);
          if (!plan.recorded) recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: null, runId: null, action: LAND_DESTINATION, outcome: plan.ref, source: "request" },
            { v: 1, ref: plan.ref, common: project.common });
          recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: plan.rootId, runId: plan.runId, action: LAND_HANDOFF, outcome: commit, source: "request" },
            { v: 1, key: plan.key, ref: plan.ref, old: plan.old, commit, keep, folder: place.folder, policy: "squash", candidate: plan.candidate, base: plan.squash!.base, tree: plan.squash!.tree, checks: plan.checks });
        });
      } catch (error) {
        if (error instanceof Refused) return error.result;
        throw error;
      }
      const kept = await git(["update-ref", "--no-deref", "-m", `toolroll: landing commit for ${plan.taskId}`, keep, commit]);
      if (kept.code !== 0) return refuse("git", "Toolroll made the landing commit but couldn't keep it. Look again, then land it.");
      return { ok: true, replayed: false, kind: "land", ref: plan.ref, branch: plan.branch, commit, old: plan.old, mode: "handoff", warning: null,
        handoff: { ref: keep, command: handoffCommand(place.folder, commit) } };
    }
    // The intent, with everything re-read in one transaction (the durable lock: one unsettled intent per project).
    let intentId: number;
    try {
      intentId = store.transact(() => {
        const who = stillStands();
        if (!who.ok) throw new Refused(who);
        if (intents(store, "repo = ?", [plan.repo]).some(one => settledOf(store, one.id) === null)) throw new Refused(refuse("busy", "Another landing in this project hasn't finished. Try again in a moment."));
        if (!plan.recorded) recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: null, runId: null, action: LAND_DESTINATION, outcome: plan.ref, source: "request" },
          { v: 1, ref: plan.ref, common: project.common });
        return recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: plan.rootId, runId: plan.runId, action: LAND_INTENT, outcome: "pending", source: "request" },
          { v: 1, kind: plan.kind, key: plan.key, ref: plan.ref, old: plan.old, commit, mode: plan.mode, ...(plan.reverts === undefined ? {} : { reverts: plan.reverts.intent }),
            ...(plan.squash === null ? {} : { policy: "squash", candidate: plan.candidate, base: plan.squash.base, tree: plan.squash.tree, checks: plan.checks }) });
      });
    } catch (error) {
      if (error instanceof Refused) return error.result;
      throw error;
    }
    const settle = (outcome: string, words: string) => recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo: plan.repo, taskId: plan.rootId, runId: plan.runId,
      action: LAND_SETTLED, outcome: `${intentId}:${outcome}`, source: "work" }, { v: 1, words });
    // Right before the write: the branch again (real, at `old`, and standing exactly where it stood at the look: checked
    // out nowhere, or in the project folder, still completely clean), then, in one transaction, everything the yes rests
    // on. The write itself never follows a symbolic ref and refuses a moved branch.
    const place = await placeOf(git, project, plan.ref, plan.old, commit);
    const expected = plan.mode === "files" ? "here" : "free";
    if (place.kind !== expected) {
      const words = place.kind === "problem" ? place.message : place.kind === "busy" ? `${place.why[0]!.toUpperCase()}${place.why.slice(1)} now, so Toolroll won't touch its files. Look again, then land it.`
        : `${plan.branch} changed where it's checked out since you looked. Look again, then land it.`;
      const reason: LandRefusal = place.kind === "problem" ? place.reason : place.kind === "busy" ? "dirty" : "stale";
      settle("refused", words);
      return refuse(reason, words);
    }
    const last = store.transact(stillStands);
    if (!last.ok) { settle("refused", last.message); return last; }
    const swapped = await git(["update-ref", "--no-deref", "-m", `toolroll: land ${plan.taskId}`, plan.ref, commit, plan.old]);
    if (swapped.code !== 0) {
      const words = `${plan.branch} moved while landing, so nothing changed. Look again, then land it.`;
      settle("refused", words);
      return refuse("moved", words);
    }
    if (plan.mode === "files") {
      // The folder's index and files follow, from exactly `old` to exactly the commit: git refuses to overwrite any file
      // it doesn't track (ignored ones included) or one changed since. If it can't, the branch goes back (the same swap).
      const followed = await git(["read-tree", "-m", "-u", plan.old, commit]);
      if (followed.code !== 0) {
        const back = await git(["update-ref", "--no-deref", "-m", `toolroll: land ${plan.taskId} (back)`, plan.ref, plan.old, commit]);
        const words = back.code === 0 ? `Your project folder's files couldn't be updated (a file in the way or changed), so ${plan.branch} went back and nothing changed. Look again, then land it.`
          : `Your project folder's files couldn't be updated, and ${plan.branch} couldn't be put back. Look at ${plan.repo} with git status.`;
        settle(back.code === 0 ? "refused" : "needs-person", words);
        return refuse("dirty", words);
      }
    }
    settle("landed", plan.kind === "undo" ? "Undone." : "Landed.");
    return { ok: true, replayed: false, kind: plan.kind, ref: plan.ref, branch: plan.branch, commit, old: plan.old, mode: plan.mode, warning: null, handoff: null };
  });
}

/** The exact command that brings a handed-off landing commit onto the branch checked out in `folder`. */
function handoffCommand(folder: string, commit: string): string {
  return `git -C ${shownName(folder)} merge --ff-only ${commit}`;
}

type Handoff = { id: number; task: string; key: string; ref: string; old: string; commit: string; keep: string; folder: string; candidate: string };
/** The landing commits Toolroll made for people to bring in themselves, newest first. */
export function handoffsOf(store: Store, repo: string, taskId?: string): Handoff[] {
  return store.handle.prepare(`SELECT id,detail,task_id FROM action_ledger WHERE repo = ? AND action = ?${taskId === undefined ? "" : " AND task_id = ?"} ORDER BY id DESC`)
    .all(...(taskId === undefined ? [repo, LAND_HANDOFF] : [repo, LAND_HANDOFF, taskId])).flatMap(row => {
      try {
        const d = JSON.parse(String(row["detail"] ?? "null")) as Record<string, unknown>;
        const ok = d["v"] === 1 && typeof d["key"] === "string" && typeof d["ref"] === "string" && typeof d["old"] === "string" && OID.test(d["old"]) && typeof d["commit"] === "string" && OID.test(d["commit"])
          && typeof d["keep"] === "string" && typeof d["folder"] === "string" && typeof d["candidate"] === "string" && OID.test(d["candidate"]);
        return ok ? [{ id: Number(row["id"]), task: String(row["task_id"]), key: d["key"] as string, ref: d["ref"] as string, old: d["old"] as string, commit: d["commit"] as string,
          keep: d["keep"] as string, folder: d["folder"] as string, candidate: d["candidate"] as string }] : [];
      } catch { return []; }
    });
}

class Refused extends Error {
  constructor(readonly result: { ok: false; reason: LandRefusal; message: string }) { super(result.message); }
}

/** The landing's one commit: exactly the candidate's tree, its only parent the branch's commit as read, the message the
 * person read. Written as an object only (`commit-tree`: no checkout, index or ref is touched); checked back before use. */
async function squashCommit(git: Git, plan: LandingPlan): Promise<{ ok: true; commit: string } | { ok: false; reason: LandRefusal; message: string }> {
  const squash = plan.squash!;
  const identity = ["-c", "user.name=Toolroll", "-c", "user.email=land@toolroll.invalid", "-c", "commit.gpgsign=false"];
  const made = await git([...identity, "commit-tree", squash.tree, "-p", plan.old, "-m", squash.message]);
  const commit = made.stdout.trim();
  if (made.code !== 0 || !OID.test(commit)) return refuse("git", "Toolroll couldn't make the landing commit.");
  const shown = await git(["cat-file", "commit", commit]);
  const header = shown.stdout.split("\n\n")[0] ?? "";
  const parents = header.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice("parent ".length));
  if (shown.code !== 0 || !header.startsWith(`tree ${squash.tree}\n`) || parents.length !== 1 || parents[0] !== plan.old) return refuse("git", "Toolroll couldn't make the landing commit.");
  return { ok: true, commit };
}

/** A commit on the branch's current commit that reverts exactly the landed range, made in a temporary detached checkout
 * (no hooks, no signing) that is always removed. */
async function revertCommit(git: Git, plan: LandingPlan, scratch?: string): Promise<{ ok: true; commit: string } | { ok: false; reason: LandRefusal; message: string }> {
  const reverts = plan.reverts!;
  const folder = mkdtempSync(join(scratch ?? tmpdir(), "toolroll-undo-"));
  const checkout = join(folder, "checkout");
  let added = false;
  try {
    const add = await git(["worktree", "add", "--detach", checkout, plan.old]);
    added = add.code === 0;
    if (!added) return refuse("git", "Toolroll couldn't make a temporary checkout for the undo.");
    const identity = ["-c", "user.name=Toolroll", "-c", "user.email=undo@toolroll.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    const reverted = await git([...identity, "revert", "--no-edit", "--no-commit", `${reverts.old}..${reverts.landed}`], checkout);
    if (reverted.code !== 0) {
      await git(["revert", "--abort"], checkout);
      return refuse("moved", `Undoing it conflicts with later changes on ${plan.branch}. To undo it yourself: git -C ${plan.repo} revert ${reverts.old}..${reverts.landed}`);
    }
    const committed = await git([...identity, "commit", "--no-verify", "--allow-empty", "-m", `Undo landing of ${plan.taskId} (${short(reverts.old)}..${short(reverts.landed)})`], checkout);
    const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], checkout);
    const commit = head.stdout.trim();
    if (committed.code !== 0 || head.code !== 0 || !OID.test(commit)) return refuse("git", "Toolroll couldn't make the undo commit.");
    return { ok: true, commit };
  } finally {
    if (added) await git(["worktree", "remove", checkout]).catch(() => null);
    rmSync(folder, { recursive: true, force: true });
    await git(["worktree", "prune"]).catch(() => null);
  }
}

/** A landing's settled words for a task page: "Landed on main (abc1234)", or null. */
export function landedWords(store: Store, rootId: string): string | null {
  const landed = landingOf(store, rootId);
  if (landed === null) return null;
  return landed.undone ? `Landed on ${landed.intent.ref.replace(/^refs\/heads\//, "")} (${short(landed.intent.commit)}), then undone.`
    : `Landed on ${landed.intent.ref.replace(/^refs\/heads\//, "")} (${short(landed.intent.commit)}).`;
}

