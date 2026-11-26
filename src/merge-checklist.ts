/** "Can I merge?" (docs/plans/plain-toolroll.md P1.6): one checklist per task, read from the records the task page,
 * the result page and the pull request row already read, with nothing recomputed and nothing checked live. Each row
 * says one fact about the task's current result; a blocker carries one existing act the person can take: Run checks,
 * Retry, or Ask the agent to fix (Send back with a note naming the blocker). Nothing here acts: it is a read, and every
 * act it names is the person's own post through its usual door.
 *
 * Rows Toolroll keeps no record of (up to date with main; conflicts outside a batch check) say so, rather than guess:
 * GitHub shows them on the pull request. */
import { assignmentOf, type AssignmentAccess, type AssignmentSnapshot } from "./assignment.js";
import { pullRequestFollowOf, pullRequestViewOf, publishingOf } from "./pull-request-flow.js";
import { releaseCiHoldOf, releaseCiRunningOf } from "./release-ci-hold.js";
import { isRevisionFeedback } from "./result-review.js";
import { approvalOf, deployGateScope } from "./scope.js";
import { shipChecksForTask, type Store } from "./store.js";
import { approvedCheckStateOf, completedByOf, requirementWordOf } from "./task-status.js";
import { projectCheckSet } from "./check-levels.js";
import { projectName } from "./project.js";
import { LAND_HANDOFF, LAND_INTENT, landingHistoryOf, publishesThroughPullRequests } from "./local-landing.js";
import { recentGitReads, type GitRead, type TaskBaseView } from "./task-base.js";

/** The bounded git reads a checklist's landing history uses (display only, answers kept for a moment). */
const landingReads: GitRead = recentGitReads();

/** A task's landing history when its work is on its branch now (landingHistoryOf), else null: what the checklist says in
 * place of "Not yet" for work that already landed. Projects that publish through pull requests have none. */
export function landedNowOf(store: Store, assignment: AssignmentSnapshot, read: GitRead = landingReads): { words: string; reverted: boolean } | null {
  // Only accepted work lands: anything else reads nothing more (no statement, no git read).
  const head = assignment.state === "complete" ? assignment.receipt?.head ?? null : null;
  if (head === null || assignment.repo === null || publishesThroughPullRequests(store, assignment.repo)) return null;
  const history = landingHistoryOf(store, assignment.repo, assignment.rootId, head, read);
  return history !== null && history.landed ? { words: history.words, reverted: history.reverted } : null;
}

/** Each listed task's landing words ("Landed on main (abc1234)", no closing period) when its accepted work is on its
 * branch, for a list (the workbench's rows, `toolroll task list`): one ledger read for every row, then the landing history
 * (landedNowOf's) only for a row Toolroll landed or handed a landing commit for. Work a person merged by hand with no
 * Toolroll landing is said on its own page only. Display only. */
export function landedRowsOf(store: Store, rows: readonly { rootId: string; repo: string | null; resultRunId: number | null; assignmentState: string }[],
  read: GitRead = landingReads): Map<string, string> {
  const out = new Map<string, string>();
  const done = rows.filter(one => one.assignmentState === "complete" && one.repo !== null && one.resultRunId !== null);
  if (done.length === 0) return out;
  const ids = [...new Set(done.map(one => one.rootId))];
  const touched = new Set(store.handle.prepare(`SELECT DISTINCT task_id FROM action_ledger WHERE action IN (?, ?) AND task_id IN (${ids.map(() => "?").join(",")})`)
    .all(LAND_INTENT, LAND_HANDOFF, ...ids).map(row => String(row["task_id"])));
  for (const one of done) {
    if (!touched.has(one.rootId) || publishesThroughPullRequests(store, one.repo!)) continue;
    const history = landingHistoryOf(store, one.repo!, one.rootId, store.getRun(one.resultRunId!)?.headRevision ?? null, read);
    if (history !== null && history.landed) out.set(one.rootId, history.words.replace(/\.$/, ""));
  }
  return out;
}

