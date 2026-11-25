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
 *   (everyday-9 A1, "squash"): exactly the tree its checks passed on, its only parent the destination's current commit,
 *   so rejected attempts' commits never reach the branch. Only when the destination's commit is an ancestor of the
 *   candidate (the fast-forward condition), so nothing on the branch is ever dropped; when the branch moved past the
 *   work's start, nothing lands and the person is told to bring the task up to date first. The commit is deterministic
 *   (fixed identity, the completion's own time, the message shown): its id is computed at the look, before anything is
 *   written, and is part of what the person says yes to, with its tree, the tree the checks ran on, the candidate, the
 *   family's start and "squash". The yes writes exactly those bytes (`hash-object`, checked back to the same id and
 *   tree), keeps the commit at refs/toolroll/land/<task>, and records it before the branch moves.
 * - Every git call goes through the hardened helper (teardown-git.ts: no hooks, no config includes or commands, no
 *   global or system config), bound to the project's recorded main checkout. A repository whose config names a
 *   command, or whose files need Git filters (Git LFS, encodings) or hold submodules, is refused, never altered.
 * - Toolroll moves only an UNOCCUPIED branch, and never touches any checkout's index or files. A destination checked out
 *   in the project folder gets a handoff (everyday-9 A1): the yes makes the commit, keeps it at refs/toolroll/land/<task>
 *   (recorded pending, the ref created with a compare-and-swap, then settled) and shows the exact
 *   `git -C '<folder>' merge --ff-only <commit>`; once the branch contains it, an authorized reconcile records it as
 *   landed so Undo works (it never grants acceptance). Checked out in any other folder: refused, with no command to
 *   run there. Nothing is ever stashed, forced or reset. A symbolic destination (a ref that names another branch) is
 *   refused at the look, before the lock and right before the write.
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
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
/** A landing commit made for the person to bring in themselves (the destination was checked out): recorded pending,
 * then settled once its commit is kept at its ref. */
export const LAND_HANDOFF = "land handoff";
export const LAND_HANDOFF_SETTLED = "land handoff settled";

/** Who lands: a person proved by password (or a browser session's approver), or this computer's local owner acting as
 * exactly `land-task` (the same authority as Accept on a solo install). */
export type LandAuthority = { kind: "person"; who: VerifiedApprover } | { kind: "local" };

export type LandingPlan = {
  kind: "land" | "undo";
  taskId: string; rootId: string; runId: number; receipt: string;
  /** land: the completion's digest: today's receipt, or (everyday-9 A2) the one the person accepted, for this same
   * result, before its checks were run again. Undo: the receipt field's value. */
  completion: string;
  repo: string; ref: string; branch: string;
  /** The branch's commit now (the expected old value of the swap). */
  old: string;
  /** land: the result's commit, whose exact tree lands. undo: null until the revert commit is made at the act. */
  candidate: string | null;
  /** land: the one commit it makes (everyday-9 A1): its exact id, its tree (the tree the checks ran on), its message
   * and time, the family's start the reviewed change ran from, and what it changes. Null for undo. */
  squash: Squash | null;
  /** ref: no checkout has the branch; only it moves. handoff: the project folder has it checked out; Toolroll makes and
   * keeps the commit and shows the command, touching no checkout. */
  mode: "ref" | "handoff";
  /** handoff: the folder the command runs in. */
  handoff?: { folder: string };
  /** passed: checks passed on exactly the candidate; none: the project has no check command. Undo: none. */
  checks: "passed" | "none";
  /** The destination is Toolroll's record (true), or proposed now and recorded by the yes (false). */
  recorded: boolean;
  /** undo: the landing it reverts: `source` names it stably (`intent:<id>`, or `handoff:<id>` for a handed-off commit
   * the person brought in, before and after its reconcile). */
  reverts?: { source: string; old: string; landed: string };
  /** What the check eligibility rests on, read at the look: re-read in the transaction right before the write. */
  bindings: CheckBindings;
  /** A short pin of everything above: the yes names it, and a stale one refuses. */
  key: string;
};
export type Squash = { policy: "squash"; base: string | null; commit: string; tree: string; checkedTree: string; time: number; message: string; files: string[]; fileCount: number; added: number; removed: number };
export type CheckBindings = { full: string | null; quick: string | null; setup: string | null; access: string };
/** The project's check command, quick command, setup and check access as they stand now. */
function checkBindingsOf(store: Store, repo: string): CheckBindings {
  return { full: store.liveVerifyCommand(repo)?.digest ?? null, quick: store.liveVerifyCommand(quickVerifyKey(repo))?.digest ?? null,
    setup: store.liveWorktreeSetup(repo)?.digest ?? null, access: String(store.projectCheckAccess(repo)) };
}
export type LandingRead =
  | { ok: true; plan: LandingPlan }
  | { ok: true; landed: { at: string; ref: string; commit: string; mode: "files" | "ref" | "handoff" } }
  | { ok: false; reason: LandRefusal; message: string };
