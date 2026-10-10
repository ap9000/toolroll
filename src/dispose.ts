// Assignment tracking grants no repair authority or attempts.
import { originalTaskBase, focusedTestCommandSupported } from "./observations.js";
/**
 * The build disposition service (Parity II Phase 2, v4 Q2 / v6 W1): the
 * operations that actually END an attempt — sealing parks, accepting
 * completions behind the completion fence, recording failures with their
 * strikes and holds, opening publication intents — extracted from tick's
 * and the standalone build command's finalizers into ONE place. The two
 * historical roads differ deliberately
 * (the standalone command completes no task, strikes nothing, publishes
 * nothing), and the policy record says so explicitly instead of forking
 * the logic: behavior on both is byte-identical to what the callers
 * inlined before.
 */

import { createHash } from "node:crypto";
import {
  interruptIfStopped,
  release,
  type FailureClass,
  finalize,
} from "./claim.js";
import { bodyHashOf, publicationBody } from "./publish.js";
import { modeTermsFromJson } from "./modes.js";
import { evidenceRoot, readVerifiedArtifact, writeEvidenceFile } from "./evidence.js";
import { queueBuildReview } from "./build-review.js";
import { homedir } from "node:os";
import type { BuildResult } from "./builder.js";
import type { Store } from "./store.js";
import { type ProofVerdict, type VerifyCommandFacts } from "./proof.js";
import { verificationEvidence, failedVerificationEvidence } from "./verification-evidence.js";
import { classifyGateFailure, describeGateFailure, gateFailureSummary, type GateFailureClass } from "./gate-failure.js";
import { propose, approve } from "./scope.js";
import { headWithin } from "./names.js";

/**
 * Which road is disposing. 'tick' = the unattended loop: full task
 * completion, strikes, quota, publication. 'standalone' = the one-off
 * `build` command: run records only — no task state, no strikes, no
 * publication (its historical shape).
 */
export type DisposePolicy = "tick" | "standalone";

export type DisposeContext = {
  store: Store;
  policy: DisposePolicy;
  /** The lease this attempt ran under; undefined only on the standalone road. */
  leaseId: string | undefined;
  runId: number;
  taskId: string;
  taskRef: number;
  runner: string;
  /** The canonical repo, for the publication grant lookup (tick policy). */
  repo: string;
  branch: string;
  /** task_ref.origin — the publication selector consults it. */
  origin: string;
  provider: string;
  model: string | null;
  /** Where the attempt's tree lives — failure records name it. */
  worktreePath: string;
  /** The same evidence root the builder used. */
  evidenceRoot?: string;
  clock: () => Date;
};

export type Disposition =
  | { kind: "parked"; decisionId: number }
  | { kind: "park-fenced" }
  | { kind: "disowned" }
  | { kind: "built"; committed: boolean; noChange: boolean }
  | { kind: "built-fenced" }
  | { kind: "skipped"; reason: "unapproved" | "scope-changed" }
  | { kind: "fenced" }
  | { kind: "malformed"; sealed: boolean }
  | {
      kind: "failed";
      failureClass: FailureClass;
      disposition: string | null;
      strikes: number | null;
      sealed: boolean;
    }
  /** The standalone road's simple record: outcome written, nothing else. */
  | { kind: "recorded"; outcome: "failed" | "refused" }
  /** v52: an operator's stop won before terminal settlement — the attempt
   * is sealed as interrupted with its work preserved, its own stop
   * settled, no strike and no retry. `stopRun` names the exact stopped
   * run (this one, or the owning ancestor whose stop it inherited). */
  | { kind: "stopped"; stopRun: number; requeued: boolean }
  /** The service stopped or restarted while the attempt ran (no one stopped
   * the task): its work is preserved, the run ends as interrupted, and the
   * task is back in the queue — no strike, no backoff — so the next builder
   * pass resumes it from the kept work. */
  | { kind: "handed-back"; requeued: boolean }
  | { kind: "invariant"; reason: string };

/** The reasons tick classifies as the attempt itself breaking. */
const TICK_FAILURE_REASONS = new Set([
  "agent",
  "agent-reported",
  "no-op",
  "no-handoff",
  "moved-head",
  "moved-branch",
  "timeout",
  "git",
  "commit-failure",
  "provider-init",
  "setup",
  "revision-brief",
  "stopped",
  // Phase 3 (C1): the gateway's typed refusals consume the task strike
  // budget like every other infrastructure failure — the pre-claim skip
  // keeps the NORMAL road from ever reaching here; these arms bound the
  // races.
  "provider-unattested",
  "provider-protocol",
]);

/** The standalone road's historical "broke" list — narrower, deliberately. */
const STANDALONE_BROKE_REASONS = new Set([
  "agent",
  "agent-reported",
  "no-op",
  "no-handoff",
  "moved-head",
  "timeout",
  "git",
]);

/** A committed build whose approved check passed gets the project's one
 * automatic review when its review switch is on (build-review.ts). No-change
 * results and failed checks go straight to the person, as before. */
export function maybeRequestAutoReview(store: Store, repo: string, runId: number, committed: boolean, noChange: boolean, now: Date, root = evidenceRoot(homedir())): void {
  if (!committed || noChange) return;
  queueBuildReview(store, repo, runId, root, now);
}

export function disposeBuildOutcome(context: DisposeContext, result: BuildResult): Disposition {
  // Stop and every terminal side effect compete under the same SQLite
  // write lock. A separate preliminary transaction leaves a completion gap.
  return context.store.transact(() => disposeBuildOutcomeLocked(context, result));
}

