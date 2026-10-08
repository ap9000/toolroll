/**
 * The workspace's ONE display projection (package 1, 2026-09-13): the
 * words, tone, and next action a task or result wears on every surface —
 * Work rows, the task page's status box, the focused chat's journey card,
 * the review cockpit's chip, and the completion receipt's heading. Pure
 * functions over facts the store already records (task state, the dispatch
 * diagnosis, the machine's proof verdict and its reasons, an operator's
 * acceptance, the publication row); nothing here is a second lifecycle,
 * and nothing here reads the agent's narrative as evidence of success.
 *
 * The vocabulary is the truthful-status contract from the workspace plan:
 * a saved result with a failed check says "Changes saved, but checks
 * failed"; a missing proof says "verification needed"; agent-reported
 * checks say so; an accepted exception stays an exception; and nothing
 * local is ever called shipped or deployed — "PR opened" and "Merge
 * observed" name observed publication records, and deployment is never
 * claimed without one.
 */

import type { DispatchAction, DispatchDiagnosis } from "./dispatch.js";
import { ACCEPT_NEEDS_REASON, FAILED_CHECK, cantAcceptYetOf, evidenceProblemOf, type AcceptLabel, type EvidenceProblem } from "./result-acts.js";
export { ACCEPT_NEEDS_REASON, cantAcceptYetOf, evidenceProblemOf, type EvidenceProblem };
import { GOAL_ASSESSMENT_PENDING, manualReviewOnly, plainReasonWords, type ProofVerdict } from "./proof.js";
import type { ReviewRetryState, TaskState } from "./store.js";
import type { TaskControlView } from "./task-control.js";
import { OPEN_RESULT, plainReasonOf, stageOfCode, taskStatusOf, workToneOf } from "./task-status.js";
import { whenUtc } from "./when-html.js";

/** The Work destination's views — shortcuts over the same rows, never a
 * persisted state. All is the default. */
export type WorkView = "all" | "needs-you" | "running" | "completed";

export const WORK_VIEWS: readonly { key: WorkView; label: string; hint: string; empty: string }[] = [
  { key: "all", label: "All", hint: "Every task in view, most urgent first.", empty: "Nothing is in progress. Describe work in chat or add a task, and it appears here." },
  { key: "needs-you", label: "Needs you", hint: "Tasks waiting on an answer, approval, or your inspection.", empty: "Nothing needs you right now. Queued and running work continues on its own." },
  { key: "running", label: "Building", hint: "Attempts a builder owns right now.", empty: "Nothing is building right now. Approved tasks start when a builder with capacity is connected." },
  { key: "completed", label: "Complete", hint: "Tasks the lead or user has marked complete. Recorded check results remain available.", empty: "No tasks have been marked complete in this view." },
];

export function parseWorkView(raw: string | null): WorkView {
  return raw === "needs-you" || raw === "running" || raw === "completed" ? raw : "all";
}

/** The finished result's recorded facts, as `taskViewData`, dispatch, and
 * the completed-work query already read them. */
export type ResultFacts = {
  runId: number | null;
  /** The result run's role — a scout delivers a report, not a diff. */
  role: string | null;
  outcome: string | null;
  verdict: ProofVerdict | null;
  reasons: readonly string[];
  accepted: boolean;
  /** A no-change conclusion's two presence facts (handoff + sealed diff);
   * undefined when the caller did not read them. */
  recordComplete?: boolean;
  /** The check level this result now stands at (check-levels.ts): Off reads
   * Ready for review, saying no check ran, until a follow-up check passes. */
  checkLevel?: "quick" | "full" | "off" | null;
  /** This exact run's independent review (v50 retry projection), read
   * per run so an older selected result keeps its own words; undefined
   * when the caller did not read it, null when never requested. */
  review?: ReviewFacts | null;
};

/** The result's review facts as `reviewRetryStateOf` records them, plus
 * the one liveness fact the words depend on. */
export type ReviewFacts = {
  state: ReviewRetryState["state"];
  /** The attempt in play: the next ordinal while queued, else the live or
   * latest attempt's. */
  attempt: number | null;
  cap: number;
  attempts: number;
  retriesRemaining: number;
  latestReason: string | null;
  interrupted: boolean;
  /** Who asked for the open (queued) request, when one is open. */
  queuedBy: string | null;
  queuedOrigin?: "operator" | "automatic" | null;
  /** Whether the live attempt's reviewer worker is answering. */
  reviewerAlive: boolean;
  /** The build's one automatic review is still pending (build-review.ts). */
  automaticPending?: boolean;
};

/** The review facts from the store's bounded retry projection — the same
 * reading `diagnoseTaskDispatch` makes, so every surface starts from one
 * record. `reviewerAlive` answers for the live attempt's runner. */
export function reviewFactsOf(retry: ReviewRetryState | null, reviewerAlive: (runner: string) => boolean, automaticPending = false): ReviewFacts | null {
  if (retry === null || retry.state === "unrequested") return null;
  const current = retry.live ?? (retry.state === "queued" ? null : retry.latest);
  return {
    state: retry.state,
    attempt: retry.state === "queued" ? retry.nextAttempt : current?.attempt ?? null,
    cap: retry.cap,
    attempts: retry.attempts.length,
    retriesRemaining: retry.retriesRemaining,
    latestReason: retry.latest?.reason ?? null,
    interrupted: retry.latest !== null && (retry.latest.outcome === "interrupted" || retry.latest.reason === "interrupted"),
    queuedBy: retry.openRequest?.requestedBy ?? null,
    queuedOrigin: retry.openRequest?.origin ?? null,
    reviewerAlive: retry.live !== null && reviewerAlive(retry.live.runner),
    automaticPending,
  };
}

