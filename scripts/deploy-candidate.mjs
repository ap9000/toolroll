// Deployment uses a real passing project check and the lead/user's decision
// about that exact result. It never schedules or depends on a model reviewer.
export function deploymentCandidate(store, { runId, head, evidenceRoot, now, releaseFlow = false, nightlyRefreshed = false }, { assignmentOf, verificationEvidence, installedScope, installedNightly }) {
  const requireFact = (value, message) => { if (!value) throw Error(message); };
  const run = store.getRun(runId);
  const ref = run ? store.refById(run.taskRef) : null;
  const scope = ref ? store.getScope(ref.externalId) : null;
  // `task regate` reruns the approved check on the last built commit and
  // records no-change. It is a candidate only for that same commit; its own
  // receipt and completion are held to the checks below like any build. A
  // prepared candidate's build records a commit of its own with exactly the
  // candidate's tree; its rerun under the same signed scope is that check again.
  const built = run ? store.runsFor(run.taskRef).find(one => one.id < runId && one.role === 'builder' && one.outcome === 'built') : undefined;
  const regated = run?.outcome === 'no-change' && built?.headRevision === head &&
    (scope?.candidate === head || ((scope?.candidate ?? null) !== null && built.scopeDigest === run.scopeDigest));
  requireFact(run?.role === 'builder' && (run.outcome === 'built' || regated) && run.headRevision === head,
    `Run ${runId} is not a built candidate at ${head.slice(0, 7)}.`);
  requireFact(scope && scope.approvedDigest === scope.digest && scope.digest === run.scopeDigest,
    "The run's signed scope is no longer the approved one.");
  // The same gate as the installed deploy-gate.ts, read from the plane even when its runtime predates this rule.
  // A person's approval during CI must not let a direct deployment bypass the coordinator's wait.
  const ci = store.handle.prepare("SELECT action FROM action_ledger WHERE task_id = ? AND action IN (?, ?) ORDER BY id DESC LIMIT 1")
    .get(ref.externalId, "release asked while CI runs", "release approval CI passed");
  requireFact(ci?.action !== "release asked while CI runs", "This release still waits for GitHub CI. Resume it with `toolroll release`.");
  // Only a person's approval deploys (docs/plans/approval-policy.md §1.7): the ceremony or a paired-chat tap, with a
  // person's proof recorded for these exact words — never the lead, a mode, a flow or a schedule. Every phase, resumed
  // ones included, proves the candidate through here. The answer comes from the INSTALLED runtime's scope.js when it
  // has one, else from the plane's own records read here; never from the candidate being deployed, which would decide
  // its own authorization.
  // One approval per release (docs/plans/release-once.md): a task that belongs to a release authority deploys only
  // while the live-release predicate accepts it, read by the INSTALLED runtime; one too old to read release authority
  // refuses every such task rather than reinterpret what it can't read. The predicate proves the anchor's person
  // approval; a carried commit's own seal is never a person's.
  const release = typeof installedScope?.liveReleaseOf === 'function'
    ? installedScope.liveReleaseOf(store, ref.externalId, 'deploy', now)
    : releaseFromRecords(store, ref.externalId);
  requireFact(release?.applies === false || release?.ok === true, `This release can't deploy: ${release?.why ?? 'its release record cannot be read'}.`);
  const approvedTask = release?.applies === true ? release.authority.anchorTask : ref.externalId;
  // GitHub's nightly lane debt (docs/plans/evals-nightly.md, part A2) holds every deploy of the project, a person's
  // approval or not, unless this exact candidate holds a fresh exemption. Read by the INSTALLED runtime; one too old to
  // read the debt refuses while any is open rather than reinterpret what it can't read. An exemption counts only after
  // THIS deployment re-read it (`nightlyRefreshed`: the installed runtime's refreshNightlyForDeploy ran just now);
  // otherwise every open failure holds, exemption or not (Codex round 2, finding 3).
  const nightly = typeof installedNightly?.nightlyDebtHold === 'function'
    ? installedNightly.nightlyDebtHold(store, { repo: ref.repo, taskId: nightlyRefreshed === true ? ref.externalId : null, candidate: scope.candidate ?? head, phase: 'deploy', release: release?.applies === true, now })
    : nightlyDebtFromRecords(store, ref.repo);
  requireFact(nightly === null, nightly?.why);
  // A release's own automatic approval (docs/plans/auto-approve-green.md) stands only inside `toolroll release`: the
  // deploy it reserved (--operation, whose secret this run proves before staging anything), read by the INSTALLED
  // runtime. A direct deploy, or a runtime too old to read it, needs a person's approval.
  const person = releaseFlow === true && release?.applies === true && typeof installedScope?.releaseApprovalOf === 'function'
    ? installedScope.releaseApprovalOf(store, approvedTask, now)
    : typeof installedScope?.personApprovalOf === 'function'
    ? installedScope.personApprovalOf(store, approvedTask)
    : personApprovalFromRecords(store, approvedTask);
  requireFact(person?.ok === true, `A person has to approve this candidate's scope: ${person?.why ?? 'its approval cannot be read'}.`);
  const evidence = verificationEvidence(store, evidenceRoot, runId);
  requireFact(evidence.ok && evidence.bytes, `Native check unavailable: ${evidence.problem ?? 'no receipt'}.`);
  const gate = JSON.parse(evidence.bytes);
  // A release check's coverage (receipt version 3): partial or identity-removed never deploys, whatever the exit.
  requireFact(gate.coverage === undefined || gate.coverage === 'full' || gate.coverage === 'composed', `The release check didn't cover this candidate (${gate.coverage}).`);
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
  return { taskId: ref.externalId, repo: ref.repo, scopeDigest: scope.digest, approvedBy: person.by,
    completion: assignment.completion, gateDigest: evidence.digest,
    proofVerdict: store.proofVerdictFor(runId)?.verdict ?? null,
    acceptance: store.proofAcceptance(runId), criteria: scope.acceptance.length,
    worktree: run.worktree, gate };
}

