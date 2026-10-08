/**
 * The claim, and the fence around it.
 *
 * This is the record §4 calls the one that matters, and the reason is a
 * specific 3am failure. A runner takes a task, starts work, and then stops
 * being reachable — the machine sleeps, the process is OOM-killed, the network
 * partitions. The scheduler cannot tell "dead" from "slow", so it waits for the
 * lease to expire and gives the task to someone else. Then the first runner
 * wakes up, finishes the work it was doing, and reports success for a task that
 * another runner is now halfway through.
 *
 * Both runners are behaving correctly. Without a fence, the control plane
 * believes the last one to speak.
 *
 * So a lease carries two things. `lease_id` is immutable and identifies one
 * grant of one task to one runner. `lease_generation` counts how many times
 * that task has been granted at all, and it only ever goes up. Acquiring is a
 * compare-and-swap on the generation; every later call carries the lease it
 * thinks it holds, and anything whose generation has been superseded is
 * refused. The late completion above is refused not because we detected the
 * crash — we never did — but because the world moved on without it.
 *
 * Losing a race here is ordinary, not an error. Several runners asking for the
 * same task at the same moment is the system working; exactly one wins.
 *
 * Time is a parameter everywhere. Expiry decided by an implicit clock is
 * untestable, and a lease is exactly the kind of thing that has to be provable
 * rather than probable.
 */

import { randomUUID } from "node:crypto";
import { authenticate } from "./runner.js";
import { pauseForAuth } from "./provider-auth.js";
import {
  DEFAULT_MAX_OPEN_DECISIONS,
  missingCapability,
  scopeApprovedForDispatch,
  taskReadinessBlocker,
} from "./dispatch.js";

import {
  BUILT_IN,
  type Store,
  type Mutation,
  type Run,
  type TaskState,
} from "./store.js";
import type { ParsedDecision, Problem } from "./decision.js";
import { digestOf } from "./scope.js";
import type { ParsedPlan } from "./plan.js";
import { parseExecutionPlanDocument } from "./plan.js";
import { sealUnchangedPlanUnderMode } from "./plan-auto.js";
import { routeFromJson } from "./phase-routing.js";
import {
  contractChangesOf,
  decodePlannerSource,
  encodePlannerSource,
  canonicalContractJson,
  PLANNER_SOURCE_LIMITS,
  describeContractChanges,
  encodePlanContractRecord,
  plannerContractOf,
  plannerSourceDigest,
  type PlanContractRecord,
  type PlannerSource,
} from "./planner-source.js";
import { storeEvidence, readVerifiedArtifact, EVIDENCE_CAPS } from "./evidence.js";
import type { AuthorityChangeField } from "./plan.js";
import type { ParsedReport } from "./scout-report.js";


export type Claim = {
  taskRef: number;
  /** Immutable. Identifies this grant, and no other. */
  leaseId: string;
  /** Monotonic per task. The fencing token. */
  generation: number;
  runner: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
};

export type AcquireResult =
  | { ok: true; claim: Claim; reclaimed: boolean; replayed?: boolean }
  | { ok: false; reason: "held"; by: string; until: string }
  | { ok: false; reason: "reserved"; reservedFor: string }
  | { ok: false; reason: "external"; detail: "stale-mirror" | "external-closed" | "dispatch-revoked" | "plane-blocked" }
  /** A mode-sealed approval whose signature no longer stands (v29): the
   * approval falls back to a person; nothing dispatches on a dead mode. */
  | { ok: false; reason: "mode-ended"; message: string }
  /** The credential presented with this acquisition did not verify against
   * the runner row AT CLAIM TIME (MCP spec v6): stale incarnations never
   * ride a successor's rotation. */
  | { ok: false; reason: "unauthenticated"; detail: "unknown" | "bad-token" | "retired" | "expired" }
  /** The task is placed nowhere — a repo-scoped runner cannot be
   * authorized for null. Place it, then dispatch. */
  | { ok: false; reason: "unplaced" }
  /** The runner's bound repo list does not contain the task's repo.
   * The refusal names the binding road. */
  | { ok: false; reason: "unauthorized-repo"; repo: string }
  /** A coordinator filed this and no password ceremony has sealed its
   * scope yet — nothing claims, plans, or runs it until one does. */
  | { ok: false; reason: "coordinator-filed" };

/** `fenced` means the lease was superseded; `unknown` means it never existed. */
export type FenceResult =
  | { ok: true; claim: Claim; duplicate?: boolean }
  | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/**
 * Completion's OWN result (external dispatch, finding 33): `completed` is
 * today's world — the task is done/failed as asked; `disowned` means the
 * tracker closed this mirror while it was being built — the task is
 * cancelled, the branch is kept as evidence, and the caller must never
 * publish. The arm is DURABLE (claim.released_by), so a retried completion
 * returns its original answer forever.
 */
export type CompleteResult =
  | { ok: true; arm: "completed" | "disowned"; claim: Claim; duplicate?: boolean }
  | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/** How stale a mirror's last complete sync may be before admission refuses. */
export const SYNC_MAX_AGE_MS = 15 * 60_000;

export type AcquireOptions = {
  now: Date;
  /** The runner's minted credential, re-verified INSIDE the claim
   * transaction (MCP gateway spec v6, Codex round-5 finding 1): a
   * takeover that rotates the credential between the caller's own auth
   * and this CAS must not let the stale process ride its successor's
   * authority. */
  token: string;
  ttlMs?: number;
  /** Injected in tests so a lease id can be asserted on. */
  newLeaseId?: () => string;
  /** The watch incarnation dispatching this claim, for crash recovery keyed to it. */
  incarnation?: string;
  mutation?: Mutation;
  /** External-mirror freshness bound; defaults to SYNC_MAX_AGE_MS. */
  syncMaxAgeMs?: number;
};

/**
 * Long enough that an ordinary build does not lose its lease mid-thought,
 * short enough that a dead runner's work is picked up the same night rather
 * than at breakfast.
 */
export const DEFAULT_LEASE_MS = 15 * 60_000;

/**
 * Take the task, if it is free.
 *
 * Free means no claim, or a claim whose lease expired, or one already released.
 * A live lease belonging to somebody else is refused with who holds it and
 * until when, because "no" without a reason is indistinguishable from a bug.
 */
export function acquire(
  store: Store,
  taskRef: number,
  runner: string,
  options: AcquireOptions,
): AcquireResult {
  // Replay detection is ACQUIRE-SPECIFIC (external dispatch, finding 36):
  // the stored payload is untouched — the flag rides only the returned
  // copy, so a second replay cannot double-stamp, and Store.replay's T→T
  // contract holds for every other user.
  const replayed = store.hasMutationRecord(options.mutation ?? {});
  const result = inTransaction(store, () => acquireLocked(store, taskRef, runner, options));
  return replayed && result.ok ? { ...result, replayed: true } : result;
}

/**
 * The body of `acquire`, for callers already holding the transaction.
 * `acquireIfReady` needs its readiness check and the CAS to be one atomic
 * step, and SQLite does not nest transactions.
 */