function disposeBuildOutcomeLocked(context: DisposeContext, result: BuildResult): Disposition {
  const { store, policy, leaseId, runId, taskId, taskRef, runner, repo, branch, origin, provider, model, worktreePath, clock } =
    context;

  // THE STOP FENCE at settlement (v52), before any arm below and inside
  // its own transaction: a stop recorded against this attempt (or the
  // ancestor it runs under) before this instant WINS — a late success is
  // never accepted as done, a park is never sealed, a failure never takes
  // a strike. The attempt ends as interrupted with its work preserved (a
  // commit it made stays on the branch as a reviewable artifact), its
  // stop settles, and the task waits under the stop's own hold. The
  // already-sealed revision endings are exempt exactly as below: their
  // finalizer fenced the stop itself, inside its own transaction.
  if (result.ok || (result.reason !== "plan-revised" && result.reason !== "plan-revision-blocked")) {
    const stopped = store.transact(() => {
      const run = store.getRun(runId);
      const fenceLease = leaseId ?? run?.leaseId;
      if (run === null || run.outcome !== null || fenceLease === undefined) return null;
      return interruptIfStopped(store, {
        leaseId: fenceLease,
        runId,
        taskId,
        ...(result.ok && result.parked === undefined ? { committed: result.committed } : {}),
        now: clock(),
      });
    });
    if (stopped !== null) return { kind: "stopped", stopRun: stopped.stopRun, requeued: stopped.requeued };
  }

  if (result.ok && result.parked !== undefined) {
    if (leaseId === undefined) return { kind: "park-fenced" };
    const sealed = finalize(store, leaseId, {
      kind: "park",
      runId,
      taskId,
      decision: result.parked.decision,
      artifactIds: result.parked.artifactIds,
      now: clock(),
    });
    if (!sealed.ok) return { kind: "park-fenced" };
    // A park is the system working, and it ends any failure streak — on the
    // loop's road. The standalone command never touched strikes.
    if (policy === "tick") store.resetStrikes(taskRef);
    return { kind: "parked", decisionId: sealed.decisionId };
  }

  if (result.ok) {
    if (policy === "standalone") {
      store.finishRun(runId, {
        outcome: result.noChange === true ? "no-change" : "built",
        ...(result.noChange === true ? { reason: "handoff" } : {}),
        committed: result.committed,
        now: clock(),
      });
      return { kind: "built", committed: result.committed, noChange: result.noChange === true };
    }
    if (leaseId === undefined) return { kind: "built-fenced" };
    // The completion has to be *accepted*, not assumed — one transaction
    // around the fenced release, the run's outcome, and the publication
    // intent, so "done" and "this must reach a PR" cannot come apart.
    const sealed = store.transact(() => {
      const fence = finalize(store, leaseId, { kind: "complete", state: "done", now: clock() });
      if (!fence.ok) return fence;
      // The disowned arm (external dispatch, v4 §24): the tracker closed
      // this mirror while it was being built.
      if (fence.arm === "disowned") {
        store.finishRun(runId, { outcome: "failed", reason: "external-closed", committed: result.committed, now: clock() });
        store.enqueueNotification(
          {
            source: { run: runId },
            dedupeKey: `run:${runId}:external-closed`,
            kind: "external-closed",
            subject: `${taskId}: the tracker closed this while it was being built`,
            body: `The branch ${branch} is kept as evidence; nothing is published. Reopen the tracker item and \`toolroll task reopen ${taskId}\` if the work should continue.`,
          },
          clock(),
        );
        return fence;
      }
      store.finishRun(runId, {
        outcome: result.noChange === true ? "no-change" : "built",
        ...(result.noChange === true ? { reason: "handoff" } : {}),
        committed: result.committed,
        now: clock(),
      });
      // A stated no-change publishes nothing.
      if (result.noChange !== true && result.committed) {
        const grant = store.publicationGrantFor(repo);
        const headSha = store.getRun(runId)?.headRevision ?? null;
        if (
          grant !== null &&
          grant.publishOn !== "complete" &&
          headSha !== null &&
          headWithin(branch, grant.headPrefix) &&
          (grant.selector === "all" || origin === "ours")
        ) {
          const intentId = store.createPublicationIntent(
            {
              run: runId,
              taskRef,
              githubRepo: grant.githubRepo,
              remote: grant.remote,
              base: grant.base,
              head: branch,
              headSha,
              bodyHash: "",
              draft: grant.draft,
            },
            clock(),
          );
          // The body's identity is computed from the rows this very
          // transaction made durable — reproducible after any crash.
          const publication = store.publicationForRun(runId);
          if (publication !== null) {
            store.handle
              .prepare("UPDATE publication SET body_hash = ? WHERE id = ?")
              .run(bodyHashOf(publicationBody(store, publication)), intentId);
          }
        }
      }
      return fence;
    });
    if (sealed.ok && sealed.arm === "disowned") return { kind: "disowned" };
    if (sealed.ok) {
      // A concluded success ends the failure streak and its backoff — and
      // proves the credential, clearing any quota stamp.
      store.resetStrikes(taskRef);
      store.clearQuota(runner, provider, model ?? "");
      maybeRequestAutoReview(store, repo, runId, result.committed, result.noChange === true, clock(), context.evidenceRoot);
      return { kind: "built", committed: result.committed, noChange: result.noChange === true };
    }
    store.transact(() => {
      store.finishRun(runId, { outcome: "failed", reason: "fenced", committed: result.committed, now: clock() });
      store.enqueueNotification(
        {
          source: { run: runId },
          dedupeKey: `run:${runId}:fenced`,
          kind: "build-fenced",
          subject: `${taskId}: completed, but the lease was gone`,
          body: `The commit exists on ${branch}, but the world moved past this lease before the completion was accepted. Look before anything reuses it.`,
        },
        clock(),
      );
    });
    return { kind: "built-fenced" };
  }

  // ---- refusals and failures -----------------------------------------------

  // THE ALREADY-SEALED ENDINGS (adaptive execution plans). Every other arm
  // below ends the attempt itself — releases the claim, writes the run's
  // outcome, counts what it costs. These two arrive with all of that
  // already done: `finalize` (a `revision` ending) released the lease, appended the
  // ledger row, placed the hold when one was owed, finished the run, and
  // paged, all inside ONE fenced transaction — the planner road's shape,
  // where claim.ts owns the ending and dispose only reports it.
  //
  // So this branch exists to do NOTHING, deliberately, and it is placed
  // above the policy arms so that every road — tick and standalone —
  // skips them alike.
  //
  // Falling through instead would be wrong twice over. `release()` would
  // survive it (an already-released lease whose `released_by` is
  // 'released' reads as this same lease's duplicate hand-back, not a
  // fence), but `finishRun` overwrites unconditionally, so the sealed
  // `finished_at` would be restamped by a second, later writer; and the
  // bottom of the chain returns `invariant`, which means "the dispatcher
  // broke a rule it was supposed to uphold" — the opposite of what
  // happened here, where the machine worked exactly as designed.
  if (result.reason === "plan-revised" || result.reason === "plan-revision-blocked") {
    return { kind: "skipped", reason: result.reason as never };
  }

  if (policy === "standalone") {
    if (result.reason === "malformed-decision" && leaseId !== undefined) {
      const sealed = finalize(store, leaseId, {
        kind: "malformed",
        runId,
        taskId,
        problems: result.problems ?? [],
        now: clock(),
      });
      return { kind: "malformed", sealed: sealed.ok };
    }
    const outcome = STANDALONE_BROKE_REASONS.has(result.reason) ? "failed" : "refused";
    store.finishRun(runId, { outcome, reason: result.reason, now: clock() });
    return { kind: "recorded", outcome };
  }

  if (result.reason === "unapproved" || result.reason === "scope-changed") {
    // Approval drifted between the prefilter and the builder's own gate.
    if (leaseId !== undefined) release(store, leaseId, clock());
    store.finishRun(runId, { outcome: "refused", reason: result.reason, now: clock() });
    return { kind: "skipped", reason: result.reason };
  }

  if (result.reason === "fenced") {
    // The lease did not survive the build. Nothing is ours to release.
    store.finishRun(runId, { outcome: "refused", reason: "fenced", now: clock() });
    return { kind: "fenced" };
  }

  if (result.reason === "malformed-decision") {
    if (leaseId === undefined) return { kind: "malformed", sealed: false };
    const sealed = finalize(store, leaseId, {
      kind: "malformed",
      runId,
      taskId,
      problems: result.problems ?? [],
      now: clock(),
    });
    return { kind: "malformed", sealed: sealed.ok };
  }

  // A stop no operator asked for is the SERVICE stopping (the fence above
  // already settled every task stop): hand the attempt back, never strike it.
  if (result.reason === "stopped" && policy === "tick" && leaseId !== undefined && store.getRun(runId)?.role === "builder") {
    const handed = finalize(store, leaseId, { kind: "hand-back", runId, taskId, message: result.message, now: clock() });
    return { kind: "handed-back", requeued: handed.requeued };
  }

  if (TICK_FAILURE_REASONS.has(result.reason)) {
    // One fenced transaction decides what the failure means. The
    // classification trusts only what the machine itself observed.
    const failureClass: FailureClass =
      result.reason === "agent-reported"
        ? "agent-reported"
        : result.reason === "no-handoff"
          ? "no-handoff"
          : result.reason === "no-op" || result.reason === "moved-head" || result.reason === "moved-branch"
          ? "no-op"
          : result.reason === "timeout" || result.reason === "git" || result.reason === "provider-init" || result.reason === "setup" || result.reason === "stopped" || result.reason === "provider-unattested" || result.reason === "provider-protocol"
            ? "retryable-infra"
            : result.reason === "commit-failure"
              ? "commit-failure"
              : "unknown";
    // The attempt's ending, in words, on the run itself: the class is what
    // the strikes count, the message is what a person reads (an agent's
    // own verdict was already recorded by the builder under the same key).
    if (result.reason !== "agent-reported" && result.message.trim() !== "") {
      store.recordOutcomeFacts(runId, { handoff: result.message });
    }
    if (leaseId === undefined) {
      store.finishRun(runId, { outcome: "failed", reason: result.reason, now: clock() });
      return { kind: "failed", failureClass, disposition: null, strikes: null, sealed: false };
    }
    const sealed = finalize(store, leaseId, {
      kind: "failure",
      runId,
      taskId,
      failureClass,
      message: result.message,
      worktree: worktreePath,
      now: clock(),
    });
    return {
      kind: "failed",
      failureClass,
      disposition: sealed.ok ? sealed.disposition : null,
      strikes: sealed.ok && "strikes" in sealed ? sealed.strikes : null,
      sealed: sealed.ok,
    };
  }

  // no-claim, not-yours, not-leased, protected-branch, wrong-branch:
  // invariants the dispatcher was supposed to uphold.
  if (leaseId !== undefined) release(store, leaseId, clock());
  store.finishRun(runId, { outcome: "refused", reason: result.reason, now: clock() });
  if (result.reason === "stale-approval") {
    // A deterministic refusal (setup review): the approval no longer
    // matches the routing, and nothing about the next pass changes that.
    // Retrying every pass wrote a thousand refused runs in minutes. So:
    // release, record, HOLD the task under a backoff the approval door
    // lifts, and page once per approval — the operator re-approves (or
    // reconfigures the build agent) and the hold goes with the yes.
    if (leaseId !== undefined) release(store, leaseId, clock());
    store.finishRun(runId, { outcome: "refused", reason: "stale-approval", now: clock() });
    holdStaleApproval(store, { taskRef, taskId, message: result.message }, clock());
    return { kind: "skipped", reason: "stale-approval" as never };
  }

  return { kind: "invariant", reason: result.reason };
}

