/** Presentation only. Assignment state and retry authority belong to their
 * existing projections and signed operating-mode terms, never this renderer. */
import type { AssignmentSnapshot } from './assignment.js';
import type { DisplayStatus, StatusTone, WorkStatus } from './workspace-ui.js';
import { assignmentPresentationOf, shortenedMaterialReason, type AssignmentStatusOptions, type AssignmentWorkStatus } from './assignment-presentation.js';
import { plainReasonWords } from './proof.js';
import { chatResultHref } from './chat-controls.js';
import { statusDetailsHtml, statusWhyHtml, type PullRequestFact, type TaskStatus } from './task-status.js';
import { html, type Html } from './html.js';


/** The existing verified receipt reader may discover damage after a verdict
 * was saved. Keep the limitation visible without inventing another work stage. */
export function assignmentWithEvidence(assignment: AssignmentSnapshot, resultStatus: DisplayStatus | null, resultRunId: number | null = assignment.receipt?.runId ?? null): AssignmentSnapshot {
  if (resultStatus?.token !== 'evidence-damaged') return assignment;
  return { ...assignment,
    attempts: assignment.attempts.map(attempt => attempt.taskId === assignment.activeTaskId && resultRunId !== null && attempt.runId === resultRunId ? { ...attempt, detail: resultStatus.detail } : attempt),
    attention: [...new Set([...assignment.attention, resultStatus.detail])],
  };
}

export function assignmentStatusOf(assignment: AssignmentSnapshot, workStatus?: AssignmentWorkStatus): WorkStatus {
  return assignmentPresentationOf(assignment, workStatus === undefined ? {} : { workStatus }).status;
}

const taskHref = (assignment: AssignmentSnapshot, taskId: string): string => `/t/${encodeURIComponent(assignment.rootId)}?version=${encodeURIComponent(taskId)}`;

/** Navigation only. A control action still opens its existing exact ceremony. */
export function assignmentActionHref(assignment: AssignmentSnapshot): string | null {
  const action = assignment.primaryAction;
  if (action === null) return null;
  const { taskId, runId, decisionId } = action.target;
  if (decisionId !== null) return `/d/${decisionId}`;
  if (action.code === 'inspect-decisions') return '/';
  if (action.code === 'sign-in') return '/settings#providers';
  // The confirmation sits on the task page, behind the password.
  if (action.code === 'confirm-stopped') return `/t/${encodeURIComponent(assignment.rootId)}#confirm-stopped`;
  if (action.code === 'open-pr' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(assignment.publication?.prUrl ?? '')) return assignment.publication!.prUrl;
  if (runId !== null && (action.code === 'open-result' || action.code === 'open-pr' || action.code === 'retry-review')) {
    return `/review?result=${encodeURIComponent(taskId)}&run=${runId}`;
  }
  if (runId !== null && (action.code === 'inspect-run' || action.code === 'reconcile-run')) return `/r/${runId}`;
  const anchor = action.code === 'approve-scope' ? '#approve'
    : action.code === 'inspect-stop' || action.code === 'resume-run' ? '#task-control'
    // Retry (and Build again) is the task's status card itself, at the top: no anchor to its options.
    : action.code === 'unhold' ? '#task-actions'
    : action.code === 'write-scope' || action.code === 'select-agent' ? '#scope'
    : action.code === 'inspect-hold' ? '#holds'
    : action.code === 'start-worker' || action.code === 'repair-dependency' ? '#run-status' : '';
  return taskHref(assignment, taskId) + anchor;
}

export type AssignmentAttemptRow = { taskId: string; label: string; href: string; runId: number | null; detail: string | null };

/** Every version of the assignment, oldest first, as the card lists them. */
export function assignmentAttemptsOf(assignment: AssignmentSnapshot): AssignmentAttemptRow[] {
  return assignment.attempts.map((attempt, index) => ({
    taskId: attempt.taskId, label: `${index === 0 ? 'Original' : `Correction ${index}`} · ${attempt.label}`,
    href: taskHref(assignment, attempt.taskId), runId: attempt.runId,
    detail: (assignment.state === 'checking' && attempt.taskId === assignment.activeTaskId) || attempt.detail === assignment.detail ? null : attempt.detail,
  }));
}