export const CHECKLIST_KEYS = ["plan", "build", "checks", "requirements", "pull-request", "pr-ci", "up-to-date", "conflicts", "comments", "release"] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];
/** yes: done; no: in the way (with its act when one exists); waiting: under way, nothing to do yet; unknown: Toolroll
 * keeps no record of it; note: a fact worth seeing that is not in the way (no check is set: Land doesn't need one);
 * skip: doesn't apply to this task. */
export type ChecklistMark = "yes" | "no" | "waiting" | "unknown" | "note" | "skip";
/** The existing act a blocker carries. `fix`: Send back, with `note` as its feedback (empty: send the saved notes). */
export type ChecklistAct = { kind: "run-checks"; run: number } | { kind: "retry"; taskId: string } | { kind: "fix"; run: number; note: string };
export type ChecklistRow = { key: ChecklistKey; label: string; mark: ChecklistMark; say: string; act: ChecklistAct | null };
export type MergeChecklist = {
  taskId: string; activeTaskId: string; run: number | null; head: string | null;
  /** yes: nothing Toolroll records is in the way; no: something is (the first `no` row); not-yet: only waiting rows.
   * landed: its work is already on the branch (local-landing.ts landingHistoryOf): the sentence is that history and
   * there are no rows, since nothing is left to merge (everyday-9 E1). */
  answer: "yes" | "no" | "not-yet" | "merged" | "landed";
  sentence: string;
  rows: ChecklistRow[];
};

export const CHECKLIST_LABELS: Readonly<Record<ChecklistKey, string>> = {
  plan: "Plan approved",
  build: "Build finished",
  checks: "Project checks passed on this commit",
  requirements: "Requirements met",
  "pull-request": "Pull request open",
  "pr-ci": "PR CI passed on this exact commit",
  "up-to-date": "Up to date with main",
  conflicts: "No conflicts",
  comments: "Review comments answered",
  release: "Release check passed",
};
/** The one sentence for a row Toolroll keeps no record of. */
export const NOT_RECORDED = "Toolroll doesn't record this. The pull request on GitHub shows it.";
/** The same, for a project that doesn't open pull requests (it may not be on GitHub at all). */
export const NOT_RECORDED_LOCAL = "Toolroll doesn't record this. Your repository shows it.";
/** The act labels, the same words the result page uses. */
export const CHECKLIST_ACT_LABELS: Readonly<Record<ChecklistAct["kind"], string>> = { "run-checks": "Run checks", retry: "Retry", fix: "Ask the agent to fix" };

const short = (sha: string | null | undefined): string => sha == null ? "this commit" : sha.slice(0, 7);
/** A project with no check command: where a person sets one (Settings → Projects → the project → Checks). */
export const noCheckSetWords = (repo: string): string => `No check is set for ${projectName(repo)}. Set one in Settings → Projects → ${projectName(repo)} → Checks.`;

/** The checklist for a task's current result, as `access` may see it; null when the task isn't visible there. */
export function mergeChecklistOf(store: Store, taskId: string, now: Date, access: AssignmentAccess, root?: string): MergeChecklist | null {
  const assignment = assignmentOf(store, taskId, now, access, root);
  if (assignment === null) return null;
  return checklistFromAssignment(store, taskId, assignment, landedNowOf(store, assignment)?.words ?? null);
}

/** The checklist from an assignment snapshot already read (the task page reads one). `landed`: the task's landing
 * history words when its work is already on the branch (landedNowOf): the answer is then that history, with no rows. */
