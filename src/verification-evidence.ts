// Verified-build assignment completion reuses these gate checks.
import { observationBrief, readObservationEvidence } from "./observations.js";
/** Machine verification receipts use the existing sealed artifact store (schema
 * 60). Verbose output is independently bounded; no agent-authored check claim
 * can create or replace this receipt. */
import { createHash } from "node:crypto";
import type { Artifact, Store, VerifyCommand } from "./store.js";
import type { VerifyCommandFacts } from "./proof.js";
import { adjudicate, type AdjudicateResult } from "./proof.js";
import { parseReviewContext, reviewContextCustodyProblem } from "./review-context.js";
import { readVerifiedArtifact, storeEvidence, scanForSecrets, redactSecretLines } from "./evidence.js";
import { readVerificationReceipt } from "./contracts/verification-receipt.js";
import { LEGACY_GATE_SOURCE, readVerificationView, type LegacyGateView } from "./contracts/verification-view.js";
import { readCandidateEndpoints, savedInventoryPaths } from "./contracts/diff-stat.js";
import { liveQuickCommand, quickVerifyKey, runCheckLevel } from "./check-levels.js";

export const VERIFICATION_RECEIPT_CAPTURE = "machine verification receipt v1";
export const REVIEW_GATE_NAME = "REVIEW-VERIFICATION.json";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (a: Artifact) => ({ artifactId: a.id, sha256: a.sha256, bytesStored: a.bytesStored, bytesOriginal: a.bytesOriginal, truncated: a.truncated, redacted: a.redacted, captureStatus: a.captureStatus });
export const isVerificationReceipt = (a: Artifact) => a.kind === "structured-output" && (a.capture === VERIFICATION_RECEIPT_CAPTURE || a.capture === "machine verification reuse v1");

export function sealVerificationReceipt(store: Store, root: string, runId: number, head: string, command: VerifyCommand, result: VerifyCommandFacts, now: Date, reusedFrom?: { run: number; digest: string }): void {
  const source = store.getRun(runId)!;
  const log = store.artifactsFor(runId).find(a => a.kind === "check-log");
  if (!log) throw new Error("Verification receipt requires its retained log");
  const receipt = {
    version: reusedFrom === undefined ? 1 : 2, run: runId, head, base: source.baseRevision, scopeDigest: source.scopeDigest,
    ...(reusedFrom === undefined ? {} : { reusedFrom, executedHere: false }),
    command, result, log: binding(log),
  };
  const checked = readVerificationReceipt(receipt);
  if (!checked.ok) throw new Error(`The verification receipt does not match its contract: ${checked.issues.map(issue => issue.line).join("; ")}`);
  // Sealed in the writer's own key order, as every receipt before the schema: its bytes and digests stay comparable.
  const raw = JSON.stringify(receipt, null, 1);
  const hits = scanForSecrets(raw);
  storeEvidence(store, root, runId, "structured-output", "verification-receipt.json", Buffer.from(hits.length ? redactSecretLines(raw, hits) : raw), reusedFrom === undefined ? VERIFICATION_RECEIPT_CAPTURE : "machine verification reuse v1", now, { captureStatus: "ok", redacted: hits.length > 0 });
}

/** Read and bind existing evidence, never backfill historical receipts. A legacy
 * single-attempt machine header is sufficient only with its exact approved grant
 * and sealed candidate endpoints. Recovery logs without a receipt stay explicit. */
