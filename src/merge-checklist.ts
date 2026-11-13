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
import { approvedCheckStateOf, requirementWordOf } from "./task-status.js";

export const CHECKLIST_KEYS = ["plan", "build", "checks", "requirements", "pull-request", "pr-ci", "up-to-date", "conflicts", "comments", "release"] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];
/** yes: done; no: in the way (with its act when one exists); waiting: under way, nothing to do yet; unknown: Toolroll
 * keeps no record of it; skip: doesn't apply to this task. */
export type ChecklistMark = "yes" | "no" | "waiting" | "unknown" | "skip";
/** The existing act a blocker carries. `fix`: Send back, with `note` as its feedback (empty: send the saved notes). */
export type ChecklistAct = { kind: "run-checks"; run: number } | { kind: "retry"; taskId: string } | { kind: "fix"; run: number; note: string };
export type ChecklistRow = { key: ChecklistKey; label: string; mark: ChecklistMark; say: string; act: ChecklistAct | null };
export type MergeChecklist = {
  taskId: string; activeTaskId: string; run: number | null; head: string | null;
  /** yes: nothing Toolroll records is in the way; no: something is (the first `no` row); not-yet: only waiting rows. */
  answer: "yes" | "no" | "not-yet" | "merged";
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
/** The act labels, the same words the result page uses. */
export const CHECKLIST_ACT_LABELS: Readonly<Record<ChecklistAct["kind"], string>> = { "run-checks": "Run checks", retry: "Retry", fix: "Ask the agent to fix" };

const short = (sha: string | null | undefined): string => sha == null ? "this commit" : sha.slice(0, 7);

/** The checklist for a task's current result, as `access` may see it; null when the task isn't visible there. */
export function mergeChecklistOf(store: Store, taskId: string, now: Date, access: AssignmentAccess, root?: string): MergeChecklist | null {
  const assignment = assignmentOf(store, taskId, now, access, root);
  if (assignment === null) return null;
  return checklistFromAssignment(store, taskId, assignment);
}

/** The checklist from an assignment snapshot already read (the task page reads one). */
export function checklistFromAssignment(store: Store, taskId: string, assignment: AssignmentSnapshot): MergeChecklist {
  const active = assignment.activeTaskId;
  const scope = store.getScope(active);
  const task = store.getTask(active);
  const receipt = assignment.receipt;
  const run = receipt?.runId ?? null;
  const head = receipt?.head ?? null;
  const rows: ChecklistRow[] = [];
  const row = (key: ChecklistKey, mark: ChecklistMark, say: string, act: ChecklistAct | null = null) => rows.push({ key, label: CHECKLIST_LABELS[key], mark, say, act });

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
  else row("checks", "no", check === "unreadable" ? "The check result couldn't be read." : "No check ran on this commit.", { kind: "run-checks", run: receipt.runId });

  // Requirements: the result's own blockers, as Accept reads them.
  const criteria = assignment.readiness?.blockers.filter(one => one.key === "criteria" || one.key === "high") ?? [];
  if (receipt === null) row("requirements", "waiting", "Waits for a build.");
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

  // Up to date with main and conflicts: Toolroll keeps no record of either, except a batch check's conflict.
  row("up-to-date", merged ? "yes" : "unknown", merged ? "Merged." : NOT_RECORDED);
  if (merged) row("conflicts", "yes", "Merged.");
  else if (receipt?.checks.batch?.state === "conflict") row("conflicts", "no", "It conflicted with another result in its batch check.", { kind: "fix", run: receipt.runId, note: "It conflicts with another change. Rebase it on main and resolve the conflict." });
  else row("conflicts", "unknown", NOT_RECORDED);

  // Review comments: the saved notes and pull request review comments not yet sent back.
  const notes = run === null ? [] : store.liveDiffComments(run).filter(one => isRevisionFeedback(one));
  if (run === null) row("comments", "waiting", "Waits for a build.");
  else if (notes.length === 0) row("comments", "yes", "None open.");
  else row("comments", "no", `${notes.length} note${notes.length === 1 ? "" : "s"} not sent back yet.`, { kind: "fix", run, note: "" });

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
    : `Yes, as far as Toolroll records.${unknown.length === 0 ? "" : ` Check ${unknown.join(" and ")} on GitHub.`}`;
  return { taskId, activeTaskId: active, run, head, answer, sentence, rows };
}

/** The checklist as plain lines (the CLI, the lead, the TUI): the answer, then one line per row that applies. */
export function checklistLines(list: MergeChecklist): string[] {
  const MARK: Readonly<Record<ChecklistMark, string>> = { yes: "✓", no: "✗", waiting: "…", unknown: "?", skip: "–" };
  return [`Can I merge ${list.activeTaskId}? ${list.sentence}`,
    ...list.rows.filter(one => one.mark !== "skip").map(one => `  ${MARK[one.mark]} ${one.label}: ${one.say}${one.act === null ? "" : ` [${CHECKLIST_ACT_LABELS[one.act.kind]}]`}`)];
}