export function assignmentAttemptsHtml(assignment: AssignmentSnapshot): Html {
  if (assignment.attempts.length === 0) return html``;
  return html`<details class="assignment-attempts"><summary>Attempts <span class="meta">${assignment.attempts.length}</span></summary><ol>${assignmentAttemptsOf(assignment).map(attempt =>
    html`<li data-attempt-task="${attempt.taskId}" data-history-version="${attempt.taskId}"><a href="${attempt.href}">${attempt.label}</a>${attempt.runId === null ? '' : html` <a href="/r/${attempt.runId}">Run #${attempt.runId}</a>`}${attempt.detail === null ? '' : html`<p class="meta">${attempt.detail}</p>`}</li>`
  )}</ol>${assignment.owner === null ? '' : html`<p class="meta">Lead: ${assignment.owner.label}${assignment.owner.active ? '' : ' · access ended'}</p>`}<p class="work-meta work-id">Task <span class="mono">${assignment.rootId}</span></p></details>`;
}

/** Only recognized storage limits and explicitly identified older records are
 * secondary. Unknown findings and damaged current material stay in view. */
function savedMaterialNotice(detail: string, assignment: AssignmentSnapshot): 'partial' | 'history' | null {
  if (shortenedMaterialReason(detail)) return 'partial';
  const earlier = /^Saved [\w-]+ #(\d+) \(run (\d+)\) is unavailable or changed\.$/.exec(detail);
  return earlier !== null && assignment.receipt !== null && Number(earlier[2]) < assignment.receipt.runId &&
    !assignment.receipt.artifacts.some(one => one.id === Number(earlier[1])) ? 'history' : null;
}

type AssignmentCardOptions = Omit<AssignmentStatusOptions, 'links'> & { hideAction?: boolean; problem?: boolean; resultHref?: string; pullRequest?: PullRequestFact | null };

/** The status card's content: one projection for the server HTML and the
 * rebuilt task page, so the two never word the same state differently. The
 * headline, sentence and detail rows are the shared task status; the exact
 * recorded reasons stay one tap away under Details, never as red text. */
export type AssignmentCard = {
  token: string; tone: StatusTone; label: string;
  status: TaskStatus;
  action: { label: string; href: string; openResult: boolean } | null;
  /** Exact technical reasons and diagnostics, shown on request. */
  reasons: string[];
  diagnostics: { token: string; label: string; detail: string }[];
  notices: { summary: string; lines: string[] } | null;
  attempts: AssignmentAttemptRow[];
  lead: { label: string; active: boolean } | null;
};

export function assignmentCardOf(assignment: AssignmentSnapshot, options: AssignmentCardOptions = {}): AssignmentCard {
  const receipt = assignment.receipt;
  // The checks live on the one result page (a failed build has one too), where Run checks runs in place; never Chat,
  // which would only lead back to this card.
  const checksPage = receipt === null ? null : `/review?result=${encodeURIComponent(receipt.taskId)}&run=${receipt.runId}&tab=checks`;
  const links = receipt === null ? {} : { result: options.resultHref ?? chatResultHref(receipt.taskId, receipt.runId), checks: checksPage,
    pullRequest: `/t/${encodeURIComponent(assignment.rootId)}#merge`,
    ...(receipt.completionKind === 'research-report' ? {} : { runChecks: `${checksPage}#follow-ups` }) };
  const presentation = assignmentPresentationOf(assignment, { ...options, links });
  const { status, diagnostics, taskStatus } = presentation;
  const href = assignment.primaryAction?.code === 'open-result' && options.resultHref !== undefined ? options.resultHref : assignmentActionHref(assignment);
  const attention = presentation.attention.map(one => one.detail);
  const notices = [...attention, ...diagnostics.map(one => one.detail)].filter(one => savedMaterialNotice(one, assignment) !== null);
  const partial = notices.some(one => savedMaterialNotice(one, assignment) === 'partial');
  const history = notices.some(one => savedMaterialNotice(one, assignment) === 'history');
  const recorded = assignment.detail === taskStatus.sentence || taskStatus.headline === 'Ready for review' || taskStatus.headline === 'Complete' ? [] : [assignment.detail];
  return {
    token: status.token, tone: status.tone, label: status.label, status: taskStatus,
    action: options.hideAction || href === null ? null : { label: assignment.primaryAction!.label, href, openResult: options.resultHref !== undefined },
    reasons: [...new Set([...recorded, ...attention.filter(one => savedMaterialNotice(one, assignment) === null).map(plainReasonWords)])].filter(one => one !== taskStatus.sentence),
    diagnostics: diagnostics.filter(one => savedMaterialNotice(one.detail, assignment) === null)
      .map(one => ({ token: one.token, label: one.label, detail: one.detail })),
    notices: notices.length === 0 ? null : { summary: [partial ? 'Saved output is partial' : '', history ? 'Earlier material unavailable' : ''].filter(Boolean).join(' · '), lines: [...new Set(notices)] },
    attempts: assignmentAttemptsOf(assignment),
    lead: assignment.owner === null ? null : { label: assignment.owner.label, active: assignment.owner.active },
  };
}