function acquireLocked(
  store: Store,
  taskRef: number,
  runner: string,
  options: AcquireOptions,
): AcquireResult {
  const { now, ttlMs = DEFAULT_LEASE_MS, newLeaseId = randomUUID, mutation = {} } = options;
  const db = store.handle;

  // Idempotency wraps the CAS, not the other way round: a retried
  // acquire must hand back the first answer rather than take a second lease.
  return (
    store.replay(mutation, "acquire", () => {
      const stamp = now.toISOString();
      // THE RUNNER GATE, first leg (MCP gateway spec v6). Identity is
      // proven INSIDE this transaction — the row re-read, the hash
      // re-compared — so a takeover between the caller's own auth and
      // this CAS never lets a stale process ride its successor's
      // authority. Then the repo tuple: authority derives from
      // task_ref.repo ONLY; a task placed nowhere cannot be authorized
      // by a repo-scoped runner, and a runner not bound to the task's
      // repo never even holds a claim.
      const gate = authenticate(store, runner, options.token);
      if (!gate.ok) return { ok: false as const, reason: "unauthenticated" as const, detail: gate.reason };
      const placedRef = store.refForId(taskRef);
      const placedRepo = placedRef?.repo ?? null;
      if (placedRepo === null) return { ok: false as const, reason: "unplaced" as const };
      if (!gate.runner.repos.includes(placedRepo)) {
        return { ok: false as const, reason: "unauthorized-repo" as const, repo: placedRepo };
      }
      // THE COORDINATOR QUARANTINE in the one primitive every claim road
      // shares (MCP spec v6, round-3 f1): a coordinator-filed task whose
      // scope has not been sealed by the password ceremony claims for
      // NOBODY — not the pre-approval planner road, not a raw CLI claim.
      // One SQL predicate, so roads cannot diverge. After the seal it is
      // ordinary in every respect.
      if (placedRef !== null && placedRef.coordinatorCid !== null && !store.scopeSealed(placedRef.externalId)) {
        return { ok: false as const, reason: "coordinator-filed" as const };
      }
      // The reservation gate lives HERE, in the one primitive every
      // acquisition path shares (queue-columns review, finding 1): tick's
      // acquireIfReady and the raw CLI claim both
      // pass through this line, so a task reserved for one worker can
      // never be taken by another, whatever the caller's snapshot said.
      // Scheduling, not authority: nothing about WHAT may build changes.
      const reservedFor = store.assignedRunnerOf(taskRef);
      if (reservedFor !== null && reservedFor !== runner) {
        return { ok: false as const, reason: "reserved" as const, reservedFor };
      }
      // The external-mirror gate (dispatch v3 §2): every acquisition path
      // shares this line, so a stale, closed, revoked, or plane-blocked
      // mirror never starts a build — whatever the caller's snapshot said.
      // An ordinary task costs one indexed lookup.
      const mirrorWhy = store.mirrorAdmissionRefusal(taskRef, now, options.syncMaxAgeMs ?? SYNC_MAX_AGE_MS);
      if (mirrorWhy !== null && mirrorWhy !== "not-a-mirror") {
        return { ok: false as const, reason: "external" as const, detail: mirrorWhy };
      }
      // THE MODE BELT on the one primitive every claim road shares (Codex
      // people round 2, finding 2): a mode-sealed approval whose signature
      // no longer stands — revoked, expired by clock, or a dead signer —
      // does not dispatch, CLI claim included. Live claims already taken
      // are untouched; this fences only NEW takes.
      if (!store.modeApprovalLive(taskRef, now)) {
        return {
          ok: false as const,
          reason: "mode-ended" as const,
          message: "the operating mode that approved this has ended — the approval falls back to a person",
        };
      }
      const existing = latest(db, taskRef);

      if (existing !== undefined && isLive(existing, stamp)) {
        return {
          ok: false as const,
          reason: "held" as const,
          by: String(existing["runner"]),
          until: String(existing["expires_at"]),
        };
      }

      const generation = existing === undefined ? 1 : Number(existing["lease_generation"]) + 1;
      const claim: Claim = {
        taskRef,
        leaseId: newLeaseId(),
        generation,
        runner,
        acquiredAt: stamp,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        heartbeatAt: stamp,
      };

      // The compare-and-swap, enforced by UNIQUE (task_ref, lease_generation)
      // rather than by anything this code does. Two runners that both read the
      // same generation both try to write generation + 1; the database admits
      // one. OR IGNORE turns the loser's constraint violation into a row count
      // of zero, because losing a race is an ordinary outcome and not an error.
      const { changes } = db
        .prepare(
          `INSERT OR IGNORE INTO claim
             (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, incarnation)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          claim.leaseId,
          taskRef,
          claim.generation,
          runner,
          claim.acquiredAt,
          claim.expiresAt,
          claim.heartbeatAt,
          options.incarnation ?? null,
        );

      if (Number(changes) === 0) {
        const winner = latest(db, taskRef);
        return {
          ok: false as const,
          reason: "held" as const,
          by: winner === undefined ? "unknown" : String(winner["runner"]),
          until: winner === undefined ? stamp : String(winner["expires_at"]),
        };
      }

      return { ok: true as const, claim, reclaimed: existing !== undefined };
    },
    // Only a lease that was actually granted is worth remembering. Recording
    // the refusal would make this key a permanent "no" for a task that is
    // free again five minutes later.
    result => result.ok,
    )
  );
}

/** The newest lease on a task, held or not. */
function latest(db: Store["handle"], taskRef: number): Record<string, unknown> | undefined {
  return db
    .prepare("SELECT * FROM claim WHERE task_ref = ? ORDER BY lease_generation DESC LIMIT 1")
    .get(taskRef);
}

/**
 * Why `acquireIfReady` said no before the race was even run. `not-ready` is
 * about the task's own state; `capability` is about the machine's — a gap a
 * person can fill, named so the caller can say which.
 */
export type NotReady = {
  ok: false;
  reason: "not-ready" | "capability" | "attention-budget" | "capacity" | "quota" | "provider-unavailable";
  message: string;
};

/** DESIGN §8 gate 6: above this many open decisions, stop dispatching the parkers.
 * `missingCapability` remains re-exported for callers of the old claim seam. */
export { DEFAULT_MAX_OPEN_DECISIONS, missingCapability } from "./dispatch.js";

/**
 * Take the task, if it is free *and still worth taking*.
 *
 * `listReady` then `acquire` is two reads of a world that moves between them:
 * a hold placed, a blocker reopened, the task cancelled — and the CAS admits
 * the claim anyway, because the CAS only defends against other claimants. An
 * unattended pass has nobody watching who would notice the stale dispatch, so
 * the readiness conditions are re-proved inside the same transaction as the
 * acquire, against rows the write lock has already pinned.
 *
 * "Not ready" is a different answer from "held": held means somebody else got
 * it, which is a race being won; not-ready means nobody should have it, and
 * says why.
 */
export function acquireIfReady(
  store: Store,
  taskRef: number,
  runner: string,
  options: AcquireOptions & {
    repo?: string;
    maxOpenDecisions?: number;
    /** The provider this dispatch resolved to — the quota key. */
    provider?: string;
    /** The model this dispatch would run — the quota scope. */
    model?: string;
    /** What this dispatch is FOR. Re-proved inside the transaction — the
     * caller's survey is not trusted (Codex planning review, finding 2). */
    dispatchRole?: "builder" | "planner" | "scout";
  },
): AcquireResult | NotReady {
  const role = options.dispatchRole ?? "builder";
  return inTransaction(store, () => {
    const why = taskReadinessBlocker(store, taskRef, options.now);
    if (why !== null) return { ok: false as const, reason: "not-ready" as const, message: why.message };

    // The role's own precondition, re-read where the write lock has pinned
    // it — never an early return past the shared gates below. A planner
    // dispatches exactly when the operator asked and no promise exists yet;
    // a builder dispatches exactly when the promise is approved. A
    // mode-sealed approval additionally re-proves its signature is STILL
    // the live mode (belt to the demotion sweep — R-REVOKE's next gate
    // holds even in the window before an expired mode is durably closed).
    const approvedScope = scopeApprovedForDispatch(store, taskRef, options.now);
    if (role === "planner") {
      const ref = store.refForId(taskRef);
      if (ref?.plan !== "requested") {
        return { ok: false as const, reason: "not-ready" as const, message: "no plan was requested" };
      }
      if (approvedScope) {
        return { ok: false as const, reason: "not-ready" as const, message: "the scope is already approved — nothing left to plan" };
      }
    }
    // The deliverable is re-read here (v34): a scout dispatches exactly on
    // a report task with an approved scope, and a builder never on one —
    // the caller's survey chose the role, the row proves it.
    if (role === "scout" || role === "builder") {
      const deliverable = store.refForId(taskRef)?.deliverable ?? "branch";
      if (role === "scout" && deliverable !== "report") {
        return { ok: false as const, reason: "not-ready" as const, message: "this task delivers a branch — a scout has nothing to report on it" };
      }
      if (role === "builder" && deliverable === "report") {
        return { ok: false as const, reason: "not-ready" as const, message: "this task delivers a report — a scout, never a builder, takes it" };
      }
      if (role === "scout" && !approvedScope) {
        return { ok: false as const, reason: "not-ready" as const, message: "the scope is not approved" };
      }
    }
    if (role !== "planner" && !approvedScope) {
      return { ok: false as const, reason: "not-ready" as const, message: "the scope is not approved" };
    }
    // Capabilities are re-read inside the same transaction as the CAS, like
    // every other readiness fact: a key that expired between the survey and
    // the take must not be dispatched on the survey's answer.
    const gap = missingCapability(store, taskRef, options.repo ?? null, options.now);
    if (gap !== null) return { ok: false as const, reason: "capability" as const, message: gap };

    // Capacity (§8 gate 3), counted where the claim lands — two overlapping
    // passes cannot both see a free slot that only exists once. Enforced for
    // registered runners; a runner the store has never met is a test driving
    // the API directly, and the CLI always registers.
    const registered = store.getRunner(runner);
    if (registered !== null) {
      const held = store.liveClaimCount(runner, options.now);
      if (held >= registered.runner.capacity) {
        return {
          ok: false as const,
          reason: "capacity" as const,
          message: `${runner} holds ${held} of ${registered.runner.capacity} slot(s) — a free CPU against a full ledger is not capacity`,
        };
      }
    }

    // Quota, same gate: an exhausted credential refuses; a half-open one
    // admits exactly this dispatch as its probe, consumed here so a racing
    // pass cannot also treat it as open.
    const scope = options.model ?? "";
    // Quota is keyed to the credential that actually exhausts: the RESOLVED
    // provider, never a fixed binary name — codex quota must not collide
    // with claude's, nor bypass it (Codex provider review, high finding 5).
    const quota = store.quotaState(runner, options.provider ?? "claude", scope, options.now);
    if (quota !== null && quota.state === "exhausted") {
      return {
        ok: false as const,
        reason: "quota" as const,
        message: `${runner}'s provider quota is exhausted (${quota.reason})${quota.resetAt === null ? "" : ` until ${quota.resetAt}`} — a free slot against an exhausted quota is not capacity`,
      };
    }
    // THE ROUTED PROVIDER'S READINESS (v47), re-read inside the same
    // transaction: a provider THIS runner has reported unavailable never
    // claims — no substitution, no second-best. Unknown passes; only a
    // recorded unavailable refuses, and it says what was observed.
    const readiness = store.runnerReadinessOf(runner, options.provider ?? "claude");
    if (readiness !== null && readiness.state === "unavailable") {
      return {
        ok: false as const,
        reason: "provider-unavailable" as const,
        message: `${readiness.provider} is reported unavailable on ${runner} (${readiness.reason}; observed ${readiness.observedAt}) — nothing substitutes for a routed provider`,
      };
    }
    // The attention budget (§8, gate 6), proved where every other readiness
    // fact is proved. A phone with thirty open questions answers none of
    // them; above the budget, tasks with a *measured* habit of parking step
    // aside so the night keeps building what builds. First-time parkers pass
    // — a rate nobody measured is not a rate.
    const budget = options.maxOpenDecisions ?? DEFAULT_MAX_OPEN_DECISIONS;
    if (store.countUnanswered() >= budget) {
      // A planner exists to generate questions; above the budget it is
      // refused outright — no zero-rate first-timer pass (finding 2).
      if (role === "planner") {
        return {
          ok: false as const,
          reason: "attention-budget" as const,
          message: `${store.countUnanswered()} decisions already wait — a planner would only add more; answer some first`,
        };
      }
      const rate = store.refForId(taskRef)?.parkRate ?? 0;
      if (rate > 0) {
        return {
          ok: false as const,
          reason: "attention-budget" as const,
          message: `${store.countUnanswered()} decisions already wait and this task parks ${Math.round(rate * 100)}% of its attempts — answer some before it may add more`,
        };
      }
    }
    const taken = acquireLocked(store, taskRef, runner, options);
    // The half-open probe slot is consumed only WITH the claim it admits —
    // an attention refusal or a lost CAS must not re-arm the quota as
    // exhausted with no probe in flight (finding 3). Same transaction, so
    // consume-with-claim is all-or-nothing.
    if (taken.ok && quota !== null) {
      store.consumeHalfOpen(runner, options.provider ?? "claude", scope, options.now);
    }
    return taken;
  });
}

/**
 * "I am still here." Extends the lease, and tells a superseded runner that it
 * has been superseded — which is the cheapest moment for it to find out, well
 * before it has finished work nobody will accept.
 */