export type LandRefusal = "pull-requests" | "not-found" | "not-complete" | "checks" | "destination" | "moved" | "occupied" | "dirty" | "unsupported" | "git" | "busy" | "stale" | "authority" | "nothing";
export type LandResult =
  | { ok: true; replayed: boolean; kind: "land" | "undo"; ref: string; branch: string; commit: string; old: string; mode: "files" | "ref" | "handoff"; warning: string | null;
      /** handoff: where the commit is kept and the exact command that brings it onto the branch (null when the folder's
       * name can't be written safely in a command; then the words say so). */
      handoff: { ref: string; command: string | null } | null }
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
type Intent = { id: number; at: string; repo: string; task: string; run: number; kind: "land" | "undo"; ref: string; old: string; commit: string; candidate: string; mode: "files" | "ref"; key: string;
  /** undo: the landing it reverts, by its stable name (`intent:<id>`, `handoff:<id>`), or an earlier version's intent id. */
  reverts: string | number | null;
  /** A handed-off commit the person brought in, recorded as landed by a reconcile: its handoff's id. */
  fromHandoff: number | null };
function intentOf(row: LedgerRow & { repo: string; task: string; run: number }): Intent | null {
  const d = row.detail;
  if (d["v"] !== 1 || typeof d["ref"] !== "string" || typeof d["old"] !== "string" || typeof d["commit"] !== "string" || !OID.test(d["old"]) || !OID.test(d["commit"])
    || (d["mode"] !== "files" && d["mode"] !== "ref") || typeof d["key"] !== "string" || (d["kind"] !== "land" && d["kind"] !== "undo")) return null;
  const candidate = typeof d["candidate"] === "string" && OID.test(d["candidate"]) ? d["candidate"] : d["commit"];
  return { id: row.id, at: row.at, repo: row.repo, task: row.task, run: row.run, kind: d["kind"], ref: d["ref"], old: d["old"], commit: d["commit"], candidate, mode: d["mode"], key: d["key"],
    reverts: typeof d["reverts"] === "number" || typeof d["reverts"] === "string" ? d["reverts"] : null, fromHandoff: typeof d["fromHandoff"] === "number" ? d["fromHandoff"] : null };
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
  const name = landed.fromHandoff !== null ? `handoff:${landed.fromHandoff}` : `intent:${landed.id}`;
  const undone = all.some(one => one.kind === "undo" && (one.reverts === name || one.reverts === landed.id) && settledOf(store, one.id)?.outcome.startsWith("landed") === true);
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
  | { kind: "folder" };

/** Where `ref` stands: symbolic, moved from `old`, unreadable, or checked out in any folder but the project's own is a
 * problem (the last refused with no command to run there: that checkout's git config and hooks are its own); else free
 * (checked out nowhere) or folder (checked out in the project folder: a handoff, Toolroll touching none of it). */
async function placeOf(git: Git, project: { repo: string; common: string }, ref: string, old: string | null): Promise<Place> {
  const branch = ref.slice("refs/heads/".length);
  const symbolic = await git(["symbolic-ref", "-q", ref]);
  if (symbolic.code === 0) return { kind: "problem", reason: "destination", message: `${branch} points at another branch (${symbolic.stdout.trim().replace(/^refs\/heads\//, "")}), so Toolroll won't move it. Land it with git yourself.` };
  if (symbolic.code !== 1) return { kind: "problem", reason: "git", message: `Toolroll couldn't read ${branch}.` };
  if (old !== null) {
    const read = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (read.code !== 0 || read.stdout.trim() !== old) return { kind: "problem", reason: "moved", message: `${branch} moved since you looked. Look again, then land it.` };
  }
  const on = await checkoutsOn(git, ref);
  if (on === null) return { kind: "problem", reason: "git", message: "Toolroll couldn't list this project's checkouts." };
  if (on.length === 0) return { kind: "free" };
  let repoReal = project.repo;
  try { repoReal = realpathSync(project.repo); } catch { /* compared as recorded */ }
  if (on.length !== 1 || on[0] !== repoReal) return { kind: "problem", reason: "occupied", message: `${branch} is checked out in another folder, so Toolroll won't move it or suggest a command to run there. Switch that folder to another branch, then land it.` };
  return { kind: "folder" };
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
  // A completion is history (everyday-9 A2): accepted, then its checks run again or their command changed, it stays
  // Complete under the digest the person accepted, for this same result (the same build, commit and scope). It lands
  // only on checks that pass on its exact commit now (below); a later failure blocks it, with the reason.
  const later = assignment.completion.digest !== receipt.digest;
  if (later && assignment.completion.historical !== true) return refuse("checks", "This result changed since you accepted it. Look at it again, then land it.");
  const candidate = receipt.head;
  if (candidate === null || !OID.test(candidate) || receipt.completionKind === "research-report") return refuse("nothing", "This result has no commit to land.");
  const landed = landingOf(store, assignment.rootId);
  if (landed !== null && !landed.undone && landed.intent.candidate === candidate) return { ok: true, landed: { at: landed.at, ref: landed.intent.ref, commit: landed.intent.commit, mode: landed.intent.mode } };
  // Exactly checked: the sealed receipt's check passed on this commit (verification-evidence.ts binds it to the head), or
  // the project has no check command at all.
  const checks = receipt.checks.status === "passed" ? "passed" as const : !projectCheckSet(store, project.repo) && receipt.checks.status === "not-run" ? "none" as const : null;
  if (checks === null) {
    if (receipt.checks.status === "failed") return refuse("checks", later ? `Its checks failed when they ran again after you accepted it (${receipt.checks.detail}). It stays Complete; it can't land until they pass on its exact commit.`
      : "Its checks failed. Only work whose checks passed on its exact commit lands.");
    return refuse("checks", later ? "Its checks changed since you accepted it and haven't run on its exact commit since. Run checks (it stays Complete), then land it."
      : "Its checks haven't passed on its exact commit. Run checks, then land it.");
  }
  const destination = await destinationOf(store, project, git, options.into);
  if (!destination.ok) return destination;
  // The family's start the reviewed change ran from (task-base.ts), from Toolroll's run record: bound, for the record.
  const run = store.getRun(receipt.runId);
  const base = run === null || run.branch === null ? null : wholeChangeBaseOf(store, run.taskRef, run.branch) ?? run.baseRevision;
  return planFor(git, project, destination, { kind: "land", taskId: receipt.taskId, rootId: assignment.rootId, runId: receipt.runId, receipt: receipt.digest, completion: assignment.completion.digest, candidate, checks,
    bindings: checkBindingsOf(store, project.repo) }, { base, message: squashMessage(store.getTask(receipt.taskId)?.title ?? null, receipt.taskId),
    // The commit's time is the completion's own (recorded, so the same inputs always make the same commit).
    time: Math.max(0, Math.floor(Date.parse(assignment.completion.at) / 1000) || 0),
    handedOff: handoffsOf(store, project.repo, assignment.rootId).filter(one => one.candidate === candidate).map(one => one.commit) });
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
  fixed: Pick<LandingPlan, "kind" | "taskId" | "rootId" | "runId" | "receipt" | "completion" | "candidate" | "checks" | "reverts" | "bindings">,
  squashing: { base: string | null; message: string; time: number; handedOff: readonly string[] } | null = null): Promise<LandingRead> {
  const { ref } = destination;
  const branch = ref.slice("refs/heads/".length);
  const read = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  const old = read.stdout.trim();
  if (read.code !== 0 || !OID.test(old)) return refuse("destination", `There's no branch \`${branch}\` in this project.`);
  if (fixed.candidate !== null) {
    if (old === fixed.candidate) return refuse("nothing", ALREADY_MSG(ref, old));
    const type = await git(["cat-file", "-t", fixed.candidate]);
    if (type.code !== 0 || type.stdout.trim() !== "commit") return refuse("git", `This result's commit ${short(fixed.candidate)} is no longer in the project.`);
    // Already there (everyday-9 A3): the person merged it themselves, or brought in the landing commit Toolroll handed
    // them. Nothing more lands.
    for (const landed of [fixed.candidate, ...(squashing?.handedOff ?? [])]) {
      if ((await git(["merge-base", "--is-ancestor", landed, old])).code === 0) return refuse("nothing", ALREADY_MSG(ref, landed));
    }
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
    // The one commit, exactly: the tree the checks ran on, the branch's commit as its only parent, a fixed identity, the
    // completion's own time and the message shown. Its id is computed here, before anything is written, so the yes
    // names the exact commit that lands.
    const message = squashing?.message ?? `Toolroll task ${fixed.taskId}`, time = squashing?.time ?? 0, treeId = tree.stdout.trim();
    squash = { policy: "squash", base: squashing?.base ?? null, commit: commitIdOf(squashBody(treeId, old, time, message)), tree: treeId, checkedTree: treeId, time, message, ...changes };
  }
  const place = await placeOf(git, project, ref, old);
  if (place.kind === "problem") return refuse(place.reason, place.message);
  // An undo while the project folder has the branch checked out: the person reverts it there (Toolroll touches no
  // checkout).
  if (place.kind === "folder" && fixed.kind === "undo") {
    const command = gitCommand(project.repo, ["revert", "--no-edit", `${oidOrThrow(fixed.reverts!.old)}..${oidOrThrow(fixed.reverts!.landed)}`]);
    return refuse("occupied", `${branch} is checked out in your project folder, so Toolroll won't touch its files. ${command === null ? UNSAFE_FOLDER(`git revert --no-edit ${fixed.reverts!.old}..${fixed.reverts!.landed}`) : `To do it yourself there: ${command}`}`);
  }
  const mode = place.kind === "free" ? "ref" as const : "handoff" as const;
  const plan: Omit<LandingPlan, "key"> = { ...fixed, squash, repo: project.repo, ref, branch, old, mode, ...(place.kind === "folder" ? { handoff: { folder: project.repo } } : {}), recorded: destination.recorded };
  return { ok: true, plan: { ...plan, key: keyOf({ v: 1, ...plan, common: project.common }) } };
}

async function readUndo(store: Store, rootId: string, project: { repo: string; common: string }, git: Git, options: Options): Promise<LandingRead> {
  void options;
  const landed = landingOf(store, rootId);
  if (landed !== null && landed.undone) return refuse("nothing", "This landing was already undone.");
  // A handed-off commit the person brought in (the branch contains it): undoable as a landing, read here, recorded as
  // one by the yes's reconcile (land below), under the same stable name.
  const brought = landed === null ? await broughtIn(store, git, project.repo, rootId) : null;
  const source = landed !== null ? { key: landed.intent.key, task: landed.intent.task, run: landed.intent.run, ref: landed.intent.ref, old: landed.intent.old, commit: landed.intent.commit,
    name: landed.intent.fromHandoff !== null ? `handoff:${landed.intent.fromHandoff}` : `intent:${landed.intent.id}` }
    : brought === null ? null : { key: brought.key, task: brought.task, run: brought.run, ref: brought.ref, old: brought.old, commit: brought.commit, name: `handoff:${brought.id}` };
  if (source === null) return refuse("nothing", "This task hasn't landed, so there's nothing to undo.");
  return planFor(git, project, { ref: source.ref, recorded: true }, { kind: "undo", taskId: source.task, rootId, runId: source.run, receipt: source.key, completion: source.key, candidate: null, checks: "none",
    reverts: { source: source.name, old: source.old, landed: source.commit }, bindings: checkBindingsOf(store, project.repo) });
}

/** The newest kept handoff of this task whose commit its branch contains now and no landing records yet, or null. */
async function broughtIn(store: Store, git: Git, repo: string, rootId: string): Promise<Handoff | null> {
  const reconciled = new Set(intents(store, "task_id = ?", [rootId]).flatMap(one => one.fromHandoff === null ? [] : [one.fromHandoff]));
  for (const one of handoffsOf(store, repo, rootId)) {
    if (reconciled.has(one.id)) continue;
    if ((await git(["merge-base", "--is-ancestor", one.commit, one.ref])).code === 0) return one;
  }
  return null;
}

/** The squash commit's exact bytes: deterministic, so the same tree, parent, time and message always make the same id. */
function squashBody(tree: string, parent: string, time: number, message: string): string {
  const who = `Toolroll <land@toolroll.invalid> ${time} +0000`;
  return `tree ${tree}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`;
}
/** A commit's id from its bytes, as git computes it (SHA-1 object format; a SHA-256 repository never gets this far). */
function commitIdOf(body: string): string {
  return createHash("sha1").update(`commit ${Buffer.byteLength(body, "utf8")}\0`).update(body, "utf8").digest("hex");
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
  const how = plan.mode === "handoff" ? `your project folder has ${plan.branch} checked out, so Toolroll won't touch its files: Land makes the commit and shows the one git command that brings it in`
    : `no folder has ${plan.branch} checked out; only the branch moves`;
  if (plan.kind === "undo") {
    return [`Undo the landing of ${short(plan.reverts!.landed)} on ${plan.branch} in ${shownName(plan.repo)} (${how}).`,
      "A new commit reverts exactly what it changed; nothing is rewritten. No check runs on the undo."];
  }
  const squash = plan.squash!;
  const names = squash.files.slice(0, 3).map(shownName).join(", ") + (squash.fileCount > 3 ? ` and ${squash.fileCount - 3} more` : "");
  return [`Lands 1 commit on ${plan.branch}: ${squash.fileCount === 0 ? "no file changes" : names} (+${squash.added} −${squash.removed}).`,
    `${short(squash.commit)} "${shownName(squash.message)}", on top of ${short(plan.old)} in ${shownName(plan.repo)} (${how}).`,
    plan.checks === "passed" ? `Checks ran on these exact files: they passed on ${short(plan.candidate!)}, and ${short(squash.commit)} carries the same tree.` : "No check ran: this project has no check command.",
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
    // An earlier version's landing that also moved a checkout's files: its files are the person's to look at.
    else if (at === intent.commit && intent.mode === "files") { outcome = "needs-person"; words = `The branch moved to ${short(intent.commit)}; check your folder's files with git status in ${repo}.`; }
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
    // The same yes to a handoff: its commit kept again if its ref went missing (the object still there), the record
    // settled if a crash left it pending, and only then reported; a commit that is gone is said plainly.
    const handedOff = input.undo === true ? undefined : handoffRows(store, repo).find(one => one.key === input.key);
    if (handedOff !== undefined) {
      const who = standing(store, authority, repo);
      if (!who.ok) return who;
      const git = gitFor(repo, options.git);
      const there = await git(["cat-file", "-t", handedOff.commit]);
      if (there.code !== 0 || there.stdout.trim() !== "commit") return refuse("git", "The landing commit Toolroll kept for this is gone. Look again, then land it.");
      if (!await keepAt(git, handedOff.keep, handedOff.commit, `toolroll: landing commit for ${taskId}`)) return refuse("git", "Toolroll couldn't keep the landing commit. Look again, then land it.");
      if (!handedOff.settled) recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo, taskId: handedOff.task, runId: handedOff.run, action: LAND_HANDOFF_SETTLED,
        outcome: `${handedOff.id}:kept`, source: "work" }, { v: 1, keep: handedOff.keep, commit: handedOff.commit });
      return { ok: true, replayed: handedOff.settled, kind: "land", ref: handedOff.ref, branch: handedOff.ref.slice("refs/heads/".length), commit: handedOff.commit, old: handedOff.old, mode: "handoff",
        warning: null, handoff: { ref: handedOff.keep, command: handoffCommand(repo, handedOff.commit) } };
    }
    await settleUnfinished(store, repo, now, options);
    // A handed-off commit the person brought in becomes a landing record before an undo reads it (it never grants
    // acceptance: it records only where the branch already is), so Undo reverts exactly that commit.
    if (input.undo === true) {
      const rootId = assignmentOf(store, taskId, now, { principal: "operator", repos: access.repos, includeUnplaced: false }, options.root)?.rootId ?? null;
      if (rootId !== null) await reconcileHandoffs(store, gitFor(repo, options.git), repo, rootId, first.actor, now);
    }
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
        if (again?.state !== "complete" || again.receipt?.digest !== plan.receipt || again.completion?.digest !== plan.completion) return refuse("stale", "This result changed since you looked. Look again, then land it.");
      } else {
        const landed = landingOf(store, plan.rootId);
        const name = landed === null ? null : landed.intent.fromHandoff !== null ? `handoff:${landed.intent.fromHandoff}` : `intent:${landed.intent.id}`;
        if (landed === null || landed.undone || name !== plan.reverts?.source) return refuse("stale", "That landing changed since you looked. Look again.");
      }
      if (JSON.stringify(checkBindingsOf(store, plan.repo)) !== JSON.stringify(plan.bindings)) return refuse("stale", "The project's checks changed since you looked. Look again, then land it.");
      return who;
    };
    // The commit the branch moves to is written now, only for someone who may land here (proved again with the intent
    // below): a landing's one commit, exactly the bytes whose id the person read, or the undo's revert, made in a
    // temporary checkout of its own.
    const pre = standing(store, authority, plan.repo);
    if (!pre.ok) return pre;
    const made = plan.kind === "undo" ? await revertCommit(git, plan, options.scratch) : await squashCommit(git, plan, options.scratch);
    if (!made.ok) return made;
    const commit = made.commit;
    const keep = handoffRefOf(plan.rootId);
    // The squash is kept at its ref before anything moves (so a person's gc can't take it), the ref moved only from what
    // it was read as (a compare-and-swap; created when absent).
    if (plan.kind === "land") {
      const kept = await keepAt(git, keep, commit, `toolroll: landing commit for ${plan.taskId}`);
      if (!kept) return refuse("git", "Toolroll made the landing commit but couldn't keep it. Nothing landed; look again, then land it.");
    }
    // The project folder has the branch checked out: no checkout is touched. The handoff is recorded pending, its commit
    // kept (above), then settled; the same yes again finds the same commit (it is deterministic) and settles the same.
    if (plan.mode === "handoff") {
      const place = await placeOf(git, project, plan.ref, plan.old);
      if (place.kind !== "folder") return refuse(place.kind === "problem" ? place.reason : "stale", place.kind === "problem" ? place.message : "Your project folder changed since you looked. Look again, then land it.");
      let handoffId: number, replayed = false;
      try {
        handoffId = store.transact(() => {
          const who = stillStands();
          if (!who.ok) throw new Refused(who);
          const earlier = handoffRows(store, plan.repo).find(one => one.key === plan.key && one.commit === commit);
          if (earlier !== undefined) { replayed = earlier.settled; return earlier.id; }
          if (!plan.recorded) recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: null, runId: null, action: LAND_DESTINATION, outcome: plan.ref, source: "request" },
            { v: 1, ref: plan.ref, common: project.common });
          return recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: plan.rootId, runId: plan.runId, action: LAND_HANDOFF, outcome: "pending", source: "request" },
            { v: 1, key: plan.key, ref: plan.ref, old: plan.old, commit, keep, folder: project.repo, policy: "squash", candidate: plan.candidate, base: plan.squash!.base, tree: plan.squash!.tree,
              checkedTree: plan.squash!.checkedTree, checks: plan.checks });
        });
      } catch (error) {
        if (error instanceof Refused) return error.result;
        throw error;
      }
      // Re-proved before it is reported: the ref names exactly this commit now.
      const at = await git(["rev-parse", "--verify", "-q", `${keep}^{commit}`]);
      if (at.code !== 0 || at.stdout.trim() !== commit) return refuse("git", "Toolroll couldn't keep the landing commit. Nothing landed; look again, then land it.");
      if (!replayed) recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo: plan.repo, taskId: plan.rootId, runId: plan.runId, action: LAND_HANDOFF_SETTLED,
        outcome: `${handoffId}:kept`, source: "work" }, { v: 1, keep, commit });
      return { ok: true, replayed, kind: "land", ref: plan.ref, branch: plan.branch, commit, old: plan.old, mode: "handoff", warning: null,
        handoff: { ref: keep, command: handoffCommand(project.repo, commit) } };
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
          { v: 1, kind: plan.kind, key: plan.key, ref: plan.ref, old: plan.old, commit, mode: "ref", ...(plan.reverts === undefined ? {} : { reverts: plan.reverts.source }),
            ...(plan.squash === null ? {} : { policy: "squash", candidate: plan.candidate, base: plan.squash.base, tree: plan.squash.tree, checkedTree: plan.squash.checkedTree, keep, checks: plan.checks }) });
      });
    } catch (error) {
      if (error instanceof Refused) return error.result;
      throw error;
    }
    const settle = (outcome: string, words: string) => recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo: plan.repo, taskId: plan.rootId, runId: plan.runId,
      action: LAND_SETTLED, outcome: `${intentId}:${outcome}`, source: "work" }, { v: 1, words });
    // Right before the write: the branch again (real, at `old`, checked out nowhere), then, in one transaction, everything
    // the yes rests on. The write itself never follows a symbolic ref and refuses a moved branch.
    const place = await placeOf(git, project, plan.ref, plan.old);
    if (place.kind !== "free") {
      const words = place.kind === "problem" ? place.message : `${plan.branch} is checked out in your project folder now, so Toolroll won't move it. Look again, then land it.`;
      settle("refused", words);
      return refuse(place.kind === "problem" ? place.reason : "occupied", words);
    }
    const last = store.transact(stillStands);
    if (!last.ok) { settle("refused", last.message); return last; }
    const swapped = await git(["update-ref", "--no-deref", "-m", `toolroll: land ${plan.taskId}`, plan.ref, commit, plan.old]);
    if (swapped.code !== 0) {
      const words = `${plan.branch} moved while landing, so nothing changed. Look again, then land it.`;
      settle("refused", words);
      return refuse("moved", words);
    }
    settle("landed", plan.kind === "undo" ? "Undone." : "Landed.");
    return { ok: true, replayed: false, kind: plan.kind, ref: plan.ref, branch: plan.branch, commit, old: plan.old, mode: "ref", warning: null, handoff: null };
  });
}

