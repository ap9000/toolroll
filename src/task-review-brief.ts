/** A read-only packet of saved result facts. Never opens a worktree or emits logs, patches or saved shell commands. */
import type { Artifact, Run, Store } from './store.js';
import { assignmentChecksForRun, assignmentOf, type AssignmentAccess } from './assignment.js';
import { assignmentPresentationOf } from './assignment-presentation.js';
import { readVerifiedArtifact, readVerifiedProofForRun, reportShotsOf, scanForSecrets } from './evidence.js';
import { SCREENSHOT_CAPTURE, structuredHandoffView, terminalDiffView } from './result-evidence-readers.js';
import { buildReviewOf, type FindingSeverity } from './review-switch.js';
import { parseReport } from './scout-report.js';
import { sanitizeTranscriptLine } from './live.js';
import { redactSecretAssignments } from './builder.js';
import { parseExecutionPlanDocument } from './plan.js';

const MISSING = 'not recorded' as const;
type Missing = typeof MISSING;
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
type Finding = { severity: FindingSeverity; file: string; line: number; scenario: string };
export type ReviewBrief = {
  header: { task: string; run: number | Missing; provider: string; model: string; minutes: number | Missing; outcome: string; base: string; head: string; state: string };
  conclusion: string;
  changedFiles: { files: { path: string; additions: number | Missing; deletions: number | Missing }[]; total: number; omitted: number } | Missing;
  check: { status: string; exit: number | Missing; failed: string[] | Missing };
  review: { state: string; reason: string; findings: Finding[]; counts: Record<FindingSeverity, number>; omitted: Record<FindingSeverity, number> } | Missing;
  screenshots: { files: { path: string; bytes: number | Missing }[]; omitted: number } | Missing;
  plan: { titles: string[]; omitted: number } | Missing;
  nextActions: string[];
};

/** Redact before shortening so a clipped credential cannot escape recognition. Apply to every data string in both formats. */
function safeText(value: unknown, secrets: readonly string[], cap = 300): string {
  if (typeof value !== 'string' || !value.trim()) return MISSING;
  const flat = value.replace(/\s+/g, ' ').trim();
  const cleaned = sanitizeTranscriptLine(flat);
  if (secrets.some(secret => secret !== '' && value.includes(secret)) ||
      /\blt_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b|\bBearer\s+\S+/i.test(flat) ||
      scanForSecrets(flat).length || redactSecretAssignments(flat) !== flat || cleaned.startsWith('[a credential-shaped')) return '[redacted]';
  return cleaned.length <= cap ? cleaned : `${cleaned.slice(0, cap - 1)}…`;
}

function verifiedText(root: string, artifact: Artifact | null | undefined): string | null {
  if (!artifact || artifact.truncated || artifact.captureStatus === 'failed') return null;
  const read = readVerifiedArtifact(root, artifact);
  return read.ok ? read.content.toString('utf8') : null;
}