export function heartbeat(
  store: Store,
  leaseId: string,
  now: Date,
  ttlMs: number = DEFAULT_LEASE_MS,
): FenceResult {
  const db = store.handle;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  return inTransaction(store, () => {
    const { changes } = db
      .prepare(
        `UPDATE claim SET heartbeat_at = ?, expires_at = ?
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), expiresAt, leaseId);

    if (Number(changes) === 0) return refusal(db, leaseId);

    const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(leaseId);
    return { ok: true as const, claim: readClaim(row as Record<string, unknown>) };
  });
}

/**
 * The fence, as a predicate on the write rather than a check before it.
 *
 * Checking first and updating second leaves a window: a reclaim committing
 * between the two makes the check's answer stale, and the update — matching on
 * lease id alone — succeeds anyway. Both runners then believe they hold the
 * task, which is the precise failure this module was written to make
 * impossible. Putting the condition inside the statement closes it, because
 * SQLite evaluates it against the row it is about to write.
 */
const NOT_SUPERSEDED = `NOT EXISTS (
  SELECT 1 FROM claim AS newer
   WHERE newer.task_ref = claim.task_ref
     AND newer.lease_generation > claim.lease_generation
)`;

/**
 * Why a fenced write matched nothing. Worth the extra read: "you were
 * superseded" and "I have never heard of this lease" send a runner to very
 * different places.
 */
function refusal(db: Store["handle"], leaseId: string): { ok: false; reason: "fenced" | "unknown" } {
  const row = db.prepare("SELECT 1 AS hit FROM claim WHERE lease_id = ?").get(leaseId);
  return { ok: false, reason: row === undefined ? "unknown" : "fenced" };
}

/** How a lease is handed back, by what a late retry from the same lease is told: 'completed' (and 'disowned') read as
 * "you already did this"; 'parked', 'released' and 'interrupted' are the fence. */
type ReleasedAs = "completed" | "parked" | "released" | "interrupted";

/** The release every ending makes: a compare-and-swap that only the live lease nobody superseded wins. */
function releaseAs(store: Store, leaseId: string, as: ReleasedAs, now: Date): boolean {
  const { changes } = store.handle
    .prepare(`UPDATE claim SET released_at = ?, released_by = ? WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`)
    .run(now.toISOString(), as, leaseId);
  return Number(changes) > 0;
}

/**
 * The open attempt an ending seals, proved first inside finalize's transaction: the run must be this lease's open
 * attempt of the role the ending is for (anything else is a caller defect, thrown — not a race to absorb).
 */
function openAttempt(store: Store, leaseId: string, runId: number, what: string, role?: Run["role"]): Run {
  const run = store.getRun(runId);
  if (run === null || run.leaseId !== leaseId || run.outcome !== null) throw new Error(`run ${runId} is not ${leaseId}'s open attempt — ${what} seals exactly one`);
  if (role !== undefined && run.role !== role) throw new Error(`run ${runId} is a ${run.role} run — only ${role} runs can be sealed as ${what}`);
  return run;
}

/** Release the claim as `as`, or — for a lease the world moved past — finish the run (and its open repair child) as a
 * fenced refusal and say why. Null when the release won. */
function releaseOrRefuse(store: Store, leaseId: string, as: ReleasedAs, runId: number, now: Date, repairRun: Run | null = null): { ok: false; reason: "fenced" | "unknown" } | null {
  if (releaseAs(store, leaseId, as, now)) return null;
  if (repairRun !== null) store.finishRun(repairRun.id, { outcome: "refused", reason: "fenced", now });
  store.finishRun(runId, { outcome: "refused", reason: "fenced", now });
  return refusal(store.handle, leaseId);
}

/**
 * Hand the task back.
 *
 * Accepted only from the lease that currently holds it. A completion arriving
 * on a superseded lease is the failure this whole module exists for, and it is
 * rejected without touching anything — the work is not lost, it is simply not
 * this runner's to report, and the record says so rather than overwriting a
 * live claim with a dead runner's opinion.
 */
export function release(store: Store, leaseId: string, now: Date): FenceResult {
  const db = store.handle;

  return inTransaction(store, () => {
    if (!releaseAs(store, leaseId, "released", now)) {
      // A repeat of a hand-back this same lease already made is not a fence —
      // nobody took the task away, the runner simply said so twice because its
      // first acknowledgement was lost. M1 asks for duplicate completion to be
      // reconciled rather than refused, and telling an honest runner it was
      // superseded would send it to stop when it should carry on.
      //
      // Deliberately not filtered by supersession. A lease that released and
      // was then reacquired by somebody else still *completed*: its work was
      // accepted at the time, and the honest answer to a late retry is "you
      // already did this", not "you were fenced" — which would say its work
      // never counted. Fencing is for a lease that never finished.
      //
      // But *how* the lease came to be released decides everything. Only a
      // release the runner itself made counts as "you already did this". A
      // lease the reaper or dead-runner recovery took back was never handed
      // in by anybody — the world moved on without it, and the answer to its
      // late retry is the fence.
      return duplicateOrRefusal(db, leaseId, ["released", "completed"]);
    }

    const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(leaseId);
    store.bumpWake();
    return { ok: true as const, claim: readClaim(row as Record<string, unknown>) };
  });
}

/**
 * Whether an already-released lease was released in a way the caller may
 * treat as its own doing. Anything else — reaped, recovered, or provenance
 * unknown — is the fence, because accepting it would let a reclaimed lease's
 * late retry pass as an ordinary duplicate.
 */
function duplicateOrRefusal(
  db: Store["handle"],
  leaseId: string,
  own: readonly string[],
): FenceResult {
  const released = db
    .prepare("SELECT * FROM claim WHERE lease_id = ? AND released_at IS NOT NULL")
    .get(leaseId);
  if (released !== undefined && own.includes(String(released["released_by"] ?? ""))) {
    return { ok: true as const, claim: readClaim(released), duplicate: true };
  }
  if (released !== undefined) return { ok: false as const, reason: "fenced" as const };
  return refusal(db, leaseId);
}

/**
 * How an attempt ended, one kind per ending, each with the facts its seal needs. `finalize` seals every one.
 */
export type Outcome =
  /** The task's terminal state, written with the release (no run: the lease's own completion). */
  | ({ kind: "complete" } & CompleteSeal)
  | ({ kind: "park" } & ParkSeal)
  | ({ kind: "malformed" } & MalformedSeal)
  | ({ kind: "interrupted" } & InterruptedSeal)
  | ({ kind: "hand-back" } & HandBackSeal)
  | ({ kind: "failure" } & FailureSeal)
  | ({ kind: "plan" } & PlanSeal)
  | ({ kind: "revision" } & RevisionSeal)
  | ({ kind: "plan-failure" } & PlanFailureSeal)
  | ({ kind: "scout" } & ScoutSeal)
  | ({ kind: "scout-failure" } & ScoutFailureSeal);

/** What sealing each kind answers. */
export type Finalized = {
  complete: CompleteResult;
  park: ParkFinalize;
  malformed: MalformedFinalize;
  interrupted: InterruptSeal;
  "hand-back": HandBackFinalize;
  failure: FailureDisposition;
  plan: PlanFinalize;
  revision: RevisionFinalize;
  "plan-failure": PlanFailureDisposition;
  scout: ScoutFinalize;
  "scout-failure": ScoutFailureDisposition;
};

/**
 * THE ONE WAY AN ATTEMPT ENDS: seal `outcome` for `leaseId` in one fenced transaction.
 *
 * Every ending passes the same fence, in the same order: the run is this lease's open attempt of the right role (a
 * caller defect otherwise, thrown); a stop that applies to it wins — the attempt is sealed as interrupted instead
 * (except the endings that ARE a stop or a service hand-back); then the claim is released by a compare-and-swap only the
 * live, unsuperseded lease wins. A lease the world moved past writes nothing but its own run's fenced refusal (the
 * stop and hand-back endings still end their run, touching no task state), and a retry of an ending the same lease
 * already made answers as a duplicate where that ending allows it. Only then does the ending's own effect run —
 * decision and hold, incident, strike and backoff, scope, report, revision, task state, the disowned mirror — inside
 * the same transaction, so nothing of it exists without the release, and a crash rolls all of it back together.
 */
export function finalize<O extends Outcome>(store: Store, leaseId: string, outcome: O): Finalized[O["kind"]] {
  return inTransaction(store, () => {
    switch (outcome.kind) {
      case "complete": return sealComplete(store, leaseId, outcome);
      case "park": return sealPark(store, leaseId, outcome);
      case "malformed": return sealMalformed(store, leaseId, outcome);
      case "interrupted": return sealInterrupted(store, leaseId, outcome);
      case "hand-back": return sealHandBack(store, leaseId, outcome);
      case "failure": return sealFailure(store, leaseId, outcome);
      case "plan": return sealPlan(store, leaseId, outcome);
      case "revision": return sealRevision(store, leaseId, outcome);
      case "plan-failure": return sealPlanFailure(store, leaseId, outcome);
      case "scout": return sealScout(store, leaseId, outcome);
      case "scout-failure": return sealScoutFailure(store, leaseId, outcome);
    }
  }) as Finalized[O["kind"]];
}

/**
 * Release the lease and write the task's terminal state, as one step.
 *
 * Release-then-mark is a window: between the two, the freed task is back in
 * the ready set, and another pass can claim it before the terminal state
 * lands — two builders for one task, the second dispatched by our own
 * bookkeeping. Here the state is written inside the same transaction as the
 * fenced release, so a task is never simultaneously free and unfinished.
 *
 * A fenced or unknown lease writes nothing: a runner the world moved past
 * does not get to say how the task ended. A duplicate release reports
 * `duplicate` and also writes nothing — the first completion already said,
 * and a retry changing the answer would make "done" negotiable.
 */
function sealComplete(store: Store, leaseId: string, args: CompleteSeal): CompleteResult {
  const { state, now, mutation = {} } = args;
  const db = store.handle;
  const stoppedRun = db.prepare("SELECT r.id FROM run r JOIN run_stop s ON s.run = r.id WHERE r.lease_id = ? AND r.outcome IS NULL LIMIT 1").get(leaseId);
  if (stoppedRun !== undefined) {
    const runId = Number(stoppedRun["id"]);
    const run = store.getRun(runId)!;
    const task = store.refForId(run.taskRef);
    if (task !== null) interruptIfStopped(store, { leaseId, runId, taskId: task.externalId, now });
    return { ok: false as const, reason: "stopped" as const };
  }
  if (!releaseAs(store, leaseId, "completed", now)) {
    // Only a completion this same lease already made reads as a duplicate.
    // The DURABLE disposition (released_by) reproduces the original arm —
    // whatever the task or the tracker did since (finding 33). A lease
    // the reaper or recovery released was never *accepted*; a late
    // completion after that is exactly the stale commit the fence keeps
    // out.
    const released = db
      .prepare("SELECT * FROM claim WHERE lease_id = ? AND released_at IS NOT NULL")
      .get(leaseId);
    if (released !== undefined) {
      const by = String(released["released_by"] ?? "");
      if (by === "completed" || by === "disowned") {
        return {
          ok: true as const,
          arm: by === "disowned" ? ("disowned" as const) : ("completed" as const),
          claim: readClaim(released),
          duplicate: true,
        };
      }
      return { ok: false as const, reason: "fenced" as const };
    }
    return refusal(db, leaseId) as CompleteResult;
  }

  const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(leaseId);
  const claim = readClaim(row as Record<string, unknown>);

  const taskId = db
    .prepare("SELECT external_id FROM task_ref WHERE id = ? AND backend = ?")
    .get(claim.taskRef, BUILT_IN);

  // The completion gate (external dispatch, v4 §24): the latch is read
  // INSIDE this transaction, on a FRESH win only. A latched mirror's
  // completion is DISOWNED — the task is cancelled, the disposition is
  // written durably, and the caller never sees the completed arm, so
  // publication is impossible by construction.
  const disowned = taskId !== undefined && !store.mirrorAllowsCompletion(String(taskId["external_id"]));
  if (disowned) {
    db.prepare("UPDATE claim SET released_by = 'disowned' WHERE lease_id = ?").run(leaseId);
  }

  if (taskId !== undefined) {
    store.replay(mutation, "completeFenced", () => {
      if (disowned) {
        // Cancellation goes through the one floor — a disowned
        // completion is a typed machine reason, not a bare state write.
        store.applyCancellation(
          String(taskId["external_id"]),
          { kind: "machine", code: "disowned-completion" },
          now,
          null,
        );
      } else {
        db.prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?").run(
          state,
          now.toISOString(),
          String(taskId["external_id"]),
        );
      }
      return true;
    });
  }

  store.bumpWake();
  return { ok: true as const, arm: disowned ? ("disowned" as const) : ("completed" as const), claim };
}

/** The task's terminal state, written with the release (no run: the lease's own completion). */
export type CompleteSeal = { state: Extract<TaskState, "done" | "failed">; now: Date; mutation?: Mutation };

/**
 * Validate the optional accepted formatting child against the open planner
 * root. The child remains open until the root's fence settles, so a crash or
 * takeover can never leave it masquerading as successfully delivered work.
 */
function plannerRepairChild(store: Store, root: Run, repairRunId: number | null): Run | null {
  if (repairRunId === null) return null;
  if (root.role !== "planner" || root.outcome !== null || root.providerStartedAt === null) {
    throw new Error(`run ${root.id} cannot own a structured planner correction`);
  }
  const accepted = store.getRun(repairRunId);
  if (accepted === null || accepted.id === root.id || accepted.role !== "planner" || accepted.outcome !== null) {
    throw new Error(`run ${repairRunId} is not an open planner correction for ${root.id}`);
  }
  const sameCustody = (run: Run): boolean =>
    run.taskRef === root.taskRef &&
    run.leaseId === root.leaseId &&
    run.runner === root.runner &&
    run.provider === root.provider &&
    run.model === root.model &&
    run.sessionId !== null &&
    run.sessionId === root.sessionId &&
    run.branch === root.branch &&
    run.worktree === root.worktree &&
    run.baseRevision === root.baseRevision &&
    run.providerStartedAt !== null;
  if (!sameCustody(accepted)) {
    throw new Error(`run ${repairRunId} does not share planner ${root.id}'s exact custody and session`);
  }

  let cursor = accepted;
  for (let edge = 1; edge <= 2; edge += 1) {
    if (cursor.parentRun === root.id) return accepted;
    const parent = cursor.parentRun === null ? null : store.getRun(cursor.parentRun);
    if (
      parent === null ||
      parent.role !== "planner" ||
      parent.outcome !== "failed" ||
      !sameCustody(parent)
    ) {
      throw new Error(`run ${repairRunId} is outside planner ${root.id}'s bounded linear correction chain`);
    }
    cursor = parent;
  }
  throw new Error(`run ${repairRunId} is outside planner ${root.id}'s bounded linear correction chain`);
}

/**
 * Seal a park, fenced at the write (§7).
 *
 * The builder proved its lease after the agent ran; this transaction proves
 * it again *in the same statement that releases it*, because everything a
 * park creates — the decision, its hold, the outbox row — is only true if
 * this lease still spoke for the task at the moment of sealing. A superseded
 * lease creates none of it: no decision, no hold, no notification, and the
 * run is finalized as the fenced refusal it was. A crash anywhere inside
 * rolls all of it back together; there is no instant at which a decision
 * exists without its hold.
 *
 * `released_by = 'parked'` so a late retry from this lease is answered with
 * the fence, not "duplicate": a park hands the task to a person, and nothing
 * the runner says afterwards is that person's answer.
 */
function sealPark(store: Store, leaseId: string, args: ParkSeal): ParkFinalize {
  const { runId, taskId, decision, artifactIds, now } = args;
  const run = openAttempt(store, leaseId, runId, "a park");
  const repairRun = plannerRepairChild(store, run, args.repairRunId ?? null);
  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };

  const fenced = releaseOrRefuse(store, leaseId, "parked", runId, now, repairRun);
  if (fenced !== null) return fenced;

  const decisionId = store.saveDecision(
    {
      run: runId,
      urgency: decision.urgency,
      recap: decision.recap,
      question: decision.question,
      options: decision.options,
      recommendation: decision.recommendation,
      ...(decision.assignee === null ? {} : { assignee: decision.assignee }),
      ...(decision.deadline === null ? {} : { deadline: decision.deadline }),
    },
    now,
  );
  for (const artifact of artifactIds) store.linkEvidence(decisionId, artifact);

  // The hold is indefinite by construction. The decision's deadline is
  // attention metadata; wiring it into `until` would dispatch the task,
  // unanswered, the moment the deadline passed — expiry never chooses.
  store.holdOwned(
    {
      taskRef: run.taskRef,
      ownerKind: "decision",
      ownerId: String(decisionId),
      reason: `decision:${decisionId} — ${oneLine(decision.question, 80)}`,
      until: null,
    },
    now,
  );
  store.finishRun(runId, { outcome: "parked", reason: `decision:${decisionId}`, now });
  if (repairRun !== null) {
    store.finishRun(repairRun.id, { outcome: "no-change", reason: "structured planner output repaired", now });
  }
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `decision:${decisionId}`,
      kind: "decision",
      subject: `${taskId} parked a decision`,
      body: `${oneLine(decision.question, 200)}\n\`toolroll decide ${decisionId}\``,
      // The push stamp (arc 3): class + machine-minted link, at enqueue
      // or never. Fixed phrases ride the push service; this subject does not.
      pushClass: "decision",
      link: `/d/${decisionId}`,
    },
    now,
  );
  return { ok: true as const, decisionId };
}

