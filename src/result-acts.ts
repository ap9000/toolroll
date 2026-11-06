/** The result page's acts (2026-10-02), chosen in one place: exactly one ink
 * act, the one that resolves the result's state, and never navigation; at
 * most one outline act beside it. A result that can't be accepted says why
 * in one line before them.
 *
 *   everything met                      → Accept and finish
 *   a "You check this one" unanswered   → the next check, then Accept without your check
 *   a check you marked Not right        → Request changes, then Accept anyway
 *   checks queued or running            → Checks running (disabled), then Accept without checks
 *   checks didn't run, a check exists   → Run checks, then Accept without checks
 *   report and changes disagree,
 *   or the proof is refuted             → Request changes, then Accept (as allowed);
 *                                         never Accept as ink, even with no form here
 *   a Needs you form resolves it        → that form (Build again, Check again)
 *   saved notes or a failing PR         → Revise / Draft a repair task
 *   a failed build                      → Retry (its note starts with what to change), then Run checks when they
 *                                         didn't run; never Accept: a failed build is not a result to accept
 *   a failed task's delivered result    → Retry, then Accept anyway (in outline, with a reason) where it may be
 *                                         accepted; Run checks stays in its Checks row
 *
 * Accepting finishes the task in one request (Accept and finish): the person's
 * acceptance, when one is owed, and the completion together. This only decides
 * which act is ink; the page recomputes it as the person answers each check. */

import type { ProofVerdict } from "./proof.js";

/** The words over the reason field an Accept of a refuted result requires. */
export const ACCEPT_NEEDS_REASON = "Accepting needs a reason";

/** What kind of evidence problem a verdict records: a check the machine
 * actually ran and saw fail, evidence that contradicts the sealed record
 * (a mismatched changed-path claim, an altered criterion, a caveat that
 * contradicts a met verdict), or evidence that is simply absent. A generic
 * refuted verdict is NOT a failed test claim — only the verify-command
 * reasons say a check failed. */
export type EvidenceProblem = "checks-failed" | "mismatched" | "missing" | "none";

export const FAILED_CHECK = /^the repository's approved verification command exited (-?[0-9]+)/;

export function evidenceProblemOf(verdict: ProofVerdict | null, reasons: readonly string[]): EvidenceProblem {
  if (verdict === "verified" || verdict === "attested") return "none";
  if (verdict === "refuted") return reasons.some(reason => FAILED_CHECK.test(reason)) ? "checks-failed" : "mismatched";
  return "missing";
}

/** Why a result can't be accepted as it stands, in one plain line, or null
 * when nothing refutes it (a person's acceptance settles it). The result page
 * shows it before Request changes, its one ink act. */
export function cantAcceptYetOf(verdict: ProofVerdict | null, reasons: readonly string[], accepted: boolean): string | null {
  if (accepted || verdict !== "refuted") return null;
  // A mismatch is the status card's own headline; here only what accepting takes.
  return evidenceProblemOf(verdict, reasons) === "checks-failed"
    ? "Can't accept yet: the project's check failed on these changes."
    : ACCEPT_NEEDS_REASON;
}

export type ResultActKind = "retry" | "accept" | "accept-anyway" | "next-check" | "checks-running" | "run-checks" | "request-changes" | "rebuild" | "recheck-stopped" | "revise" | "draft-repair";

export type ResultActFacts = {
  /** An Accept this page can post (Accept and finish, or the person's acceptance alone); `ready`: every requirement met and checks passed. */
  accept: { ready: boolean } | null;
  /** The checks didn't run, the project has one, and this person may run it. */
  runChecks: boolean;
  /** Checks on this result are queued or running. */
  checksRunning: boolean;
  /** Why it can't be accepted yet (cantAcceptYetOf), or null. */
  blocked: string | null;
  /** The feedback form is on this page. */
  canRequest: boolean;
  /** A Needs you form that resolves it here. */
  need: "rebuild" | "recheck-stopped" | null;
  /** Saved notes ready to become a revision, or a failing pull request's repair. */
  next: "revise" | "draft-repair" | null;
  /** A failed build: `retry` when the task can be retried from here; `acceptAnyway` when it delivered a result that
   * may still be accepted, with a reason. */
  failed?: { retry: boolean; acceptAnyway?: boolean } | null;
  /** "You check this one" items not answered yet on this page. */
  unanswered?: number;
  /** Items the person marked Not right. */
  notRight?: number;
};