// Recovery reads this existing receipt binding, then requires an actually executed
// v1 passing gate. This reader does not rerun checks or transfer a prior approval.
export function verificationEvidence(store: Store, root: string, runId: number):
  { ok: true; bytes: string | null; digest: string } | { ok: false; problem: string } {
  const fail = (problem: string) => ({ ok: false as const, problem });
  const source = store.getRun(runId);
  if (!source) return fail("The verification source run is missing.");
  const repo = store.refById(source.taskRef)?.repo;
  const artifacts = store.artifactsFor(runId);
  const receipts = artifacts.filter(isVerificationReceipt);
  const machine = store.proofVerdictFor(runId);
  const verified = (machine?.machineVerdict ?? machine?.verdict) === "verified";
  // A run whose checks were Off recorded no check; that is not a gap.
  if (!receipts.length && !verified && runCheckLevel(store, runId) === "off") return { ok: true, bytes: null, digest: hash(null) };
  // A Quick run is bound to the project's approved quick command, a Full one to the full command.
  const command = repo ? sealedCommandKey(root, receipts) === quickVerifyKey(repo) ? liveQuickCommand(store, repo) : store.liveVerifyCommand(repo) : null;
  if (!command && !receipts.length && !verified) return { ok: true, bytes: null, digest: hash(null) };
  if (!command || command.approvedAt > source.startedAt) return fail("The original approved verification command is missing or changed.");
  if (receipts.length > 1) return fail("The verification receipt is ambiguous.");
  const logs = artifacts.filter(a => a.kind === "check-log");
  if (logs.length !== 1 || logs[0]!.captureStatus === "failed") return fail("One readable machine verification log is required.");
  const log = logs[0]!;
  const read = readVerifiedArtifact(root, log);
  if (!read.ok) return fail("The retained verification log no longer verifies.");
  let receipt;
  if (receipts.length) {
    const artifact = receipts[0]!;
    if (artifact.truncated || artifact.redacted || artifact.captureStatus === "failed") return fail("The verification receipt is incomplete.");
    const sealed = readVerifiedArtifact(root, artifact);
    if (!sealed.ok) return fail("The verification receipt no longer verifies.");
    try { receipt = JSON.parse(sealed.content.toString("utf8")); } catch { return fail("The verification receipt cannot be read."); }
    // The schema checks the shape; the bindings below check it against the store. The receipt itself stays exactly
    // as sealed: its bytes are this view's bytes and part of its digest.
    const read = readVerificationReceipt(receipt);
    if (!read.ok) return fail(`The verification receipt is malformed: ${read.issues.map(issue => issue.line).join("; ")}`);
    const checked = read.value;
    if (checked.run !== runId || checked.head !== source.headRevision || checked.base !== source.baseRevision || checked.scopeDigest !== source.scopeDigest || JSON.stringify(receipt.command) !== JSON.stringify(command) || JSON.stringify(receipt.log) !== JSON.stringify(binding(log))) return fail("The candidate, approved command or retained log changed since verification.");
    if (receipt.version === 2) {
      try {
      const brief = observationBrief(store, root, source.taskRef);
      const reused = checked.reusedFrom;
      if (!brief || !readObservationEvidence(store, root, runId) || !reused || reused.run !== brief.sourceRun || reused.run >= runId || reused.digest !== brief.gateDigest ||
          source.baseRevision !== brief.head || source.headRevision !== brief.head || checked.executedHere !== false) return fail("The reused gate is not bound to an unchanged observation follow-up.");
      const original = verificationEvidence(store, root, reused.run);
      if (!original.ok || !original.bytes || original.digest !== reused.digest) return fail("The original passing gate no longer verifies.");
      const previousRead = readVerificationView(original.bytes);
      if (!previousRead.ok) return fail("The original passing gate no longer verifies.");
      const previous = previousRead.value;
      const originalLog = store.getArtifact(previous.log.artifactId);
      if (previous.head !== source.headRevision || !("exitCode" in previous.result) || previous.result.exitCode !== 0 || JSON.stringify(previous.command) !== JSON.stringify(command) ||
          JSON.stringify(previous.result) !== JSON.stringify(receipt.result) || originalLog?.sha256 !== log.sha256 ||
          originalLog.bytesOriginal !== log.bytesOriginal || originalLog.redacted !== log.redacted || originalLog.truncated !== log.truncated) return fail("The reused gate's candidate, command, result or copied log changed.");
      } catch { return fail("The reused gate or its observations no longer verify."); }
    } else if (checked.reusedFrom !== undefined || checked.executedHere !== undefined) return fail("The gate reuse receipt has an unsupported version.");
    const result = checked.result;
    if (!result.configured) return fail("The machine verification result is malformed.");
    if (verified && (!result.ran || result.exitCode !== 0)) return fail("The passing machine verdict disagrees with its verification receipt.");
  } else {
    const stat = artifacts.filter(a => a.kind === "diff-stat");
    if (stat.length !== 1 || stat[0]!.truncated || stat[0]!.captureStatus === "failed") return fail("Legacy verification has no exact candidate inventory.");
    const readStat = readVerifiedArtifact(root, stat[0]!);
    if (!readStat.ok) return fail("Legacy candidate inventory no longer verifies.");
    let inventory: unknown;
    try { inventory = JSON.parse(readStat.content.toString("utf8")); } catch { return fail("Legacy candidate inventory is unreadable."); }
    const endpointsRead = readCandidateEndpoints(inventory);
    if (!endpointsRead.ok) return fail("Legacy verification candidate endpoints do not match.");
    const endpoints = endpointsRead.value;
    if (!source.headRevision || endpoints.head !== source.headRevision || endpoints.base !== source.baseRevision || endpoints.filesTruncated !== false) return fail("Legacy verification candidate endpoints do not match.");
    const text = read.content.toString("utf8");
    const header = /^=== Attempt summary ===\n- Project check · attempt 1: \(exit (\d+)\)\n\n=== Project check · attempt 1 ===\n/.exec(text);
    const exitCode = header ? Number(header[1]) : -1;
    if (!header || exitCode > 255 || !text.startsWith(`${header[0]}$ ${command.command}\n(exit ${exitCode})\n\n--- stdout ---\n`)) return fail("The original log lacks an unambiguous machine gate receipt; historical output was not reconstructed.");
    if (verified && exitCode !== 0) return fail("The passing machine verdict disagrees with the original failed check.");
    const view: LegacyGateView = { version: 1, source: LEGACY_GATE_SOURCE, run: runId, head: source.headRevision, base: source.baseRevision, scopeDigest: source.scopeDigest, command, result: { configured: true, ran: true, exitCode }, log: binding(log), candidate: binding(stat[0]!) };
    receipt = view;
  }
  // The view preserves shortened/redacted status and does not claim the omitted
  // output exists. Its fingerprint is re-proved before every turn and ingestion.
  const bytes = JSON.stringify(receipt);
  return { ok: true, bytes, digest: hash({ receipt, receipts }) };
}