/**
 * The stale-approval HOLD, shared by the post-build disposition above and
 * the tick's pre-admission refusal (v48 integrity): a pre-routing row
 * whose sealed profile no longer matches what would resolve is refused
 * BEFORE any run row exists — held under the backoff the approval door
 * lifts, paged once per approval — so the fail-closed admission never
 * turns into a refusal every pass.
 */
export function holdStaleApproval(store: Store, args: { taskRef: number; taskId: string; message: string }, now: Date): void {
  const scope = store.getScope(args.taskId);
  store.holdOwned(
    {
      taskRef: args.taskRef,
      ownerKind: "backoff",
      ownerId: `stale:${args.taskRef}`,
      reason: "stale-approval — the approval no longer matches how builds are routed; approve the scope again on its page",
      until: new Date(now.getTime() + 6 * 60 * 60_000),
    },
    now,
  );
  store.enqueueNotification(
    {
      source: { taskRef: args.taskRef },
      dedupeKey: `stale-approval:${args.taskRef}:${scope?.approvedDigest ?? "none"}`,
      kind: "stale-approval",
      pushClass: "attention",
      link: `/t/${encodeURIComponent(args.taskId)}`,
      subject: `${args.taskId}: its approval no longer matches the build routing — approve it again`,
      body: `${args.message}\nNothing runs on it until the scope is approved again; the hold lifts with the yes.`,
    },
    now,
  );
}