/** The tokens a review in flight wears — the dispatch codes, unchanged. */
export const REVIEW_TOKENS: ReadonlySet<string> = new Set(["reviewing", "review-pending", "review-failed", "review-exhausted"]);

const retriesLeft = (count: number, explicit = true): string => `${count}${explicit ? " explicit" : ""} ${count === 1 ? "retry" : "retries"}`;

/**
 * A review that is queued, running, failed with a retry left, or
 * exhausted is the result's PRIMARY status — the machine is still
 * deciding, and every surface must say so with the same words. A review
 * never requested, or one that succeeded, adds nothing: the stored verdict
 * (folded by the review where one landed) speaks. Words and tokens are
 * the v50 dispatch contract; nothing here changes the lifecycle.
 */
export function reviewStatusOf(review: ReviewFacts | null): DisplayStatus | null {
  // The one automatic review (build-review.ts) holds the result only while it
  // is queued or running. A failed review never blocks: the result reads as
  // it would unreviewed, marked "not reviewed" by the result itself.
  if (review === null || review.automaticPending !== true || (review.state !== "queued" && review.state !== "running")) return null;
  return { token: "reviewing", label: "Reviewing", detail: "An automatic review is reading this result before it reaches you.", tone: "live", action: { label: OPEN_RESULT, kind: "open-result" } };
}

export type PublicationFacts = {
  state: string;
  prNumber: number | null;
  prUrl: string | null;
  remoteState: string | null;
  lastCheckState: string | null;
} | null;

export type StatusTone = "attention" | "problem" | "live" | "ready" | "done" | "muted" | "neutral";

export type NextAction = {
  label: string;
  /** Where the act lives — the page, not a URL, so every surface can
   * build its own link (a task page anchors, a row links out). */
  kind: "open-result" | "open-review" | "open-task" | "open-run" | "open-pr";
};

export type DisplayStatus = {
  /** The stable `data-work-status` token pages and tests key off. */
  token: string;
  /** The main wording — the same words on every surface. */
  label: string;
  /** One plain sentence: the real reason when one is recorded, never an
   * invented cause, repair, retry time, or percentage. */
  detail: string;
  tone: StatusTone;
  action: NextAction | null;
};

/** The exit code of the failed check, when the recorded reason names one. */
export function failedCheckExit(reasons: readonly string[]): number | null {
  for (const reason of reasons) {
    const found = FAILED_CHECK.exec(reason);
    if (found !== null) return Number(found[1]);
  }
  return null;
}

/** The observed publication record in words. Each state is a distinct
 * fact: a pushed branch is not a PR, an open PR is not a merge, and a
 * merge is not a deployment — no record here ever says "deployed". The
 * words name what was recorded or last observed and what stays
 * unconfirmed; a missing or stale observation never proves that nothing
 * merged or deployed, and merging is never called manual-only — an
 * authorized mode may merge on green. */
export function publicationStatusOf(publication: PublicationFacts): { token: string; label: string; detail: string } | null {
  if (publication === null) return null;
  const pr = publication.prNumber === null ? "the pull request" : `PR #${publication.prNumber}`;
  const ci = publication.lastCheckState === null || publication.lastCheckState === "none" ? "" : ` CI was last seen ${publication.lastCheckState}.`;
  if (publication.remoteState === "MERGED") {
    return { token: "merge-observed", label: "Merge observed", detail: `GitHub reports ${pr} merged. Deployment is not confirmed by any record here.` };
  }
  if (publication.remoteState === "CLOSED") {
    return { token: "pr-closed", label: "PR closed without merging", detail: `GitHub last reported ${pr} closed without a merge. No merge or deployment is recorded here.` };
  }
  if (publication.state === "opened") {
    return { token: "pr-opened", label: "PR opened", detail: `${pr} was last seen open on GitHub. No merge or deployment is recorded here.${ci}` };
  }
  if (publication.state === "pushed") {
    return { token: "branch-pushed", label: "Branch pushed", detail: "The branch reached the remote; no pull request is recorded yet." };
  }
  if (publication.state === "failed") {
    return { token: "publication-failed", label: "Publication failed", detail: "The last publication attempt failed; no pull request or merge is recorded here." };
  }
  return { token: "publication-pending", label: "Publication requested", detail: "Publishing was authorized and has not completed; no pull request or merge is recorded yet." };
}

/**
 * The finished result's status — the one place the done words are chosen.
 * Precedence: no record → scout report → operator acceptance → the machine
 * verdict's problems (a refuted or short verdict is never masked by a
 * no-change outcome) → a no-change conclusion, which owes no proof beyond
 * its handoff and sealed diff → agent-attested → verified, where an
 * observed publication names itself (a published but unverified result
 * keeps its evidence problem as the main wording; the publication rides
 * the detail).
 */
export function resultStatusOf(result: ResultFacts | null, publication: PublicationFacts = null): DisplayStatus {
  return (result?.role === "builder" ? reviewStatusOf(result.review ?? null) : null) ?? storedResultStatusOf(result, publication);
}

/** What the machine itself recorded about a result, in a clause. */
function machineVerdictWords(result: ResultFacts): string {
  if (result.verdict === "verified") return "it verified the result before the acceptance";
  if (result.verdict === "attested") return "the checks on record are the agent's own report";
  const problem = evidenceProblemOf(result.verdict, result.reasons);
  if (problem === "checks-failed") {
    const exit = failedCheckExit(result.reasons);
    return `the approved check failed against it${exit === null ? "" : ` (exit ${exit})`}`;
  }
  if (problem === "mismatched") return "its evidence did not match the sealed record";
  return "its required evidence was missing";
}

