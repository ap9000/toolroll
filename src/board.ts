/**
 * The board's lane classifier — one exhaustive precedence order, applied to
 * one database snapshot (Codex board review, findings 1 and 2).
 *
 * Lanes are the pipeline read left to right: attention → queued → waiting →
 * building, with completed work joining from its own query. The chain below
 * is total (the final else is queued) and disjoint (it is an if/else chain),
 * so a task appears on the board exactly once — a parked task is attention,
 * never also "waiting" through the hold its own decision placed.
 */

import { passFraction, type CriterionMatrixRow } from "./proof.js";

export type BoardLane = "attention" | "queued" | "waiting" | "building";

/** Everything one task contributes to the board, fetched in one snapshot. */
export type BoardFacts = {
  taskId: string;
  title: string;
  /** Where the task is placed — null for work nobody has placed yet. */
  repo: string | null;
  state: "queued" | "running" | "failed";
  updatedAt: string;
  strikes: number;
  hasScope: boolean;
  approved: boolean;
  /** Planning mode: requested = a planner will run; drafted = review it. */
  plan: "requested" | "drafted" | null;
  /** First line of the scope's goal — the promise a queued card shows. */
  goal: string | null;
  /** An unanswered decision's id — open or expired; expiry never answers. */
  openDecisionId: number | null;
  /** The same decision's question and birth — fetched together with the
   * id so all three name one decision (Codex round 2, finding 13). */
  question: string | null;
  decisionCreatedAt: string | null;
  openIncidents: number;
  /** Oldest unresolved incident — the honest stall anchor for stopped work. */
  oldestIncidentAt: string | null;
  /** The newest live claim, with its run's provenance when a run exists. A
   * claim legitimately precedes its run (finding 7) — every run field is
   * nullable and the card says "preparing" until they arrive. */
  claim: {
    runner: string;
    claimedAt: string;
    model: string | null;
    branch: string | null;
    worktree: string | null;
    /** The run's role when one exists — a planning session reads differently. */
    role: string | null;
    /** Which harness is spending — worn on the card when it is not claude. */
    provider: string | null;
    /** The machine's own phase (M5.4) — stamped at state-machine boundaries,
     * never parsed from a provider stream. Null before the first boundary. */
    phase: string | null;
  } | null;
  /** The newest unfinished run under the live claim — where a building card
   * links, so a glance lands on the build itself. Null before the run
   * starts (the card falls back to the task screen). */
  liveRunId?: number | null;
  /** The top-precedence live hold: operator > backoff > decision > incident. */
  hold: { ownerKind: "operator" | "decision" | "incident" | "backoff"; until: string | null } | null;
  /** The first blocker that is not done, when one exists. */
  unmetDependency: string | null;
  /** That blocker's state — pre-redacted by the caller to null when the
   * blocker's repo is outside the ceiling (Codex round 2, finding 12);
   * the classifier never learns what it must not say. */
  blockerState: string | null;
  /** The first required capability not currently verified, as "kind:name". */
  missingRequirement: string | null;
  /** Queue rank — 0 is filing order. Scheduling only; ranks compare
   * within one column, never across columns. */
  priority?: number;
  /** The worker this task is reserved for; null = the shared queue. */
  assignedRunner?: string | null;
};

export type BoardCard = {
  lane: BoardLane;
  taskId: string;
  title: string;
  repo: string | null;
  /** One honest phrase for the card's chip — why it sits in this lane. */
  reason: string;
  /** Where the card's link should land. */
  href: string;
  claim: BoardFacts["claim"];
  /** When this stall began — attention cards only; the lane sorts by it. */
  stalledSince: string | null;
  /** The live attempt's ordinal when earlier ones failed — building only. */
  attempt: number | null;
  overdue: boolean;
  /** The task's queue rank, carried for the queued lane's sort and badge. */
  priority: number;
  /** The worker this card is reserved for; null = the shared queue. */
  assignedRunner: string | null;
};

/** ISO to the minute for chip text — "retrying 14:32". */
function clockOf(iso: string): string {
  return iso.slice(11, 16);
}

