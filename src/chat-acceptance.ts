/** Read-only acceptance evidence for every chat surface. The saved verdict,
 * human acceptance and current file health remain separate facts. Reading or
 * sending this packet never accepts a result or authorizes another action. */
import type { Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { readVerifiedArtifact, readVerifiedProofForRun, scanForSecrets } from "./evidence.js";
import { verificationEvidence } from "./verification-evidence.js";
import { manualReviewOnly, type CriterionMatrixRow } from "./proof.js";
import { assignmentChecksForRun } from "./assignment.js";
import { approvedCheckOf, approvedCheckStateOf, checksFactOf, type ApprovedCheckState } from "./task-status.js";

export const ACCEPTANCE_PAGE_SIZE = 3;

/** `check`: the approved check read now (task-status.ts approvedCheckOf); undefined when this read had no saved files,
 * and then a verified result claims nothing about its check. */
export function acceptanceStatus(proof: { verdict: string; reasons: readonly string[]; matrix: readonly CriterionMatrixRow[] } | null, accepted: boolean, check?: ApprovedCheckState | null): string {
  if (accepted) return manualReviewOnly(proof) ? "Accepted by a person" : "Accepted with an exception";
  if (manualReviewOnly(proof)) return "You check the remaining requirements";
  if (proof?.verdict === "verified" && check !== "passed") {
    return check === undefined ? "Open the result to see its checks" : check === "failed" ? "Checks failed" : check === "running" ? "Checks running" : "The check result couldn't be read";
  }
  return proof === null ? "No checks recorded" : ({ verified: "Checks passed", attested: "Checks reported by the agent", short: "Some required material is missing", refuted: "Saved result conflicts with the approved scope" }[proof.verdict] ?? "Some required material is missing");
}

export function readAcceptanceEvidence(store: Store, who: VerifiedApprover, root: string | undefined, task: string, runId?: number, offset = 0) {
  const ref = store.lookupRef(task);
  if (ref?.repo == null || !who.repos.includes(ref.repo)) return { ok: false as const, message: "That task is not in your projects." };
  const family = store.taskFamilyOf(task, who.repos, false);
  if (family === null || family.problem !== null) return { ok: false as const, message: "This task's revision history needs attention." };
  if (runId === undefined && family.current.id !== task) return { ok: false as const, message: "A newer revision is current. Choose the exact result before requesting its evidence." };
  const run = runId === undefined ? store.runsFor(ref.id).find(one => one.finishedAt !== null && ["builder", "repair", "scout"].includes(one.role)) : store.getRun(runId);
  if (run == null || run.taskRef !== ref.id || run.finishedAt === null || run.outcome === null || !["builder", "repair", "scout"].includes(run.role)) return { ok: false as const, message: "Choose a finished result belonging to that task." };
  const recorded = store.proofVerdictFor(run.id);
  const acceptance = store.proofAcceptance(run.id);
  const matrix = recorded?.matrix ?? [];
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= matrix.length)) return { ok: false as const, message: "Choose a criterion offset from this result's evidence." };
  const artifacts = store.artifactsFor(run.id);
  const problems: string[] = [];
  const notices: string[] = [];
  if (root === undefined) problems.push("This chat cannot read the saved result files.");
  for (const artifact of artifacts.filter(one => ["proof", "terminal-diff", "diff-stat", "check-log", "review-context", "report", "handoff", "screenshot"].includes(one.kind))) {
    if (root === undefined) break;
    const read = readVerifiedArtifact(root, artifact);
    if (!read.ok || artifact.captureStatus === "failed") problems.push(`Saved ${artifact.kind} #${artifact.id} is unavailable or changed.`);
    if (artifact.truncated) notices.push(`Saved ${artifact.kind} #${artifact.id} was shortened; omitted content is unavailable.`);
    if (artifact.redacted) notices.push(`Sensitive content was removed from ${artifact.kind} #${artifact.id}; it cannot support a claim.`);
  }
  const proof = root === undefined ? null : readVerifiedProofForRun(store, root, run.id);
  if (proof === null) problems.push("No readable saved proof is available.");
  else if (!proof.ok) problems.push("The saved proof is unavailable or cannot be read.");
  const verification = root === undefined ? null : verificationEvidence(store, root, run.id);
  // The one answer to "did the approved check pass" (task-status.ts), with follow-ups on the same commit.
  const checkNow = root === undefined || run.role === "scout" ? undefined
    : approvedCheckStateOf(approvedCheckOf(recorded?.verdict ?? null, recorded?.reasons ?? [], checksFactOf(assignmentChecksForRun(store, root, run.id, new Date()), run.headRevision)));
  let gate: Record<string, unknown> = { status: "No machine verification receipt available" };
  if (verification !== null && !verification.ok) { problems.push(verification.problem); gate = { status: "Verification evidence unavailable" }; }
  else if (verification?.ok && verification.bytes !== null) {
    const receipt = JSON.parse(verification.bytes);
    gate = { status: receipt.result.ran ? (receipt.result.exitCode === 0 ? checkNow === undefined || checkNow === "passed" ? "Passed" : "Passed when it ran; not counted now" : "Failed") : "Did not run", exitCode: receipt.result.exitCode ?? null, command: "The approved project verification command", logShortened: receipt.log.truncated };
  }
  // These are summaries for conversation, not substitute approval terms.
  // Full statements, caveats and references remain on the authenticated screen.
  const brief = (text: string | null | undefined, cap = 600) => {
    if (text == null) return null;
    if (scanForSecrets(text).length > 0 || /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/.test(text)) return "[Sensitive text hidden; inspect the original result in Toolroll]";
    const clean = text.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, "[path]").replace(/(^|[\s"'`(<[=:,])\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+/g, "$1[path]");
    return clean.length <= cap ? clean : `${clean.slice(0, cap)}… [shortened; open the result for the full text]`;
  };
  const page = matrix.slice(offset, offset + ACCEPTANCE_PAGE_SIZE);
  return { ok: true as const, body: {
    task, run: run.id, title: store.getTask(task)?.title ?? task, currentExecution: family.current.id,
    isCurrent: family.current.id === task && store.runsFor(ref.id).find(one => one.finishedAt !== null && ["builder", "repair", "scout"].includes(one.role))?.id === run.id,
    status: acceptanceStatus(recorded, acceptance !== null, checkNow), recordedVerdict: recorded?.verdict ?? null,
    accepted: acceptance !== null, acceptance: acceptance === null ? null : { at: acceptance.acceptedAt, note: brief(acceptance.note) },
    reasons: (recorded?.reasons ?? []).map(one => brief(one)), gate,
    criteriaTotal: matrix.length, nextCriterionOffset: offset + page.length < matrix.length ? offset + page.length : null,
    criteria: page.map(row => ({ id: row.id, requirement: brief(row.statement), state: row.state === "manual-review" ? "You check" : row.state,
      details: row.detail.map(one => brief(one)), requiredEvidence: row.requiredEvidence,
      reviewer: row.review == null ? null : { judgement: row.review.judgement, note: brief(row.review.note) },
      evidence: row.answered.map(one => ({ kind: one.kind, reference: brief(one.ref) })),
      coverageGaps: row.coverage?.gaps.map(one => brief(one)) ?? [],
    })),
    caveats: proof?.ok ? proof.proof.caveats.map(one => brief(one)) : [],
    problems, notices,
    nextStep: acceptance !== null ? "Acceptance is already recorded. No further acceptance is needed for this result." : "Inspect the saved result, then mark it complete or request changes. Opening a link or requesting images changes nothing.",
    disclosure: "Conversation summary only. Inspect the complete result, its checks and its terms on the result screen before marking it complete.",
  } };
}

/** Deterministic outbox text uses the same verified reader as conversational
 * requests. Every criterion is included; long values disclose shortening. */
export function acceptanceEvidenceText(store: Store, who: VerifiedApprover, root: string | undefined, task: string, run: number) {
  const first = readAcceptanceEvidence(store, who, root, task, run);
  if (!first.ok) return first;
  const packet = first.body;
  const criteria = [...packet.criteria];
  let offset = packet.nextCriterionOffset;
  while (offset !== null) {
    const page = readAcceptanceEvidence(store, who, root, task, run, offset);
    if (!page.ok) return page;
    criteria.push(...page.body.criteria);
    offset = page.body.nextCriterionOffset;
  }
  const lines = [
    `Result #${run} · ${packet.status}`,
    `Project checks: ${String(packet.gate["status"])}${packet.gate["logShortened"] === true ? " (saved log shortened)" : ""}`,
    ...criteria.map(row => [
      `${row.id}: ${row.requirement} — ${row.state === "pass" ? "passed" : row.state}`,
      ...(row.reviewer === null ? [] : [`Earlier assessment ${row.reviewer.judgement === "upholds" ? "supported this finding" : row.reviewer.judgement === "contradicts" ? "disputed this finding" : "could not confirm this finding"}: ${row.reviewer.note ?? "No note saved."}`]),
      ...row.coverageGaps.map(gap => `Coverage gap: ${gap}`),
    ].join("\n")),
    ...packet.caveats.map(caveat => `Limitation: ${caveat}`),
    ...packet.problems.map(problem => `Saved material problem: ${problem}`),
    ...packet.notices,
    packet.disclosure,
  ];
  return { ok: true as const, text: lines.join("\n\n"), isCurrent: packet.isCurrent, accepted: packet.accepted };
}