export function assignmentSummaryHtml(assignment: AssignmentSnapshot, options: AssignmentCardOptions & { compact?: boolean; sentence?: string | undefined } = {}): Html {
  const card = assignmentCardOf(assignment, options);
  const tone = card.status.tone;
  return html`<section class="${options.compact ? 'assignment-summary' : 'card assignment-summary'}" aria-label="assignment progress" data-assignment="${assignment.rootId}" data-work-status="${card.token}" data-tone="${card.tone}" data-headline="${card.status.headline}" data-headline-tone="${tone}"${options.compact ? '' : html` data-task-status`}>${
    options.compact ? html`<span class="status-line" data-work-status="${card.token}" data-tone="${card.tone}"><i class="status-dot" aria-hidden="true"></i><span class="status-label">${card.label}</span></span>` : html`<h2 class="assignment-state status-headline"><i aria-hidden="true"></i>${card.label}</h2>`}<p class="meta assignment-detail status-sentence">${options.sentence ?? card.status.sentence}</p>${
    card.action === null ? '' : html`<a class="${options.compact ? 'work-action' : 'button-link'}" href="${card.action.href}"${card.action.openResult ? html` data-open-result` : ''}${options.compact ? '' : html` data-primary-action`}>${card.action.label}${options.compact ? ' →' : ''}</a>`}${
    options.compact ? '' : statusDetailsHtml(card.status)}${
    statusWhyHtml(card.status, card.reasons, card.diagnostics)}${
    card.notices === null ? '' : html`<details class="assignment-notices"><summary>${card.notices.summary}</summary>${card.notices.lines.map(one => html`<p class="meta">${one}</p>`)}</details>`}${
    assignmentAttemptsHtml(assignment)}</section>`;
}

/** Shared assignment layout; actions remain comfortable on touch screens. */
export const ASSIGNMENT_CSS = `.assignment-summary{min-width:0;overflow-wrap:anywhere}.assignment-summary .assignment-state{font-weight:600;margin:0}.assignment-summary h2.assignment-state{font-size:1.125rem;color:var(--foreground)}.assignment-summary>.assignment-attempts,.assignment-summary>.assignment-notices{border:0;box-shadow:none;padding:0;margin:.25rem 0 0;background:transparent}.assignment-summary>.button-link{margin-top:.7rem;min-height:44px}.assignment-summary>.work-action{display:inline-flex;margin-inline-start:.6rem;min-height:44px;align-items:center}.assignment-detail{margin:.55rem 0}.assignment-attempts summary,.assignment-notices summary{min-height:44px;display:list-item;align-content:center;cursor:pointer}.assignment-notices summary{font-size:.8125rem;color:var(--foreground)}.assignment-notices p{margin:.25rem 0 .5rem}.assignment-attempts ol{padding-left:1.4rem}.assignment-attempts li{margin:.4rem 0}.assignment-attempts li a{display:inline-flex;align-items:center;min-height:44px;margin-right:.7rem}.assignment-attempts li p{margin:0 0 .4rem}`;
