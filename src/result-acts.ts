/** The result page's acts (2026-10-02; docs/plans/plain-toolroll.md P1.3), chosen in one place: three verbs, each a
 * relabel over the post it has always made. Exactly one ink act at most, the one that resolves the result's state,
 * and never navigation; at most one outline act beside it. A result that can't be accepted says why in one line
 * before them. Run checks stays in the Checks row, and a person's own checks in the Checks list: neither is an act here.
 *
 *   everything met                      → Accept
 *   a "You check this one" unanswered   → (the check itself, above), then Accept without your check
 *   a check you marked Not right        → Send back, then Accept anyway
 *   checks queued or running            → (Checks running, in its row), then Accept without checks
 *   checks didn't run, a check exists   → (Run checks, in its row), then Accept without checks
 *   report and changes disagree,
 *   or the proof is refuted             → Send back, then Accept (as allowed);
 *                                         never Accept as ink, even with no form here
 *   a Needs you form resolves it        → that form (Retry: Build again; Check again)
 *   saved notes or a failing PR         → Send back (the revision from the notes, or the repair of the PR)
 *   a failed build                      → Retry (its note starts with what to change); never Accept: a failed build
 *                                         is not a result to accept
 *   a failed task's delivered result    → Retry, then Accept anyway (in outline, with a reason) where it may be
 *                                         accepted
 *
 * Accepting finishes the task in one request: the person's acceptance, when one is owed, and the completion
 * together. This only decides which act is ink; the page recomputes it as the person answers each check. */

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

/** The three verbs, and the posts each one makes (docs/plans/plain-toolroll.md P1.3): Accept is today's Accept (and
 * finish), or Accept anyway with a reason; Send back is today's request for changes and its revision from saved notes
 * for an unpublished result, or the repair of a published one; Retry is today's Retry, or Build again. Check again
 * keeps its own words (its act stands on the build, not on the result). */
export type ResultVerb = "Accept" | "Send back" | "Retry";
export const RESULT_VERB: Readonly<Record<ResultActKind, ResultVerb | null>> = {
  accept: "Accept", "accept-anyway": "Accept",
  "request-changes": "Send back", revise: "Send back", "draft-repair": "Send back",
  retry: "Retry", rebuild: "Retry",
  "recheck-stopped": null,
  // Never in the act row: Run checks lives in the Checks row, and a person's own checks in the Checks list.
  "next-check": null, "checks-running": null, "run-checks": null,
};
/** What Send back does, said on its own confirm line: the rule is fixed by whether the result is already published. */
export const SEND_BACK_UNPUBLISHED = "Sends it back with your notes. The same task builds again once you approve the revision.";
export const SEND_BACK_PUBLISHED = "It's already published, so this files a fix as a new version for you to approve.";

export function resultActsOf(facts: ResultActFacts): ResultActs {
  const request = facts.canRequest ? "request-changes" as const : null;
  const accept = facts.accept === null ? null : "accept" as const;
  if (facts.failed != null) {
    const anyway = facts.failed.acceptAnyway === true ? "accept-anyway" as const : null;
    return facts.failed.retry ? { primary: "retry", secondary: anyway, line: null } : { primary: null, secondary: anyway, line: null };
  }
  if (facts.need !== null) return { primary: facts.need, secondary: request, line: null };
  // Saved notes or a failing pull request: Send back is ink, and Accept the quiet other way.
  if (facts.next !== null) return { primary: facts.next, secondary: accept, line: null };
  // Can't be accepted yet: Accept is never the ink act, even when the feedback form isn't here.
  if (facts.blocked !== null) return { primary: request, secondary: accept, line: facts.blocked };
  // The person's own checks come first, in the Checks list above: nothing here is ink until each is answered.
  if (accept !== null && (facts.unanswered ?? 0) > 0) return { primary: null, secondary: accept, line: null };
  if (accept !== null && (facts.notRight ?? 0) > 0) return { primary: request, secondary: accept, line: null };
  // Checks running, or not run: their row says so and offers Run checks; Accept waits in outline.
  if (facts.checksRunning) return { primary: null, secondary: accept ?? request, line: null };
  if (facts.accept === null) return { primary: null, secondary: request, line: null };
  if (facts.accept.ready) return { primary: "accept", secondary: request, line: null };
  if (facts.runChecks) return { primary: null, secondary: "accept", line: null };
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