/** The grant key a run's single sealed receipt names, read without trusting it further. */
function sealedCommandKey(root: string, receipts: readonly Artifact[]): string | null {
  if (receipts.length !== 1) return null;
  const sealed = readVerifiedArtifact(root, receipts[0]!);
  if (!sealed.ok) return null;
  try {
    const read = readVerificationReceipt(JSON.parse(sealed.content.toString("utf8")));
    return read.ok ? read.value.command.repo : null;
  } catch { return null; }
}

/** Only a sealed failed check can start unattended diagnosis. Lost custody,
 * changed approvals/trees and incomplete evidence still need attention; they
 * must not become another code-writing attempt. Keep the log out of the small
 * revision artifact and re-read it when the repair builder starts. */
export function failedVerificationEvidence(store: Store, root: string, runId: number):
  | { kind: "none" }
  | { kind: "unavailable"; problem: string }
  | { kind: "failed"; digest: string; receipt: string; log: string } {
  if (!store.artifactsFor(runId).some(isVerificationReceipt)) return { kind: "none" };
  const verified = verificationEvidence(store, root, runId);
  if (!verified.ok) return { kind: "unavailable", problem: verified.problem };
  if (verified.bytes === null) return { kind: "none" };
  const view = readVerificationView(verified.bytes);
  if (!view.ok) return { kind: "unavailable", problem: "The verification receipt cannot be read." };
  const receipt = view.value, result = receipt.result;
  if (!result.configured || (result.ran ? result.exitCode === 0 :
    result.failure !== "timed-out" && result.failure !== "retry-timed-out")) return { kind: "none" };
  const artifact = store.getArtifact(receipt.log.artifactId);
  if (!artifact || artifact.truncated || artifact.redacted || artifact.captureStatus !== "ok") {
    return { kind: "unavailable", problem: "Automatic repair needs the complete, unredacted failed-check log." };
  }
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) return { kind: "unavailable", problem: "The failed-check log no longer verifies." };
  return { kind: "failed", digest: verified.digest, receipt: verified.bytes, log: read.content.toString("utf8") };
}

/** A fresh review may assess a pre-upgrade result which stopped solely because
 * no builder proof was written. Read original sealed facts; never run checks,
 * backfill receipts, rewrite artifacts, or reuse a different candidate's gate.
 * Called inside review ingestion, after its exact bindings have been proved. */