/**
 * Plain words for every hold owner — shared with the task page so "who is
 * holding this" reads the same everywhere. An unknown or retired owner
 * degrades to the generic word, never to its raw name.
 */
export const HOLD_OWNER_WORDS: Record<string, string> = {
  operator: "held by you",
  decision: "waiting on a question",
  incident: "stopped by an incident",
  backoff: "backing off after a failure",
  revision: "waiting on a plan-revision decision",
};

export function holdOwnerWords(ownerKind: string): string {
  return HOLD_OWNER_WORDS[ownerKind] ?? "held";
}

/**
 * A completed task whose proof is short or refuted and not yet accepted
 * (Priority 2): the board's once-and-only-once rule holds because the
 * done lane's own query excludes exactly these same rows (the fetch site
 * splits `listCompletedWorkScoped`'s rows by verdict before either lane
 * renders) — never a second classifier disagreeing with the first.
 */
export type UnverifiedDoneFacts = {
  taskId: string;
  title: string;
  repo: string | null;
  /** The run's completion time — the stall anchor, same as every other
   * attention card's `stalledSince`. */
  completedAt: string;
  proofVerdict: "short" | "refuted";
  /** v39: the signed rubric's own matrix — folded into the plain-text
   * `reason` chip via the shared `passFraction` helper (v40 closes the
   * hand-rolled copy this card used to keep), since a board card carries
   * no room for the full matrix. `[]` for a grandfathered task. */
  proofMatrix?: readonly Pick<CriterionMatrixRow, "state">[];
  /** v40: the bounded repair chain's own trajectory, when one exists —
   * one more word on the SAME chip, never a second card (one task, one
   * card, the board's own once-and-only-once rule). */
  repairChain?: { attempt: number; outcome: "drafted" | "attempts-spent" | "no-progress" | "integrity-refused" | "resolved"; approved: boolean } | null;
};

export function attentionCardForUnverifiedDone(facts: UnverifiedDoneFacts): BoardCard {
  const matrix = facts.proofMatrix ?? [];
  const { passed, total } = passFraction(matrix as CriterionMatrixRow[]);
  const matrixWords = total === 0 ? "" : ` (${passed}/${total} criteria)`;
  const chain = facts.repairChain ?? null;
  const repairWords =
    chain === null
      ? ""
      : chain.outcome === "drafted"
        ? ` — repair attempt ${chain.attempt} ${chain.approved ? "approved" : "awaiting approval"}`
        : chain.outcome === "resolved"
          ? ` — repair resolved`
          : ` — repair ${chain.outcome} at attempt ${chain.attempt}`;
  return {
    lane: "attention",
    taskId: facts.taskId,
    title: facts.title,
    repo: facts.repo,
    href: `/t/${encodeURIComponent(facts.taskId)}`,
    claim: null,
    stalledSince: facts.completedAt,
    attempt: null,
    overdue: false,
    priority: 0,
    assignedRunner: null,
    reason: (facts.proofVerdict === "refuted" ? "complete — conflicting evidence" : "complete — missing evidence") + matrixWords + repairWords,
  };
}