/** Keep `commit` at `ref` (Toolroll's own refs/toolroll/land/ namespace): created when absent, else moved from exactly
 * what it was read as, never following a symbolic ref; true once the ref names the commit. */
async function keepAt(git: Git, ref: string, commit: string, why: string): Promise<boolean> {
  const was = await git(["rev-parse", "--verify", "-q", ref]);
  const old = was.code === 0 ? was.stdout.trim() : "0".repeat(40);
  if (old === commit) return true;
  if (was.code === 0 && !OID.test(old)) return false;
  const moved = await git(["update-ref", "--no-deref", "-m", why, ref, commit, old]);
  return moved.code === 0;
}

/** Each kept handoff of `rootId` whose commit its branch now contains, and that no landing records yet, recorded as a
 * landing (settled landed in the same transaction, so it never holds the project's landing lock). Only `land` calls it,
 * after proving the caller may land in this project. It records where the branch already is; it grants nothing. */
async function reconcileHandoffs(store: Store, git: Git, repo: string, rootId: string, actor: string, now: Date): Promise<void> {
  for (;;) {
    const one = await broughtIn(store, git, repo, rootId);
    if (one === null) return;
    store.transact(() => {
      if (intents(store, "task_id = ?", [rootId]).some(intent => intent.fromHandoff === one.id)) return;
      const id = recordActionWhole(store.handle, { at: now.toISOString(), actor, repo, taskId: rootId, runId: one.run, action: LAND_INTENT, outcome: "pending", source: "request" },
        { v: 1, kind: "land", key: one.key, ref: one.ref, old: one.old, commit: one.commit, mode: "ref", policy: "squash", candidate: one.candidate, fromHandoff: one.id });
      recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo, taskId: rootId, runId: one.run, action: LAND_SETTLED, outcome: `${id}:landed:brought-in`, source: "work" },
        { v: 1, words: "The person brought in the landing commit Toolroll made; recorded as landed." });
    });
  }
}

