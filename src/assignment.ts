/** One assignment follows the existing task family. It owns no execution,
 * approval or proof state. Lead ownership and exact receipt acknowledgments
 * are append-only actions; handoffs use the existing durable outbox. */
import { createHash } from "node:crypto";
import { currentActor, withActor } from "./actor.js";
import { replacedWords } from "./task-status.js";
import { COMPLETION_ACTION, familyChangedFiles } from "./result-completion.js";
import { homedir } from "node:os";
import { readSchemaVersion, stopFactOf, type Store, type ProofVerdictRow, type ProofAcceptanceRow, type Artifact } from "./store.js";
import { approvalOf } from "./scope.js";
import { openWorkDecisionOf, taskWorkSummaryOf, workDecisionAction, type WorkAction, type WorkSummaryAccess } from "./work-summary.js";
import { evidenceRoot, readVerifiedArtifact, readVerifiedReport } from "./evidence.js";
import { verificationEvidence } from "./verification-evidence.js";
import { reproveApprover, type VerifiedApprover } from "./principal.js";
import { noteAssignmentStatus } from "./assignment-status.js";
import { historicalAssessmentReason } from "./assignment-presentation.js";
import { manualReviewOnly } from "./proof.js";
import { ACCEPT_NEEDS_REASON, cantAcceptYetOf } from "./result-acts.js";
import { runCheckLevel, type CheckLevel } from "./check-levels.js";
import { followUpChecksOf, withFollowUps } from "./result-follow-ups.js";
import { buildReviewOf, findingWords, type BuildReviewView } from "./review-switch.js";
import { NEEDS, WAITS, processNeedOf, resultHoldUpSentence, type NeedKey, type WaitKey } from "./needs-you.js";
import { assignmentStageOf, type ChecksBatch } from "./task-status.js";
import { leadClaimOf, type LeadClaim } from "./lead-voice.js";

export type AssignmentAccess = WorkSummaryAccess;
export type AssignmentOwner = { kind: "coordinator" | "lead"; id: string; label: string };
export type AssignmentChecks = {
  status: "passed" | "failed" | "not-run" | "unavailable";
  exitCode: number | null; command: string | null; logArtifactId: number | null; detail: string;
  /** Which check this is (check-levels.ts): quick, full, or off; null before levels. */
  level?: CheckLevel | null;
  /** A follow-up check waiting or running on this commit. */
  running?: "quick" | "full" | null;
  /** A batch check (batch-checks.ts): waiting for its batch, or how it was checked. */
  batch?: ChecksBatch | null;
};
export type AssignmentReceipt = {
  digest: string; rootId: string; taskId: string; runId: number;
  base: string | null; head: string | null; scopeDigest: string | null;
  proof: ProofVerdictRow | null;
  completionKind: "verified-build" | "checked-build" | "finished-build" | "research-report" | "accepted-exception" | null;
  proofAcceptance: ProofAcceptanceRow | null;
  checks: AssignmentChecks;
  artifacts: { id: number; kind: string; sha256: string; bytes: number; complete: boolean }[];
  caveats: string[]; agentReport: string | null; evidence: "recorded";
};
export type AssignmentSnapshot = {
  version: 1; rootId: string; activeTaskId: string; repo: string | null; title: string;
  state: "working" | "checking" | "needs-decision" | "ready-to-check" | "complete" | "cancelled";
  detail: string; primaryAction: WorkAction | null; attention: string[];
  attempts: { taskId: string; runId: number | null; label: string; detail: string }[];
  owner: (AssignmentOwner & { active: boolean }) | null;
  receipt: AssignmentReceipt | null;
  savedContext?: {
    goal: string | null; outOfScope: string | null;
    excerpts: { artifactId: number; runId: number; kind: string; sha256: string; text: string | null; shortened: boolean; problem: string | null }[];
  };
  /** `lead`: marked complete by the person's lead (`toolroll lead token`), shown as "by the lead". */
  completion: { actor: string; at: string; digest: string; lead?: true } | null;
  handoff: { kind: "result" | "decision" | "attention"; digest: string; acknowledged: boolean } | null;
  publication: { state: string; prUrl: string | null; remoteState: string | null } | null;
  /** The result's one automatic review, when its project had review on:
   * pending, HIGH findings, suggested follow-ups (MEDIUM/LOW), or not reviewed. */
  review: BuildReviewView | null;
  deployment: { status: "not-recorded" };
  /** What this assignment asks of a person, or waits for when no person can act (needs-you.ts). */
  need?: { key: NeedKey; build: number | null } | { wait: WaitKey; build: number | null } | null;
  /** The person's lead took it on (lead-voice.ts): "<name> is on it" until done, handed on, or two quiet hours. */
  lead?: LeadClaim | null;
  /** How many earlier versions of this task are still queued or running; absent when none. */
  earlierActive?: number;
  /** Of those, how many are running rather than only queued; present with earlierActive. */
  earlierRunning?: number;
};

/** Status-first handoff for routine reads. Fetch get_assignment only when
 * inspecting its exact evidence; do not repeat a full proof in every poll. */