// ---- the bounded repair loop (v40, evidence-review-v1) --------------------

/** Whether a run's proof reasons name a LIE about the signed terms — an
 * altered criterion statement, or an overclaimed changed path — rather
 * than a gap in the work. The exact phrases `adjudicate()` uses for those
 * two rules, and no others; the integrity stop's own predicate. */
function isIntegrityRefutation(reasons: readonly string[]): boolean {
  return reasons.some(one => one.includes("was signed as") || one.includes("not in the sealed diff"));
}

/** Strict shrink: `to` is a proper subset of `from` — gnhf's no-progress
 * rule (docs/DESIGN.md:229), extended: an attempt that does not strictly
 * shrink the unresolved-criterion set counts as a failure. */
function strictlyShrunk(from: readonly string[], to: readonly string[]): boolean {
  if (to.length >= from.length) return false;
  const fromSet = new Set(from);
  return to.every(id => fromSet.has(id));
}

/** The public, envelope-documented name for each stop — distinct from the
 * store's own short `repair_chain.outcome` word (the DB enum is a
 * different namespace; these are the CLI/console-facing reason tokens,
 * registered in envelope.ts's DOCUMENTED_REASONS). */
export type RepairStopReason = "repair-attempts-spent" | "repair-no-progress" | "repair-refused-integrity";

/**
 * The chain's happy exit (v40): the instant one of its own attempts
 * reaches `verified` or `attested`, the chain is done. Checked at every
 * completed build's own verdict-save point — not only after a review —
 * since a review can never UPGRADE a verdict past what `adjudicate`
 * already found (foldReview's monotonicity), so only the structural save
 * can ever produce one of these two words.
 */
export function maybeSettleRepairChain(store: Store, taskId: string, verdict: ProofVerdict, now: Date): void {
  if (verdict !== "verified" && verdict !== "attested") return;
  const chain = store.repairChainForDraft(taskId);
  if (chain === null || chain.outcome !== "drafted") return;
  store.settleRepairChain(chain.id, "resolved", now);
}

/** Read the sealed receipt, log and candidate inventory behind a failed gate
 * and say whether the failure is one no repair attempt could fix. An
 * unreadable or truncated inventory leaves the failure repairable. */
function unrelatedGateFailure(store: Store, evidenceRoot: string, failure: { receipt: string; log: string }, runId: number): Exclude<GateFailureClass, { kind: "repairable" }> | null {
  const receipt = JSON.parse(failure.receipt) as { result: VerifyCommandFacts; command?: { timeoutMs?: number } };
  let changed: string[] | null = null;
  const stat = store.artifactsFor(runId).find(a => a.kind === "diff-stat");
  if (stat && !stat.truncated && stat.captureStatus === "ok") {
    const read = readVerifiedArtifact(evidenceRoot, stat);
    if (read.ok) {
      try {
        const inventory = JSON.parse(read.content.toString("utf8")) as { filesTruncated?: boolean; files?: { path?: unknown }[] };
        if (inventory.filesTruncated === false && Array.isArray(inventory.files)) {
          changed = inventory.files.map(one => one.path).filter((path): path is string => typeof path === "string");
        }
      } catch { changed = null; }
    }
  }
  const classified = classifyGateFailure(receipt.result, failure.log, changed, receipt.command?.timeoutMs ?? null);
  return classified.kind === "repairable" ? null : classified;
}