/** A git command a person can copy and paste, run in the recorded project folder: the folder exactly as recorded,
 * POSIX single-quoted (`'` as `'\''`), every other argument fixed words or a validated commit id. Null when the folder's
 * name holds a control, bidi or zero-width character: no command could be both exact and safe to show. */
/** A full commit id, or a throw: only ever a 40-hex OID goes into a command a person copies. */
function oidOrThrow(oid: string): string {
  if (!OID.test(oid)) throw new Error("not a commit id");
  return oid;
}
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_COMMAND = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
export function gitCommand(folder: string, args: readonly string[]): string | null {
  if (UNSAFE_IN_COMMAND.test(folder)) return null;
  return ["git", "-C", `'${folder.replace(/'/g, "'\\''")}'`, ...args].join(" ");
}
/** What to say instead of a command when the folder's name can't be written safely in one. */
const UNSAFE_FOLDER = (what: string) => `Toolroll can't write a safe command for this folder's name; run ${what} in your project folder.`;
/** The exact command that brings a handed-off landing commit onto the branch the project folder has checked out. */
function handoffCommand(folder: string, commit: string): string | null {
  return gitCommand(folder, ["merge", "--ff-only", oidOrThrow(commit)]);
}
/** The words for a handoff's command, or what to run instead when no command can be written safely. */
export function handoffWords(handoff: { command: string | null }, commit: string): string {
  return handoff.command === null ? UNSAFE_FOLDER(`git merge --ff-only ${commit}`) : `To bring it in: ${handoff.command}`;
}