export function checklistFromAssignment(store: Store, taskId: string, assignment: AssignmentSnapshot, landed: string | null = null,
  /** The project's main as the task's Base line names it (task-base.ts taskBaseOf), when the caller read it already (the
   * task page). Undefined: read here, for a project without pull requests. */
  base?: Pick<TaskBaseView, "main"> | null,
  /** The bounded git read "Up to date with main" uses (display only). */
  read: GitRead = landingReads): MergeChecklist {
  const active = assignment.activeTaskId;
  if (landed !== null) return { taskId, activeTaskId: active, run: assignment.receipt?.runId ?? null, head: assignment.receipt?.head ?? null, answer: "landed", sentence: landed, rows: [] };
  const scope = store.getScope(active);
  const task = store.getTask(active);
  const receipt = assignment.receipt;
  const run = receipt?.runId ?? null;
  const head = receipt?.head ?? null;
  const rows: ChecklistRow[] = [];
  const row = (key: ChecklistKey, mark: ChecklistMark, say: string, act: ChecklistAct | null = null) => rows.push({ key, label: CHECKLIST_LABELS[key], mark, say, act });
  // Accepted: a person's acceptance of this result is on record (a completion is history: it stays when its checks run
  // again later). It answers every "You check" requirement, as Land reads it; checks and main still count (below).
  const accepted = assignment.state === "complete" && assignment.completion !== null;

  // Plan approved: the approval as dispatch reads it.
  if (scope === null) row("plan", "no", "There's no plan yet.");
  else if (approvalOf(scope).approved) row("plan", "yes", scope.approvedBy == null ? "Approved." : `Approved by ${scope.approvedBy}.`);
  else row("plan", "no", "The plan waits for your approval.");

  // Build finished: a result is recorded; a failed task retries.
  if (task?.state === "failed") row("build", "no", "The last build failed.", { kind: "retry", taskId: active });
  else if (receipt !== null) row("build", "yes", `Build #${receipt.runId} finished.`);
  else if (assignment.state === "working" || assignment.state === "checking") row("build", "waiting", "Building now.");
  else row("build", "waiting", "Nothing is built yet.");

  // Project checks on this commit: the approved check as the Checks row reads it.
  const check = receipt === null ? null : approvedCheckStateOf(receipt.checks);
  if (receipt === null || check === null) row("checks", "waiting", "Waits for a build.");
  else if (check === "passed") row("checks", "yes", receipt.checks.release != null && receipt.checks.status !== "passed" ? `Covered by release check #${receipt.checks.release.run}.` : `Passed on ${short(head)}.`);
  else if (check === "failed") row("checks", "no", `Failed on ${short(head)}${receipt.checks.exitCode === null ? "" : ` (exit ${receipt.checks.exitCode})`}.`,
    { kind: "fix", run: receipt.runId, note: `The project checks failed on ${short(head)}${receipt.checks.exitCode === null ? "" : ` (exit ${receipt.checks.exitCode})`}. Fix them so they pass.` });
  else if (check === "running") row("checks", "waiting", "Running now.");
  else if (check === "off") row("checks", "waiting", "Checks are off for this project; they run at release.");
  // No check command at all: Run checks could only refuse, so the row says how to set one instead. Not in the way: Land
  // lands work from a project with no check (local-landing.ts), and so does Accept.
  else if (check === "not-run" && assignment.repo !== null && !projectCheckSet(store, assignment.repo)) {
    row("checks", "note", noCheckSetWords(assignment.repo));
  }
  else row("checks", "no", check === "unreadable" ? "The check result couldn't be read." : check === "stale" ? "The check command changed since they ran on this commit." : "No check ran on this commit.", { kind: "run-checks", run: receipt.runId });

  // Requirements: the result's own blockers, as Accept reads them.
  const criteria = assignment.readiness?.blockers.filter(one => one.key === "criteria" || one.key === "high") ?? [];
  if (receipt === null) row("requirements", "waiting", "Waits for a build.");
  else if (accepted) { const by = completedByOf(assignment.completion); row("requirements", "yes", by === null ? "Accepted." : `Accepted by ${by}.`); }
  else if (criteria.length > 0) row("requirements", "no", criteria[0]!.message, { kind: "fix", run: receipt.runId, note: criteria.map(one => one.message).join("\n") });
  else if (assignment.readiness?.verdict === "refuted") row("requirements", "no", "The result doesn't match its plan.", { kind: "fix", run: receipt.runId, note: "The result doesn't match its plan. Fix it so it does." });
  else {
    // A requirement only a person can confirm, not yet confirmed (no acceptance of this result): it waits on them.
    const yours = receipt.proofAcceptance !== null ? 0
      : (receipt.proof?.matrix ?? []).filter(one => requirementWordOf(one, receipt.proof?.verdict ?? null) === "You check").length;
    if (yours > 0) row("requirements", "waiting", `You check ${yours} requirement${yours === 1 ? "" : "s"}.`);
    else row("requirements", "yes", "Every requirement is met.");
  }

  // The pull request and its CI, as the task's pull request row reads them.
  const view = run === null ? null : pullRequestViewOf(store, run);
  const publishing = publishingOf(store, assignment.repo);
  let merged = false;
  if (view === null) {
    if (!publishing.on) {
      row("pull-request", "skip", "This project doesn't open pull requests.");
      row("pr-ci", "skip", "No pull request.");
    } else {
      row("pull-request", "waiting", receipt === null ? "Opens once it's built and accepted." : "Opens when you accept it.");
      row("pr-ci", "waiting", "Runs once the pull request opens.");
    }
  } else {
    merged = view.state === "merged";
    if (merged) row("pull-request", "yes", view.prNumber === null ? "Merged." : `#${view.prNumber} merged.`);
    else if (view.state === "opening") row("pull-request", "waiting", "Opening now.");
    else if (view.state === "failed" || view.state === "closed") row("pull-request", "no", view.detail);
    else row("pull-request", "yes", `#${view.prNumber} is open.`);
    const publication = store.publicationForRun(view.runId);
    const follow = publication === null ? null : pullRequestFollowOf(store, publication.id);
    const ship = shipChecksForTask(store, active);
    const exact = publication !== null && follow !== null && follow.readyHead === publication.headSha;
    if (merged) row("pr-ci", "yes", "Merged.");
    else if (view.state === "ready" || (view.state === "waiting" && view.fullCheck !== null)) row("pr-ci", exact ? "yes" : "waiting", exact ? `Passed on ${short(publication!.headSha)}.` : "Passed, on an earlier commit.");
    else if (view.state === "failing") {
      const failing = ship?.checks.filter(one => one.state === "failed").map(one => one.workflow === null ? one.name : `${one.workflow} / ${one.name}`) ?? [];
      const said = `Failed on ${short(publication?.headSha)}${failing.length === 0 ? "" : `: ${failing.slice(0, 3).join(", ")}${failing.length > 3 ? ", …" : ""}`}.`;
      // A revision Toolroll already filed with the failure is the fix under way: no second one from here.
      if (view.revisionTask !== null) row("pr-ci", "no", `${said} Revision ${view.revisionTask} was filed with the failure.`);
      else row("pr-ci", "no", said, receipt === null ? null : { kind: "fix", run: receipt.runId, note: `PR CI failed on ${short(publication?.headSha)}${failing.length === 0 ? "" : ` (${failing.join(", ")})`}. Fix it so it passes.` });
    } else if (view.state === "running") row("pr-ci", "waiting", "Running now.");
    else if (view.state === "opening") row("pr-ci", "waiting", "Runs once the pull request opens.");
    else row("pr-ci", view.state === "failed" || view.state === "closed" ? "skip" : "waiting", view.state === "failed" || view.state === "closed" ? "No open pull request." : "No CI has reported yet.");
  }

  // Up to date with main and conflicts: Toolroll keeps no record of either, except a batch check's conflict. Where to
  // look is GitHub only when this project opens pull requests there. A project without pull requests reads git itself
  // (everyday-9 E3): the commits on main the RESULT doesn't contain (main..its head), since its work lands only on top
  // of main. A result that already contains main's newer commits is up to date, whatever base its review started from
  // (review round 1); the review base itself is unchanged.
  const notRecorded = publishing.on ? NOT_RECORDED : NOT_RECORDED_LOCAL;
  const standing = merged || publishing.on || receipt === null || assignment.repo === null ? null : resultBehindMain(assignment.repo, head, base === undefined ? undefined : base?.main ?? null, read);
  if (merged) row("up-to-date", "yes", "Merged.");
  else if (standing == null || standing.main === null || standing.behind === null) row("up-to-date", "unknown", notRecorded);
  else if (standing.behind === 0) row("up-to-date", "yes", `Up to date with ${standing.main}.`);
  else row("up-to-date", "no", `${standing.main} has ${standing.behind === 1 ? "1 commit" : `${standing.behind} commits`} this work doesn't. Send it back to build on the current ${standing.main}.`,
    { kind: "fix", run: receipt!.runId, note: `${standing.main} moved on since this work started. Build it again on the current ${standing.main}.` });
  if (merged) row("conflicts", "yes", "Merged.");
  else if (receipt?.checks.batch?.state === "conflict") row("conflicts", "no", "It conflicted with another result in its batch check.", { kind: "fix", run: receipt.runId, note: "It conflicts with another change. Rebase it on main and resolve the conflict." });
  else row("conflicts", "unknown", notRecorded);

  // Review comments: the saved notes and pull request review comments not yet sent back.
  const notes = run === null ? [] : store.liveDiffComments(run).filter(one => isRevisionFeedback(one));
  if (run === null) row("comments", "waiting", "Waits for a build.");
  else if (notes.length === 0) row("comments", "yes", "None open.");
  // Accepted work lands without them (local-landing.ts): a saved note is still offered, never in the way.
  else row("comments", accepted ? "note" : "no", `${notes.length} note${notes.length === 1 ? "" : "s"} not sent back yet.`, { kind: "fix", run, note: "" });

  // A release: its own check, as the release card reads it.
  if (scope !== null && deployGateScope(scope)) {
    if (releaseCiHoldOf(store, active) !== null || releaseCiRunningOf(store, active) !== null) row("release", "waiting", "GitHub's checks are still running.");
    else if (receipt !== null && receipt.checks.level === "full" && receipt.checks.status === "passed") row("release", "yes", `The full check passed on ${short(head)}.`);
    else if (receipt !== null && receipt.checks.status === "failed") row("release", "no", "The release check failed.", { kind: "fix", run: receipt.runId, note: "The release check failed. Fix it so it passes." });
    else row("release", "waiting", "The release check hasn't run on this commit yet.");
  } else row("release", "skip", "Not a release.");

  const first = rows.find(one => one.mark === "no");
  const unknown = rows.filter(one => one.mark === "unknown").map(one => one.label.toLowerCase());
  const answer: MergeChecklist["answer"] = merged ? "merged" : first !== undefined ? "no" : rows.some(one => one.mark === "waiting") ? "not-yet" : "yes";
  const sentence = answer === "merged" ? "Already merged."
    : answer === "no" ? `Not yet: ${first!.label.toLowerCase()} — ${first!.say}`
    : answer === "not-yet" ? `Not yet: ${rows.find(one => one.mark === "waiting")!.label.toLowerCase()} — ${rows.find(one => one.mark === "waiting")!.say}`
    : `Yes, as far as Toolroll records.${unknown.length === 0 ? "" : ` Check ${unknown.join(" and ")} ${publishing.on ? "on GitHub" : "in your repository"}.`}`;
  return { taskId, activeTaskId: active, run, head, answer, sentence, rows };
}

