// Deployment uses a real passing project check and the lead/user's decision
// about that exact result. It never schedules or depends on a model reviewer.
export function deploymentCandidate(store, { runId, head, evidenceRoot, now }, { assignmentOf, verificationEvidence }) {
  const requireFact = (value, message) => { if (!value) throw Error(message); };
  const run = store.getRun(runId);
  const ref = run ? store.refById(run.taskRef) : null;
  const scope = ref ? store.getScope(ref.externalId) : null;
  // `task regate` reruns the approved check on the last built commit and
  // records no-change. It is a candidate only for that same commit; its own
  // receipt and completion are held to the checks below like any build.
  const regated = run?.outcome === 'no-change' && scope?.candidate === head &&
    store.runsFor(run.taskRef).find(one => one.id < runId && one.role === 'builder' && one.outcome === 'built')?.headRevision === head;
  requireFact(run?.role === 'builder' && (run.outcome === 'built' || regated) && run.headRevision === head,
    `Run ${runId} is not a built candidate at ${head.slice(0, 7)}.`);
  requireFact(scope && scope.approvedDigest === scope.digest && scope.digest === run.scopeDigest,
    "The run's signed scope is no longer the approved one.");
  const evidence = verificationEvidence(store, evidenceRoot, runId);
  requireFact(evidence.ok && evidence.bytes, `Native check unavailable: ${evidence.problem ?? 'no receipt'}.`);
  const gate = JSON.parse(evidence.bytes);
  const live = store.liveVerifyCommand(ref.repo);
  requireFact(gate.run === runId && gate.head === head && gate.scopeDigest === scope.digest &&
    gate.result?.ran === true && gate.result.exitCode === 0 && live && gate.command.command === live.command,
    'The native check did not pass this candidate under the currently approved command.');
  const assignment = assignmentOf(store, ref.externalId, now,
    { principal: 'operator', repos: null, includeUnplaced: true }, evidenceRoot);
  requireFact(assignment?.state === 'complete' && assignment.receipt?.runId === runId &&
    assignment.receipt.head === head && assignment.receipt.scopeDigest === scope.digest &&
    assignment.completion?.digest === assignment.receipt.digest,
    'The lead or user has not marked this exact result complete.');
  // The same readiness guard as task complete, read now: a failed or missing required check, an unresolved
  // requirement or an unresolved HIGH finding refuses (a requirement a release check covers counts as passed).
  const blockers = assignment.readiness?.blockers;
  requireFact(Array.isArray(blockers), 'The result\'s readiness could not be read.');
  requireFact(blockers.length === 0, `This result isn't ready to deploy: ${blockers.map(one => one.message).join(' ')}`);
  return { taskId: ref.externalId, repo: ref.repo, scopeDigest: scope.digest,
    completion: assignment.completion, gateDigest: evidence.digest,
    proofVerdict: store.proofVerdictFor(runId)?.verdict ?? null,
    acceptance: store.proofAcceptance(runId), criteria: scope.acceptance.length,
    worktree: run.worktree, gate };
}