/** Select only finished build/report attempts in the admitted family. An explicit run never crosses that boundary. */
export function taskReviewBrief(store: Store, task: string, root: string, now: Date, access: AssignmentAccess,
  options: { run?: number; all?: boolean; secrets?: readonly string[] } = {}): { ok: true; brief: ReviewBrief } | { ok: false; reason: string; message: string } {
  const family = store.taskFamilyOf(task, access.repos, access.principal === 'operator' && access.includeUnplaced === true);
  if (family === null) return { ok: false, reason: 'not-found', message: 'That task is unavailable in your projects.' };
  const runs = family.versions.flatMap(version => store.runsFor(version.refId))
    .filter(run => (run.role === 'builder' || run.role === 'scout') && run.finishedAt !== null && run.outcome !== null)
    .sort((a, b) => b.id - a.id);
  const run = options.run === undefined ? runs[0] ?? null : runs.find(one => one.id === options.run) ?? null;
  if (options.run !== undefined && run === null) return { ok: false, reason: 'not-found', message: 'That finished build or report is unavailable for this task.' };
  const assignment = assignmentOf(store, task, now, access, root);
  const safe = (value: unknown, cap?: number) => safeText(value, options.secrets ?? [], cap);
  const sha = (value: string | null | undefined) => /^[a-f0-9]{40,64}$/.test(value ?? '') ? value!.slice(0, 12) : MISSING;
  const artifacts = run === null ? [] : store.artifactsFor(run.id);
  // Pass only the inventory: this reader does not need to open the patch for a brief.
  const statView = terminalDiffView(artifacts.filter(one => one.kind === 'diff-stat' && one.captureStatus !== 'failed'), root)?.stat;
  const stat = statView && !('problem' in statView) ? statView : null;
  const handoff = structuredHandoffView(artifacts, root, value => safe(value, 600));
  const reportText = run?.role === 'scout' ? verifiedText(root, artifacts.find(one => one.kind === 'report')) : null;
  const report = reportText === null ? null : parseReport(reportText, { stored: true });
  const conclusion = handoff?.conclusion ?? (report?.ok ? report.report.summary : run?.handoff);
  const duration = run?.finishedAt ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 60_000 : NaN;
  const recordedCheck = run === null ? null : store.runCheckFor(run.id);
  const receipt = assignment?.receipt?.runId === run?.id ? assignment?.receipt : null;
  // The shared assignment reader includes later checks on the same candidate. Its result wins;
  // old named failures must not ride a newer passing (or differently failed) check.
  const checks = receipt?.checks ?? (run === null ? null : assignmentChecksForRun(store, root, run.id, now));
  const status = checks && checks.status !== 'unavailable' && checks.status !== 'not-run' ? checks.status : recordedCheck?.status ?? checks?.status ?? MISSING;
  const exit = checks && checks.status === status ? checks.exitCode : recordedCheck?.exitCode;
  const sameCheck = recordedCheck?.status === status && recordedCheck.exitCode === exit &&
    (!checks?.logArtifactId || artifacts.some(one => one.id === checks.logArtifactId && one.kind === 'check-log'));
  const progress = run === null ? null : store.checkProgress(run.id);
  const failed = sameCheck ? [...new Set([
    ...recordedCheck!.suites.filter(one => one.status === 'failed').map(one => safe(one.name)),
    ...Object.entries(progress?.suites ?? {}).filter(([, suite]) => suite.state === 'failed').map(([name, suite]) => `${name}: ${suite.failed} failed`),
  ])] : [];
  const review = run === null ? null : buildReviewOf(store, run.id);
  const findings = review === null ? [] : [...review.high, ...review.followUps].filter(one => one && SEVERITIES.includes(one.severity));
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, findings.filter(one => one.severity === severity).length])) as Record<FindingSeverity, number>;
  const shown = SEVERITIES.flatMap(severity => severity === 'LOW' && !options.all ? [] : findings.filter(one => one.severity === severity))
    .slice(0, 12).map(one => ({ severity: one.severity, file: safe(one.file), line: Number.isSafeInteger(one.line) ? one.line : 0, scenario: safe(one.scenario) }));
  const omitted = Object.fromEntries(SEVERITIES.map(severity => [severity, counts[severity] - shown.filter(one => one.severity === severity).length])) as Record<FindingSeverity, number>;

  const proof = run === null ? null : readVerifiedProofForRun(store, root, run.id);
  const shots = artifacts.filter(one => one.kind === 'screenshot');
  const reportShots = report?.ok && run !== null ? reportShotsOf(artifacts, root, run.id, report.report.images) : [];
  const pathOf = (artifact: Artifact) => SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1] ??
    (reportShots.some(one => one.artifactId === artifact.id) ? `evidence/${artifact.key}` : null);
  const declared = proof?.ok ? proof.proof.screenshots.map(one => one.path) : [];
  const paths = [...new Set([...declared, ...shots.flatMap(one => pathOf(one) ?? [])])];
  const screenshots = paths.map(path => {
    const artifact = shots.find(one => pathOf(one) === path);
    return { path: safe(path), bytes: artifact && artifact.captureStatus !== 'failed' && readVerifiedArtifact(root, artifact).ok ? artifact.bytesStored : MISSING };
  });
  const plan = run === null ? null : planTitles(store, root, run);
  const current = run !== null && receipt !== null && family.current.refId === run.taskRef;
  const nextActions: string[] = [];
  if (!run) nextActions.push('Open the task to inspect its progress.');
  else if (!current) nextActions.push('Open the current result before completing or requesting a revision.');
  else {
    if (assignment?.state === 'ready-to-check') nextActions.push(`Complete: toolroll task complete ${safe(family.root.id)} --digest ${receipt!.digest}`);
    const diff = artifacts.find(one => one.kind === 'terminal-diff');
    if (run.role === 'builder' && diff && readVerifiedArtifact(root, diff).ok) {
      nextActions.push(`Revise: toolroll task revise ${safe(family.root.id)} --run ${run.id} --feedback "requested change"`);
    } else if (run.role === 'builder') nextActions.push('Revision unavailable: saved changes are not recorded or cannot be read.');
    if (assignment?.state === 'ready-to-check' || assignment?.state === 'complete') {
      if (run.role === 'builder' && run.outcome === 'built') nextActions.push(assignment.state === 'complete'
        ? 'Merge into a release through the normal release approval and check process.'
        : 'After completion, merge into a release through the normal release approval and check process.');
    } else nextActions.push(`Open the task: ${safe(assignment?.detail)}`);
  }
  return { ok: true, brief: {
    header: { task: safe(run === null ? task : store.externalIdFor(run.taskRef)), run: run?.id ?? MISSING,
      provider: safe(run?.provider), model: safe(run?.model), minutes: Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 10) / 10 : MISSING,
      outcome: safe(run?.outcome), base: sha(run?.baseRevision), head: sha(run?.headRevision), state: run !== null && !current ? 'Earlier result' : assignment === null ? MISSING : assignmentPresentationOf(assignment).status.label },
    conclusion: safe(conclusion, 600),
    changedFiles: stat === null ? MISSING : { files: [...stat.files].sort((a, b) => ((b.additions ?? 0) + (b.deletions ?? 0)) - ((a.additions ?? 0) + (a.deletions ?? 0)))
      .slice(0, 15).map(one => ({ path: safe(one.path), additions: one.additions ?? MISSING, deletions: one.deletions ?? MISSING })), total: stat.fileCount, omitted: Math.max(0, stat.fileCount - Math.min(15, stat.files.length)) },
    check: { status: status === 'unavailable' ? MISSING : status, exit: exit ?? MISSING, failed: status !== 'failed' ? [] : failed.length ? failed : MISSING },
    review: review === null ? MISSING : { state: review.state, reason: safe(review.reason), findings: shown, counts, omitted },
    screenshots: screenshots.length ? { files: screenshots.slice(0, 8), omitted: Math.max(0, screenshots.length - 8) } : MISSING,
    plan: plan === null || plan.length === 0 ? MISSING : { titles: plan.slice(0, 5).map(one => safe(one)), omitted: Math.max(0, plan.length - 5) },
    nextActions,
  } };
}