export type ParkSeal = {
  runId: number;
  taskId: string;
  decision: ParsedDecision;
  artifactIds: readonly number[];
  /** Open planner correction that authored the accepted payload. It is
   * settled in this same fence, never earlier. */
  repairRunId?: number | null;
  now: Date;
};
export type ParkFinalize = { ok: true; decisionId: number } | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/**
 * Seal a park whose payload never became a decision (§6's bounded repair ran
 * out). Same fence, same atomicity, different record: an incident that stays
 * in every brief until a person resolves it, holding the task so the next
 * pass does not spend the same tokens hitting the same wall nightly. The
 * malformed payload is preserved as evidence — a person may still be able to
 * read what the agent meant.
 */
function sealMalformed(store: Store, leaseId: string, args: MalformedSeal): MalformedFinalize {
  const { runId, taskId, problems, now } = args;
  const run = openAttempt(store, leaseId, runId, "a park");

  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };

  const fenced = releaseOrRefuse(store, leaseId, "parked", runId, now);
  if (fenced !== null) return fenced;

  const incidentId = store.createIncident({ run: runId, kind: "malformed-decision" }, now);
  store.holdOwned(
    {
      taskRef: run.taskRef,
      ownerKind: "incident",
      ownerId: String(incidentId),
      reason: `malformed-decision — the agent tried to park ${taskId} and could not say what`,
      until: null,
    },
    now,
  );
  store.finishRun(runId, { outcome: "failed", reason: "malformed-decision", now });
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `malformed:${runId}`,
      kind: "malformed-decision",
      pushClass: "attention",
      link: `/r/${runId}`,
      subject: `${taskId}: the agent parked but could not say what`,
      body: [
        `Repair ran out. The task is held until somebody looks.`,
        ...problems.slice(0, 5).map(problem => `- ${oneLine(problem.message, 120)}`),
        `The raw payload is preserved in run ${runId}'s evidence.`,
      ].join("\n"),
    },
    now,
  );
  return { ok: true as const, incidentId };
}

export type MalformedSeal = {
  runId: number;
  taskId: string;
  problems: readonly Problem[];
  now: Date;
};
export type MalformedFinalize = { ok: true; incidentId: number } | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/** How a failed attempt is classified, per gnhf. Decides retry, backoff, or stall. */
export type FailureClass =
  | "agent-reported"
  | "retryable-infra"
  | "no-op"
  /** Run 2085: stopped before its handoff; the work was kept and the retry resumes it. Strikes like no-op. */
  | "no-handoff"
  | "commit-failure"
  | "unknown";

/** 1m, 2m, 4m, 8m, 16m — doubling, capped. Indexed by strikes-1. */
const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000];
export const MAX_STRIKES = 3;

export type FailureDisposition =
  | { ok: true; disposition: "backoff"; strikes: number; until: string }
  | { ok: true; disposition: "stalled"; strikes: number; incidentId: number }
  | { ok: true; disposition: "commit-incident"; incidentId: number }
  | { ok: true; disposition: "auth-expired"; provider: string }
  | { ok: false; reason: "fenced" | "unknown" | "stopped" };

export type InterruptSeal =
  | { ok: true; stopRun: number; requeued: boolean; fenced: false }
  | { ok: true; stopRun: number; requeued: false; fenced: true };

/**
 * Seal an operator-stopped attempt (v52): ONE fenced transaction for the
 * claim's release as `interrupted`, the run's ending as `failed` /
 * `interrupted` (the same words dead-runner recovery writes, so the
 * recovered-draft road inherits the preserved work exactly as after a
 * crash), every open run the attempt owns, the task's return to the
 * queue under the stop's own hold, and the stop's settlement. Nothing
 * here is a failure: no strike, no backoff, no incident, no automatic
 * repair task, no notification page. A commit the attempt already made
 * is kept as a reviewable artifact — `committed` records that it exists.
 *
 * A lease the world moved past (reaped, recovered, superseded) still
 * ends the run as interrupted — that IS the honest ending — but touches
 * no task state: the task belongs to whoever holds it now.
 */