export function assessmentFromSavedEvidence(store: Store, root: string, runId: number): AdjudicateResult | null {
  const previous = store.proofVerdictFor(runId);
  if (previous?.verdict !== "short" || previous.reasons.length !== 1 || previous.reasons[0] !== "no proof was written" ||
    previous.matrix.some(row => row.review !== null || row.assessment !== undefined)) return null;
  const source = store.getRun(runId);
  if (!source?.headRevision || !source.baseRevision) return null;
  const task = store.externalIdFor(source.taskRef);
  const scope = task === null ? null : store.getScope(task);
  if (!scope || scope.digest !== source.scopeDigest || scope.acceptance.length === 0) return null;
  const artifacts = store.artifactsFor(runId);
  if (artifacts.some(one => one.kind === "proof")) return null;
  const readOne = (kind: Artifact["kind"]) => {
    const found = artifacts.filter(one => one.kind === kind);
    if (found.length !== 1 || found[0]!.truncated || found[0]!.redacted || found[0]!.captureStatus === "failed") return null;
    const read = readVerifiedArtifact(root, found[0]!);
    return read.ok ? read.content.toString("utf8") : null;
  };
  const diff = readOne("terminal-diff"), stat = readOne("diff-stat"), handoff = readOne("handoff"), context = readOne("review-context");
  if (diff === null || stat === null || handoff === null || context === null) return null;
  const parsedContext = parseReviewContext(context);
  if (!parsedContext.ok || parsedContext.inventory.run !== runId || reviewContextCustodyProblem(store, root, parsedContext.inventory) !== null) return null;
  const gate = verificationEvidence(store, root, runId);
  if (!gate.ok || gate.bytes === null) return null;
  try {
    const view = readVerificationView(gate.bytes);
    const base = source.branch ? store.firstBuilderBase(source.taskRef, source.branch) ?? source.baseRevision : source.baseRevision;
    const paths = savedInventoryPaths(stat, source.headRevision, base);
    if (!view.ok || paths === null) return null;
    const receipt = view.value;
    return adjudicate({ directAssessment: true, proofArtifactPresent: false, proofParse: null,
      handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: "ok",
      diffStat: { captured: true, truncated: false, paths },
      verifyCommand: receipt.result, verificationCommand: receipt.command.command, screenshots: [],
      approvedCriteria: scope.acceptance, reviewContext: parsedContext.inventory.coverage });
  } catch { return null; }
}

/** Reuse is exclusive to a machine-authored observation revision, with its
 * own current approval and complete new observations. Never synthesize a pass. */
export function reuseObservationVerification(store: Store, root: string, runId: number, now: Date): VerifyCommandFacts | null {
  const run = store.getRun(runId);
  if (!run) throw Error("The observation run is missing.");
  const brief = observationBrief(store, root, run.taskRef);
  if (!brief) return null;
  const scope = store.getScope(store.externalIdFor(run.taskRef)!);
  if (!scope || scope.digest !== run.scopeDigest || scope.approvedDigest !== scope.digest || run.baseRevision !== brief.head || run.headRevision !== brief.head ||
      !readObservationEvidence(store, root, runId)) throw Error("Only complete observations for the unchanged approved candidate can reuse its gate.");
  const original = verificationEvidence(store, root, brief.sourceRun);
  if (!original.ok || !original.bytes || original.digest !== brief.gateDigest) throw Error("The original passing gate is unavailable or changed.");
  const view = readVerificationView(original.bytes);
  if (!view.ok) throw Error("The original passing gate is unavailable or changed.");
  const receipt = view.value, log = store.getArtifact(receipt.log.artifactId);
  if (!log || receipt.head !== brief.head || !("ran" in receipt.result) || receipt.result.ran !== true || receipt.result.exitCode !== 0) throw Error("The source gate did not pass this candidate.");
  const read = readVerifiedArtifact(root, log);
  if (!read.ok) throw Error("The original check log no longer verifies.");
  if (store.artifactsFor(runId).some(a => a.kind === "check-log" || isVerificationReceipt(a))) throw Error("This attempt already has a gate; it cannot be replaced.");
  storeEvidence(store, root, runId, "check-log", "check-log.txt", read.content, `Reused unchanged passing checks from run #${brief.sourceRun}; no full command executed in this attempt`, now,
    { captureStatus: "ok", redacted: log.redacted, sourceBytesOriginal: log.bytesOriginal });
  sealVerificationReceipt(store, root, runId, brief.head, receipt.command, receipt.result, now, { run: brief.sourceRun, digest: brief.gateDigest });
  store.addRunNote(runId, "Toolroll", `Reused the passing project checks from run #${brief.sourceRun} for the unchanged candidate. This attempt collected only the missing focused observations.`, now);
  return receipt.result;
}
