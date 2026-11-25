/**
 * Land accepted work on a local project's branch (everyday-8 #1, the Codex-refined build spec; owner defaults of
 * 2026-11-25): a separate act after Accept, for a project with no pull-request publishing. Fast-forward only, tasks
 * only, into a destination Toolroll records (the project's own repository and an exact branch ref), shown before the
 * person says yes.
 *
 * The rules, each enforced here and tried by local-landing.attack.test.ts:
 * - Only a completed task whose completion is today's exact receipt; checks passed on exactly the candidate commit,
 *   or the project has no check command at all (the screen then says "No check ran").
 * - The candidate is the result's recorded head commit, never anything a checkout says. It lands only as a
 *   fast-forward of the destination's current commit; when the branch moved past the work's start, nothing lands (a
 *   merged commit would need a check of its own) and the exact git commands are said instead.
 * - Every git call goes through the hardened helper (teardown-git.ts: no hooks, no config includes or commands, no
 *   global or system config), bound to the project's recorded main checkout. A repository whose config names a
 *   command, or whose files need Git filters (Git LFS, encodings) or hold submodules, is refused, never altered.
 * - The person's checkout must be clean (no staged, unstaged or untracked changes), with no merge, rebase,
 *   cherry-pick, revert or bisect in progress, not sparse; a destination branch checked out in any other checkout is
 *   refused. Nothing is ever stashed, forced or reset.
 * - The promotion is a compare-and-swap of the branch ref from the exact commit read (expected old), then the files of
 *   a checkout standing on it move with git's own two-tree fast-forward (read-tree -m -u), which refuses to overwrite.
 *   A failure after the swap swaps the ref back the same way. Every landing writes its intent first and its outcome
 *   after (the recovery record); an intent left unsettled by a crash is settled from what git shows before anything
 *   else lands in that project.
 * - Undo makes a new commit that reverts exactly the landed commits, on the branch as it is now, and lands it the same
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
import { projectCheckSet } from "./check-levels.js";
import { recordActionWhole } from "./action-ledger.js";
import { reproveApprover, verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { localActNow, LOCAL_OWNER_LAPSED } from "./local-owner.js";

export const LAND_DESTINATION = "land destination";
export const LAND_INTENT = "land intent";
export const LAND_SETTLED = "land settled";

/** Who lands: a person proved by password (or a browser session's approver), or this computer's local owner acting as
 * exactly `land-task` (the same authority as Accept on a solo install). */
export type LandAuthority = { kind: "person"; who: VerifiedApprover } | { kind: "local" };

export type LandingPlan = {
  kind: "land" | "undo";
  taskId: string; rootId: string; runId: number; receipt: string;
  repo: string; ref: string; branch: string;
  /** The branch's commit now (the expected old value of the swap). */
  old: string;
  /** land: the result's commit. undo: null until the revert commit is made at the act. */
  candidate: string | null;
  /** files: the project's folder stands on the branch and its files move too; ref: no checkout has the branch open. */
  mode: "files" | "ref";
  /** passed: checks passed on exactly the candidate; none: the project has no check command. Undo: none. */
  checks: "passed" | "none";
  /** The destination is Toolroll's record (true), or proposed now and recorded by the yes (false). */
  recorded: boolean;
  /** undo: the landing it reverts. */
  reverts?: { intent: number; old: string; landed: string };
  /** A short pin of everything above: the yes names it, and a stale one refuses. */
  key: string;
};
export type LandingRead =
  | { ok: true; plan: LandingPlan }
  | { ok: true; landed: { at: string; ref: string; commit: string; mode: "files" | "ref" } }
  | { ok: false; reason: LandRefusal; message: string };