function sealInterrupted(store: Store, leaseId: string, args: InterruptedSeal): InterruptSeal {
  const { runId, taskId, stopRun, now } = args;
  const db = store.handle;
  const run = openAttempt(store, leaseId, runId, "an interruption");
  // A lease the world moved past still ends its run as interrupted — that IS the honest ending — touching no task state.
  const fenced = !releaseAs(store, leaseId, "interrupted", now);
  if (args.message !== undefined && args.message.trim() !== "") {
    store.recordOutcomeFacts(runId, { handoff: args.message });
  }
  // Owned descendants first (a repair turn, a correction) — the parent's
  // ending settles the stop, and every owned row ends in the same write.
  for (const owned of store.ownedRunsOf(runId)) {
    if (owned === runId) continue;
    const child = store.getRun(owned);
    if (child !== null && child.outcome === null) {
      store.finishRun(owned, { outcome: "failed", reason: "interrupted", now, stopSettlement: "interrupted" });
    }
  }
  store.finishRun(runId, {
    outcome: "failed",
    reason: "interrupted",
    ...(args.committed === undefined ? {} : { committed: args.committed }),
    now,
    stopSettlement: "interrupted",
  });
  store.settleRunStop(stopRun, "interrupted", now);
  if (fenced) return { ok: true as const, stopRun, requeued: false as const, fenced: true as const };
  // Back to the queue, where the stop's hold keeps it — a paused task
  // reads as queued-and-held, exactly like an operator pause.
  const requeued = db
    .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'")
    .run(now.toISOString(), taskId);
  store.bumpWake();
  return { ok: true as const, stopRun, requeued: Number(requeued.changes) > 0, fenced: false as const };
}

export type InterruptedSeal = { runId: number; taskId: string; stopRun: number; message?: string; committed?: boolean; now: Date };

/**
 * Hand an attempt back because the SERVICE stopped (its builder is
 * stopping or restarting), not because anyone stopped the task: one fenced
 * transaction releases the claim as `interrupted`, ends the run (and every
 * open run it owns) as `failed` / `interrupted` — the words dead-runner
 * recovery writes, so the next attempt inherits the preserved work in the
 * same checkout exactly as after a crash — and returns the task to the
 * queue with no strike, no backoff and no hold, so the next builder pass
 * resumes it. A lease the world moved past still ends the run, touching no
 * task state.
 */
function sealHandBack(store: Store, leaseId: string, args: HandBackSeal): HandBackFinalize {
  const { runId, taskId, now } = args;
  const db = store.handle;
  const run = openAttempt(store, leaseId, runId, "a hand-back");
  // A lease the world moved past still ends its run as interrupted — that IS the honest ending — touching no task state.
  const fenced = !releaseAs(store, leaseId, "interrupted", now);
  if (args.message.trim() !== "") store.recordOutcomeFacts(runId, { handoff: args.message });
  for (const owned of store.ownedRunsOf(runId)) {
    if (owned === runId) continue;
    const child = store.getRun(owned);
    if (child !== null && child.outcome === null) store.finishRun(owned, { outcome: "failed", reason: "interrupted", now });
  }
  store.finishRun(runId, { outcome: "failed", reason: "interrupted", now });
  if (fenced) return { ok: true as const, requeued: false, fenced: true };
  const requeued = db
    .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'")
    .run(now.toISOString(), taskId);
  store.bumpWake();
  return { ok: true as const, requeued: Number(requeued.changes) > 0, fenced: false };
}

export type HandBackSeal = { runId: number; taskId: string; message: string; now: Date };
export type HandBackFinalize = { ok: true; requeued: boolean; fenced: boolean };

/**
 * THE STOP FENCE at settlement (v52): when a stop applies to the run —
 * its own or an owning ancestor's — seal the attempt as interrupted and
 * answer with the seal; otherwise null, and the caller's own ending
 * proceeds. Every fenced finalizer asks this first, inside its own
 * transaction, so a stop that commits before terminal settlement wins
 * whatever the attempt was about to say.
 */
export function interruptIfStopped(
  store: Store,
  args: { leaseId: string; runId: number; taskId: string; message?: string; committed?: boolean; now: Date },
): InterruptSeal | null {
  const stop = store.applicableStopFor(args.runId);
  if (stop === null) return null;
  const run = store.getRun(args.runId);
  const where = run?.worktree ?? null;
  const { leaseId, ...rest } = args;
  return inTransaction(store, () => sealInterrupted(store, leaseId, {
    ...rest,
    stopRun: stop.run,
    message: args.message ?? `stopped by ${stop.requestedBy} (run #${stop.run}) — ${where === null ? "the attempt's evidence is on record" : `the work is preserved in ${where}`}`,
  }));
}

/**
 * Seal a failed attempt: one fenced transaction for the release, the run,
 * the strike, the hold, and the page (§6, gnhf adopted rather than
 * reinvented).
 *
 * Strikes count only top-level builder attempts; built, no-change, and
 * parked reset them elsewhere; refusals, fenced attempts, and repair
 * children never reach this function. Under three strikes the task
 * requeues behind a doubling backoff hold the failure owns; at three it
 * stalls — an 'attempts-exhausted' incident, the task marked failed, held,
 * and paged once — because a fourth identical attempt at 3am is a token
 * bonfire, not persistence. A commit-stage failure takes neither road: the
 * worktree holds unpreserved work, ordinary re-pooling would refuse it as
 * dirty forever, so it is an immediate incident naming the checkout.
 */
function sealFailure(store: Store, leaseId: string, args: FailureSeal): FailureDisposition {
  const { runId, taskId, failureClass, message, now } = args;
  const db = store.handle;

  const run = openAttempt(store, leaseId, runId, "a failure", "builder");
  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };

  const fenced = releaseOrRefuse(store, leaseId, "released", runId, now);
  if (fenced !== null) return fenced;

  // A sign-in that no longer works is not the attempt's fault: no strike,
  // no retry, the task back in the queue, and its provider paused.
  if (failureClass !== "commit-failure" && run.terminalClass === "auth-expired") {
    return { ok: true as const, ...sealAuthExpired(store, run, taskId, now) };
  }
  store.finishRun(runId, { outcome: "failed", reason: failureClass, now });

  if (failureClass === "commit-failure") {
    // The work exists and is uncommitted; nothing times its way out of
    // that. A person (or an explicit repair) proves the checkout.
    const incidentId = store.createIncident({ run: runId, kind: "commit-failure" }, now);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "incident",
        ownerId: String(incidentId),
        reason: `commit-failure — uncommitted work preserved in ${args.worktree}`,
        until: null,
      },
      now,
    );
    store.enqueueNotification(
      {
        source: { run: runId },
        dedupeKey: `commit-failure:${runId}`,
        kind: "commit-failure",
        pushClass: "attention",
        link: `/r/${runId}`,
        subject: `${taskId}: the commit itself failed`,
        body: `${oneLine(message, 200)}\nThe work is preserved, uncommitted, in ${args.worktree}. Prove it and \`toolroll task requeue ${taskId}\`.`,
      },
      now,
    );
    return { ok: true as const, disposition: "commit-incident" as const, incidentId };
  }

  const strikes = store.addStrike(run.taskRef);

  if (strikes >= MAX_STRIKES) {
    const incidentId = store.createIncident({ run: runId, kind: "attempts-exhausted" }, now);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "incident",
        ownerId: String(incidentId),
        reason: `attempts-exhausted — ${strikes} consecutive failures, last: ${failureClass}`,
        until: null,
      },
      now,
    );
    db.prepare("UPDATE task SET state = 'failed', updated_at = ? WHERE id = ?").run(
      now.toISOString(),
      taskId,
    );
    store.enqueueNotification(
      {
        source: { run: runId },
        dedupeKey: `stalled:${run.taskRef}`,
        kind: "attempts-exhausted",
        pushClass: "attention",
        link: `/r/${runId}`,
        subject: `${taskId} stalled after ${strikes} straight failures`,
        body: `Last failure (${failureClass}): ${oneLine(message, 200)}\nIt will not be retried. Read the runs, then \`toolroll task requeue ${taskId}\`.`,
      },
      now,
    );
    return { ok: true as const, disposition: "stalled" as const, strikes, incidentId };
  }

  // Under the limit: requeue behind a doubling pause the failure owns.
  // Replacing the previous backoff hold is correct — this attempt's strike
  // already reflects the whole streak.
  const wait = BACKOFF_MS[Math.min(strikes, BACKOFF_MS.length) - 1] as number;
  const until = new Date(now.getTime() + wait);
  store.holdOwned(
    {
      taskRef: run.taskRef,
      ownerKind: "backoff",
      ownerId: String(run.taskRef),
      // Run 2085: this failure is named in plain words wherever the hold shows.
      reason: failureClass === "no-handoff"
        ? `The agent stopped before handing off; its work was kept and it is being resumed (retry ${strikes}/${MAX_STRIKES} in ${Math.round(wait / 60_000)}m)`
        : `retry ${strikes}/${MAX_STRIKES} after ${failureClass} — backing off ${Math.round(wait / 60_000)}m`,
      until,
    },
    now,
  );
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `run:${runId}:failed`,
      kind: "build-failed",
      subject: failureClass === "no-handoff"
        ? `${taskId}: the agent stopped before handing off; its work was kept, retry ${strikes}/${MAX_STRIKES}`
        : `${taskId}: attempt failed (${failureClass}), retry ${strikes}/${MAX_STRIKES}`,
      body: `${oneLine(message, 200)}\nNext attempt no earlier than ${until.toISOString()}.`,
    },
    now,
  );
  return { ok: true as const, disposition: "backoff" as const, strikes, until: until.toISOString() };
}

export type FailureSeal = {
  runId: number;
  taskId: string;
  failureClass: FailureClass;
  message: string;
  worktree: string;
  now: Date;
};

/**
 * The auth-expired ending, inside the caller's fenced transaction (claim
 * already released): the run fails as `auth-expired`, the task goes back to
 * the queue with no strike and no backoff, and dispatch for the run's
 * provider pauses — the first such run of an incident tells a person once.
 */
function sealAuthExpired(store: Store, run: Run, taskId: string, now: Date): { disposition: "auth-expired"; provider: string } {
  store.finishRun(run.id, { outcome: "failed", reason: "auth-expired", now });
  store.handle.prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'").run(now.toISOString(), taskId);
  pauseForAuth(store, { provider: run.provider, authMode: run.authMode ?? null, runId: run.id, taskRef: run.taskRef, now });
  store.bumpWake();
  return { disposition: "auth-expired", provider: run.provider };
}