export function assignmentBrief(assignment: AssignmentSnapshot | null) {
  if (assignment === null) return null;
  const receipt = assignment.receipt;
  return { version: assignment.version, rootId: assignment.rootId, activeTaskId: assignment.activeTaskId,
    state: assignment.state, detail: assignment.detail, owner: assignment.owner, primaryAction: assignment.primaryAction,
    attention: assignment.attention, attempts: assignment.attempts.length, handoff: assignment.handoff, completion: assignment.completion,
    result: receipt === null ? null : { digest: receipt.digest, taskId: receipt.taskId, runId: receipt.runId,
      base: receipt.base, head: receipt.head, completionKind: receipt.completionKind,
      checks: receipt.checks, proofAcceptance: receipt.proofAcceptance, verdict: receipt.proof?.verdict ?? null,
      criteria: { passed: receipt.proof?.matrix.filter(row => row.state === "pass").length ?? 0, total: receipt.proof?.matrix.length ?? 0 }, evidence: receipt.evidence },
    publication: assignment.publication, review: assignment.review, deployment: assignment.deployment };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A lookup added with lead-quiet, read safely: a deploy proves completion with this code over the INSTALLED runtime's
 * store, before this version's migration, so the method (or its table) may not exist yet. Absent reads as none. */
function olderStoreSafe<T>(read: () => T, absent: T): T {
  try { return read(); } catch (error) { if (error instanceof TypeError || /no such (table|column)/.test(String(error))) return absent; throw error; }
}
/** A check as the receipt digest seals it: presentation-only fields (check-levels.ts) left out. */
const sealedChecks = ({ level: _level, running: _running, batch: _batch, ...proof }: AssignmentChecks): Omit<AssignmentChecks, "level" | "running" | "batch"> => proof;
const OWNER_ACTION = "assignment claimed";
const CHECK_ACTION = COMPLETION_ACTION;
const actorOf = (owner: AssignmentOwner) => `${owner.kind}:${owner.id}`;

function ownerOf(store: Store, rootId: string, repo: string | null): AssignmentSnapshot["owner"] {
  // The release verifier reads the new projection against the still-running
  // v70 Store before migrating a backup. That read cannot invent team tables.
  const hasTeam = store.handle.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_task_owner'").get() !== undefined;
  if (!hasTeam) {
    const version = readSchemaVersion(store.handle);
    if (!version.ok || version.version !== 70) throw new Error("Team ownership history is missing; refusing to recreate it.");
  }
  const team = hasTeam ? store.handle.prepare("SELECT l.id,l.name,l.status FROM team_task_owner o JOIN team_lead l ON l.id=o.lead JOIN task_ref r ON r.id=o.task_ref WHERE r.backend='built-in' AND r.external_id=? AND r.repo IS ?").get(rootId,repo) : undefined;
  if (team) return { kind: "lead", id: String(team["id"]), label: String(team["name"]), active: team["status"] === "active" };
  const claim = store.handle.prepare("SELECT actor FROM action_ledger WHERE task_id = ? AND action = ? AND source = 'work' ORDER BY id DESC LIMIT 1").get(rootId, OWNER_ACTION);
  const origin = store.lookupRef(rootId)?.coordinatorCid;
  const id = claim === undefined ? origin : String(claim["actor"]).replace(/^coordinator:/, "");
  if (!id) return null;
  const credential = store.handle.prepare("SELECT name,repos,revoked_at FROM coordinator_credential WHERE cid = ?").get(id);
  let repos: unknown = [];
  try { repos = JSON.parse(String(credential?.["repos"] ?? "[]")); } catch { /* unavailable owner stays inactive */ }
  return { kind: "coordinator", id, label: String(credential?.["name"] ?? "Former lead"),
    active: credential !== undefined && credential["revoked_at"] === null && repo !== null && Array.isArray(repos) && repos.includes(repo) };
}

// Report the recorded check outcome, never turn a model verdict into a check.
// Follow-up checks on the same commit (Run checks) upgrade a pass and show a failure.
export function assignmentChecksForRun(store: Store, root: string | undefined, runId: number, now: Date): AssignmentChecks {
  const own = buildChecks(store, root, runId);
  const run = store.getRun(runId);
  const followUps = followUpChecksOf(store, runId, now, root);
  if (followUps.length === 0) return own;
  const read = withFollowUps({ status: own.status, level: own.level ?? null, exitCode: own.exitCode, head: run?.headRevision ?? null }, followUps);
  const latest = [...followUps].reverse().find(one => one.state === "passed" || one.state === "failed");
  const changed = read.status !== own.status || read.level !== (own.level ?? null) || read.exitCode !== own.exitCode;
  const words = read.level === "quick" ? "Quick checks" : "Checks";
  // A batch check: waiting for its batch, or how the latest finished one was checked and on which commit.
  const waitingBatch = followUps.some(one => one.why === "batch" && one.state === "waiting");
  const sealedBatch = latest?.batch ?? null;
  const batch: ChecksBatch | null = waitingBatch ? { state: "waiting", tested: null, peers: [] }
    : sealedBatch !== null && latest !== undefined ? { state: sealedBatch.mode, tested: latest.tested ?? sealedBatch.tested,
      peers: sealedBatch.members.filter(one => one.run !== runId).map(one => one.task) } : null;
  return { ...own, running: read.running, ...(batch === null ? {} : { batch }),
    ...(changed ? { status: read.status, level: read.level, exitCode: read.exitCode, logArtifactId: latest?.logArtifactId ?? own.logArtifactId,
      detail: read.status === "passed" ? `${words} passed.` : `${words} failed (exit ${read.exitCode}).` } : {}) };
}

function buildChecks(store: Store, root: string | undefined, runId: number): AssignmentChecks {
  const level = runCheckLevel(store, runId);
  const unavailable = (detail: string): AssignmentChecks => ({ status: "unavailable", exitCode: null, command: null, logArtifactId: null, detail, level });
  if (root === undefined) return unavailable("Saved checks are unavailable.");
  try {
    const gate = verificationEvidence(store, root, runId);
    if (!gate.ok) return unavailable(gate.problem);
    const receipt = gate.bytes === null ? null : JSON.parse(gate.bytes);
    if (receipt === null) return { ...unavailable(level === "off" ? "Checks were off for this build." : "No machine check is recorded."), status: "not-run" };
    const ran = receipt.result.ran === true, exitCode = ran ? receipt.result.exitCode : null;
    // The sealed receipt names the grant that ran: the quick one, or the full one.
    const sealedLevel: CheckLevel = typeof receipt.command?.repo === "string" && receipt.command.repo.startsWith("quick:") ? "quick" : "full";
    const words = sealedLevel === "quick" ? "Quick checks" : "Checks";
    return { status: ran ? exitCode === 0 ? "passed" : "failed" : "not-run", exitCode,
      command: receipt.command.command, logArtifactId: receipt.log.artifactId, level: level === null ? null : sealedLevel,
      detail: ran ? exitCode === 0 ? `${words} passed.` : `${words} failed (exit ${exitCode}).` : `${words} did not finish.` };
  } catch { return unavailable("Saved checks could not be read."); }
}

export function assignmentOf(store: Store, taskId: string, now: Date, access: AssignmentAccess, root?: string): AssignmentSnapshot | null {
  const family = store.taskFamilyOf(taskId, access.repos, access.principal === "operator" && access.includeUnplaced === true);
  if (family === null) return null;
  const current = family.current;
  const work = taskWorkSummaryOf(store, current.id, now, access);
  if (work === null) return null;
  const result = work.resultRunId === null ? null : store.getRun(work.resultRunId);
  const proof = result === null ? null : store.proofVerdictFor(result.id);
  const acceptance = result === null ? null : store.proofAcceptance(result.id);
  const scope = store.getScope(current.id);
  const owner = ownerOf(store, family.root.id, current.repo);
  const attention: string[] = family.problem === null ? [] : [family.problem];
  // Family admission above precedes question bodies. The newest result
  // does not settle an unanswered question on any earlier version.
  const questions = [current, ...family.versions.filter(version => version.id !== current.id)].flatMap(version => {
    const decision = openWorkDecisionOf(store, version.refId, now);
    return decision === null ? [] : [{ taskId: version.id, decision }];
  });
  // A finished task label cannot hide a lease or an unfinished process record.
  const busy = (version: typeof current): boolean => version.state === "running" || store.currentLiveLease(version.refId, now) !== null ||
    store.runsFor(version.refId).some(run => run.outcome === null || store.stopQuiescenceProblem(run.id) !== null);
  const earlierActive = family.versions.filter(version => version.id !== current.id && (version.state === "queued" || busy(version)));
  // Of those, how many have work under way (the rest only wait in the queue).
  const earlierRunning = earlierActive.filter(busy).length;
  const unfinished = store.runsFor(current.refId).find(run => run.outcome === null) ?? null;
  const attempts = family.versions.map(version => {
    const summary = version.id === current.id ? work : taskWorkSummaryOf(store, version.id, now, access);
    return { taskId: version.id, runId: summary?.liveRunId ?? summary?.resultRunId ?? null,
      label: summary?.status.label ?? version.state, detail: summary?.status.detail ?? "Status is unavailable." };
  });
  const artifacts = result === null ? [] : store.artifactsFor(result.id);
  const reports = artifacts.filter(a => a.kind === "report");
  const unavailable = family.versions.flatMap(version => store.runsFor(version.refId).flatMap(run =>
    store.artifactsFor(run.id).filter(artifact => root === undefined || !readVerifiedArtifact(root, artifact).ok)
      .map(artifact => `Saved ${artifact.kind} #${artifact.id} (run ${run.id}) is unavailable or changed.`)));
  const checks = result === null ? null : assignmentChecksForRun(store, root, result.id, now);
  const finishedBuild = result?.role === "builder" && (result.outcome === "built" || result.outcome === "no-change") &&
    result.finishedAt !== null && /^[a-f0-9]{40}$/.test(result.headRevision ?? "");
  // Finished work returns to its lead or user. Strict terms and previous model
  // judgments stay recorded; neither is a second execution stage for handoff.
  const completionKind: AssignmentReceipt["completionKind"] = result?.role === "scout" && result.outcome === "built" && result.finishedAt !== null ? "research-report"
    : finishedBuild && acceptance !== null ? "accepted-exception"
    : finishedBuild ? checks?.status === "passed" ? "checked-build" : "finished-build" : null;
  const receiptBody = result === null ? null : {
    rootId: family.root.id, taskId: current.id, runId: result.id, base: result.baseRevision,
    head: result.headRevision, scopeDigest: result.scopeDigest ?? null, proof, completionKind, proofAcceptance: acceptance, checks: checks!,
    artifacts: artifacts.map(a => ({ id: a.id, kind: a.kind, sha256: a.sha256, bytes: a.bytesStored,
      complete: !a.truncated && a.captureStatus !== "failed" })),
    // Stored verdict limitations are separate from the agent's outcome.
    // Full agent caveats remain in the referenced proof artifact.
    caveats: [...(proof?.reasons ?? []), ...unavailable,
      ...(completionKind === "research-report" && reports.length !== 1 ? ["The report artifact is missing or ambiguous."] : []), ...(completionKind === "accepted-exception" && !artifacts.some(a => a.kind === "proof") ? ["No builder proof artifact is recorded."] : []),
      ...(artifacts.some(a => a.kind === "check-log" && a.truncated) ? ["The check log was shortened when stored; only the retained output is available."] : []),
      ...artifacts.filter(a => a.kind !== "check-log" && (a.truncated || a.captureStatus === "failed")).map(a => `Saved ${a.kind} #${a.id} is ${a.captureStatus === "failed" ? "a failed capture" : "incomplete"}.`)],
    agentReport: result.handoff, evidence: "recorded" as const,
  };
  // The digest seals the proof, not how it is shown: the check's `level` (read from its sealed command) and `running`
  // (a follow-up in flight) stay out of it, so a result completed before check levels keeps its completion, and a
  // follow-up check that is still running never unseals one.
  const sealedBody = receiptBody === null ? null : { ...receiptBody, checks: sealedChecks(receiptBody.checks) };
  const receipt = receiptBody === null ? null : { ...receiptBody, digest: digest({ receipt: sealedBody,
    scope: scope === null ? null : { digest: scope.digest, approved: approvalOf(scope).approved, termsProblem: scope.termsProblem ?? null },
    versions: family.versions.map(v => ({ id: v.id, state: v.state })) }) };
  let completion: AssignmentSnapshot["completion"] = null;
  let state: AssignmentSnapshot["state"] = "working";
  let detail = work.status.detail;
  let primaryAction = work.primaryAction;
  const live = work.liveRunId !== null || work.status.token === "running";
  const processFact = result === null ? null : stopFactOf(store, result.id);
  const processProblem = processFact?.problem ?? null;
  let need: AssignmentSnapshot["need"] = null;
  // The exact completed result, scope, family and custody fences apply to
  // every deliverable. Human acceptance remains its own recorded authority;
  // it never changes a machine verdict or supplies a missing report.
  // Kept out of the sealed receipt (sealedChecks): the review never changes the result's digest.
  const review = result === null ? null : olderStoreSafe(() => buildReviewOf(store, result.id), null);
  // A result under its one automatic review has not reached the person yet.
  const reviewing = review?.state === "pending" && current.state === "done";
  const ready = !reviewing && current.state === "done" && result !== null && completionKind !== null &&
    scope !== null && scope.termsProblem == null && approvalOf(scope).approved && scope.digest === result.scopeDigest &&
    store.activeHolds(current.refId, now).length === 0 && store.applicableStopFor(result.id) === null &&
    processProblem === null &&
    family.problem === null && earlierActive.length === 0 && unfinished === null && store.currentLiveLease(current.refId, now) === null && questions.length === 0;
  if (family.problem !== null) state = "needs-decision";
  else if (current.state === "cancelled") {
    state = "cancelled";
    const successor = olderStoreSafe(() => store.replacementOf(current.id) ?? store.replacementOf(family.root.id), null);
    detail = successor === null ? "This assignment was cancelled." : `${replacedWords(successor)}.`;
    primaryAction = successor === null ? { code: "inspect-task", label: "View assignment", target: { taskId: current.id, runId: null, decisionId: null }, access: "read", retry: "read-again" }
      : { code: "inspect-task", label: `Open ${successor}`, target: { taskId: successor, runId: null, decisionId: null }, access: "read", retry: "read-again" };
  }
  else if (!live && processFact !== null && result !== null) {
    // Toolroll can't confirm the build stopped. A person confirms it when
    // nothing of it may still run; otherwise the work waits, needing no one.
    const process = processNeedOf(processFact)!;
    if ("need" in process) {
      state = "needs-decision";
      detail = NEEDS[process.need].sentence({ build: process.build });
      primaryAction = { code: "confirm-stopped", label: NEEDS[process.need].action.label, target: { taskId: current.id, runId: process.build, decisionId: null },
        access: access.principal === "operator" ? "operator-control" : "operator-handoff", retry: "refresh-before-acting" };
      need = { key: process.need, build: process.build };
    } else {
      state = "working";
      detail = WAITS[process.wait]({ build: process.build });
      primaryAction = { code: "inspect-run", label: "View the build", target: { taskId: current.id, runId: process.build, decisionId: null }, access: "read", retry: "read-again" };
      need = { wait: process.wait, build: process.build };
    }
  }
  else if (current.state === "done" && questions.length > 0 && work.status.tone !== "problem" &&
    !["stopping", "stopped", "review-failed", "review-exhausted"].includes(work.status.token) &&
    store.activeHolds(current.refId, now).length === 0 && (result === null || store.applicableStopFor(result.id) === null)) {
    const question = questions[0]!;
    state = "needs-decision";
    detail = question.decision.question;
    primaryAction = workDecisionAction(question.taskId, question.decision, access.principal);
  }
  else if (reviewing && result !== null) {
    state = "checking";
    detail = "An automatic review is reading this result before it reaches you.";
    primaryAction = { code: "inspect-run", label: "Open result", target: { taskId: current.id, runId: result.id, decisionId: null }, access: "read", retry: "read-again" };
  }
  else if (ready && receipt !== null) {
    state = "ready-to-check";
    detail = completionKind === "research-report" ? "The research report is ready for the lead to read."
      : completionKind === "accepted-exception" ? "An operator accepted this result with its recorded limitations. The lead can inspect that decision; the recorded checks are unchanged."
      : receipt.checks.detail;
    primaryAction = { code: "open-result", label: completionKind === "research-report" ? "Read report" : "Open result", target: { taskId: current.id, runId: result!.id, decisionId: null }, access: "read", retry: "read-again" };
    const checked = store.handle.prepare("SELECT actor,at FROM action_ledger WHERE task_id = ? AND run_id = ? AND action = ? AND outcome = ? AND source = 'work' ORDER BY id DESC")
      .all(family.root.id, result!.id, CHECK_ACTION, receipt.digest).find(row => /^(operator|coordinator|lead):.+/.test(String(row["actor"])));
    // This ledger fact was authorized when written. Credential rotation,
    // membership changes and ownership transfer cannot revoke past completion.
    // The exact result digest still fences changes to work, scope and history.
    if (checked !== undefined) {
      const rootRef = store.lookupRef(family.root.id);
      const byLead = rootRef !== null && olderStoreSafe(() => store.taskActs(rootRef.id), []).filter(one => one.act === "completed").at(-1)?.lead === true;
      completion = { actor: String(checked["actor"]), at: String(checked["at"]), digest: receipt.digest, ...(byLead ? { lead: true as const } : {}) };
      state = "complete";
      primaryAction = { ...primaryAction, label: completionKind === "research-report" ? "Read report" : "Open result" };
      const label = byLead ? "the lead" : completion.actor.startsWith("operator:") ? completion.actor.slice(9) : owner && completion.actor === actorOf(owner) ? owner.label : "the previous lead";
      detail = completionKind === "research-report" ? `Research report checked by ${label}. No deployment is implied.`
        : `Handled by ${label}. ${receipt.checks.detail} Publication and deployment are separate.`;
    }
  } else if (work.status.rank === 0 || (!live && (current.state === "done" || current.state === "failed" || work.status.views.includes("needs-you")))) {
    state = "needs-decision";
    if (current.state === "done" && work.status.tone !== "attention" && work.status.tone !== "problem") detail = result?.role === "scout"
      ? completionKind === null ? "The research report is missing or incomplete. Inspect the saved report before checking this handoff."
        : "The saved report is awaiting resolution of its current scope or hold."
      : resultHoldUpSentence({ hold: store.activeHolds(current.refId, now)[0]?.reason ?? null,
          planChanged: result !== null && scope !== null && !!result.scopeDigest && scope.digest !== result.scopeDigest,
          unapproved: scope === null || scope.termsProblem != null || !approvalOf(scope).approved, question: questions.length > 0,
          running: store.currentLiveLease(current.refId, now) !== null, unfinished: unfinished !== null,
          noCommit: result === null || completionKind === null });
    // Built to an earlier plan: the result page can't resolve it (accepting would leave it stuck), building again can.
    if (current.state === "done" && result !== null && scope !== null && scope.termsProblem == null && approvalOf(scope).approved && !!result.scopeDigest && scope.digest !== result.scopeDigest &&
      store.activeHolds(current.refId, now).length === 0 && unfinished === null && store.currentLiveLease(current.refId, now) === null && store.finalResultReason(result.id) === null) {
      detail = NEEDS.rebuild.sentence({ build: result.id });
      primaryAction = { code: "retry-task", label: NEEDS.rebuild.action.label, target: { taskId: current.id, runId: result.id, decisionId: null },
        access: access.principal === "operator" ? "operator-control" : "operator-handoff", retry: "refresh-before-acting" };
      need = { key: "rebuild", build: result.id };
    }
  }
  if (earlierActive.length > 0) {
    attention.push(`${earlierActive.length} earlier task version${earlierActive.length === 1 ? " is" : "s are"} still active.`);
    if (state === "ready-to-check" || state === "complete" || current.state === "done") {
      state = "needs-decision";
      detail = "Earlier work is still active. Resolve it before completing this assignment.";
      const earlier = earlierActive[0]!;
      primaryAction = taskWorkSummaryOf(store, earlier.id, now, access)?.primaryAction ?? {
        code: "inspect-task", label: "Review active work", target: { taskId: earlier.id, runId: null, decisionId: null }, access: "read", retry: "read-again",
      };
    }
  }
  if (state === "needs-decision") attention.push(detail);
  // Every Needs you action wears its need's own words (needs-you.ts), on every surface.
  if (state === "needs-decision" && primaryAction !== null && need === null) {
    const read = assignmentStageOf({ state, primaryAction, review }, { token: work.status.token, views: work.status.views });
    // A result review keeps its own, more specific words (See what is missing, Open the failed check).
    if (read.stage === "needs-you" && read.need !== undefined && read.need !== "other" && read.need !== "review-result") primaryAction = { ...primaryAction, label: NEEDS[read.need].action.label };
  }
  if (receipt !== null) {
    if (finishedBuild && receipt.checks.status !== "passed") attention.push(receipt.checks.detail);
    if (proof?.verdict !== "verified") attention.push(...(proof?.reasons ?? []).filter(reason => !historicalAssessmentReason(reason)));
    attention.push(...receipt.caveats.filter(reason => !proof?.reasons.includes(reason)));
  }
  if (review !== null && review.sentBackAs === null) {
    if (review.state === "not-reviewed") attention.push(`Not reviewed: ${review.reason ?? "the automatic review did not finish"}.`);
    attention.push(...review.high.map(one => `Review: ${findingWords(one)}`));
  }
  if (state !== "complete") completion = null;
  if (current.state !== "cancelled") attention.push(...questions.map(question => question.decision.question));
  if (owner !== null && !owner.active) attention.push(owner.kind === "lead" ? "This lead is paused. A manager can resume it or transfer responsibility." : "The previous lead no longer has access. Another lead can claim this assignment.");
  const handoff = state === "ready-to-check" || state === "complete" ? { kind: "result" as const, digest: receipt!.digest, acknowledged: state === "complete" }
    : state === "cancelled" ? { kind: "attention" as const, digest: digest({ root: family.root.id, current: current.id, state }), acknowledged: false }
    : state === "needs-decision" ? { kind: primaryAction?.target.decisionId != null ? "decision" as const : "attention" as const,
      digest: digest({ root: family.root.id, current: current.id, detail,
        action: primaryAction === null ? null : { code: primaryAction.code, target: primaryAction.target },
        attention, receipt: receipt?.digest ?? null }), acknowledged: false } : null;
  const publication = result === null ? null : store.publicationForRun(result.id);
  const lead = state === "complete" || state === "cancelled" || access.principal !== "operator" ? null : leadClaimOf(store, family.root.id, now, access.viewer);
  // Existing saved inputs and output, read only after family admission. Keep
  // polling briefs small; full reads disclose exactly which excerpts are shortened.
  const planId = result?.planRevision == null ? null : store.getPlanRevision(result.planRevision)?.artifact;
  const plan = planId == null ? store.latestPlanArtifact(current.refId) : store.getArtifact(planId);
  const selected = [plan, ...["terminal-diff", "check-log", "report", "handoff"].map(kind =>
    artifacts.filter(artifact => artifact.kind === kind).at(-1) ?? null)].filter((one): one is Artifact => one !== null);
  const savedContext = { goal: scope?.goal ?? null, outOfScope: scope?.outOfScope ?? null,
    excerpts: selected.map(artifact => {
      const read = root === undefined ? null : readVerifiedArtifact(root, artifact);
      const text = read?.ok ? read.content.toString("utf8") : null;
      return { artifactId: artifact.id, runId: artifact.run, kind: artifact.kind, sha256: artifact.sha256,
        text: text?.slice(0, 8000) ?? null, shortened: artifact.truncated || (text?.length ?? 0) > 8000,
        problem: read?.ok ? artifact.captureStatus === "failed" ? "The original capture failed." : null : "Saved bytes are unavailable or changed." };
    }) };
  return { version: 1, rootId: family.root.id, activeTaskId: current.id, repo: current.repo, title: family.root.title,
    state, detail, primaryAction, attention: [...new Set(attention)], attempts, owner, receipt, savedContext, completion, handoff,
    publication: publication === null ? null : { state: publication.state, prUrl: publication.prUrl, remoteState: publication.remoteState },
    review, deployment: { status: "not-recorded" }, ...(need === null ? {} : { need }), ...(lead === null ? {} : { lead }), ...(earlierActive.length === 0 ? {} : { earlierActive: earlierActive.length, earlierRunning }) };
}

type MutationResult = { ok: true; assignment: AssignmentSnapshot } | { ok: false; reason: string; message: string };
function admittedOwner(store: Store, taskId: string, owner: AssignmentOwner, now: Date, root?: string): AssignmentSnapshot | null {
  if (owner.kind !== "coordinator") return null; // A stable lead is identity, not a bearer credential.
  const row = store.handle.prepare("SELECT repos, revoked_at FROM coordinator_credential WHERE cid = ?").get(owner.id);
  if (row === undefined || row["revoked_at"] !== null) return null;
  let repos: unknown;
  try { repos = JSON.parse(String(row["repos"])); } catch { return null; }
  if (!Array.isArray(repos) || repos.some(r => typeof r !== "string")) return null;
  return assignmentOf(store, taskId, now, { principal: "coordinator", repos }, root);
}
export function claimAssignment(store: Store, taskId: string, owner: AssignmentOwner, now: Date, root?: string): MutationResult {
  return store.transact(() => {
    const current = admittedOwner(store, taskId, owner, now, root);
    if (current === null) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
    if (current.owner?.kind === "lead" || current.owner?.active && current.owner.id !== owner.id) return { ok: false, reason: "owned", message: "Another lead already owns this assignment." };
    if (current.owner?.id !== owner.id) {
      store.recordAction({ at: now.toISOString(), actor: actorOf(owner), repo: current.repo,
        taskId: current.rootId, runId: null, action: OWNER_ACTION, outcome: "owner", source: "work" });
      store.bumpWake();
    }
    const assignment = admittedOwner(store, current.rootId, owner, now, root)!;
    noteAssignmentHandoff(store, assignment, now);
    noteAssignmentStatus(store, assignment, now);
    return { ok: true, assignment };
  });
}

/** Diagnostic only: artifact availability does not authorize or block a human
 * handoff. Deployment independently validates its actual native check. */
export function assignmentEvidenceIntact(store: Store, root: string, receipt: AssignmentReceipt): boolean {
  try {
    const family = store.taskFamilyOf(receipt.taskId, null, true);
    if (family === null || family.problem !== null || family.root.id !== receipt.rootId ||
      !family.versions.every(version => store.runsFor(version.refId).every(run =>
        store.artifactsFor(run.id).every(artifact => readVerifiedArtifact(root, artifact).ok)))) return false;
    if (receipt.completionKind === "research-report") {
      const report = readVerifiedReport(store, root, store.lookupRef(receipt.taskId)!.id);
      return report?.ok === true && report.run === receipt.runId;
    }
    return receipt.completionKind !== null;
  } catch { return false; }
}

function acknowledgeCurrent(store: Store, current: AssignmentSnapshot, receiptDigest: string, actor: string, now: Date, root: string, access: AssignmentAccess): MutationResult {
  if (!/^[a-f0-9]{64}$/.test(receiptDigest) || current.receipt?.digest !== receiptDigest) return { ok: false, reason: "stale", message: "The result changed. Read the current assignment before checking it." };
  const receipt = current.receipt;
  if (current.state !== "ready-to-check" && current.state !== "complete") return { ok: false, reason: "not-ready", message: "This assignment still has unresolved execution, scope or decisions." };
  if (current.state !== "complete") {
    // v102: declared paths are only a promise. A result whose actual diff reaches protected files, on a
    // scope one person approved, completes only by someone else — two people have then seen the work.
    const problem = store.protectedResultProblem(receipt.taskId, familyChangedFiles(store, receipt.taskId, receipt.runId, root), actor.startsWith("operator:") ? actor.slice("operator:".length) : null);
    if (problem !== null) return { ok: false, reason: "approval-rules", message: problem };
    store.recordAction({ at: now.toISOString(), actor, repo: current.repo,
      taskId: current.rootId, runId: receipt.runId, action: CHECK_ACTION, outcome: receiptDigest, source: "work" });
    const ref = store.lookupRef(current.rootId);
    // Whose act this is, even outside a command that named its person: the operator who marked it.
    const by = currentActor() ?? (actor.startsWith("operator:") ? { account: actor.slice("operator:".length), lead: false } : null);
    if (ref !== null) store.noteTaskAct(ref.id, "completed", now, undefined, by);
    store.bumpWake();
  }
  const assignment = assignmentOf(store, current.rootId, now, access, root)!;
  noteAssignmentStatus(store, assignment, now);
  return { ok: true, assignment };
}

export function checkAssignment(store: Store, taskId: string, receiptDigest: string, owner: AssignmentOwner, now: Date, root = evidenceRoot(homedir())): MutationResult {
  return store.transact(() => {
    const current = admittedOwner(store, taskId, owner, now, root);
    if (current === null) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
    if (current.owner?.kind !== owner.kind || current.owner.id !== owner.id || !current.owner.active) return { ok: false, reason: "not-owner", message: "Claim this assignment before checking its handoff." };
    return acknowledgeCurrent(store, current, receiptDigest, actorOf(owner), now, root, { principal: "coordinator", repos: [current.repo!] });
  });
}

/** The signed-in user can mark the same exact receipt handled without taking
 * lead ownership. This records review, never check success or new authority. */
export function checkAssignmentAsOperator(store: Store, taskId: string, receiptDigest: string, who: VerifiedApprover, now: Date, root = evidenceRoot(homedir())): MutationResult {
  // Completing is this person's act (or their lead's): it never pings them.
  return withActor(currentActor() ?? { account: who.name, lead: false }, () => store.transact(() => {
    if (!reproveApprover(store, who).ok) return { ok: false, reason: "unauthenticated", message: "Sign in again before marking this result complete." };
    const access: AssignmentAccess = { principal: "operator", repos: who.repos };
    const current = assignmentOf(store, taskId, now, access, root);
    if (current === null || !store.accountCanAccess(who.name, current.repo)) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
    return acknowledgeCurrent(store, current, receiptDigest, `operator:${who.name}`, now, root, access);
  }));
}

/** The acceptance's own ledger act, as a separate Accept request records it. */
export const ACCEPT_ACTION = "task accept-proof";

/** Only a person's check stands between this result and done: its proof is short for that alone, and nobody accepted it. */
export function personCheckPending(receipt: AssignmentReceipt | null): boolean {
  return receipt !== null && receipt.proofAcceptance === null && manualReviewOnly(receipt.proof === null ? null : { verdict: receipt.proof.verdict, reasons: receipt.proof.reasons, matrix: receipt.proof.matrix });
}

type Finished = { ok: true } | { ok: false; reason: string; message: string };
class Undone extends Error { constructor(readonly result: { ok: false; reason: string; message: string }) { super(result.message); } }

/** An acceptance this receipt owes before it finishes, by the result page's own rule: the person's own check
 * (no reason needed), or an exception a report that doesn't match its changes needs a reason for. Null when
 * Accept and finish is a plain completion: nothing is owed (no proof, a failed check, or a verified result),
 * or it was already accepted. */
export function owedAcceptance(receipt: AssignmentReceipt | null): "person-check" | "exception" | null {
  if (receipt === null || receipt.proofAcceptance !== null) return null;
  if (personCheckPending(receipt)) return "person-check";
  return cantAcceptYetOf(receipt.proof?.verdict ?? null, receipt.proof?.reasons ?? [], false) === ACCEPT_NEEDS_REASON ? "exception" : null;
}

/** Accept and finish: the person's acceptance of the exact result they read and its completion, in one
 * transaction. Whether an acceptance is owed is decided here, against the receipt as it stands: only a
 * person's own check or a reasoned exception records one (with its ledger act); an exception without its
 * reason is refused; anything else is the plain completion Mark complete always was. The completion names the receipt the acceptance produced, under the
 * same digest a separate Accept then Mark complete leave. `receiptDigest` is the receipt as read, before
 * accepting (`runId`, when named, must be its run); any other change refuses both, and a refused completion
 * keeps no acceptance. `finish` completes the receipt (Mark complete by default; Complete and open a pull
 * request passes its own). */
export function acceptAndCompleteAsOperator(store: Store, taskId: string, input: { runId: number | null; receiptDigest: string; note: string | null },
  who: VerifiedApprover, now: Date, root = evidenceRoot(homedir()),
  finish: (digest: string) => Finished = digest => checkAssignmentAsOperator(store, taskId, digest, who, now, root)): Finished {
  try {
    return withActor(currentActor() ?? { account: who.name, lead: false }, () => store.transact((): Finished => {
      if (!reproveApprover(store, who).ok) return { ok: false, reason: "unauthenticated", message: "Sign in again before accepting this result." };
      const access: AssignmentAccess = { principal: "operator", repos: who.repos };
      const before = assignmentOf(store, taskId, now, access, root);
      if (before === null || !store.accountCanAccess(who.name, before.repo)) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
      const receipt = before.receipt;
      if (receipt === null || (input.runId !== null && receipt.runId !== input.runId) || !/^[a-f0-9]{64}$/.test(input.receiptDigest) || receipt.digest !== input.receiptDigest) {
        return { ok: false, reason: "stale", message: "This result changed. Open the current result before accepting it." };
      }
      // Already complete, or nothing owed: the plain completion of the receipt as read.
      const owed = before.state === "ready-to-check" ? owedAcceptance(receipt) : null;
      // An exception is accepted only with its reason: never a completion that skips it.
      if (owed === "exception" && input.note === null) return { ok: false, reason: "needs-reason", message: `${ACCEPT_NEEDS_REASON}.` };
      let digest = receipt.digest;
      if (owed !== null) {
        store.acceptProof(receipt.runId, who.name, input.note, now);
        store.recordAction({ at: now.toISOString(), actor: who.name, repo: before.repo, taskId, runId: null, action: ACCEPT_ACTION, outcome: "accepted", source: "request" });
        const accepted = assignmentOf(store, taskId, now, access, root)?.receipt ?? null;
        if (accepted === null || accepted.runId !== receipt.runId) throw new Undone({ ok: false, reason: "stale", message: "This result changed. Open the current result before accepting it." });
        digest = accepted.digest;
      }
      const done = finish(digest);
      if (!done.ok) throw new Undone(done);
      return done;
    }));
  } catch (error) {
    if (error instanceof Undone) return error.result;
    throw error;
  }
}

function noteAssignmentHandoff(store: Store, assignment: AssignmentSnapshot, now: Date): void {
  if (!assignment.owner?.active || assignment.handoff === null || assignment.handoff.acknowledged) return;
  const ref = store.lookupRef(assignment.rootId);
  if (!ref || !ref.repo) return;
  store.enqueueNotification({ dedupeKey: `assignment:${ref.id}:${assignment.owner.id}:${assignment.handoff.digest}`,
    kind: "assignment-handoff", source: { taskRef: ref.id }, subject: assignment.state === "cancelled" ? "Assignment cancelled" : assignment.state === "ready-to-check" ? "Ready" : "Assignment needs a decision",
    body: assignment.detail, link: `/t/${encodeURIComponent(assignment.rootId)}` }, now);
}

/** The ordinary worker reconciles at most 50 owned roots per pass. A lost
 * wakeup is recovered after restart; immutable notification keys dedupe it. */
export function syncAssignmentHandoffs(store: Store, now: Date, repos: readonly string[], root?: string): void {
  if (repos.length === 0) return;
  store.transact(() => {
  const key = `assignment-handoff:${digest([...new Set(repos)].sort())}`;
  const cursor = store.serviceCursor(key);
  const rows = store.handle.prepare(`SELECT t.id,t.external_id FROM task_ref t WHERE t.backend = 'built-in' AND t.revision_of IS NULL
    AND t.repo IN (SELECT value FROM json_each(?)) AND t.id > ?
    AND (t.coordinator_cid IS NOT NULL OR EXISTS(SELECT 1 FROM team_task_owner o WHERE o.task_ref=t.id) OR EXISTS (SELECT 1 FROM action_ledger a WHERE a.task_id = t.external_id AND a.action = ?))
    ORDER BY t.id LIMIT 50`).all(JSON.stringify(repos), cursor, OWNER_ACTION);
  for (const row of rows) {
    const assignment = assignmentOf(store, String(row["external_id"]), now, { principal: "operator", repos }, root);
    if (assignment !== null) {
      noteAssignmentHandoff(store, assignment, now);
      noteAssignmentStatus(store, assignment, now);
    }
  }
  store.setServiceCursor(key, rows.length < 50 ? 0 : Number(rows.at(-1)!["id"]), now);
  });
}

export function assignmentUpdates(store: Store, now: Date, access: AssignmentAccess, query: { after: number; limit: number }, root?: string) {
  const after = Number.isSafeInteger(query.after) && query.after >= 0 ? query.after : 0;
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit) || 50));
  const rows = store.handle.prepare(`SELECT n.id,n.task_id,n.dedupe_key,n.created_at FROM notification n
    JOIN task_ref t ON t.id = n.task_ref AND t.backend = 'built-in' AND t.external_id = n.task_id AND t.repo = n.project
    WHERE n.id > ? AND n.kind = 'assignment-handoff' AND n.provenance_scope = 'task'
      AND (? = 1 OR n.project IN (SELECT value FROM json_each(?))) ORDER BY n.id LIMIT ?`)
    .all(after, access.repos === null ? 1 : 0, JSON.stringify(access.repos ?? []), limit + 1);
  const page = rows.slice(0, limit);
  const events = page.flatMap(row => {
    const assignment = assignmentOf(store, String(row["task_id"]), now, access, root);
    if (assignment === null) return [];
    const parts = String(row["dedupe_key"]).split(":");
    const receiptDigest = parts.at(-1)!;
    return [{ id: Number(row["id"]), createdAt: String(row["created_at"]), rootId: assignment.rootId, digest: receiptDigest,
      superseded: assignment.handoff?.digest !== receiptDigest || assignment.owner?.id !== parts.at(-2), assignment: assignmentBrief(assignment)! }];
  });
  return { events, nextCursor: page.length === 0 ? after : Number(page.at(-1)!["id"]), hasMore: rows.length > limit };
}