export function classify(facts: BoardFacts, now: Date): BoardCard {
  const base = {
    taskId: facts.taskId,
    title: facts.title,
    repo: facts.repo,
    href: `/t/${encodeURIComponent(facts.taskId)}`,
    claim: facts.claim,
    stalledSince: null as string | null,
    attempt: null as number | null,
    overdue: false,
    priority: facts.priority ?? 0,
    assignedRunner: facts.assignedRunner ?? null,
  };

  if (facts.claim !== null) {
    const doing = facts.claim.role === "planner" ? "planning — " : facts.claim.role === "scout" ? "scouting — " : "";
    // A building card lands on the build itself when one exists — the
    // pop-in glance should reach the live page in one click. Before the
    // run starts the task screen remains the destination.
    const liveRunId = facts.liveRunId ?? null;
    return {
      ...base,
      lane: "building",
      href: liveRunId === null ? base.href : `/r/${liveRunId}`,
      attempt: facts.strikes > 0 ? facts.strikes + 1 : null,
      reason:
        facts.claim.model === null && facts.claim.branch === null
          ? `${doing}${facts.claim.runner} · preparing workspace`
          : `${doing}${facts.claim.runner}`,
    };
  }
  if (facts.openDecisionId !== null) {
    // The question is the content — the generic verb only when the
    // snapshot could not carry it.
    return {
      ...base,
      lane: "attention",
      reason: facts.question ?? "answer a question",
      href: `/d/${facts.openDecisionId}`,
      stalledSince: facts.decisionCreatedAt ?? facts.updatedAt,
    };
  }
  if (facts.state === "failed" || facts.openIncidents > 0) {
    return {
      ...base,
      lane: "attention",
      stalledSince: facts.oldestIncidentAt ?? facts.updatedAt,
      reason:
        facts.openIncidents > 0
          ? `stopped — ${facts.openIncidents} incident${facts.openIncidents > 1 ? "s" : ""}`
          : `failed${facts.strikes > 0 ? ` after ${facts.strikes} attempt${facts.strikes > 1 ? "s" : ""}` : ""}`,
    };
  }
  if (facts.plan === "drafted" && !facts.approved) {
    // The planner concluded; the negotiation waits on the operator.
    return { ...base, lane: "attention", reason: "review the plan", stalledSince: facts.updatedAt };
  }
  if (facts.plan !== "requested") {
    if (!facts.hasScope) {
      return { ...base, lane: "attention", reason: "write its scope", stalledSince: facts.updatedAt };
    }
    if (!facts.approved) {
      return { ...base, lane: "attention", reason: "approve its scope", stalledSince: facts.updatedAt };
    }
  }
  if (facts.state === "running") {
    // Running with no live claim: the build vanished out from under the
    // state machine (reaped, or the claim expired mid-flight). A repair
    // card, not a silent omission (finding 1).
    return { ...base, lane: "attention", reason: "build vanished — needs repair", stalledSince: facts.updatedAt };
  }
  if (facts.hold !== null) {
    const until = facts.hold.until;
    const reason =
      facts.hold.ownerKind === "operator"
        ? "held by you"
        : facts.hold.ownerKind === "backoff"
          ? until === null
            ? "backing off"
            : until <= now.toISOString()
              ? "retrying now"
              : `retrying ${clockOf(until)}`
          : // A decision or incident hold with no open item
            // above it is an orphan — say who holds it in plain words,
            // never the internal owner token.
            holdOwnerWords(facts.hold.ownerKind);
    return { ...base, lane: "waiting", reason };
  }
  if (facts.unmetDependency !== null) {
    // A terminal blocker will never clear itself. Say repair instead of
    // presenting an impossible dependency as ordinary patience.
    if (facts.blockerState === "failed" || facts.blockerState === "cancelled") {
      return {
        ...base,
        lane: "waiting",
        reason: `waiting for ${facts.unmetDependency}, but it ${facts.blockerState === "cancelled" ? "was cancelled" : "failed"}`,
      };
    }
    const doing =
      facts.blockerState === null
        ? ""
        : facts.blockerState === "running"
          ? " — building now"
          : ` — ${facts.blockerState}`;
    return { ...base, lane: "waiting", reason: `waits on ${facts.unmetDependency}${doing}` };
  }
  if (facts.missingRequirement !== null) {
    return { ...base, lane: "waiting", reason: `needs ${facts.missingRequirement}` };
  }
  // Task-local prerequisites all satisfied. Fleet-wide constraints (worker
  // capacity, provider quota, the attention budget) are deliberately not
  // per-card claims — the board cannot know which runner would take this
  // task, so the queued lane's header speaks for the fleet (finding 6).
  // The card at this stage IS the promise: show the goal, not "ready" —
  // unless the promise is still being negotiated, in which case say so.
  if (facts.plan === "requested") {
    return { ...base, lane: "queued", reason: "planning next" };
  }
  return { ...base, lane: "queued", reason: facts.goal ?? "ready" };
}