type Handoff = { id: number; task: string; run: number; key: string; ref: string; old: string; commit: string; keep: string; folder: string; candidate: string; settled: boolean };
/** Every recorded handoff of the project (pending or settled), newest first. */
function handoffRows(store: Store, repo: string, taskId?: string): Handoff[] {
  return store.handle.prepare(`SELECT id,detail,task_id,run_id FROM action_ledger WHERE repo = ? AND action = ?${taskId === undefined ? "" : " AND task_id = ?"} ORDER BY id DESC`)
    .all(...(taskId === undefined ? [repo, LAND_HANDOFF] : [repo, LAND_HANDOFF, taskId])).flatMap(row => {
      try {
        const d = JSON.parse(String(row["detail"] ?? "null")) as Record<string, unknown>;
        const ok = d["v"] === 1 && typeof d["key"] === "string" && typeof d["ref"] === "string" && typeof d["old"] === "string" && OID.test(d["old"]) && typeof d["commit"] === "string" && OID.test(d["commit"])
          && typeof d["keep"] === "string" && typeof d["folder"] === "string" && typeof d["candidate"] === "string" && OID.test(d["candidate"]);
        const id = Number(row["id"]);
        const settled = ok && store.handle.prepare("SELECT 1 AS hit FROM action_ledger WHERE action = ? AND outcome = ? LIMIT 1").get(LAND_HANDOFF_SETTLED, `${id}:kept`) !== undefined;
        return ok ? [{ id, task: String(row["task_id"]), run: Number(row["run_id"]), key: d["key"] as string, ref: d["ref"] as string, old: d["old"] as string, commit: d["commit"] as string,
          keep: d["keep"] as string, folder: d["folder"] as string, candidate: d["candidate"] as string, settled }] : [];
      } catch { return []; }
    });
}
/** The landing commits Toolroll made and kept for people to bring in themselves (settled handoffs), newest first. */
export function handoffsOf(store: Store, repo: string, taskId?: string): Handoff[] {
  return handoffRows(store, repo, taskId).filter(one => one.settled);
}