/** Untrusted text on its way into a subject line: one line, bounded. */
function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

/** The live claim on a task, if there is one. */
export const MAX_PLAN_STRIKES = 3;

/** Backoff for planner retries: shorter than the builder's — a planner that
 * cannot start is usually a transient, and nothing downstream is waiting on
 * a workspace. */
const PLAN_BACKOFF_MS = [60_000, 2 * 60_000, 4 * 60_000] as const;

export type PlanFinalize =
  | { ok: true; changes: number; amendment: string | null }
  | { ok: false; reason: "fenced" | "unknown" | "stopped" }
  /** The filed request moved while the planner ran (contract handoff,
   * task 1): the draft was planned against terms that no longer exist,
   * so nothing of it is ingested — the newer source stands, the claim
   * releases, and the task stays requested for a fresh attempt. */
  | { ok: false; reason: "stale-source" | "source-invalid"; detail: string };

/**
 * Seal a successful planning run: the proposed scope, the plan document
 * artifact, the drafted state, the run outcome, and the page to the
 * operator exist together or — if the lease was superseded — not at all.
 * The scope proposal is authority-bearing (it is what the approve card
 * will restate), which is why this is the park discipline, not the DONE
 * one (Codex planning review, question 2).
 */
function sealPlan(store: Store, leaseId: string, args: PlanSeal): PlanFinalize {
  const { runId, taskId, plan, now } = args;
  const db = store.handle;
  // The ingestion record (contract handoff, task 1) is composed here from
  // the filed terms and the drafted plan; its file and row land inside the
  // transaction below, only after the stale-source check admits the draft.
  const filed = args.source?.contract.scope ?? null;
  const contractChanges = filed === null ? [] : contractChangesOf(filed, plan);
  // A hand-built plan (the pre-source road) carries no amendment field.
  const amendment = plan.amendment ?? null;
  const record: PlanContractRecord | null =
    args.source === undefined
      ? null
      : {
          version: 1,
          sourceDigest: args.source.sourceDigest,
          sourceArtifact: args.sourceArtifact ?? null,
          filed: filed === null ? null : { goal: filed.goal, outOfScope: filed.outOfScope, touches: filed.touches, acceptance: filed.acceptance },
          proposed: { goal: plan.goal, outOfScope: plan.outOfScope, touches: plan.touches, acceptance: plan.acceptance },
          amendment,
          changes: contractChanges,
        };
  const run = openAttempt(store, leaseId, runId, "a plan", "planner");
  const repairRun = plannerRepairChild(store, run, args.repairRunId ?? null);
  if (store.lookupRef(taskId)?.id !== run.taskRef) throw new Error("a planner can finalize only its own task");
  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };
  const invalidSource = (detail: string, kind: "malformed" | "failure" = "malformed"): PlanFinalize => {
    const failed = sealPlanFailure(store, leaseId, { runId, taskId, failure: kind, message: detail, now });
    if (repairRun !== null) store.finishRun(repairRun.id, { outcome: "refused", reason: failed.ok ? "source-invalid" : "fenced", now });
    return failed.ok ? { ok: false, reason: "source-invalid", detail } : failed;
  };
  const sources = store.artifactsFor(runId).filter(one => one.kind === "plan-contract" && one.key.endsWith("/planner-source.json"));
  // Legacy rows have no input stamp or artifact. Every current dispatch
  // stamps even an empty scope; dropping a caller argument cannot bypass custody.
  if (args.source !== undefined || sources.length > 0 || run.scopeDigest !== null) {
    if (args.source === undefined || args.evidenceRoot === undefined || sources.length !== 1 || sources[0]!.id !== args.sourceArtifact) {
      return invalidSource("the planner's admitted source inventory is missing, ambiguous, or was not presented");
    }
    const artifact = sources[0]!;
    let verified: ReturnType<typeof readVerifiedArtifact>;
    try { verified = readVerifiedArtifact(args.evidenceRoot, artifact); }
    catch { return invalidSource("the planner source file cannot be read"); }
    if (!verified.ok || artifact.truncated) return invalidSource("the planner source bytes no longer verify");
    const recorded = decodePlannerSource(verified.content);
    if (recorded === null || recorded.taskId !== taskId || !verified.content.equals(encodePlannerSource(args.source)) || run.scopeDigest !== (recorded.contract.scope?.digest ?? "")) {
      return invalidSource("the supplied planning source is not the source recorded for this run");
    }
    if (contractChanges.length > 0 && (typeof amendment !== "string" || !amendment.trim() || amendment.length > PLANNER_SOURCE_LIMITS.amendment)) {
      return invalidSource("a planner changed the filed contract without a bounded, explicit amendment");
    }
  }

  // THE SOURCE RECHECK (contract handoff, task 1): the filed request is
  // re-derived from durable state inside this very transaction and must
  // still be the one the planner read. A scope rewritten, approved, or
  // re-termed while the planner ran is the NEWER source; an old draft
  // never overwrites it. The attempt ends refused in words — no strike,
  // the planner did nothing wrong — and the task stays requested. The
  // claim releases under the same fence the ingestion would have used.
  if (args.source !== undefined) {
    const current = plannerContractOf(store, taskId);
    const currentDigest = current.ok ? plannerSourceDigest(current.contract) : null;
    const currentAnswers = store.answeredDecisionsFor(taskId, PLANNER_SOURCE_LIMITS.answers + 1).map(one => ({ question: one.question, choice: one.choice ?? "", note: one.note }));
    if (currentDigest !== args.source.sourceDigest || canonicalContractJson(currentAnswers) !== canonicalContractJson(args.source.answers)) {
      const detail = current.ok
        ? describeSourceDrift(args.source, current.contract)
        : `the filed request can no longer be read: ${current.message}`;
      const fenced = releaseOrRefuse(store, leaseId, "released", runId, now, repairRun);
      if (fenced !== null) return fenced;
      if (repairRun !== null) store.finishRun(repairRun.id, { outcome: "refused", reason: "stale-source", now });
      store.finishRun(runId, { outcome: "refused", reason: "stale-source", now });
      store.enqueueNotification(
        {
          source: { run: runId },
          dedupeKey: `plan-stale-source:${run.taskRef}:${runId}`,
          kind: "plan-stale-source",
          link: `/t/${encodeURIComponent(taskId)}`,
          subject: `${taskId}: the filed request changed while the planner ran`,
          body: `${oneLine(detail, 300)}\nNothing from that draft was ingested; the current terms stand and the next pass plans against them.`,
        },
        now,
      );
      return { ok: false as const, reason: "stale-source" as const, detail };
    }
  }

  if (record !== null && args.evidenceRoot !== undefined) {
    const recordBytes = encodePlanContractRecord(record);
    if (recordBytes.length > EVIDENCE_CAPS["plan-contract"]) return invalidSource("the required plan amendment record exceeds its explicit evidence cap");
    try {
      const recordId = storeEvidence(
        store,
        args.evidenceRoot,
        runId,
        "plan-contract",
        "plan-contract.json",
        recordBytes,
        record.changes.length === 0
          ? "plan ingestion: filed contract reproduced exactly (verified tree)"
          : `plan ingestion: ${record.changes.length} contract change(s), amendment ${record.amendment === null ? "absent" : "stated"} (verified tree)`,
        now,
        { captureStatus: "ok" },
      );
      const captured = store.getArtifact(recordId);
      if (captured === null || captured.truncated || !readVerifiedArtifact(args.evidenceRoot, captured).ok) {
        return invalidSource("the required plan contract record did not seal completely", "failure");
      }
    } catch {
      return invalidSource("the required plan contract record could not be saved", "failure");
    }
  }

  const fenced = releaseOrRefuse(store, leaseId, "completed", runId, now, repairRun);
  if (fenced !== null) return fenced;

  store.saveScope({
    taskId,
    goal: plan.goal,
    outOfScope: plan.outOfScope,
    touches: plan.touches,
    acceptance: plan.acceptance,
    proposedAt: now.toISOString(),
    digest: digestOf({ goal: plan.goal, outOfScope: plan.outOfScope, touches: plan.touches, acceptance: plan.acceptance }),
    budgetMicrousd: filed?.terms.budgetMicrousd ?? null,
    approvedAt: null,
    approvedBy: null,
    approvedDigest: null,
  }, {}, filed === null ? {} : {
    proposedVia: filed.proposedVia,
    qualityMode: filed.terms.qualityMode,
    ...(filed.terms.profile == null ? {} : { profile: filed.terms.profile }),
    ...(filed.terms.profile != null && routeFromJson(filed.terms.routeJson) !== null &&
      canonicalContractJson([...new Set(filed.acceptance.flatMap(one => one.evidence))].sort()) === canonicalContractJson([...new Set(plan.acceptance.flatMap(one => one.evidence))].sort())
      ? { route: routeFromJson(filed.terms.routeJson)! } : {}),
  });
  let verifiedPlan = false;
  if (args.artifact !== null) {
    const artifactId = store.saveArtifact({ run: runId, kind: "plan", ...args.artifact }, now);
    if (args.evidenceRoot !== undefined && !args.artifact.truncated) {
      try {
        const captured = store.getArtifact(artifactId);
        const verified = captured === null ? null : readVerifiedArtifact(args.evidenceRoot, captured);
        verifiedPlan = verified?.ok === true && verified.content.equals(Buffer.from(plan.plan, "utf8")) && parseExecutionPlanDocument(plan.plan).ok;
      } catch { verifiedPlan = false; }
    }
  }
  store.setPlanState(run.taskRef, "drafted");
  const autoApproved = sealUnchangedPlanUnderMode(store, taskId, args.source?.sourceDigest ?? "", runId,
    args.source !== undefined && filed !== null && contractChanges.length === 0 && amendment === null && verifiedPlan, now);
  store.resetPlanStrikes(run.taskRef);
  store.finishRun(runId, { outcome: "built", reason: "plan-drafted", now });
  if (repairRun !== null) {
    store.finishRun(repairRun.id, { outcome: "no-change", reason: "structured planner output repaired", now });
  }
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `plan:${run.taskRef}:${runId}`,
      kind: "plan-ready",
      subject: autoApproved ? `${taskId}: unchanged plan auto-approved` : `${taskId}: plan ready for review${contractChanges.length === 0 ? "" : ` — ${contractChanges.length} contract change${contractChanges.length === 1 ? "" : "s"} to check`}`,
      body:
        `The planner proposes: ${oneLine(plan.goal, 200)}\n` +
        (contractChanges.length === 0
          ? filed === null
            ? ""
            : "The filed goal, exclusions, touches, and acceptance criteria are reproduced exactly.\n"
          : `It AMENDS the filed contract (${oneLine(describeContractChanges(contractChanges).join("; "), 300)})${amendment === null ? "" : ` — because: ${oneLine(amendment, 200)}`}\n`) +
        (autoApproved ? "Approved under the signed operating mode. The next build may proceed with the original terms and required quality checks." : "Review, edit, and approve the scope — nothing builds until you do."),
    },
    now,
  );
  return { ok: true as const, changes: contractChanges.length, amendment };
}