/**
 * Run the approved gate again on the SAME commit (v70): a new attempt whose
 * prepared candidate is the last attempt's head. The machine checks the
 * commit out (no agent), seals a fresh diff, receipt and proof, and the
 * ordinary review follows. Used by `task regate` (an operator's yes) and by
 * the automatic single rerun after a failure the change did not cause.
 */
export type RegateRefusal = "no-task" | "no-attempt" | "accepted-result" | "published" | "claimed" | "not-approved" | "not-rejected";
export function regateTask(
  store: Store,
  taskId: string,
  now: Date,
  approval: { kind: "operator"; name: string; token: string } | { kind: "mode"; name: string; modeDigest: string },
): { ok: true; run: number; head: string } | { ok: false; reason: RegateRefusal; message: string } {
  const ref = store.lookupRef(taskId);
  if (ref === null) return { ok: false, reason: "no-task", message: `no task ${taskId}` };
  const last = store.lastBuilderRun(ref.id);
  if (last === null || !last.headRevision) return { ok: false, reason: "no-attempt", message: `${taskId} has no finished attempt to rerun the check on` };
  const verdict = store.proofVerdictFor(last.id);
  if (verdict !== null && (verdict.verdict === "verified" || verdict.verdict === "attested")) return { ok: false, reason: "accepted-result", message: `${taskId}'s last result already reads ${verdict.verdict}; there is nothing to rerun` };
  if (store.proofAcceptance(last.id) !== null) return { ok: false, reason: "accepted-result", message: `${taskId}'s last result was accepted by an operator` };
  // Rejected: the proof was refuted, or the machine never got a passing
  // gate (a timed-out check reads "short", not "refuted"). A short verdict
  // whose gate passed is a result awaiting review, not one to rerun.
  const machinePassed = verdict?.machineVerdict === "verified" || verdict?.machineVerdict === "attested";
  if (verdict === null || !(verdict.verdict === "refuted" || (verdict.verdict === "short" && !machinePassed))) {
    return { ok: false, reason: "not-rejected", message: `${taskId}'s last result is still being assessed; wait for it or stop it` };
  }
  // A pushed or opened branch is revised through its pull request, never
  // rerun underneath it; a live claim means an attempt is still running.
  const publication = store.publicationForRun(last.id);
  if (publication !== null && (publication.state === "pushed" || publication.state === "opened")) return { ok: false, reason: "published", message: `${taskId}'s last result is published; revise it through its pull request` };
  if (store.hasLiveClaim(ref.id, now)) return { ok: false, reason: "claimed", message: `a runner holds ${taskId} right now — wait for the attempt to end, or stop it` };
  const scope = store.getScope(taskId);
  if (scope === null) return { ok: false, reason: "no-attempt", message: `${taskId} has no scope` };
  const head = last.headRevision;
  const actor = approval.kind === "operator" ? approval.name : `mode ${approval.name}`;
  return store.transact(() => {
    const proposed = propose(store, {
      taskId, goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd,
      acceptance: scope.acceptance, qualityMode: scope.qualityMode ?? "default",
      candidate: head, now,
    });
    let sealed = false;
    if (approval.kind === "operator") sealed = approve(store, taskId, approval.name, now, proposed.digest, approval.token).ok;
    else sealed = store.sealScopeApproval(taskId, actor, now, {}, { kind: "mode", modeDigest: approval.modeDigest });
    if (!sealed) return { ok: false as const, reason: "not-approved" as const, message: `${taskId}'s rerun scope could not be approved` };
    // A finished task returns to the queue; one already queued (a park, a
    // stop) simply dispatches with the rerun scope on its next turn.
    if (store.getTask(taskId)?.state !== "queued") {
      const queued = store.requeueTask(taskId, actor, now);
      if (!queued.ok) {
        const why: Record<string, RegateRefusal> = { claimed: "claimed", "accepted-result": "accepted-result", published: "published" };
        return { ok: false as const, reason: why[queued.reason] ?? "not-rejected", message: `${taskId} could not be queued again: ${queued.reason}` };
      }
    }
    store.addRunNote(last.id, "Toolroll", `The check will run again on this exact commit (${head.slice(0, 7)}) as a new attempt, ${approval.kind === "operator" ? `on ${approval.name}'s say-so` : "automatically once, because the failure was outside this change"}.`, now);
    return { ok: true as const, run: last.id, head };
  });
}

export type RepairTrigger =
  | { kind: "drafted"; draftTaskId: string; attempt: number; approved: boolean }
  | { kind: "stopped"; reason: RepairStopReason }
  | { kind: "none" };

/**
 * An explicitly requested repair from saved check or historical review findings.
 * Automatic calls are retired. Composes at
 * most one durable revision draft naming exactly the unmet criterion ids,
 * inheriting the source scope and rubric verbatim — or settles the chain
 * at one of its four independent stops (integrity, no-progress, attempts
 * cap; the fourth — existing spend/run rails — is the ordinary tick's own
 * job once a mode-approved draft dispatches as a normal builder run).
 *
 * Never dispatches anything itself: a mode-authorized draft is
 * auto-APPROVED here, but still builds through the ordinary tick, under
 * the ordinary rails and strikes — this function only ever composes a
 * task and, at most, one scope approval.
 */
export function maybeTriggerRepair(store: Store, repo: string, evidenceRoot: string, sourceRunId: number, verdict: ProofVerdict, now: Date, cause: "review" | "verification" = "review", automatic = false): RepairTrigger {
  if (verdict !== "short" && verdict !== "refuted") return { kind: "none" };
  // Findings go to the lead. Explicit repair/revision actions remain available.
  // Historical mode signatures remain intact; no automatic follow-up spends.
  if (automatic) return { kind: "none" };
  // One attempt per source run, ever (source_run UNIQUE) — checked first so
  // a re-fired trigger is a silent no-op, never a duplicate.
  if (store.repairChainFor(sourceRunId) !== null) return { kind: "none" };

  const run = store.getRun(sourceRunId);
  if (run === null) return { kind: "none" };
  const stored = store.proofVerdictFor(sourceRunId);
  if (stored === null) return { kind: "none" };
  // THE RERUN STOP (v70): this attempt was a rerun of the same commit — the
  // scope names that commit as its prepared candidate and the commit has
  // been attempted before. The machine has had its one retry; whatever
  // rejected it this time, a failed check or a contradicting review, goes
  // to a person. No repair draft, no third pass, on either road.
  {
    const rerunTask = store.refById(run.taskRef)?.externalId ?? "";
    if (run.headRevision && store.getScope(rerunTask)?.candidate === run.headRevision && store.builderAttemptsAt(run.taskRef, run.headRevision) >= 2) {
      const contradicted = cause === "review";
      store.enqueueNotification({ source: { run: sourceRunId }, dedupeKey: `regate-failed:${sourceRunId}`, kind: "repair-evidence", pushClass: "attention",
        subject: contradicted ? "The rerun on the same commit was contradicted by its review" : "The project check failed again on the same commit",
        body: `Attempt #${sourceRunId} reran commit ${run.headRevision.slice(0, 7)} and ${contradicted ? "its review contradicted the result" : "the approved check failed again"}. No repair task was filed: decide whether the code or the check is wrong, then run \`toolroll task regate ${rerunTask}\` or re-scope a corrected candidate.`,
        link: `/t/${encodeURIComponent(rerunTask)}` }, now);
      return { kind: "none" };
    }
  }
  const direct = stored.matrix.length > 0 && stored.matrix.every(row => row.assessment !== undefined);
  const observation = cause === "review" && direct && !stored.matrix.some(row => row.review?.judgement === "contradicts") && stored.matrix.some(row => row.review?.judgement === "cannot-tell");
  if (cause === "review" && direct && !stored.matrix.some(row => row.review?.judgement === "contradicts") && !observation) return { kind: "none" };
  if (store.applicableStopFor(sourceRunId) !== null || store.activeHolds(run.taskRef, now).length > 0) return { kind: "none" };
  let observationGate: { digest: string; originalBase: string } | undefined;
  if (observation) {
    if (store.refForId(run.taskRef)?.repo !== repo) return { kind: "none" };
    const missing = stored.matrix.filter(row => row.review?.judgement === "cannot-tell");
    const supported = missing.every(row => row.requiredEvidence.includes("check") && !row.requiredEvidence.includes("screenshot") && !row.requiredEvidence.includes("manual-review")) && focusedTestCommandSupported(store.liveVerifyCommand(repo)?.command ?? "");
    if (!supported) {
      store.enqueueNotification({ source: { run: sourceRunId }, dedupeKey: `assessment-evidence:${sourceRunId}`, kind: "repair-evidence", pushClass: "attention", subject: "More evidence is needed", body: missing.flatMap(row => row.detail).join("\n"), link: `/r/${sourceRunId}` }, now);
      return { kind: "none" };
    }
    const gate = verificationEvidence(store, evidenceRoot, sourceRunId);
    const originalBase = originalTaskBase(store, store.externalIdFor(run.taskRef)!);
    if (!gate.ok || !gate.bytes || !originalBase || JSON.parse(gate.bytes).result?.exitCode !== 0 || stored.machineVerdict !== "verified") return { kind: "none" };
    observationGate = { digest: gate.digest, originalBase };
  }
  const mode = store.activeMode(repo, now);
  const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
  let verification: { sourceRun: number; digest: string } | undefined;
  if (cause === "verification") {
    // A signed repair mode is required for this automatic producer. The
    // existing review/manual road continues to offer unapproved drafts.
    if (terms?.repairAuto !== true || run.finishedAt === null || !run.headRevision ||
      (run.outcome !== "built" && run.outcome !== "no-change")) return { kind: "none" };
    const owner = store.refForId(run.taskRef);
    if (owner === null || owner.repo !== repo || store.applicableStopFor(sourceRunId) !== null ||
      store.activeHolds(run.taskRef, now).length > 0 ||
      (!run.committed && !(run.outcome === "no-change" && store.repairChainForDraft(owner.externalId) !== null))) return { kind: "none" };
    const failure = failedVerificationEvidence(store, evidenceRoot, sourceRunId);
    if (failure.kind === "unavailable") {
      store.enqueueNotification({ source: { run: sourceRunId }, dedupeKey: `repair-evidence:${sourceRunId}`, kind: "repair-evidence", pushClass: "attention", subject: "Repair needs complete evidence", body: failure.problem, link: `/t/${encodeURIComponent(store.refById(run.taskRef)?.externalId ?? "")}` }, now);
      return { kind: "none" };
    }
    if (failure.kind !== "failed") return { kind: "none" };
    // A failure the change cannot have caused — the whole gate timing out,
    // or an untouched test's own timeout — is handed to a person, not to
    // another code-writing attempt (2026-09-18: mayhem-spire run 1784
    // drafted a repair for a balance probe the diff never touched).
    const unrelated = unrelatedGateFailure(store, evidenceRoot, failure, sourceRunId);
    if (unrelated !== null) {
      const taskId = store.refById(run.taskRef)?.externalId ?? "";
      // One automatic rerun of the check on the same commit, under the mode
      // that already authorizes automatic repair (a rerun is strictly less
      // than a repair). A second failure on the same commit goes to a person.
      const rerunBefore = run.headRevision ? store.builderAttemptsAt(run.taskRef, run.headRevision) : 0;
      if (mode !== null && terms?.repairAuto === true && run.headRevision && rerunBefore < 2) {
        const rerun = regateTask(store, taskId, now, { kind: "mode", name: mode.name, modeDigest: mode.digest });
        if (rerun.ok) {
          store.enqueueNotification({ source: { run: sourceRunId }, dedupeKey: `regate:${sourceRunId}`, kind: "repair-evidence",
            subject: unrelated.kind === "gate-timed-out" ? "The project check ran out of time; running it once more" : "A slow test outside this change failed the check; running it once more",
            body: `${gateFailureSummary(unrelated)} The check runs again once on the same commit ${run.headRevision.slice(0, 7)}, with no agent. If it fails again, a person decides.`,
            link: `/t/${encodeURIComponent(taskId)}` }, now);
          return { kind: "none" };
        }
      }
      store.enqueueNotification({ source: { run: sourceRunId }, dedupeKey: `repair-unrelated:${sourceRunId}`, kind: "repair-evidence", pushClass: "attention",
        subject: unrelated.kind === "gate-timed-out" ? "The project check ran out of time" : "A slow test outside this change failed the project check",
        body: describeGateFailure(unrelated, taskId), link: `/t/${encodeURIComponent(taskId)}` }, now);
      return { kind: "none" };
    }
    verification = { sourceRun: sourceRunId, digest: failure.digest };
  }
  const unresolved = stored.matrix
    .filter(row => cause === "review" && direct ? row.review?.judgement === (observation ? "cannot-tell" : "contradicts") : row.state === "missing" || row.state === "failed")
    .map(row => row.id)
    .sort();
  // The project gate is independent of agent-reported criterion passes.
  // This ledger target is not a new acceptance criterion or a changed verdict.
  if (verification !== undefined && !unresolved.includes("project checks")) unresolved.push("project checks");
  unresolved.sort();
  if (unresolved.length === 0) return { kind: "none" };

  const brief = store.refById(run.taskRef);
  const ref = brief === null ? null : store.lookupRef(brief.externalId);
  if (ref === null) return { kind: "none" };

  // Never repair: a scout task (a report, not a branch — nothing to build
  // back into).
  if (ref.deliverable === "report") return { kind: "none" };
  // Never repair: a run already published or holding a merge blocker.
  const publication = store.publicationForRun(sourceRunId);
  if (publication !== null && !(verification !== undefined && publication.state === "intended" && publication.attempts === 0)) return { kind: "none" };
  // Never repair: a task with an open decision or a pending steering note.
  if (store.decisionsForTask(ref.id).some(d => d.state === "open" || d.state === "expired")) return { kind: "none" };
  if (store.pendingSteerCount(ref.id) > 0) return { kind: "none" };
  // Never repair: a run whose proof was already accepted.
  if (store.proofAcceptance(sourceRunId) !== null) return { kind: "none" };

  const task = store.getTask(ref.externalId);
  const scope = store.getScope(ref.externalId);
  if (task === null || scope === null) return { kind: "none" };

  // THE LINEAGE (contract handoff task 2): the chain this task CONTINUES
  // is found through its revision ancestry, not only its own draft row —
  // an annotation or CI detour between two repair attempts keeps the
  // root, the attempts already spent, and the remaining automatic bound.
  // The next attempt number is one past the chain's highest, whichever
  // branch spent it; nothing resets because a person annotated a draft.
  const lineage = store.repairLineageOf(ref.externalId);
  if (lineage.problem !== undefined) {
    store.enqueueNotification({ source: { run: sourceRunId }, dedupeKey: `repair-lineage:${sourceRunId}`, kind: "repair-lineage", subject: `${ref.externalId}: repair ancestry needs attention`, body: lineage.problem, link: `/t/${encodeURIComponent(ref.externalId)}` }, now);
    return { kind: "stopped", reason: "repair-refused-integrity" };
  }
  const priorChain = lineage.continues;
  const rootTask = lineage.rootTask;
  const attempt = lineage.attempts.reduce((highest, row) => Math.max(highest, row.attempt), 0) + 1;

  const auto = terms?.repairAuto === true;
  const basis: "human" | "mode" = auto ? "mode" : "human";
  const modeDigest = auto && mode !== null ? mode.digest : null;
  /** Settle the row this task continues when it is still open; a stop
   * with no open row to settle records its own settled row instead. */
  const settleOrRecord = (outcome: "integrity-refused" | "no-progress" | "attempts-spent") => {
    if (priorChain !== null && priorChain.outcome === "drafted") store.settleRepairChain(priorChain.id, outcome, now);
    else store.recordRepairStop({ rootTask, sourceRun: sourceRunId, attempt, basis, modeDigest, unresolved, outcome }, now);
  };

  // THE INTEGRITY STOP (unconditional, both roads): a refutation that lies
  // about the signed terms is never handed back to the same machine
  // unattended — park for a human instead.
  if (isIntegrityRefutation(stored.reasons)) {
    settleOrRecord("integrity-refused");
    return { kind: "stopped", reason: "repair-refused-integrity" };
  }

  // THE NO-PROGRESS STOP (unconditional, both roads): two consecutive
  // attempts that fail to strictly shrink the unresolved set.
  if (priorChain !== null) {
    const history = store.repairChainForRoot(rootTask).map(row => [...row.unresolved].sort());
    const sequence = [...history, unresolved];
    if (sequence.length >= 3) {
      const last = sequence[sequence.length - 1]!;
      const mid = sequence[sequence.length - 2]!;
      const first = sequence[sequence.length - 3]!;
      if (!strictlyShrunk(mid, last) && !strictlyShrunk(first, mid)) {
        settleOrRecord("no-progress");
        return { kind: "stopped", reason: "repair-no-progress" };
      }
    }
  }

  // THE ATTEMPT CAP: bounds only the AUTOMATIC road (a mode's signed
  // repairMaxAttempts) — the default road's loop is already bounded by
  // requiring a fresh human "yes" for every attempt.
  if (auto && terms !== null && attempt > terms.repairMaxAttempts) {
    settleOrRecord("attempts-spent");
    return { kind: "stopped", reason: "repair-attempts-spent" };
  }

  // THE DRAFT: no log content, no new instructions — exactly the unmet
  // ids, their matrix detail sentences, and the reviewer's own
  // contradiction notes.
  const contradictions = store.criterionReviewsFor(sourceRunId).filter(one => one.judgement === "contradicts");
  const unresolvedDetail = stored.matrix.filter(row => unresolved.includes(row.id)).map(row => ({ id: row.id, statement: row.statement, detail: row.detail }));
  const draftBrief = {
    schema: 1 as const,
    kind: observation ? "evidence-observation" as const : "criterion-repair" as const,
    sourceTask: ref.externalId,
    sourceRun: sourceRunId,
    sourceScopeDigest: scope.digest,
    head: run.headRevision,
    rootTask,
    attempt,
    unresolved: unresolvedDetail,
    reviewerContradictions: contradictions.map(one => ({ id: one.criterionId, author: one.author, note: one.note })),
    ...(verification === undefined ? {} : { verification }),
    ...(observationGate === undefined ? {} : { originalBase: observationGate.originalBase, gateDigest: observationGate.digest }),
  };
  const briefBytes = Buffer.from(JSON.stringify(draftBrief, null, 2), "utf8");
  const key = writeEvidenceFile(evidenceRoot, sourceRunId, `repair-brief-${sourceRunId}-${attempt}.json`, briefBytes);
  // The draft files through the ONE revision boundary: the source's goal,
  // exclusions, touches, rubric, risk, quality, posture, budget, overrides
  // and pins are read from the SOURCE ROWS inside the seal — the scope
  // read above is only the digest this draft binds to, re-proved there.
  const drafted = store.openRepairDraft(
    {
      source: { task: ref.externalId, run: sourceRunId, scopeDigest: scope.digest },
      brief: { evidenceRoot, key, sha256: createHash("sha256").update(briefBytes).digest("hex"), bytes: briefBytes.length, capture: "machine-authored repair brief (exit 0)" },
      child: {
        title: observation ? `Collect missing evidence for ${ref.externalId}` : verification === undefined ? `repair ${ref.externalId}: ${unresolved.length} criteri${unresolved.length === 1 ? "on" : "a"} unmet` : `Fix failed checks for ${ref.externalId}`,
        repair: observation ? `Collect only the missing observations for ${unresolved.join(", ")}. Keep the saved candidate unchanged. The machine runs supported focused test observations and reuses its intact passing gate; a fresh review assesses the added evidence.` : verification === undefined ? `repair exactly the unmet criteria named below; a comment cannot widen the scope. Unmet: ${unresolved.join(", ")}.` : "Diagnose the saved failed project check and repair within the original scope. Preserve the acceptance criteria and verification command; the revision brief binds the exact failure evidence.",
      },
      rootTask,
      attempt,
      basis,
      modeDigest,
      unresolved,
    },
    now,
  );
  if (!drafted.ok) return { kind: "none" };

  let approved = false;
  if (auto && mode !== null) {
    const draftScope = store.getScope(drafted.id);
    // A scope whose profile could not resolve is unapprovable by the human
    // road; the mode road refuses the same way — the draft stays honestly
    // unapproved rather than sealing an approval nobody could act on.
    if (draftScope?.profileState === "resolved") {
      approved = store.sealScopeApproval(drafted.id, `mode ${mode.name}`, now, {}, { kind: "mode", modeDigest: mode.digest });
    }
  }
  if (observation && !approved) store.enqueueNotification({ source: { run: sourceRunId }, dedupeKey: `assessment-evidence:${sourceRunId}`,
    kind: "repair-evidence", pushClass: "attention", subject: "Review evidence collection", body: "A follow-up is ready to collect the missing observations without changing the saved code.", link: `/t/${encodeURIComponent(drafted.id)}` }, now);
  return { kind: "drafted", draftTaskId: drafted.id, attempt, approved };
}