export type ResultActs = {
  /** The one ink act, or null when nothing waits on the person. */
  primary: ResultActKind | null;
  /** The one outline act beside it. */
  secondary: ResultActKind | null;
  /** The one line before the acts: why it can't be accepted yet. */
  line: string | null;
};

export function resultActsOf(facts: ResultActFacts): ResultActs {
  const request = facts.canRequest ? "request-changes" as const : null;
  const accept = facts.accept === null ? null : "accept" as const;
  if (facts.failed != null) {
    const checks = facts.runChecks && !facts.checksRunning ? "run-checks" as const : facts.checksRunning ? "checks-running" as const : null;
    const anyway = facts.failed.acceptAnyway === true ? "accept-anyway" as const : null;
    return facts.failed.retry ? { primary: "retry", secondary: anyway ?? checks, line: null } : { primary: checks, secondary: anyway, line: null };
  }
  if (facts.need !== null) return { primary: facts.need, secondary: request, line: null };
  if (facts.next !== null) return { primary: facts.next, secondary: accept ?? request, line: null };
  // Can't be accepted yet: Accept is never the ink act, even when the feedback form isn't here.
  if (facts.blocked !== null) return { primary: request, secondary: accept, line: facts.blocked };
  // The person's own checks come first: the next one is ink until each is answered.
  if (accept !== null && (facts.unanswered ?? 0) > 0) return { primary: "next-check", secondary: accept, line: null };
  if (accept !== null && (facts.notRight ?? 0) > 0) return { primary: request, secondary: accept, line: null };
  if (facts.checksRunning) return { primary: "checks-running", secondary: accept ?? request, line: null };
  if (facts.accept === null) return { primary: null, secondary: request, line: null };
  if (facts.accept.ready) return { primary: "accept", secondary: request, line: null };
  if (facts.runChecks) return { primary: "run-checks", secondary: "accept", line: null };
  return { primary: "accept", secondary: request, line: null };
}

/** The words a result's Accept wears and the one line before it, given the
 * server's words for everything but the person's own checks (`base`) and how
 * those stand on this page: an unanswered check names itself; a check marked
 * Not right says so; otherwise the base words stand. */
export type AcceptLabel = "Accept" | "Accept without checks" | "Accept without your check" | "Accept anyway";
export function acceptWithChecksOf(base: { label: AcceptLabel; ready: boolean; why: string | null }, checks: { unanswered: readonly string[]; notRight: readonly string[] }): { label: AcceptLabel; ready: boolean; why: string | null } {
  const named = (all: readonly string[]): string => `“${all[0]!.replace(/[.!?]+$/, "")}”${all.length > 1 ? ` and ${all.length - 1} more` : ""}`;
  if (checks.unanswered.length > 0) return { label: "Accept without your check", ready: false, why: `Not checked yet: ${named(checks.unanswered)}.` };
  if (checks.notRight.length > 0) return { label: "Accept anyway", ready: false, why: `You marked ${named(checks.notRight)} not right.` };
  return base;
}

/** The Requirements row as the person answers their checks: each Looks right is met, each answer leaves "You check". */
export function requirementsWordsOf(req: { met: number; total: number; yours: number }, looked: number, notRight: number): { text: string; done: boolean; short: boolean } {
  const met = req.met + looked;
  const yours = Math.max(0, req.yours - looked - notRight);
  return { text: `${met} of ${req.total} met${yours > 0 ? ` · You check ${yours}` : ""}`, done: met === req.total, short: req.total - met - yours > 0 };
}