export type PlanSeal = {
  runId: number;
  taskId: string;
  plan: ParsedPlan;
  /** The already-captured plan document file, described; null when the
   * capture itself failed (the plan still lands as scope + handoff). */
  artifact: {
    key: string;
    bytesOriginal: number;
    bytesStored: number;
    truncated: boolean;
    sha256: string;
    capture: string;
  } | null;
  /** Open planner correction that authored the accepted payload. */
  repairRunId?: number | null;
  /** The filed request this attempt planned for, and the recorded
   * evidence of it (contract handoff, task 1). The source identity is
   * re-derived from the store INSIDE this transaction and compared:
   * a concurrent scope, authority, or term change refuses the draft
   * atomically rather than letting an old plan overwrite the newer
   * source. Optional only for the pre-source road (tests that seal a
   * hand-built plan); every dispatch presents one. */
  source?: PlannerSource;
  sourceArtifact?: number | null;
  /** Where the plan-contract ingestion record is written. */
  evidenceRoot?: string;
  now: Date;
};

/** Which part of the filed request moved, in words — for the refusal,
 * the page, and the notification. */
function describeSourceDrift(source: PlannerSource, current: PlannerSource["contract"]): string {
  const was = source.contract;
  const parts: string[] = [];
  if ((was.scope?.digest ?? null) !== (current.scope?.digest ?? null)) {
    parts.push(
      was.scope === null
        ? "a scope was filed after planning started"
        : current.scope === null
          ? "the filed scope was removed"
          : "the filed scope was rewritten",
    );
  } else if (was.scope !== null && current.scope !== null && was.scope.approval.approvedDigest !== current.scope.approval.approvedDigest) {
    parts.push("the scope's approval changed");
  } else if (was.scope !== null && current.scope !== null && JSON.stringify(was.scope.terms) !== JSON.stringify(current.scope.terms)) {
    parts.push("the scope's execution terms changed");
  }
  if (JSON.stringify(was.task) !== JSON.stringify(current.task)) parts.push("the task's terms changed");
  if (JSON.stringify(was.revision) !== JSON.stringify(current.revision)) parts.push("the revision brief changed");
  return `the filed request changed while the planner ran: ${parts.length === 0 ? "its source identity moved" : parts.join("; ")} (planned against ${source.sourceDigest.slice(0, 12)})`;
}

export type RevisionFinalize =
  | { ok: true; revisionId: number; authorityKind: "plan-only" | "authority-change" }
  | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/**
 * Seal a running build's plan-revision proposal (adaptive execution plans).
 *
 * A builder that finds repository evidence invalidating a named dependency,
 * risk, or assumption in the plan it was given files ONE proposal and stops
 * without committing — the park discipline, applied to the road rather than
 * to a question. The ledger row, the hold when one is owed, the run's
 * outcome, and the page exist together or, if the lease was superseded,
 * not at all. Structurally the plan ending's twin: the same
 * open-attempt assertion, the same fenced release, the same all-or-nothing
 * transaction.
 *
 * Two dispositions, decided by the caller's classification and recorded
 * here:
 *
 *   plan-only        the signed scope and publication authority are
 *                    byte-identical to what this build started under, so
 *                    nothing authority-bearing moved and the revision is
 *                    APPLIED. The claim releases plainly, the task returns
 *                    to the ready set, and the next attempt reads the new
 *                    plan — that is the "resume" the subject line promises.
 *
 *   authority-change something else moved the signed scope or the
 *                    publication authority WHILE this build ran. Whatever
 *                    the revision proposes, it is never auto-applied: the
 *                    row lands 'blocked', a `revision` hold keeps the task
 *                    out of every ready set until a person accepts or
 *                    rejects it, and the page names exactly which fields
 *                    changed.
 *
 * The lease is released either way — the attempt is over — and the run is
 * finished as `refused`, reusing the existing outcome vocabulary rather
 * than growing it: no work was committed, and nothing failed.
 */
function sealRevision(store: Store, leaseId: string, args: RevisionSeal): RevisionFinalize {
  const { runId, taskId, taskRef, revision, now } = args;
  const run = openAttempt(store, leaseId, runId, "a plan revision", "builder");
  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };
  const fenced = releaseOrRefuse(store, leaseId, "released", runId, now);
  if (fenced !== null) return fenced;

  const applied = revision.authorityKind === "plan-only";
  const revisionId = store.insertPlanRevision(
    { taskRef, ...revision, kind: "builder-proposal", status: applied ? "applied" : "blocked" },
    now,
  );
  const moved = revision.changedFields
    .map(field => (field === "signed-scope" ? "the signed scope" : "publication authority"))
    .join(" and ");
  if (!applied) {
    store.holdOwned(
      {
        taskRef,
        ownerKind: "revision",
        ownerId: String(revisionId),
        reason: `plan-revision-blocked — ${moved} changed while this build ran, so revision ${revision.revision} waits for a person`,
        until: null,
      },
      now,
    );
  }
  store.finishRun(runId, { outcome: "refused", reason: applied ? "plan-revised" : "plan-revision-blocked", now });
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `plan-revision:${taskRef}:${revisionId}`,
      kind: applied ? "plan-revised" : "plan-revision-blocked",
      ...(applied ? {} : { pushClass: "attention" as const }),
      link: `/t/${encodeURIComponent(taskId)}`,
      subject: `${taskId}: plan revision ${revision.revision} ${applied ? "applied — resuming" : "awaiting your approval"}`,
      body: applied
        ? `The build found the plan wrong and rewrote it: ${oneLine(revision.reason, 200)}\nEvidence: ${oneLine(revision.evidenceLink ?? "none given", 200)}\nNothing was committed. The next attempt builds against the new plan.`
        : `The build proposed a new plan, but ${moved} changed while it ran — so nothing was applied: ${oneLine(revision.reason, 200)}\nEvidence: ${oneLine(revision.evidenceLink ?? "none given", 200)}\nNothing runs on this task until you accept or reject the revision.`,
    },
    now,
  );
  return { ok: true as const, revisionId, authorityKind: revision.authorityKind };
}

export type RevisionSeal = {
  runId: number;
  taskId: string;
  taskRef: number;
  /** Every content column of the row about to be appended. `status` is
   * NOT the caller's to set: it follows from `authorityKind`, decided in
   * exactly one place — here — so a caller can never file an
   * authority-changing revision as already applied. */
  revision: {
    revision: number;
    artifact: number;
    parentHash: string | null;
    reason: string;
    evidenceLink: string | null;
    author: string;
    originRun: number | null;
    authorityKind: "plan-only" | "authority-change";
    authorityDigest: string;
    changedFields: readonly AuthorityChangeField[];
  };
  now: Date;
};

export type PlanFailureDisposition =
  | { ok: true; disposition: "malformed-incident"; incidentId: number }
  | { ok: true; disposition: "backoff"; strikes: number }
  | { ok: true; disposition: "exhausted"; incidentId: number; strikes: number }
  | { ok: true; disposition: "auth-expired"; provider: string }
  | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/**
 * The planner's own fenced failure finalizer (Codex planning review,
 * finding 6): releases exactly the planner claim, finishes the run,
 * counts a SEPARATE planning strike — a planner that cannot finish must
 * never spend the builder's three attempts — and eventually leaves a
 * durable incident + hold + page. It never marks the task done, never
 * touches builder strikes, never commits, never publishes.
 *
 * A malformed payload goes straight to its incident with no strike: the
 * protocol failed, not the weather, and retrying the same session buys
 * nothing without the repair machinery (deliberately not wired for
 * planners in v1).
 */
function sealPlanFailure(store: Store, leaseId: string, args: PlanFailureSeal): PlanFailureDisposition {
  const { runId, taskId, failure: kind, message, now } = args;
  const db = store.handle;
  const run = openAttempt(store, leaseId, runId, "a failure", "planner");
  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };
  const fenced = releaseOrRefuse(store, leaseId, "released", runId, now);
  if (fenced !== null) return fenced;
  if (kind === "failure" && run.terminalClass === "auth-expired") return { ok: true as const, ...sealAuthExpired(store, run, taskId, now) };
  const malformedKind = args.malformed === "decision" ? "malformed-decision" : "malformed-plan";
  store.finishRun(runId, { outcome: "failed", reason: kind === "malformed" ? malformedKind : oneLine(message, 120), now });

  if (kind === "malformed") {
    const incidentId = store.createIncident({ run: runId, kind: malformedKind }, now);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "incident",
        ownerId: String(incidentId),
        reason: `${malformedKind} — the planner's ${args.malformed === "decision" ? "question" : "plan"} failed validation`,
        until: null,
      },
      now,
    );
    store.enqueueNotification(
      {
        source: { run: runId },
        dedupeKey: `${malformedKind}:${runId}`,
        kind: malformedKind,
        pushClass: "attention",
        link: `/r/${runId}`,
        subject: `${taskId}: the planner's ${args.malformed === "decision" ? "question" : "plan"} failed validation`,
        body: `${oneLine(message, 300)}\nResolve the incident to let planning retry.`,
      },
      now,
    );
    return { ok: true as const, disposition: "malformed-incident" as const, incidentId };
  }

  const strikes = store.addPlanStrike(run.taskRef);
  if (strikes >= MAX_PLAN_STRIKES) {
    const incidentId = store.createIncident({ run: runId, kind: "plan-attempts-exhausted" }, now);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "incident",
        ownerId: String(incidentId),
        reason: `plan-attempts-exhausted — ${strikes} straight planning failures`,
        until: null,
      },
      now,
    );
    store.enqueueNotification(
      {
        source: { run: runId },
        dedupeKey: `plan-stalled:${run.taskRef}`,
        kind: "plan-attempts-exhausted",
        pushClass: "attention",
        link: `/r/${runId}`,
        subject: `${taskId}: planning stalled after ${strikes} straight failures`,
        body: `Last failure: ${oneLine(message, 200)}\nResolve the incident to let planning retry, or write the scope yourself.`,
      },
      now,
    );
    return { ok: true as const, disposition: "exhausted" as const, incidentId, strikes };
  }

  const wait = PLAN_BACKOFF_MS[Math.min(strikes, PLAN_BACKOFF_MS.length) - 1] as number;
  const until = new Date(now.getTime() + wait);
  store.holdOwned(
    {
      taskRef: run.taskRef,
      // Its own owner id: a planning pause must never displace the
      // builder's backoff for the same task, or vice versa.
      ownerKind: "backoff",
      ownerId: `plan:${run.taskRef}`,
      reason: `plan retry ${strikes}/${MAX_PLAN_STRIKES} — backing off ${Math.round(wait / 60_000)}m`,
      until,
    },
    now,
  );
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `plan-run:${runId}:failed`,
      kind: "plan-failed",
      subject: `${taskId}: planning attempt failed, retry ${strikes}/${MAX_PLAN_STRIKES}`,
      body: `${oneLine(message, 200)}\nNext attempt no earlier than ${until.toISOString()}.`,
    },
    now,
  );
  return { ok: true as const, disposition: "backoff" as const, strikes };
}

