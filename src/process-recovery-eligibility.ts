/** Read-only eligibility, NEVER process-exit evidence or permission to clear a
 * witness. This narrow classifier relies on the installed native builder path:
 * its prepared-candidate handoff is machine-authored, and its actual v1 gate
 * receipt is sealed only after awaited witnessedRunner returned and finished
 * every direct beforeSpawn reservation. The caller must separately authenticate
 * that execution provenance, the current host/boot, and a complete OS census.
 * In particular, an eligible null PID can still hide an escaped descendant. */
import { createHash } from "node:crypto";
import { normalizeBootId } from "./boot-identity.js";
import { scopeApprovedForDispatch } from "./dispatch.js";
import { parseHandoffArtifact } from "./contracts/handoff.js";
import { readVerificationReceipt } from "./contracts/verification-receipt.js";
import { readVerifiedArtifact } from "./evidence.js";
import { ownedProcessCount, runOwnerTag } from "./exec.js";
import { scopeAuthorityOf } from "./scope.js";
import type { Artifact, Store } from "./store.js";
import { isVerificationReceipt, VERIFICATION_RECEIPT_CAPTURE, verificationEvidence } from "./verification-evidence.js";

export type RecoveryWitnessSnapshot = Readonly<{
  id: number; run: number; pid: number | null; host: string; process_group: number;
  observed_at: string; exited_at: string | null; boot_id: string | null;
  containment: string | null; container: string | null; container_identity: string | null; container_empty_at: string | null;
}>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const commit = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const artifactBinding = (a: Artifact) => ({ id: a.id, run: a.run, kind: a.kind, key: a.key, sha256: a.sha256,
  bytesOriginal: a.bytesOriginal, bytesStored: a.bytesStored, truncated: a.truncated, redacted: a.redacted,
  capture: a.capture, captureStatus: a.captureStatus, createdAt: a.createdAt });
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as Frozen<T>;
}