function storedResultStatusOf(result: ResultFacts | null, publication: PublicationFacts): DisplayStatus {
  if (result === null || result.runId === null) {
    return {
      token: "no-build-record",
      label: "Marked done without a build record",
      detail: "The task is done, but no finished attempt is recorded, so there is nothing to verify.",
      tone: "problem",
      action: { label: "Open the task", kind: "open-task" },
    };
  }
  if (result.role === "scout") {
    return { token: "report-ready", label: "Report ready", detail: "The research report is ready to read.", tone: "ready", action: { label: "Read the report", kind: "open-result" } };
  }
  const published = publicationStatusOf(publication);
  const withPublication = (detail: string): string => (published === null ? detail : `${detail} ${published.detail}`);
  const humanReview = manualReviewOnly({ verdict: result.verdict ?? "", reasons: result.reasons });
  if (result.accepted && humanReview) {
    return { token: "accepted-exception", label: "Accepted by a person", detail: withPublication("A person accepted this result. The recorded checks are unchanged."), tone: "done", action: { label: "Open the acceptance", kind: "open-review" } };
  }
  if (result.accepted) {
    return {
      token: "accepted-exception",
      label: "Accepted with an exception",
      // Acceptance records a person's decision; it neither proves nor
      // disproves anything about the checks. The machine's own verdict is
      // restated as recorded.
      detail: withPublication(`An approver accepted this result by hand, and the recorded exception says why. The machine's verdict is unchanged: ${machineVerdictWords(result)}.`),
      tone: "done",
      action: { label: "Open the recorded exception", kind: "open-review" },
    };
  }
  const problem = evidenceProblemOf(result.verdict, result.reasons);
  if (problem === "checks-failed") {
    const exit = failedCheckExit(result.reasons);
    return {
      token: "checks-failed",
      label: "Changes saved, but checks failed",
      detail: withPublication(`The repository's approved check failed against this build${exit === null ? "" : ` (exit ${exit})`}, so the result is not verified.`),
      tone: "problem",
      action: { label: "Open the failed check", kind: "open-review" },
    };
  }
  if (problem === "mismatched") {
    return {
      token: "evidence-mismatch",
      label: "Result saved, but its record does not match",
      // A structural refutation is settled before the approved check is
      // weighed, so it says nothing about whether that check passed.
      detail: withPublication("What the agent reported doesn't match the changes it saved."),
      tone: "problem",
      action: { label: OPEN_RESULT, kind: "open-review" },
    };
  }
  if (result.verdict === "short" && humanReview) {
    return { token: "verification-needed", label: "Ready to inspect", detail: withPublication("The remaining requirements need a person's inspection."), tone: "attention", action: { label: OPEN_RESULT, kind: "open-review" } };
  }
  if (result.verdict === "short") {
    return {
      token: "verification-needed",
      label: "Result saved — verification needed",
      detail: withPublication("Required saved material is missing, so this result is not verified."),
      tone: "problem",
      action: { label: "See what is missing", kind: "open-review" },
    };
  }
  if (result.outcome === "no-change") {
    // A machine verdict (attested or verified) already proved the record
    // at adjudication; only a verdict-less no-change reads its two
    // presence facts here.
    return result.recordComplete === false && result.verdict === null
      ? { token: "record-incomplete", label: "No-change result, record incomplete", detail: "The build concluded nothing needed to change, but its handoff or sealed diff is missing.", tone: "problem", action: { label: "Open the record", kind: "open-run" } }
      : { token: "no-change", label: "No changes were needed", detail: withPublication("The build concluded nothing needed to change; its handoff and sealed diff are on record."), tone: "done", action: { label: OPEN_RESULT, kind: "open-result" } };
  }
  if (result.verdict === null) {
    return {
      token: "verification-needed",
      label: "Result saved — verification needed",
      detail: withPublication("No verification result is recorded for this build."),
      tone: "problem",
      action: { label: "See what is missing", kind: "open-review" },
    };
  }
  if (result.verdict === "attested") {
    return {
      token: "agent-attested",
      label: "Result saved — checks reported by the agent",
      detail: withPublication("No independent project check ran; the checks listed are the agent's own report."),
      tone: "neutral",
      action: { label: OPEN_RESULT, kind: "open-result" },
    };
  }
  if (published !== null && (published.token === "merge-observed" || published.token === "pr-opened" || published.token === "pr-closed")) {
    return {
      token: published.token,
      label: published.label,
      detail: `The approved check passed against this result. ${published.detail}`,
      tone: published.token === "pr-closed" ? "muted" : "done",
      action: published.token === "merge-observed" ? { label: OPEN_RESULT, kind: "open-result" } : { label: "Open the pull request", kind: "open-pr" },
    };
  }
  return {
    token: "ready-to-review",
    label: "Ready",
    detail: withPublication("The approved check passed against this result."),
    tone: "ready",
    action: { label: OPEN_RESULT, kind: "open-result" },
  };
}

/** The completion receipt's heading: what the record actually supports.
 * Never "shipped" — local changes are saved; a PR or merge is named only
 * from its observed record. */
export function receiptHeadingOf(outcome: string | null, publication: PublicationFacts, role?: string | null): string {
  const published = publicationStatusOf(publication);
  if (published !== null && (published.token === "merge-observed" || published.token === "pr-opened")) return published.label;
  if (role === "scout" && (outcome === "built" || outcome === "no-change")) return "Report saved";
  if (outcome === "no-change") return "No changes were needed";
  return "Changes saved";
}

/** The receipt's one-line publication fact under the heading. */
export function receiptPublicationWords(publication: PublicationFacts): string {
  const published = publicationStatusOf(publication);
  return published === null ? "Saved on the build branch. No publication, merge, or deployment is recorded here." : published.detail;
}

/** Everything one Work row needs, gathered by the server from records it
 * already reads elsewhere. */