export type PlanFailureSeal = {
  runId: number;
  taskId: string;
  failure: "malformed" | "failure";
  /** Which payload was malformed (v4 review, finding 12): the mailbox is a `malformed-decision`. */
  malformed?: "decision" | "plan";
  message: string;
  now: Date;
};

export type ScoutFinalize = { ok: true } | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/**
 * Seal a successful scouting run (mate arc §10): the report artifact, the
 * run outcome, the task's terminal state, and the page to the operator
 * exist together or — if the lease was superseded — not at all. Nothing
 * here touches a branch, a publication, or a scope: the deliverable is
 * the artifact, and the task is done the moment it verifies.
 */
function sealScout(store: Store, leaseId: string, args: ScoutSeal): ScoutFinalize {
  const { runId, taskId, report, now } = args;
  const db = store.handle;
  const run = openAttempt(store, leaseId, runId, "a report", "scout");
  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };
  const fenced = releaseOrRefuse(store, leaseId, "completed", runId, now);
  if (fenced !== null) return fenced;
  store.saveArtifact({ run: runId, kind: "report", ...args.artifact }, now);
  store.resetStrikes(run.taskRef);
  store.finishRun(runId, { outcome: "built", reason: "report-delivered", now });
  const done = store.setTaskState(taskId, "done", now);
  if (!done.ok) {
    // A mirror the tracker closed meanwhile: the report stands as evidence
    // on the run; the task keeps the tracker's word for its state.
    store.finishRun(runId, { outcome: "built", reason: `report-delivered (task ${done.reason})`, now });
  }
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `report:${run.taskRef}:${runId}`,
      kind: "report-ready",
      subject: `${taskId}: report ready — ${oneLine(report.title, 120)}`,
      body: `${oneLine(report.summary, 300)}\nRead it on the task page${report.followUps.length > 0 ? `; ${report.followUps.length} follow-up(s) file with a tap` : ""}.`,
    },
    now,
  );
  return { ok: true as const };
}

export type ScoutSeal = {
  runId: number;
  taskId: string;
  report: ParsedReport;
  /** The already-captured report file, described. Required: a report
   * that was not captured is a FAILED attempt, never a finished task
   * (v4 review, finding 1). */
  artifact: {
    key: string;
    bytesOriginal: number;
    bytesStored: number;
    truncated: boolean;
    sha256: string;
    capture: string;
    redacted: boolean;
  };
  now: Date;
};

export type ScoutFailureDisposition =
  | { ok: true; disposition: "malformed-incident"; incidentId: number }
  | { ok: true; disposition: "backoff"; strikes: number }
  | { ok: true; disposition: "stalled"; incidentId: number; strikes: number }
  | { ok: true; disposition: "auth-expired"; provider: string }
  | { ok: false; reason: "fenced" | "unknown" | "stopped" };

/**
 * The scout's fenced failure finalizer: the BUILDER's discipline, not the
 * planner's — a scout task has no builder attempts, so its strikes are the
 * task's own (three stall it, `task requeue` clears them), and a malformed
 * report is a straight incident with no strike. Never a branch, never a
 * repair session, never a commit.
 */
function sealScoutFailure(store: Store, leaseId: string, args: ScoutFailureSeal): ScoutFailureDisposition {
  const { runId, taskId, failure: kind, message, now } = args;
  const db = store.handle;
  const run = openAttempt(store, leaseId, runId, "a failure", "scout");
  const stopped = interruptIfStopped(store, { leaseId, runId, taskId, now });
  if (stopped !== null) return { ok: false as const, reason: "stopped" as const };
  const fenced = releaseOrRefuse(store, leaseId, "released", runId, now);
  if (fenced !== null) return fenced;
  if (kind === "failure" && run.terminalClass === "auth-expired") return { ok: true as const, ...sealAuthExpired(store, run, taskId, now) };
  const malformedKind = args.malformed === "decision" ? "malformed-decision" : "malformed-report";
  store.finishRun(runId, { outcome: "failed", reason: kind === "malformed" ? malformedKind : oneLine(message, 120), now });

  if (kind === "malformed") {
    const incidentId = store.createIncident({ run: runId, kind: malformedKind }, now);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "incident",
        ownerId: String(incidentId),
        reason: `${malformedKind} — the scout's ${args.malformed === "decision" ? "question" : "report"} failed validation`,
        until: null,
      },
      now,
    );
    store.enqueueNotification(
      {
        source: { run: runId },
        dedupeKey: `${malformedKind}:${runId}`,
        kind: malformedKind,
        pushClass: "attention",
        link: `/r/${runId}`,
        subject: `${taskId}: the scout's ${args.malformed === "decision" ? "question" : "report"} failed validation`,
        body: `${oneLine(message, 300)}\nResolve the incident to let scouting retry.`,
      },
      now,
    );
    return { ok: true as const, disposition: "malformed-incident" as const, incidentId };
  }

  const strikes = store.addStrike(run.taskRef);
  if (strikes >= MAX_STRIKES) {
    const incidentId = store.createIncident({ run: runId, kind: "attempts-exhausted" }, now);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "incident",
        ownerId: String(incidentId),
        reason: `attempts-exhausted — ${strikes} consecutive scouting failures`,
        until: null,
      },
      now,
    );
    db.prepare("UPDATE task SET state = 'failed', updated_at = ? WHERE id = ?").run(now.toISOString(), taskId);
    store.enqueueNotification(
      {
        source: { run: runId },
        dedupeKey: `stalled:${run.taskRef}`,
        kind: "attempts-exhausted",
        pushClass: "attention",
        link: `/r/${runId}`,
        subject: `${taskId} stalled after ${strikes} straight scouting failures`,
        body: `Last failure: ${oneLine(message, 200)}\nIt will not be retried. Read the runs, then \`toolroll task requeue ${taskId}\`.`,
      },
      now,
    );
    return { ok: true as const, disposition: "stalled" as const, incidentId, strikes };
  }

  const wait = BACKOFF_MS[Math.min(strikes, BACKOFF_MS.length) - 1] as number;
  const until = new Date(now.getTime() + wait);
  store.holdOwned(
    {
      taskRef: run.taskRef,
      ownerKind: "backoff",
      ownerId: String(run.taskRef),
      reason: `scout retry ${strikes}/${MAX_STRIKES} — backing off ${Math.round(wait / 60_000)}m`,
      until,
    },
    now,
  );
  store.enqueueNotification(
    {
      source: { run: runId },
      dedupeKey: `run:${runId}:failed`,
      kind: "scout-failed",
      subject: `${taskId}: scouting attempt failed, retry ${strikes}/${MAX_STRIKES}`,
      body: `${oneLine(message, 200)}\nNext attempt no earlier than ${until.toISOString()}.`,
    },
    now,
  );
  return { ok: true as const, disposition: "backoff" as const, strikes };
}

export type ScoutFailureSeal = {
  runId: number;
  taskId: string;
  failure: "malformed" | "failure";
  /** Which payload was malformed (v4 review, finding 12): the park
   * mailbox is a `malformed-decision` incident, the handoff a
   * `malformed-report` one — the taxonomy says what actually broke. */
  malformed?: "decision" | "report";
  message: string;
  now: Date;
};

export function currentClaim(store: Store, taskRef: number, now: Date): Claim | null {
  const row = latest(store.handle, taskRef);
  if (row === undefined || !isLive(row, now.toISOString())) return null;
  return readClaim(row);
}

/**
 * Release every lease that has run out.
 *
 * Expiry alone already frees a task for acquisition, so this is not what makes
 * reclaim work — it is what makes it *visible*. A daemon reaping on a tick
 * turns "this lease is being ignored because its timestamp is in the past" into
 * a released row somebody can read, which is the difference between a system
 * that recovers and a system that appears to have lost the work.
 */
export function reap(store: Store, now: Date): Claim[] {
  const stamp = now.toISOString();
  const db = store.handle;

  // One transaction, so the list returned is exactly the list released — a
  // lease expiring between the read and the write belongs to the next reap.
  return inTransaction(store, () => {
    const expired = db
      .prepare("SELECT * FROM claim WHERE released_at IS NULL AND expires_at <= ?")
      .all(stamp);
    if (expired.length === 0) return [];

    db.prepare(
      "UPDATE claim SET released_at = ?, released_by = 'reaped' WHERE released_at IS NULL AND expires_at <= ?",
    ).run(stamp, stamp);
    return expired.map(readClaim);
  });
}

function isLive(row: Record<string, unknown>, stamp: string): boolean {
  return row["released_at"] === null && String(row["expires_at"]) > stamp;
}

function readClaim(row: Record<string, unknown>): Claim {
  return {
    taskRef: Number(row["task_ref"]),
    leaseId: String(row["lease_id"]),
    generation: Number(row["lease_generation"]),
    runner: String(row["runner"]),
    acquiredAt: String(row["acquired_at"]),
    expiresAt: String(row["expires_at"]),
    heartbeatAt: String(row["heartbeat_at"]),
  };
}

/**
 * IMMEDIATE rather than DEFERRED: the write lock is taken up front, so two
 * processes racing for the same task queue behind one another instead of both
 * reading, both deciding they won, and one failing at commit time.
 */
function inTransaction<T>(store: Store, body: () => T): T {
  // The store's transact: same BEGIN IMMEDIATE, plus reentrancy — a caller
  // composing a fenced finalizer with more writes (completion + publication
  // intent) joins one transaction instead of dying on a nested BEGIN.
  return store.transact(body);
}