// A successful digest is only a saved-state prerequisite. Settlement must separately
// prove provenance and absence, then recheck this same binding inside its transaction.
export function preparedCandidateObserverGapEligibility(store: Store, input: {
  runId: number; evidenceRoot: string; now: Date;
  /** Authenticated current kernel context supplied by the caller, not a row's
   * own host/boot copied back to it. Unknown identity refuses. */
  host: string; bootId: string | null;
}) {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  try {
    // SAVEPOINT supplies a consistent read snapshot, including when a caller
    // already has a transaction. No Store mutator or process probe runs here.
    return store.savepoint(() => {
      const { runId, evidenceRoot, now, host, bootId } = input;
      if (!positive(runId) || !Number.isFinite(now.getTime()) || !host || /[\x00-\x1f\x7f]/.test(host) ||
          bootId === null || normalizeBootId(bootId) !== bootId) return refuse("current-host-boot-unavailable");
      const run = store.getRun(runId);
      if (!run || run.role !== "builder" || (run.outcome !== "built" && run.outcome !== "no-change") ||
          !instant(run.startedAt) || !instant(run.finishedAt) || Date.parse(run.finishedAt) < Date.parse(run.startedAt) ||
          Date.parse(run.finishedAt) > now.getTime()) return refuse("not-terminal-prepared-builder");
      if (run.providerStartedAt !== null || run.sessionId !== null ||
          !commit(run.baseRevision) || !commit(run.headRevision) || !run.branch || !run.worktree) return refuse("provider-or-run-identity-unproven");
      const ref = store.refById(run.taskRef);
      if (!ref?.repo || store.getTask(ref.externalId)?.state !== "done") return refuse("task-not-terminal");
      const scope = store.getScope(ref.externalId);
      if (!scope || !commit(scope.candidate) || scope.digest !== run.scopeDigest || scope.approvedDigest !== scope.digest ||
          !instant(scope.approvedAt) || Date.parse(scope.approvedAt) > Date.parse(run.startedAt) ||
          !scope.approvedBy || !scopeAuthorityOf(scope).ok || !store.sealedRouteOf(ref.externalId).ok ||
          !scopeApprovedForDispatch(store, ref.id, now)) return refuse("prepared-scope-not-current");
      const signerValid = (name: string) => {
        const signer = store.accountOf(name);
        return signer?.role === "approver" && signer.revokedAt === null && store.accountCanAccess(name, ref.repo!);
      };
      if (!signerValid(scope.approvedBy)) return refuse("scope-signer-not-current");
      const command = store.liveVerifyCommand(ref.repo);
      if (!command || !positive(command.id) || !positive(command.timeoutMs) || !command.command ||
          !instant(command.approvedAt) || Date.parse(command.approvedAt) > Date.parse(run.startedAt) ||
          command.revokedAt !== null || !signerValid(command.approvedBy)) return refuse("verification-grant-not-current");
      if (store.handle.prepare("SELECT 1 FROM claim WHERE task_ref = ? AND released_at IS NULL AND expires_at >= ? LIMIT 1").get(ref.id, now.toISOString()) ||
          store.activeHolds(ref.id, now).length || store.handle.prepare("SELECT 1 FROM run WHERE task_ref = ? AND (outcome IS NULL OR finished_at IS NULL) LIMIT 1").get(ref.id)) return refuse("task-still-active-or-held");
      const owned = store.ownedRunsOf(runId);
      const ownedRuns = [];
      for (const id of owned) {
        const one = store.getRun(id);
        if (!one || one.outcome === null || !instant(one.startedAt) || !instant(one.finishedAt) ||
            Date.parse(one.finishedAt) < Date.parse(one.startedAt) || Date.parse(one.finishedAt) > Date.parse(run.finishedAt) ||
            one.providerStartedAt !== null || one.sessionId !== null ||
            store.applicableStopFor(id) !== null || ownedProcessCount(runOwnerTag(store, id)) > 0) return refuse("owned-run-not-settled");
        ownedRuns.push({ id, taskRef: one.taskRef, leaseId: one.leaseId, parentRun: one.parentRun, role: one.role,
          outcome: one.outcome, startedAt: one.startedAt, finishedAt: one.finishedAt, providerStartedAt: one.providerStartedAt, sessionId: one.sessionId });
      }
      const machine = store.proofVerdictFor(runId);
      if (!machine || (machine.machineVerdict ?? machine.verdict) !== "verified" || !instant(machine.decidedAt) ||
          Date.parse(machine.decidedAt) > now.getTime()) return refuse("machine-verification-unproven");
      const artifacts = store.artifactsFor(runId);
      const receipts = artifacts.filter(isVerificationReceipt);
      const logs = artifacts.filter(a => a.kind === "check-log");
      if (receipts.length !== 1 || receipts[0]!.capture !== VERIFICATION_RECEIPT_CAPTURE || logs.length !== 1 ||
          receipts[0]!.captureStatus !== "ok" || logs[0]!.captureStatus !== "ok") return refuse("actual-v1-gate-required");
      const gateArtifact = receipts[0]!, log = logs[0]!;
      const gate = verificationEvidence(store, evidenceRoot, runId);
      if (!gate.ok || gate.bytes === null) return refuse("verification-evidence-unavailable");
      // A legacy log-header view is not a sealed receipt: the strict schema refuses its extra keys.
      const view = JSON.parse(gate.bytes) as { version?: unknown };
      const receipt = readVerificationReceipt(view);
      if (!receipt.ok || view.version !== 1 || receipt.value.reusedFrom !== undefined || receipt.value.executedHere !== undefined ||
          receipt.value.result.configured !== true || receipt.value.result.ran !== true || receipt.value.result.exitCode !== 0 ||
          !instant(gateArtifact.createdAt) || Date.parse(gateArtifact.createdAt) < Date.parse(run.startedAt) ||
          Date.parse(gateArtifact.createdAt) > Date.parse(machine.decidedAt) ||
          Date.parse(gateArtifact.createdAt) > Date.parse(run.finishedAt)) return refuse("actual-passing-gate-unproven");
      const handoffs = artifacts.filter(a => a.kind === "handoff");
      if (handoffs.length !== 1) return refuse("machine-prepared-handoff-unavailable");
      const artifact = handoffs[0]!;
      if (artifact.capture !== "machine-authored handoff (exit 0)" || artifact.truncated || artifact.redacted || artifact.captureStatus === "failed") return refuse("machine-prepared-handoff-unavailable");
      const saved = readVerifiedArtifact(evidenceRoot, artifact);
      if (!saved.ok) return refuse("machine-prepared-handoff-unavailable");
      const read = parseHandoffArtifact(saved.content.toString("utf8"));
      if (!read.ok) return refuse("machine-prepared-handoff-mismatch");
      const handoff = read.value;
      const conclusion = `Prepared candidate ${scope.candidate} was checked out by the machine; no agent ran. ${run.outcome === "no-change" ? "The branch already matched it." : "The sealed diff spans this task's base to that candidate."}`;
      if (handoff.runId !== runId || handoff.taskId !== ref.externalId || handoff.sessionId !== null ||
          handoff.provider !== run.provider || handoff.branch !== run.branch || handoff.worktree !== run.worktree ||
          handoff.base !== run.baseRevision || handoff.head !== run.headRevision || handoff.outcome !== run.outcome ||
          handoff.committed !== run.committed || handoff.freshness.currentAsOf !== run.headRevision ||
          handoff.conclusion !== conclusion || run.handoff !== conclusion ||
          !instant(artifact.createdAt) || Date.parse(artifact.createdAt) < Date.parse(run.startedAt) ||
          Date.parse(artifact.createdAt) > Date.parse(gateArtifact.createdAt)) return refuse("machine-prepared-handoff-mismatch");
      const witnesses: RecoveryWitnessSnapshot[] = [];
      for (const id of owned) {
        for (const row of store.handle.prepare("SELECT id, run, pid, host, process_group, observed_at, exited_at, boot_id, containment, container, container_identity, container_empty_at FROM run_process WHERE run = ? ORDER BY id").all(id)) {
          if (!positive(row.id) || row.run !== id || (row.pid !== null && !positive(row.pid)) || typeof row.host !== "string" ||
              (row.process_group !== 0 && row.process_group !== 1) || !instant(row.observed_at) ||
              Date.parse(row.observed_at) < Date.parse(run.startedAt) || Date.parse(row.observed_at) > Date.parse(run.finishedAt) ||
              (row.exited_at !== null && (!instant(row.exited_at) || Date.parse(row.exited_at) < Date.parse(row.observed_at) || Date.parse(row.exited_at) > now.getTime())) ||
              (row.boot_id !== null && (typeof row.boot_id !== "string" || normalizeBootId(row.boot_id) !== row.boot_id))) return refuse("malformed-process-witness");
          // This classifier is deliberately ordinary-process-only. Even a
          // apparently empty native object needs its separate containment road.
          if (row.containment !== null || row.container !== null || row.container_identity !== null || row.container_empty_at !== null) return refuse("native-containment-outside-scope");
          if (row.pid !== null && row.exited_at === null) return refuse("known-process-exit-unproven");
          if (row.pid === null && row.exited_at === null && (id !== runId || row.host !== host || row.boot_id !== bootId ||
              Date.parse(row.observed_at) > Date.parse(gateArtifact.createdAt))) return refuse("unknown-witness-not-bound-to-gate");
          witnesses.push(row as unknown as RecoveryWitnessSnapshot);
        }
      }
      const unknownWitnessIds = witnesses.filter(row => row.pid === null && row.exited_at === null).map(row => row.id);
      if (!unknownWitnessIds.length) return refuse("no-unresolved-null-pid-witness");
      if (!witnesses.some(row => row.run === runId && row.pid !== null && row.exited_at !== null)) return refuse("known-gate-process-witness-missing");
      const binding = { version: 1 as const, kind: "prepared-candidate-observer-gap-eligibility" as const,
        host, bootId, run: { id: runId, taskRef: ref.id, taskId: ref.externalId, repo: ref.repo, leaseId: run.leaseId,
          role: run.role, outcome: run.outcome, committed: run.committed, startedAt: run.startedAt, finishedAt: run.finishedAt,
          branch: run.branch, worktree: run.worktree, base: run.baseRevision, head: run.headRevision },
        scope: { candidate: scope.candidate, digest: scope.digest, approvedAt: scope.approvedAt, approvedBy: scope.approvedBy,
          approvalBasis: scope.approvalBasis ?? "password", modeDigest: scope.modeDigest ?? null },
        command, machine, gateDigest: gate.digest, gate: artifactBinding(gateArtifact), log: artifactBinding(log),
        handoff: artifactBinding(artifact), ownedRuns, unknownWitnessIds, witnesses };
      return freeze({ ok: true as const, digest: hash(binding), binding,
        requires: "separate-authenticated-spawn-provenance-and-complete-os-census" as const });
    });
  } catch {
    // No private paths, artifact bodies, command output or raw database errors.
    return refuse("saved-eligibility-evidence-unreadable");
  }
}

export type PreparedCandidateObserverGapEligibility = ReturnType<typeof preparedCandidateObserverGapEligibility>;