export type WorkFacts = {
  id: string;
  title: string;
  repo: string | null;
  state: TaskState;
  updatedAt: string;
  dispatch: DispatchDiagnosis | null;
  result: ResultFacts | null;
  publication: PublicationFacts;
  liveRunId: number | null;
  /** The unfinished recorded attempt, even if its claim disappeared. */
  unfinishedRunId?: number | null;
  control?: TaskControlView;
  /** An unanswered question on this exact task, read from the decision
   * owner. An elapsed attention deadline does not close a question. */
  openDecision?: { id: number; runId: number; question: string; overdue: boolean } | null;
};

export type WorkStatus = DisplayStatus & {
  /** Which shortcut views list this row; `all` always does. */
  views: readonly WorkView[];
  /** The rank All sorts by: what needs a person first, then live work,
   * then queued and waiting, then finished, then cancelled. */
  rank: number;
  /** Facts that remain visible when a more useful next action leads. */
  diagnostics?: readonly Pick<DisplayStatus, "token" | "label" | "detail" | "tone">[];
};

/** These dispatch states may yield the headline to an unanswered
 * question. Failure, uncertain process ownership, holds, approvals and
 * stop settlement deliberately do not yield. This never alters dispatch. */
const QUESTION_FIRST = new Set<DispatchDiagnosis["code"]>([
  "running", "waiting-decision", "no-worker-online", "no-worker-registered",
  "worker-at-capacity", "ready", "planning-ready", "scouting-ready",
]);

/** Needs you: the existing diagnosis semantics — waiting on a person with a
 * concrete act — never every queued task indiscriminately. */
export function needsPerson(dispatch: DispatchDiagnosis | null): boolean {
  if (dispatch === null || dispatch.action === null) return false;
  // A failed task is terminal for the scheduler and still a person's act
  // (retry); every other terminal answer (complete, cancelled) is not.
  return dispatch.condition === "waiting" || dispatch.code === "failed";
}

/** Navigation labels describe the available help, not a mutation: opening
 * a hold or pause must never promise that the task has already resumed. */
const DISPATCH_ACTION_LABELS: Record<DispatchAction, string> = {
  "open-result": OPEN_RESULT,
  "retry-task": "Review and retry",
  "place-task": "Choose a project",
  "write-scope": "Define the task",
  "select-agent": "Choose an agent",
  "approve-scope": "Approve plan",
  "answer-decision": "Answer the question",
  unhold: "Review hold",
  "inspect-hold": "Review hold",
  "repair-dependency": "Review required task",
  "repair-capability": "Review missing requirement",
  "start-worker": "Check connection",
  "retry-review": "Review retry options",
  "resume-run": "Review pause",
};

export function dispatchActionLabel(dispatch: DispatchDiagnosis | null): string {
  return dispatch?.action == null ? "View task details" : DISPATCH_ACTION_LABELS[dispatch.action];
}

/** Result tokens a done task can wear, as the shared stage they mean. A
 * result that is missing its record waits on a person; a failed check fails. */
const RESULT_NEEDS_YOU = new Set(["no-build-record", "verification-needed", "evidence-mismatch", "record-incomplete", "evidence-damaged"]);
/** Result tokens that only follow a passing project check. */
const VERIFIED_RESULT = new Set(["ready-to-review", "pr-opened", "merge-observed", "pr-closed"]);

/** A finished result's display status in the shared headline's words: a
 * failed project check is Failed, a result missing its record needs a
 * person, every other saved result is Ready for review. Token and action stay. */
/** The result's headline while its report disagrees with its saved changes. */
export const MISMATCH_HEADLINE = "The report doesn't match the changes";

/** One way the report disagrees with the saved changes, in plain words: the
 * file and lines it concerns when they are in the saved changes, or
 * `inChanges: false` for a file the report names that the changes don't have.
 * `reason` is the recorded words it says plainly. */
export type ReportMismatch = { text: string; path: string | null; lines: { from: number; to: number } | null; inChanges: boolean | null;
  /** The report's own note (1-based) the disagreement is about, when it names one. */
  note: number | null; reason: string };

