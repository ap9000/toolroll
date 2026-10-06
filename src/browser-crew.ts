/** Pure rendering projection shared by browser updates and server snapshots. */
import type { BrowserCrewItem } from './browser-workspace.js';
import type { WorkIndexItem, WorkIndexPage } from './work-index.js';
import { chatControlHref, chatResultHref } from './chat-controls.js';

/** The index is navigation only. Controls retain their exact owning task, run,
 * decision and approval ceremony; opening a result keeps its saved execution. */
export function browserWorkActionHref(item: WorkIndexItem): string | null {
  const action = item.primaryAction;
  if (action === null) return null;
  const { taskId, runId, decisionId } = action.target;
  if (decisionId !== null) return `/d/${decisionId}`;
  if (action.code === 'inspect-decisions') return '/';
  if (action.code === 'sign-in') return '/settings#providers';
  if (action.code === 'confirm-stopped') return `/t/${encodeURIComponent(item.rootId)}#confirm-stopped`;
  if (action.code === 'open-result' && runId !== null) return chatResultHref(taskId, runId);
  if (action.code === 'open-pr' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(item.publicationUrl ?? '')) return item.publicationUrl!;
  if (runId !== null && (action.code === 'open-pr' || action.code === 'retry-review')) {
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
  return `/t/${encodeURIComponent(item.rootId)}?version=${encodeURIComponent(taskId)}` + anchor;
}

/** Render an already-admitted page without repeating its database query. Every task reads its one headline, the
 * same words as the Tasks list, task page and result page. */
export function browserCrewFromIndex(page: WorkIndexPage, conversationId?: string): { crew: BrowserCrewItem[]; crewTruncated: boolean } {
  const link = (href: string) => conversationId && href.startsWith('/chat?') ? href + '&conversation=' + encodeURIComponent(conversationId) : href;
  const rows = page.items.map(summary => {
    const status = summary.status;
    // Keep the server's sentence intact; ignore only empty or repeated badge words.
    const words = (text: string) => text.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').toLowerCase();
    const detail = ['Waiting', 'Failed', 'Needs you'].includes(status.label)
      && words(status.detail) !== '' && words(status.detail) !== words(status.label) ? status.detail : undefined;
    const resultHref = summary.resultRunId === null || summary.resultTaskId === null || (summary.resultOutcome !== 'built' && summary.resultOutcome !== 'no-change')
      ? null : chatResultHref(summary.resultTaskId, summary.resultRunId);
    const href = chatControlHref('task', summary.rootId);
    const action = summary.primaryAction;
    const actionHref = browserWorkActionHref(summary);
    const item: BrowserCrewItem = {
      id: summary.rootId, title: summary.title, project: summary.repo,
      state: summary.assignmentState, label: status.label, tone: status.tone, href: link(href), resultHref: resultHref === null ? null : link(resultHref),
      action: action === null || actionHref === null ? null : { label: action.label, href: link(actionHref) },
      updatedAt: summary.updatedAt,
      ...(detail === undefined ? {} : { detail }),
      ...(summary.lead === undefined ? {} : { lead: summary.lead }),
    };
    return { item, rank: status.rank };
  });
  // Stable ordering retains recency within each shared presentation rank.
  rows.sort((a, b) => a.rank - b.rank);
  return { crew: rows.map(row => row.item), crewTruncated: page.nextCursor !== null };
}