class Refused extends Error {
  constructor(readonly result: { ok: false; reason: LandRefusal; message: string }) { super(result.message); }
}

/** The landing's one commit: exactly the bytes whose id the person read (the tree the checks ran on, the branch's commit
 * as its only parent, the fixed identity and time, the message), written as an object only (`hash-object`: no checkout,
 * index or ref is touched) and checked back: the same id, that tree, that one parent. */
async function squashCommit(git: Git, plan: LandingPlan, scratch?: string): Promise<{ ok: true; commit: string } | { ok: false; reason: LandRefusal; message: string }> {
  const squash = plan.squash!;
  if (squash.tree !== squash.checkedTree) return refuse("checks", "The commit Toolroll would land doesn't carry the files its checks ran on. Nothing landed.");
  const verified = await git(["rev-parse", "--verify", "-q", `${plan.candidate!}^{tree}`]);
  if (verified.code !== 0 || verified.stdout.trim() !== squash.checkedTree) return refuse("checks", "The result's files aren't the ones its checks ran on any more. Nothing landed.");
  // The bytes go through a private temporary file Toolroll writes (outside every checkout), removed after.
  const folder = mkdtempSync(join(scratch ?? tmpdir(), "toolroll-land-"));
  let written: Awaited<ReturnType<Git>>;
  try {
    const file = join(folder, "commit");
    writeFileSync(file, squashBody(squash.tree, plan.old, squash.time, squash.message), { encoding: "utf8", mode: 0o600, flag: "wx" });
    written = await git(["hash-object", "-t", "commit", "-w", "--", file]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
  const commit = written.stdout.trim();
  if (written.code !== 0 || commit !== squash.commit) return refuse("stale", "The commit Toolroll would land isn't the one you read. Nothing landed; look again.");
  const shown = await git(["cat-file", "commit", commit]);
  const header = shown.stdout.split("\n\n")[0] ?? "";
  const parents = header.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice("parent ".length));
  if (shown.code !== 0 || !header.startsWith(`tree ${squash.checkedTree}\n`) || parents.length !== 1 || parents[0] !== plan.old) return refuse("git", "Toolroll couldn't make the landing commit.");
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

/**
 * Whether a completed task's work is already on its project's branch though Toolroll didn't land it (everyday-9 A3): the
 * branch contains the result's commit (the person merged it themselves) or a landing commit Toolroll handed them. For
 * display only ("On main"): it never accepts, completes or lands anything, and nothing reads it for a decision. The
 * branch is the recorded destination, else the one the project folder stands on; `read` is the page's bounded git read
 * (null when git can't say: then nothing is claimed).
 */
export function recognisedOnBranch(store: Store, repo: string, rootId: string, candidate: string | null,
  read: (cwd: string, args: readonly string[]) => string | null): string | null {
  if (candidate === null || !OID.test(candidate)) return null;
  const recorded = recordedDestination(store, repo)?.ref ?? null;
  const ref = recorded ?? (() => { const head = read(repo, ["symbolic-ref", "-q", "HEAD"]); return head !== null && head.startsWith("refs/heads/") ? head : null; })();
  if (ref === null || !landableBranch(ref.slice("refs/heads/".length))) return null;
  const commits = [candidate, ...handoffsOf(store, repo, rootId).filter(one => one.candidate === candidate && one.ref === ref).map(one => one.commit)];
  return commits.some(commit => read(repo, ["merge-base", "--is-ancestor", commit, ref]) !== null) ? `On ${ref.slice("refs/heads/".length)}` : null;
}

/** Whether a landing commit Toolroll handed the person is on its branch now (they brought it in) with no landing record
 * yet: the page offers Undo, whose yes records it as landed first (reconcileHandoffs). Display only. */
export function broughtInOnBranch(store: Store, repo: string, rootId: string, read: (cwd: string, args: readonly string[]) => string | null): boolean {
  const reconciled = new Set(intents(store, "task_id = ?", [rootId]).flatMap(one => one.fromHandoff === null ? [] : [one.fromHandoff]));
  return handoffsOf(store, repo, rootId).some(one => !reconciled.has(one.id) && read(repo, ["merge-base", "--is-ancestor", one.commit, one.ref]) !== null);
}