const OVERCLAIMED = /^claimed changed paths? not in the sealed diff: ([\s\S]+)$/;
const RESTATED = /^criterion "([^"]+)" was signed as "[\s\S]*" and the proof restates it as "([\s\S]*)"$/;
const CONTRADICTED_BY_CAVEAT = /^criterion "([^"]+)" is marked met, but caveat [0-9]+ admits an exception to it: ([\s\S]*)$/;
const NOTE_NUMBER = /^caveat ([0-9]+) /;
const CONTRADICTED_BY_REVIEW = /^(?:reviewer:)?[^\s"]+ contradicts criterion "([^"]+)": [\s\S]*$/i;

/** Each recorded way a refuted report disagrees with its saved changes, said
 * plainly and tied to the changed lines it concerns. `changes` maps each
 * changed file to the lines of its first change (null when it has no line
 * changes, a binary file say). Presentation only: the verdict is unchanged. */
export function reportMismatchesOf(reasons: readonly string[],
  criteria: readonly { id: string; statement: string; answered: readonly { kind: string; ref: string }[]; state?: string; detail?: readonly string[] }[],
  changes: ReadonlyMap<string, { from: number; to: number } | null>): ReportMismatch[] {
  const named = (id: string): string => {
    const statement = criteria.find(one => one.id === id)?.statement.trim() ?? "";
    if (statement === "") return `requirement ${id}`;
    return `“${statement.length > 90 ? `${statement.slice(0, 90).replace(/\s+\S*$/, "")}…` : statement}”`;
  };
  // The first file the requirement cites that the saved changes have.
  const place = (id: string): Pick<ReportMismatch, "path" | "lines" | "inChanges"> => {
    const path = criteria.find(one => one.id === id)?.answered.find(ref => ref.kind === "changed-path" && changes.has(ref.ref))?.ref ?? null;
    return path === null ? { path: null, lines: null, inChanges: null } : { path, lines: changes.get(path) ?? null, inChanges: true };
  };
  const rows = reasons.flatMap((reason): ReportMismatch[] => {
    const over = OVERCLAIMED.exec(reason);
    if (over !== null) return over[1]!.split(", ").map(path => ({ text: "The report says it changed", path, lines: null, inChanges: changes.has(path), note: null, reason }));
    const restated = RESTATED.exec(reason);
    if (restated !== null) return [{ text: `The report rewords ${named(restated[1]!)} as “${restated[2]}”`, ...place(restated[1]!), note: null, reason }];
    const caveat = CONTRADICTED_BY_CAVEAT.exec(reason);
    const note = /^criterion "[^"]+" is marked met, but caveat ([0-9]+) /.exec(reason)?.[1] ?? NOTE_NUMBER.exec(reason)?.[1] ?? null;
    if (caveat !== null) return [{ text: `The report marks ${named(caveat[1]!)} met, but its own note says: ${caveat[2]}`, ...place(caveat[1]!), note: Number(note), reason }];
    const review = CONTRADICTED_BY_REVIEW.exec(reason);
    if (review !== null) return [{ text: plainReasonWords(reason), ...place(review[1]!), note: null, reason }];
    const unsigned = UNSIGNED_NOTE.exec(reason);
    if (unsigned !== null) return [{ text: `The report's note ${unsigned[1]} is about ${unsigned[2]}, which isn't one of the signed requirements: ${unsigned[3]}`, path: null, lines: null, inChanges: null, note: Number(unsigned[1]), reason }];
    if (FAILED_CHECK.test(reason)) return [];
    return [{ text: sentenceOf(plainReasonWords(reason)), path: null, lines: null, inChanges: null, note: note === null ? null : Number(note), reason }];
  });
  // Evidence a requirement cites that doesn't hold, unless a reason above already says so.
  const evidence = criteria.flatMap(one => one.state !== "failed" && one.state !== "missing" ? [] : (one.detail ?? [])
    .filter(detail => !reasons.includes(detail) && !/is waiting for the final check|requires manual-review evidence|is marked met, but caveat|was signed as/.test(detail))
    .map((detail): ReportMismatch => {
      const lead = [`criterion "${one.id}"'s `, `criterion "${one.id}" `].find(prefix => detail.startsWith(prefix));
      const rest = lead === undefined ? detail : detail.slice(lead.length);
      return { text: `${sentenceOf(named(one.id))}: ${rest}`, ...place(one.id), note: null, reason: detail };
    }));
  return [...rows, ...evidence];
}

const UNSIGNED_NOTE = /^caveat ([0-9]+) names ("[^"]*"(?:, "[^"]*")*), (?:a criterion the proof authored|which is no signed)[\s\S]*?: ([\s\S]*)$/;

/** A sentence starts with a capital letter. */
function sentenceOf(text: string): string {
  return text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The line a failing check ended on: the last line of its error output that
 * names an error, else the last line it printed, with its 1-based number in
 * the saved log. Null when the log printed nothing. */
export function lastErrorLineOf(log: string): { line: number; text: string } | null {
  const lines = log.split("\n");
  const printed = (text: string): boolean => text.trim() !== "" && !/^\$ /.test(text) && !/^\(exit -?[0-9]+\)$/.test(text.trim()) && !/^--- (stdout|stderr) ---$/.test(text.trim())
    // A section's own header ("=== Project check · attempt 1 ===") is the log's, never the check's output.
    && !/^=== .* ===$/.test(text.trim());
  const stderr = lines.findIndex(text => text.trim() === "--- stderr ---");
  const pick = (from: number, to: number): { line: number; text: string } | null => {
    let last: number | null = null;
    for (let index = to - 1; index >= from; index -= 1) {
      if (!printed(lines[index]!)) continue;
      if (/error|fail|✗|✕|×|assert|exception|panic|cannot|not found/i.test(lines[index]!)) return { line: index + 1, text: lines[index]!.trim() };
      last ??= index;
    }
    return last === null ? null : { line: last + 1, text: lines[last]!.trim() };
  };
  return (stderr >= 0 ? pick(stderr + 1, lines.length) : null) ?? pick(0, stderr >= 0 ? stderr : lines.length);
}

/** The result page's own sentence when the decision is on it. */
export const RESULT_DECISION_SENTENCE = "Review the change, then accept it or ask for changes.";

/** What the result page's Accept says, from facts it already shows: the
 * recorded checks, the requirements not met, whether the saved proof reads,
 * and what the button posts. "Accept and finish" only when everything is met
 * and the checks passed; otherwise "Accept without checks" and one line naming
 * what. The person's own checks are the page's to add (acceptWithChecksOf).
 * `effect` says what pressing it does, in the action's own terms. */
export type AcceptFacts = {
  checks: "passed" | "failed" | "not-run" | "off" | "running" | "unavailable" | null;
  unmet: number;
  /** `complete`: accepts and finishes the exact result in one request; `accept`: records a person's acceptance only (nothing here can finish it). */
  action: "complete" | "accept";
  /** `pull-request`: one can be opened from the task after; `off`: publishing isn't set up; `other`: neither is said. Accept itself never publishes. */
  publishing: "pull-request" | "off" | "other";
  /** False when the saved proof is missing or can't be read: nothing on record says what was met. */
  proof: boolean;
};
export type AcceptWords = { label: AcceptLabel; ready: boolean; why: string | null; effect: string };

export function acceptWordsOf(facts: AcceptFacts): AcceptWords {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts = [
    ...(facts.proof ? [] : ["nothing on record says what was met"]),
    ...(facts.checks === "passed" ? [] : [facts.checks === "failed" ? "checks failed" : facts.checks === "off" ? "checks are off for this project"
      : facts.checks === "running" ? "checks are still running" : facts.checks === "unavailable" ? "saved checks can't be read" : "checks didn't run"]),
    ...(facts.unmet > 0 ? [`${plural(facts.unmet, "requirement isn't", "requirements aren't")} met`] : []),
  ];
  const ready = parts.length === 0;
  const joined = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const effect = facts.action === "accept" ? "Records that you accept it. The task stays open."
    : facts.publishing === "pull-request" ? "Finishes the task. No pull request opens; you can open one from the task after."
    : facts.publishing === "off" ? "Finishes the task. The branch stays; publishing isn't set up."
    : "Finishes the task. Nothing is published.";
  return { label: ready ? "Accept and finish" : "Accept without checks", ready, why: ready ? null : `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`, effect };
}

export function resultHeadlineOf<T extends DisplayStatus>(status: T): T {
  const read = RESULT_NEEDS_YOU.has(status.token) ? { stage: "needs-you" as const, need: "other" as const }
    : status.token === "checks-failed" ? { stage: "failed" as const } : { stage: "finished" as const };
  const shared = taskStatusOf({ ...read, reason: status.detail, checks: read.stage === "failed" ? { status: "failed", exitCode: null, head: null }
    : VERIFIED_RESULT.has(status.token) ? { status: "passed", exitCode: null, head: null } : null });
  return { ...status, label: shared.headline, tone: workToneOf(shared.headline) };
}

/** The one shared headline (task-status.ts) over the work status below: the
 * token, views, rank, action and diagnostics stay; the words and tone are
 * the eight headlines'. */
export function workStatusOf(facts: WorkFacts, resultDisplay?: DisplayStatus): WorkStatus {
  const status = workStatusWordsOf(facts, resultDisplay);
  const done = facts.state === "done" && status.token !== "waiting-decision";
  const read = done ? RESULT_NEEDS_YOU.has(status.token) ? { stage: "needs-you" as const, need: "other" as const } : stageOfCode(status.token, { needsPerson: false })
    : stageOfCode(status.token, { needsPerson: status.views.includes("needs-you"), planning: facts.dispatch?.code === "running" && facts.dispatch.role === "planner", operatorHold: facts.dispatch?.action === "unhold" });
  const stage = done && read.stage !== "needs-you" && read.stage !== "failed" ? "finished" as const : read.stage;
  const level = facts.result?.checkLevel ?? null;
  const shared = taskStatusOf({ stage, ...(read.need === undefined ? {} : { need: read.need }), reason: plainReasonOf(stage, status.token, status.detail),
    report: facts.result?.role === "scout", checks: stage !== "finished" ? null : VERIFIED_RESULT.has(status.token) ? { status: "passed", exitCode: null, head: null, level }
      : level === "off" ? { status: "not-run", exitCode: null, head: null, level } : null });
  return { ...status, label: shared.headline, tone: workToneOf(shared.headline), detail: stage === "finished" && level !== "off" ? status.detail : shared.sentence };
}

function workStatusWordsOf(facts: WorkFacts, resultDisplay?: DisplayStatus): WorkStatus {
  const dispatch = facts.dispatch;
  const result = facts.state === "done" ? resultDisplay ?? resultStatusOf(facts.result, facts.publication) : null;
  const running = facts.liveRunId !== null || (dispatch?.condition === "running" && !REVIEW_TOKENS.has(dispatch.code));
  const question = (facts.state === "queued" || facts.state === "running" || facts.state === "done") ? facts.openDecision ?? null : null;
  const needs = (dispatch !== null && !REVIEW_TOKENS.has(dispatch.code) && needsPerson(dispatch)) || question !== null;
  const views: WorkView[] = ["all"];
  if (needs) views.push("needs-you");
  if (running) views.push("running");
  if (facts.state === "done") views.push("completed");

  const dispatchWords = (tone: StatusTone, rank: number, action: NextAction | null): WorkStatus => ({
    token: dispatch?.code ?? "unknown",
    label: dispatch?.summary ?? "Status unknown",
    detail: dispatch?.detail ?? "Refresh this task before relying on its status.",
    tone,
    action,
    views,
    rank,
  });

  // The control projection knows whether a stop has actually settled.
  // A still-live claim alone cannot distinguish Running from Stopping.
  if (facts.control?.kind === "stopping") {
    return { token: "stopping", label: "Stopping…", detail: facts.control.detail ?? "The attempt is ending. Its work is preserved; resume becomes available after its processes exit.", tone: "attention", action: { label: "View stop details", kind: "open-task" }, views, rank: 0 };
  }
  if (facts.control?.kind === "paused") {
    return { token: "stopped", label: "Paused", detail: "The stopped attempt's work is preserved. Resuming requires confirmation and checks the current approval again.", tone: "attention", action: { label: "Review pause", kind: "open-task" }, views, rank: 0 };
  }

  if (facts.state === "done" && result !== null) {
    // A saved result or an ongoing review cannot answer a question. Keep
    // failures primary; the shared summary retains the answer action too.
    if (question !== null && result.tone !== "problem") {
      return { token: "waiting-decision", label: "Waiting on your answer", detail: question.question,
        tone: "attention", action: { label: "Answer question", kind: "open-task" }, views, rank: 0,
        diagnostics: [{ token: result.token, label: result.label, detail: result.detail, tone: result.tone }] };
    }
    return { ...result, views, rank: needs ? 0 : 3 };
  }
  if (facts.state === "cancelled") {
    return { token: "cancelled", label: dispatch?.summary.startsWith("Replaced by ") ? dispatch.summary : "Cancelled", detail: dispatch?.detail ?? "Nothing else will run for this task.", tone: "muted", action: null, views, rank: 4 };
  }
  if (question !== null && facts.state !== "failed" && dispatch !== null && QUESTION_FIRST.has(dispatch.code)) {
    return {
      token: "waiting-decision", label: "Waiting on your answer", detail: question.question,
      tone: "attention", action: { label: "Answer question", kind: "open-task" }, views, rank: 0,
      ...(dispatch.code === "waiting-decision" ? {} : {
        diagnostics: [{ token: dispatch.code, label: dispatch.summary, detail: dispatch.detail, tone: dispatch.condition === "running" ? "live" as const : "attention" as const }],
      }),
    };
  }
  if (running) {
    return dispatchWords("live", 1, { label: "Watch the build", kind: facts.liveRunId === null ? "open-task" : "open-run" });
  }
  if (facts.state === "failed") {
    return dispatchWords("problem", 0, { label: "Review and retry", kind: "open-task" });
  }
  if (needs) {
    return dispatchWords("attention", 0, { label: dispatchActionLabel(dispatch), kind: "open-task" });
  }
  const details: NextAction = { label: "View task details", kind: "open-task" };
  if (dispatch === null) return dispatchWords("neutral", 2, details);
  return dispatchWords(dispatch.condition === "retrying" ? "neutral" : "muted", 2, details);
}

/** The counts each view tab wears — from the same rows the page lists. */
export function workCounts(rows: readonly { views: readonly WorkView[] }[]): Record<WorkView, number> {
  const counts: Record<WorkView, number> = { all: 0, "needs-you": 0, running: 0, completed: 0 };
  for (const row of rows) for (const view of row.views) counts[view] += 1;
  return counts;
}

/** All's order: rank, then most recently updated. */
export function compareWorkRows(a: { rank: number; updatedAt: string }, b: { rank: number; updatedAt: string }): number {
  return a.rank - b.rank || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
}

/** The shell's three primary destinations, from the page's own active
 * key: every old page keeps its key and lights the destination it now
 * lives under. */
export type PrimaryDestination = "chat" | "work" | "projects" | "flows" | "settings" | null;

const WORK_KEYS = new Set(["inbox", "board", "queue", "work", "done", "activity", "review", "tasks", "runs", "workbench", "recipes", "ledger"]);
const SETTINGS_KEYS = new Set(["fleet", "caps", "people", "mode", "system", "settings"]);

export function primaryDestinationOf(active: string): PrimaryDestination {
  if (active === "chat") return "chat";
  if (active === "projects") return "projects";
  if (active === "flows") return "flows";
  if (WORK_KEYS.has(active)) return "work";
  if (SETTINGS_KEYS.has(active)) return "settings";
  return null;
}

/** Learning stays in Settings and a useful, closed result disclosure. */
export function learningHtml(view: import('./project-learning.js').LearningView, csrf: string, canManage: boolean, source?: number): string {
  const e = (x: unknown) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const fields = (values: Record<string, unknown>) => Object.entries(values).map(([k,v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('');
  const base = { csrf, repo: view.repo, identity: view.identity, revision: view.revision };
  const act = (action: string, label: string, lesson?: import('./project-learning.js').Lesson) => canManage && csrf ? `<form method="post" action="/settings/learning/change">${fields({ ...base, action, ...(lesson ? { lesson: lesson.id, version: lesson.version, sha: lesson.sha } : {}) })}<button type="submit">${label}</button></form>` : '';
  const evidence = (list: import('./project-learning.js').LearningEvidence[], run: number | null) => list.map(one => `<li><a href="/r/${one.runId ?? run}/evidence/${one.artifactId}">Source #${one.artifactId}</a><blockquote>${e(one.excerpt)}</blockquote><code>${e(one.sha256)}</code></li>`).join('');
  const lessons = view.lessons.filter(l => source === undefined || l.source === source);
  const cards = lessons.map(l => `<article class="card" data-lesson="${l.id}"><p><strong>${e(l.payload.observation)}</strong></p><p>${e(l.payload.action)}</p><p class="meta">${l.payload.kind === 'system' ? 'System suggestion · No change applied' : e(l.status === 'adopted' ? 'Adopted advice' : l.status === 'disabled' ? 'Disabled' : 'Proposed lesson')}</p><details><summary>Source and use</summary><p><a href="/r/${l.source}">Result #${l.source}</a> · <a href="/r/${l.reviewer}">Review #${l.reviewer}</a></p><p>${e(l.payload.paths.join(', '))} · ${e(l.payload.phases.join(', '))} · ${e(({ darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<string,string>)[l.payload.platform] ?? l.payload.platform)}</p><ul>${evidence(l.payload.evidence, l.source)}</ul>${l.payload.kind !== 'project' ? '' : `<p class="meta">${l.status === 'proposed' ? 'Save permits advisory reuse when enabled and applicable. It does not prove a remedy works.' : 'Disabling affects future runs. Active snapshots, code and approvals stay unchanged.'}</p>${l.status === 'proposed' ? act('adopt', 'Save lesson', l) : ''}`}</details>${l.payload.kind === 'project' && l.status === 'adopted' ? act('disable', 'Disable lesson', l) : ''}</article>`).join('');
  if (source !== undefined) return lessons.length ? `<details class="learning result-learning"><summary>Learned from this task</summary>${cards}<a href="/settings/learning?repo=${encodeURIComponent(view.repo)}">Learning settings</a></details>` : '';
  const history = view.events.map(ev => `<article class="card" data-learning-event="${e(ev.action)}"><p><strong>${e(({ assessment: ({ propose: 'Learning suggested', none: 'No lesson needed', unassessed: 'Learning not assessed', invalid: 'Learning assessment invalid' } as Record<string,string>)[ev.after] ?? 'Learning not assessed', proposal: 'Suggestion recorded', adopt: 'Lesson adopted', disable: 'Lesson disabled', reset: 'Learning reset', enable: 'Reuse enabled', pause: 'Reuse paused', reuse: 'Run context saved', failure: 'Learning issue', capture: 'Capture finished' } as Record<string,string>)[ev.action] ?? ev.action)}</strong>${ev.action === "reuse" ? ` · ${e(ev.after)}` : ""}</p><p class="meta">${whenUtc(ev.at)} · ${e(ev.actor)}${ev.run === null ? '' : ` · <a href="/r/${ev.run}">Run #${ev.run}</a>${ev.outcome === null ? "" : ` · ${e(ev.outcome)}`}`}</p><details><summary>Details</summary><p>${e(ev.before)} → ${e(ev.after)}</p><p>${e(ev.reason)}</p>${ev.lesson === null ? '' : `<p>Lesson #${ev.lesson}</p>`}<ul>${evidence(ev.evidence, ev.run)}</ul>${ev.snapshot === null ? "" : `<details><summary>Exact context</summary><pre>${e(ev.snapshot)}</pre></details>`}</details></article>`).join('');
  return `<section class="learning">${view.damaged ? '<p class="problem" role="alert">Some lessons no longer verify and are excluded from reuse.</p>' : ''}<p>${view.enabled ? 'Use adopted lessons: on' : 'Use adopted lessons: off'}</p>${act(view.enabled ? 'pause' : 'enable', view.enabled ? 'Pause reuse' : 'Enable reuse')}${cards || '<p>No lessons yet. Reviews may suggest useful advice here.</p>'}<details><summary>Reset learning</summary><p>Disable all adopted lessons and future reuse. Keep history, code, approvals and active run snapshots.</p>${act('reset', 'Reset learning')}</details><h2>Changes</h2>${history || '<p>No learning changes yet.</p>'}${view.next === null ? '' : `<a class="button-link" href="/settings/learning?repo=${encodeURIComponent(view.repo)}&before=${view.next}">Older changes</a>`}</section>`;
}

/** The first signed requirement a finished attempt missed (failed or unanswered; a person's own check is not a miss),
 * with the evidence line behind it in plain words. Null when every requirement held. */
export function missedRequirementOf(matrix: readonly { id: string; statement: string; state: string; detail: readonly string[] }[]):
  { id: string; statement: string; evidence: string | null } | null {
  const missed = matrix.find(row => row.state === "failed") ?? matrix.find(row => row.state === "missing") ?? null;
  if (missed === null) return null;
  const detail = missed.detail.find(one => !/is waiting for the final check/.test(one)) ?? missed.detail[0] ?? null;
  return { id: missed.id, statement: missed.statement, evidence: detail === null ? (missed.state === "missing" ? "The agent's report doesn't answer it." : null) : requirementEvidenceWords(missed.id, detail) };
}

/** A matrix row's recorded detail as a sentence a person reads: the agent's own note when one admits the miss. */
function requirementEvidenceWords(id: string, detail: string): string {
  const caveat = CONTRADICTED_BY_CAVEAT.exec(detail);
  // The note often names its requirement first ("c1: …"); the line already says which requirement it is.
  if (caveat !== null && caveat[1] === id) return sentenceOf(`The agent's own note says: ${caveat[2]!.trim().replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:—-]\\s*`), "")}`);
  const lead = [`criterion "${id}"'s `, `criterion "${id}" `].find(prefix => detail.startsWith(prefix));
  return sentenceOf(plainReasonWords(lead === undefined ? detail : detail.slice(lead.length)));
}

/** One milestone of a live build's plan, as the agent last reported it; its words are null where only the recorded
 * progress was read (a list row reads no plan file). */
export type BuildStep = { description: string | null; state: "pending" | "current" | "completed" | "blocked"; note: string | null };
/** Where a live build is, in one line: "Step 3 of 6: …", or, when a step is blocked, "Stuck on step 4 of 6: <why>" in
 * its place. `stuck` says which step and why; null while nothing is blocked. */
export type BuildProgress = { step: number; total: number; line: string; stuck: { step: number; why: string | null; line: string } | null };

const stepWords = (text: string | null): string | null => {
  const plain = text?.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "") ?? "";
  return plain === "" ? null : plain;
};

/** A live build's progress: the step in progress (else the first one not done) as "Step N of M: <step>"; a blocked
 * step replaces it as "Stuck on step N of M: <why>" (its note, else the step itself). Null with no plan steps. */
export function buildProgressOf(steps: readonly BuildStep[] | null | undefined): BuildProgress | null {
  if (steps == null || steps.length === 0) return null;
  const total = steps.length;
  const blocked = steps.findIndex(one => one.state === "blocked");
  if (blocked >= 0) {
    const why = stepWords(steps[blocked]!.note) ?? stepWords(steps[blocked]!.description);
    const line = `Stuck on step ${blocked + 1} of ${total}${why === null ? "" : `: ${why}`}.`;
    return { step: blocked + 1, total, line, stuck: { step: blocked + 1, why, line } };
  }
  const current = steps.findIndex(one => one.state === "current");
  const at = current >= 0 ? current : steps.findIndex(one => one.state !== "completed");
  if (at < 0) return { step: total, total, line: `All ${total} steps done. Finishing up.`, stuck: null };
  const words = stepWords(steps[at]!.description);
  return { step: at + 1, total, line: `Step ${at + 1} of ${total}${words === null ? "" : `: ${words}`}.`, stuck: null };
}

/** Earlier attempts that stopped before the one now running, in one quiet line. */
export function earlierAttemptsWords(count: number): string {
  return `${count} earlier attempt${count === 1 ? "" : "s"} stopped`;
}