export type LandRefusal = "not-found" | "not-complete" | "checks" | "destination" | "moved" | "occupied" | "dirty" | "unsupported" | "git" | "busy" | "stale" | "authority" | "nothing";
export type LandResult =
  | { ok: true; replayed: boolean; kind: "land" | "undo"; ref: string; branch: string; commit: string; old: string; mode: "files" | "ref"; warning: string | null }
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
type Intent = { id: number; at: string; repo: string; task: string; run: number; kind: "land" | "undo"; ref: string; old: string; commit: string; mode: "files" | "ref"; key: string; reverts: number | null };
function intentOf(row: LedgerRow & { repo: string; task: string; run: number }): Intent | null {
  const d = row.detail;
  if (d["v"] !== 1 || typeof d["ref"] !== "string" || typeof d["old"] !== "string" || typeof d["commit"] !== "string" || !OID.test(d["old"]) || !OID.test(d["commit"])
    || (d["mode"] !== "files" && d["mode"] !== "ref") || typeof d["key"] !== "string" || (d["kind"] !== "land" && d["kind"] !== "undo")) return null;
  return { id: row.id, at: row.at, repo: row.repo, task: row.task, run: row.run, kind: d["kind"], ref: d["ref"], old: d["old"], commit: d["commit"], mode: d["mode"], key: d["key"],
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

/** What a checkout's git folder says is under way, or null. */
function inProgress(gitdir: string): string | null {
  for (const [name, words] of [["MERGE_HEAD", "a merge"], ["CHERRY_PICK_HEAD", "a cherry-pick"], ["REVERT_HEAD", "a revert"], ["REBASE_HEAD", "a rebase"], ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase or git am"], ["BISECT_LOG", "a bisect"], ["sequencer", "a cherry-pick or revert"], ["index.lock", "another git command"]] as const) {
    try { lstatSync(join(gitdir, name)); return words; } catch { /* not there */ }
  }
  return null;
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

/** Whether the project's folder is clean and standing on `ref` at `old`: null when it is, or why not. */
async function checkoutProblem(git: Git, repo: string, common: string, ref: string, old: string): Promise<{ reason: LandRefusal; words: string } | null> {
  const doing = inProgress(common);
  if (doing !== null) return { reason: "dirty", words: `Your project folder is in the middle of ${doing}. Finish or abort it, then land again.` };
  try { lstatSync(join(common, "info", "sparse-checkout")); return { reason: "unsupported", words: "Your project folder uses a sparse checkout, which landing doesn't handle. Land it with git yourself." }; } catch { /* not sparse */ }
  const sparse = await git(["config", "--bool", "--get", "core.sparseCheckout"]);
  if (sparse.stdout.trim() === "true") return { reason: "unsupported", words: "Your project folder uses a sparse checkout, which landing doesn't handle. Land it with git yourself." };
  const head = await git(["symbolic-ref", "-q", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== ref) return { reason: "moved", words: `Your project folder moved off ${ref.replace(/^refs\/heads\//, "")}. Look again before landing.` };
  const at = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (at.code !== 0 || at.stdout.trim() !== old) return { reason: "moved", words: "Your project folder's branch moved. Look again before landing." };
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.code !== 0) return { reason: "git", words: "Toolroll couldn't read your project folder's changes." };
  if (status.stdout !== "") {
    const count = status.stdout.split("\0").filter(one => /^.. /.test(one)).length;
    return { reason: "dirty", words: `Your project folder has ${count === 1 ? "1 uncommitted or untracked change" : `${count} uncommitted or untracked changes`}. Commit, move or remove ${count === 1 ? "it" : "them"} yourself, then land again. Toolroll never stashes or overwrites your work.` };
  }
  void repo;
  return null;
}

/** The project's main checkout, as Toolroll recorded it, with its repository folder. */
function projectOf(store: Store, repo: string | null): { repo: string; common: string } | null {
  if (repo === null || !store.knownRepos().includes(repo)) return null;
  const common = commonDirOf(repo);
  return common === null ? null : { repo, common };
}

const ALREADY_MSG = (ref: string, commit: string) => `Already on ${ref.replace(/^refs\/heads\//, "")} (${short(commit)}).`;

/**
 * What landing this task's accepted result would do, read now; nothing is written. `into` names another branch than
 * the recorded (or proposed) one; the yes then records it.
 */
export async function readLanding(store: Store, taskId: string, access: { repos: readonly string[] | null }, now: Date, options: Options & { into?: string; undo?: boolean }): Promise<LandingRead> {
  const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: access.repos, includeUnplaced: false }, options.root);
  if (assignment === null) return refuse("not-found", `No task \`${taskId}\` in your projects.`);
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
  if (landed !== null && !landed.undone && landed.intent.commit === candidate) return { ok: true, landed: { at: landed.at, ref: landed.intent.ref, commit: landed.intent.commit, mode: landed.intent.mode } };
  // Exactly checked: the sealed receipt's check passed on this commit (verification-evidence.ts binds it to the head), or
  // the project has no check command at all.
  const checks = receipt.checks.status === "passed" ? "passed" as const : !projectCheckSet(store, project.repo) && receipt.checks.status === "not-run" ? "none" as const : null;
  if (checks === null) return refuse("checks", receipt.checks.status === "failed" ? "Its checks failed. Only work whose checks passed on its exact commit lands." : "Its checks haven't passed on its exact commit. Run checks, then land it.");
  const destination = await destinationOf(store, project, git, options.into);
  if (!destination.ok) return destination;
  return planFor(git, project, destination, { kind: "land", taskId: receipt.taskId, rootId: assignment.rootId, runId: receipt.runId, receipt: receipt.digest, candidate, checks });
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

async function planFor(git: Git, project: { repo: string; common: string }, destination: { ref: string; recorded: boolean },
  fixed: Pick<LandingPlan, "kind" | "taskId" | "rootId" | "runId" | "receipt" | "candidate" | "checks" | "reverts">): Promise<LandingRead> {
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
      return refuse("moved", `${branch} moved on since this work started (it's at ${short(old)} now), so it can't land as a fast-forward. `
        + `A merged commit would need its own check. To merge it yourself: git -C ${project.repo} merge ${fixed.candidate}`);
    }
    if (ancestor.code !== 0) return refuse("git", "Toolroll couldn't compare the commits.");
    const problem = await treeProblem(git, fixed.candidate) ?? await treeProblem(git, old);
    if (problem !== null) return refuse("unsupported", `This project can't be landed by Toolroll: ${problem}. Land it with git yourself.`);
  }
  const on = await checkoutsOn(git, ref);
  if (on === null) return refuse("git", "Toolroll couldn't list this project's checkouts.");
  const repoReal = realpathSync(project.repo);
  const others = on.filter(path => path !== repoReal);
  if (others.length > 0) return refuse("occupied", `${branch} is checked out in another folder (${others[0]}). Land it there with git, or switch that folder off ${branch}.`);
  const mode = on.includes(repoReal) ? "files" as const : "ref" as const;
  if (mode === "files") {
    const problem = await checkoutProblem(git, project.repo, project.common, ref, old);
    if (problem !== null) return refuse(problem.reason, problem.words);
  }
  const plan: Omit<LandingPlan, "key"> = { ...fixed, repo: project.repo, ref, branch, old, mode, recorded: destination.recorded };
  return { ok: true, plan: { ...plan, key: keyOf({ v: 1, ...plan, common: project.common }) } };
}

async function readUndo(store: Store, rootId: string, project: { repo: string; common: string }, git: Git, options: Options): Promise<LandingRead> {
  void options;
  const landed = landingOf(store, rootId);
  if (landed === null || landed.undone) return refuse("nothing", landed === null ? "This task hasn't landed, so there's nothing to undo." : "This landing was already undone.");
  const destination = { ref: landed.intent.ref, recorded: true };
  return planFor(git, project, destination, { kind: "undo", taskId: landed.intent.task, rootId, runId: landed.intent.run, receipt: landed.intent.key, candidate: null, checks: "none",
    reverts: { intent: landed.intent.id, old: landed.intent.old, landed: landed.intent.commit } });
}

/** The lines a person reads before saying yes. */
export function landingWords(plan: LandingPlan): string[] {
  const where = plan.mode === "files" ? `${plan.branch} in ${plan.repo} (your files there update too)` : `${plan.branch} in ${plan.repo} (no folder has it open; only the branch moves)`;
  if (plan.kind === "undo") {
    return [`Undo the landing of ${short(plan.reverts!.old)}..${short(plan.reverts!.landed)} on ${where}.`,
      "A new commit reverts exactly those changes; nothing is rewritten. No check runs on the undo."];
  }
  return [`Land ${short(plan.candidate!)} on ${where}, as a fast-forward from ${short(plan.old)}.`,
    plan.checks === "passed" ? `Checks passed on ${short(plan.candidate!)}.` : "No check ran: this project has no check command.",
    ...(plan.recorded ? [] : [`Toolroll remembers ${plan.branch} as where this project's work lands.`])];
}

/** Settle intents an earlier landing left unsettled (a crash between git and the record), from what git shows now. */
export async function settleUnfinished(store: Store, repo: string, now: Date, options: Options): Promise<void> {
  const project = projectOf(store, repo);
  if (project === null) return;
  const git = gitFor(repo, options.git);
  for (const intent of intents(store, "repo = ?", [repo]).filter(one => settledOf(store, one.id) === null)) {
    const read = await git(["rev-parse", "--verify", "-q", `${intent.ref}^{commit}`]);
    const at = read.stdout.trim();
    let outcome: string, words: string;
    if (at === intent.old) { outcome = "abandoned"; words = "It stopped before the branch moved; nothing changed."; }
    else if (at === intent.commit) {
      if (intent.mode === "files") {
        const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
        if (status.code === 0 && status.stdout === "" && head.stdout.trim() === intent.commit) { outcome = "landed:recovered"; words = "It had finished; recorded now."; }
        else {
          // The branch moved but the files didn't: finish the files with the same two-tree fast-forward, which refuses to
          // overwrite anything that changed.
          const files = await git(["read-tree", "-m", "-u", intent.old, intent.commit]);
          const after = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
          if (files.code === 0 && after.code === 0 && after.stdout === "") { outcome = "landed:recovered"; words = "Its files were finished now."; }
          else { outcome = "needs-person"; words = `The branch moved to ${short(intent.commit)} but your folder's files didn't follow. Look at ${repo} with git status.`; }
        }
      } else { outcome = "landed:recovered"; words = "It had finished; recorded now."; }
    } else { outcome = "needs-person"; words = `The branch is at ${OID.test(at) ? short(at) : "an unreadable commit"} now, neither before nor after the landing. Look at ${repo} with git log.`; }
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
  if (repo === null) return refuse("not-found", `No task \`${taskId}\` in your projects.`);
  return locked(repo, async (): Promise<LandResult> => {
    // The same yes again: recognised from its record, re-proved, writing nothing.
    const done = intents(store, "repo = ? AND task_id IS NOT NULL", [repo]).find(one => one.key === input.key);
    if (done !== undefined) {
      const settled = settledOf(store, done.id);
      if (settled?.outcome.startsWith("landed") === true) {
        const who = standing(store, authority, repo);
        if (!who.ok) return who;
        return { ok: true, replayed: true, kind: done.kind, ref: done.ref, branch: done.ref.slice("refs/heads/".length), commit: done.commit, old: done.old, mode: done.mode, warning: null };
      }
    }
    await settleUnfinished(store, repo, now, options);
    const read = await readLanding(store, taskId, access, now, { ...options, ...(input.into === undefined ? {} : { into: input.into }), ...(input.undo === true ? { undo: true } : {}) });
    if (!read.ok) return read;
    if (!("plan" in read)) return refuse("nothing", ALREADY_MSG(read.landed.ref, read.landed.commit));
    const plan = read.plan;
    if (plan.key !== input.key) return refuse("stale", "Something changed since you looked (the branch, your folder or the result). Look again, then land it.");
    const project = projectOf(store, plan.repo)!;
    const git = gitFor(plan.repo, options.git);
    // The undo's commit is made now, in a temporary checkout of its own, from the branch as read: only for someone who
    // may land here (proved again with the intent below).
    let commit = plan.candidate;
    if (plan.kind === "undo") {
      const pre = standing(store, authority, plan.repo);
      if (!pre.ok) return pre;
      const made = await revertCommit(git, plan, options.scratch);
      if (!made.ok) return made;
      commit = made.commit;
    }
    // The intent, with the authority and the plan's standing re-read in one transaction (the durable lock: one unsettled
    // intent per project).
    let intentId: number;
    try {
      intentId = store.transact(() => {
        const who = standing(store, authority, plan.repo);
        if (!who.ok) throw new Refused(who);
        if (intents(store, "repo = ?", [plan.repo]).some(one => settledOf(store, one.id) === null)) throw new Refused(refuse("busy", "Another landing in this project hasn't finished. Try again in a moment."));
        if (plan.kind === "land") {
          const again = assignmentOf(store, taskId, now, { principal: "operator", repos: access.repos }, options.root);
          if (again?.state !== "complete" || again.receipt?.digest !== plan.receipt || again.completion?.digest !== plan.receipt) throw new Refused(refuse("stale", "This result changed since you looked. Look again, then land it."));
        }
        if (!plan.recorded) recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: null, runId: null, action: LAND_DESTINATION, outcome: plan.ref, source: "request" },
          { v: 1, ref: plan.ref, common: project.common });
        return recordActionWhole(store.handle, { at: now.toISOString(), actor: who.actor, repo: plan.repo, taskId: plan.rootId, runId: plan.runId, action: LAND_INTENT, outcome: "pending", source: "request" },
          { v: 1, kind: plan.kind, key: plan.key, ref: plan.ref, old: plan.old, commit, mode: plan.mode, ...(plan.reverts === undefined ? {} : { reverts: plan.reverts.intent }) });
      });
    } catch (error) {
      if (error instanceof Refused) return error.result;
      throw error;
    }
    const settle = (outcome: string, words: string) => recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo: plan.repo, taskId: plan.rootId, runId: plan.runId,
      action: LAND_SETTLED, outcome: `${intentId}:${outcome}`, source: "work" }, { v: 1, words });
    // Right before acting: the folder and the branch read again, and the person's authority still standing.
    if (plan.mode === "files") {
      const problem = await checkoutProblem(git, plan.repo, project.common, plan.ref, plan.old);
      if (problem !== null) { settle("refused", problem.words); return refuse(problem.reason, problem.words); }
    }
    const who = standing(store, authority, plan.repo);
    if (!who.ok) { settle("refused", who.message); return who; }
    const swapped = await git(["update-ref", "-m", `toolroll: land ${plan.taskId}`, plan.ref, commit!, plan.old]);
    if (swapped.code !== 0) {
      const words = `${plan.branch} moved while landing, so nothing changed. Look again, then land it.`;
      settle("refused", words);
      return refuse("moved", words);
    }
    if (plan.mode === "files") {
      const files = await git(["read-tree", "-m", "-u", plan.old, commit!]);
      if (files.code !== 0) {
        const back = await git(["update-ref", "-m", `toolroll: land ${plan.taskId} rolled back`, plan.ref, plan.old, commit!]);
        const words = back.code === 0 ? "Your folder's files couldn't be updated (something changed them meanwhile), so the branch was put back. Nothing changed."
          : `Your folder's files couldn't be updated and the branch couldn't be put back: it's at ${short(commit!)}, your files are at ${short(plan.old)}. Look at ${plan.repo} with git status.`;
        settle(back.code === 0 ? "rolled-back" : "needs-person", words);
        return refuse("git", words);
      }
    }
    let warning: string | null = null;
    if (plan.mode === "files") {
      const after = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      if (after.code !== 0 || after.stdout !== "") warning = "Something changed your folder while it landed: look at it with git status.";
    }
    settle("landed", warning ?? (plan.kind === "undo" ? "Undone." : "Landed."));
    return { ok: true, replayed: false, kind: plan.kind, ref: plan.ref, branch: plan.branch, commit: commit!, old: plan.old, mode: plan.mode, warning };
  });
}

class Refused extends Error {
  constructor(readonly result: { ok: false; reason: LandRefusal; message: string }) { super(result.message); }
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