/**
 * For an installed runtime that predates release authority (src/scope.ts liveReleaseOf): a task the plane's records
 * tie to a release authority is refused with "update Toolroll first"; any other task isn't a release's.
 */
export function releaseFromRecords(store, taskId) {
  const db = store.handle;
  const table = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'release_authority'").get();
  if (table === undefined) return { applies: false };
  const belongs = db.prepare("SELECT 1 AS hit FROM release_authority WHERE anchor_task = ? UNION ALL SELECT 1 FROM release_carry WHERE task_id = ? LIMIT 1").get(taskId, taskId);
  return belongs === undefined ? { applies: false } : { applies: true, ok: false, why: 'it belongs to a release this Toolroll can\'t read; update Toolroll first' };
}

/**
 * For an installed runtime that predates GitHub's nightly debt (src/nightly-github.ts): an open lane failure on record
 * for the project refuses with "update Toolroll first"; none (or no such table) holds nothing.
 */
export function nightlyDebtFromRecords(store, repo) {
  const db = store.handle;
  const table = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'nightly_lane_failure'").get();
  if (table === undefined) return null;
  const open = db.prepare("SELECT 1 AS hit FROM nightly_lane_failure WHERE repo = ? AND cleared_at IS NULL LIMIT 1").get(repo);
  return open === undefined ? null : { why: "GitHub's nightly has an open lane failure this Toolroll can't read; update Toolroll first" };
}

/** The proofs a person gives (src/person-proof.ts), for a plane whose installed runtime predates personApprovalOf. */
const PERSON_PROOFS = new Set(['password-now', 'sso-now', 'fresh-password', 'fresh-sso', 'session', 'cli-login', 'chat', 'passkey']);

/** A proof row's detail, either form (src/scope.ts proofDetailOf). */
function proofDigestOf(detail) {
  if (typeof detail !== 'string') return null;
  if (detail.startsWith('{')) {
    try {
      const parsed = JSON.parse(detail);
      return parsed !== null && typeof parsed === 'object' && parsed.v === 1 && typeof parsed.at === 'string' && !Number.isNaN(Date.parse(parsed.at))
        && typeof parsed.digest === 'string' && parsed.digest !== '' ? parsed.digest : null;
    } catch { return null; }
  }
  const parts = detail.split(' · ');
  if (parts.length !== 3 || !parts[2].startsWith('digest ') || !/^generation \d+$/.test(parts[1]) || Number.isNaN(Date.parse(parts[0]))) return null;
  return parts[2].slice('digest '.length);
}

/**
 * Whether a person approved this task as it stands, read straight from the plane's records (src/scope.ts
 * personApprovalOf, for an installed runtime too old to export it): the ceremony or a chat tap on the current digest,
 * with that approver's newest proof row for those bytes a person's. Anything else — a mode, a flow, a schedule, the
 * lead, no proof — is refused.
 */
export function personApprovalFromRecords(store, taskId) {
  const scope = store.getScope(taskId);
  if (!scope || scope.approvedAt == null || scope.approvedBy == null || scope.approvedDigest == null) return { ok: false, why: 'not approved yet' };
  if (scope.approvedDigest !== scope.digest) return { ok: false, why: 'the approval is for different scope text' };
  const basis = scope.approvalBasis ?? null;
  if (basis === 'lead') return { ok: false, why: 'approved by the lead, not by a person' };
  if (basis !== 'password' && basis !== 'chat') return { ok: false, why: `approved by ${basis ?? 'an unknown road'}, not by a person` };
  // The acts recorded at the seal's own instant (src/scope.ts sealOriginOf): a machine's proof or the lead's act there
  // makes it a machine's seal, whatever else is on record; an older proof never vouches for a later seal.
  const rows = store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = 'approval proved' AND actor = ? AND at = ? ORDER BY id DESC")
    .all(taskId, scope.approvedBy, scope.approvedAt);
  // A plane from before lead tokens has no task_act table (it came with them, store.ts LEAD_QUIET_SCHEMA): no lead
  // could have approved there. The proof rows above still have to show a person's yes.
  const hasActs = store.handle.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'task_act'").get() !== undefined;
  const leadAct = hasActs && store.handle.prepare(`SELECT 1 AS hit FROM task_act a JOIN task_ref r ON r.id = a.task_ref AND r.backend = 'built-in'
      WHERE r.external_id = ? AND a.act = 'approved' AND a.lead = 1 AND a.account = ? AND a.at = ?`).get(taskId, scope.approvedBy, scope.approvedAt) !== undefined;
  const machine = rows.filter(row => !PERSON_PROOFS.has(String(row.outcome)));
  if (leadAct || machine.length > 0) return { ok: false, why: leadAct || machine.some(row => row.outcome === 'lead-token') ? 'approved by the lead, not by a person' : 'approved with a machine credential, not by a person' };
  const proof = rows.find(row => proofDigestOf(row.detail) === scope.approvedDigest);
  if (proof === undefined) return { ok: false, why: 'no record shows a person approved these exact words; approve it again' };
  return { ok: true, by: scope.approvedBy, at: scope.approvedAt, method: String(proof.outcome) };
}