/** How many commits on the project's main the result's head doesn't contain (`rev-list --count <head>..main`), and which
 * branch main is (`main` from the caller, else the project's checked-out branch). Null counts when git can't say.
 * Display only: it decides nothing. */
function resultBehindMain(repo: string, head: string | null, main: string | null | undefined, read: GitRead): { main: string | null; behind: number | null } {
  const branch = main === undefined ? read(repo, ["symbolic-ref", "--short", "-q", "HEAD"]) || null : main;
  if (branch === null || head === null || !/^[0-9a-f]{40}$/.test(head)) return { main: branch, behind: null };
  const counted = read(repo, ["rev-list", "--count", `${head}..refs/heads/${branch}`]);
  return { main: branch, behind: counted !== null && /^\d+$/.test(counted) ? Number(counted) : null };
}

/** The checklist as plain lines (the CLI, the lead, the TUI): the answer, then one line per row that applies. */
export function checklistLines(list: MergeChecklist): string[] {
  if (list.answer === "landed") return [list.sentence];
  const MARK: Readonly<Record<ChecklistMark, string>> = { yes: "✓", no: "✗", waiting: "…", unknown: "?", note: "–", skip: "–" };
  return [`Can I merge ${list.activeTaskId}? ${list.sentence}`,
    // A blocker's act is a button on the task's page; in plain text it says where to find it, never a fake button.
    ...list.rows.filter(one => one.mark !== "skip").map(one => `  ${MARK[one.mark]} ${one.label}: ${one.say}${one.act === null ? "" : ` Next: ${CHECKLIST_ACT_LABELS[one.act.kind]}, on the task's page.`}`)];
}