function planTitles(store: Store, root: string, run: Run): string[] | null {
  const revision = run.planRevision == null ? null : store.getPlanRevision(run.planRevision);
  // Historical runs cannot borrow a plan written after they started.
  const artifact = revision === null ? store.runsFor(run.taskRef).filter(one => one.role === 'planner' && one.id < run.id)
    .sort((a, b) => b.id - a.id).flatMap(one => store.artifactsFor(one.id)).find(one => one.kind === 'plan') : store.getArtifact(revision.artifact);
  const text = verifiedText(root, artifact);
  if (text === null) return null;
  const parsed = parseExecutionPlanDocument(text);
  return parsed.ok ? parsed.document.milestones : text.split(/\r?\n/).filter(line => /^#{1,6}\s+\S/.test(line)).map(line => line.replace(/^#{1,6}\s+/, ''));
}

/** Text and JSON share this bounded projection; --all includes LOW details within the same line budget. */
export function renderReviewBrief(brief: ReviewBrief): string[] {
  const h = brief.header;
  const lines = [`${h.task} · run ${h.run} · ${h.provider}/${h.model} · ${h.minutes} min · ${h.outcome} · ${h.base} → ${h.head} · ${h.state}`,
    `Conclusion: ${brief.conclusion}`, 'Changed files:'];
  if (brief.changedFiles === MISSING) lines.push(`  ${MISSING}`);
  else {
    lines.push(...brief.changedFiles.files.map(one => `  ${one.path} +${one.additions} / -${one.deletions}`));
    if (brief.changedFiles.total === 0) lines.push('  none');
    if (brief.changedFiles.omitted) lines.push(`  and ${brief.changedFiles.omitted} more`);
  }
  const check = brief.check;
  lines.push(`Check: ${check.status} · exit ${check.exit}${check.failed === MISSING ? ` · failed parts: ${MISSING}` : check.failed.length ? ` · failed: ${check.failed.join('; ')}` : ''}`);
  if (brief.review === MISSING) lines.push(`Automatic review: ${MISSING}`);
  else {
    lines.push(`Automatic review: ${brief.review.state}${brief.review.reason === MISSING ? '' : ` · ${brief.review.reason}`}`);
    lines.push(...brief.review.findings.map(one => `  ${one.severity} ${one.file}:${one.line} — ${one.scenario}`));
    for (const severity of SEVERITIES) if (brief.review.omitted[severity]) lines.push(`  ${severity}: ${brief.review.omitted[severity]} more (${brief.review.counts[severity]} total)`);
    if (Object.values(brief.review.counts).every(count => count === 0) && brief.review.state === 'reviewed') lines.push('  no findings');
  }
  lines.push('Screenshots:');
  if (brief.screenshots === MISSING) lines.push(`  ${MISSING}`);
  else {
    lines.push(...brief.screenshots.files.map(one => `  ${one.path} (${one.bytes}${typeof one.bytes === 'number' ? ' bytes' : ''})`));
    if (brief.screenshots.omitted) lines.push(`  and ${brief.screenshots.omitted} more`);
  }
  lines.push('Plan:');
  if (brief.plan === MISSING) lines.push(`  ${MISSING}`);
  else {
    lines.push(...brief.plan.titles.map(one => `  ${one}`));
    if (brief.plan.omitted) lines.push(`  and ${brief.plan.omitted} more`);
  }
  lines.push('Next:', ...brief.nextActions.map(one => `  ${one}`));
  return lines;
}
