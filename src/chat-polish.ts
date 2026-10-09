import { html, type Html } from './html.js';
import type { ChatSnapshot } from './store.js';

/** Presentation only. These are recorded completions, not a claim that
 * work happened since the user last visited, or that every result passed. */
export function completedWorkHtml(snapshot: ChatSnapshot, projectLabels: readonly string[], assignments?: Readonly<Record<string, { state: string }>>): Html {
  const completed = snapshot.tasks.filter(task => assignments === undefined ? task.state === 'done'
    && task.proofVerdict !== 'short' && task.proofVerdict !== 'refuted'
    && !task.historyProblem && !task.otherActive?.length
    && task.dispatch?.condition !== 'waiting' : assignments[task.id]?.state === 'complete').slice(0, 3);
  if (!completed.length) return html``;
  return html`<section class="chat-completed" aria-label="Completed work"><h3>Completed work</h3>${completed.map(task => {
    return html`<a class="chat-overview-item" href="/t/${encodeURIComponent(task.rootId ?? task.id)}"><span class="chat-overview-copy"><strong>${task.title}</strong><span>${projectLabels[task.repoIndex] ?? `Project ${task.repoIndex + 1}`}</span></span><span class="chat-completed-action">Open task <span aria-hidden="true">→</span></span></a>`;
  })}</section>`;
}

/** Keep activity truthful: the turn's recorded step count is not a
 * percentage or an invented tool phase. Billing detail stays available. */
export function chatWorkingHtml(input: { details: string; stopForm?: Html; keyed?: boolean }): Html {
  const activity = html`<span class="activity-dot" aria-hidden="true"></span><details><summary>Working<span class="activity-ellipsis" aria-hidden="true">…</span></summary><p class="meta">${input.details}</p></details>`;
  return html`<div class="chat-thinking chat-activity-row" id="latest" role="status"${input.keyed ? html` data-key="pending"` : ''}>${activity}${input.stopForm}</div>`;
}

/** Recorded activity is inspectable, not a row of performance badges. */
export function chatActivityDetailsHtml(activity: string | null): Html {
  if (!activity) return html``;
  return html`<details class="chat-activity-details"><summary>Activity</summary><div class="chat-activity" aria-label="work performed">${activity.split(' · ').map(one => html`<span>${one}</span>`)}</div></details>`;
}

// Local primitives adapted from the researched interaction patterns. No
// imported kit, animation runtime, simulated progress, or changed authority.
export const CHAT_POLISH_CSS = `
  /* Quiet workspace surfaces: color signals state, not an AI aesthetic. */
  body { background: var(--background); }
  .chat-workspace .chat-overview, .chat-workspace .chat-plan, .chat-workspace .result-panel,
  .chat-workspace .decide-card { background: var(--card); box-shadow: none; }
  .chat-workspace .result-panel { border-radius: .75rem; }
  .chat-workspace .chat-empty::before { content: none; }
  .chat-workspace .thread .msg.mate::before { background: var(--muted); box-shadow: none; border: 0; }
  .chat-workspace .thread .msg.op { box-shadow: none; border: 0; }
  .chat-workspace .completion-receipt { background: var(--card); box-shadow: none; }
  .chat-workspace .completion-receipt::after { content: none; }
  .chat-workspace .thread { min-height: 0; }
  .chat-workspace .chat-turn-history { margin: 1rem 0; border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent; box-shadow: none; padding: 0; }
  .chat-turn-history > summary { display: flex; align-items: center; gap: .75rem; min-height: 44px; cursor: pointer; font-size: .875rem; }
  .chat-turn-history > summary .meta { margin-left: auto; }
  .chat-turn-history .row { display: flex; flex-wrap: wrap; gap: .4rem; }
  .chat-turn-history .row .right { float: none; margin-left: auto; }
  .chat-workspace .task-live-summary { margin-bottom: .75rem; padding-bottom: .25rem; }
  .chat-workspace .task-journey > details, .chat-workspace .result-feedback-history,
  .chat-workspace .chat-limits, .chat-workspace .task-chat-agents {
    border: 0; border-radius: 0; background: transparent; box-shadow: none; padding: 0; margin: .25rem 0;
  }
  .chat-workspace .task-chat-agents > summary { min-height: 44px; cursor: pointer; font-size: .8125rem; color: var(--muted-foreground); }
  .chat-workspace .task-chat-agents p { margin: 0 0 .5rem; }
  .chat-workspace .decide-options .decide-option { border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent; padding: .75rem 0; }
  .chat-workspace .chat-plan { padding: 1rem; margin-top: .5rem; }
  .chat-workspace .result-knowledge { margin-bottom: .5rem; }
  .chat-workspace .result-panel [data-result-view] > details { margin-block: 0; padding-block: 0; }
  .chat-workspace .result-panel [data-result-view] > details > summary { min-height: 44px; display: flex; align-items: center; }
  .chat-workspace .result-feedback-history > summary { min-height: 44px; }
  .chat-activity-details { border: 0; background: transparent; box-shadow: none; border-radius: 0; padding: 0; margin: 0; }
  .chat-activity-details > summary { min-height: 44px; display: flex; align-items: center; gap: .4rem; cursor: pointer; color: var(--muted-foreground); font-size: .75rem; }
  .chat-activity-details > summary::after { content: '⌄'; }
  .chat-activity-details[open] > summary::after { transform: rotate(180deg); }
  .chat-activity-details .chat-activity { gap: .25rem .75rem; }
  .chat-activity-details .chat-activity span { border: 0; padding: 0; border-radius: 0; font: inherit; font-size: .75rem; }
  .chat-workspace .chat-message-foot { justify-content: flex-start; align-items: baseline; margin-top: .25rem; }
  .chat-activity-row { border: 0; background: transparent; box-shadow: none; padding: .5rem 0; min-height: 44px; gap: .65rem; }
  .chat-activity-row details { flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; margin: 0; box-shadow: none; }
  .chat-activity-row summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; width: fit-content; font-size: .875rem; font-weight: 550; }
  .chat-activity-row summary::after { content: '⌄'; margin-left: .65rem; color: var(--muted-foreground); }
  .chat-activity-row details[open] summary::after { transform: rotate(180deg); }
  .chat-activity-row .meta { padding-bottom: .5rem; overflow-wrap: anywhere; }
  .activity-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .task-live-summary { border-bottom: 1px solid var(--border); margin-bottom: 1rem; padding-bottom: .5rem; }
  .task-live-summary .task-journey, .task-live-summary .task-control { border: 0; border-radius: 0; box-shadow: none; background: transparent; margin: 0; padding: .65rem 0; }
  .task-live-summary .task-journey h2 { font-size: 1rem; }
  .task-live-summary .agents-strip { margin: .4rem 0; }
  .chat-decisions .chat-section-head { margin-bottom: .5rem; }
  .chat-decisions h2 { font-size: .875rem; font-weight: 550; color: var(--muted-foreground); }
  .decision-context summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-size: .8125rem; color: var(--muted-foreground); }
  .decision-context { border: 0; padding: 0; margin: 0; background: transparent; box-shadow: none; }
  .decide-options { display: grid; gap: .5rem; }
  .decide-options .decide-option { margin: 0; padding: .65rem .75rem; border: 1px solid var(--border); border-radius: .75rem; background: var(--background); }
  .decide-options .decide-option .meta { display: block; margin-top: .3rem; overflow-wrap: anywhere; }
  .decide-options .decide-option button { min-height: 44px; max-width: 100%; white-space: normal; text-align: left; }
  .chat-completed { margin-top: 1rem; }
  .chat-completed h3 { font-size: .8125rem; font-weight: 550; margin: 0 0 .25rem; color: var(--muted-foreground); }
  .chat-completed-action { flex: none; font-size: .75rem; white-space: nowrap; color: var(--muted-foreground); }
  .chat-overview .chat-overview-stat { box-shadow: none; border: 0; background: transparent; border-radius: 0; }
  .chat-overview .chat-overview-stat + .chat-overview-stat { border-left: 1px solid var(--border); }
  .result-panel .result-request { border-top: 1px solid var(--border); padding-top: 1rem; }
  .result-panel .result-head h2 { color: var(--foreground); }
  .result-panel .result-request h3 { color: var(--foreground); font-size: .875rem; text-transform: none; letter-spacing: 0; }
  .result-panel .result-feedback-actions { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: .5rem; }
  .result-panel .result-feedback-actions > [data-request-changes] { order: 2; background: var(--foreground); color: var(--background); border-color: var(--foreground); box-shadow: none; }
  .result-panel .result-feedback-actions > button { width: auto; min-height: 44px; white-space: nowrap; }
  .result-panel .result-feedback-actions > .quiet { background: transparent; border-color: transparent; box-shadow: none; }
  .result-panel .result-feedback-actions > button:disabled { opacity: .45; cursor: default; }
  .result-panel .result-feedback-link { display: inline-flex; align-items: center; min-height: 44px; font-size: .8125rem; text-underline-offset: 3px; }
  .result-panel .result-pin > summary, .result-panel .result-notes > summary, .result-panel .result-details > summary { min-height: 44px; }
  .result-panel .diff-comment-form textarea { min-height: 80px; margin: 0; font-size: 1rem; }
  .result-panel .result-attention { background: transparent; border: 0; border-radius: 0; box-shadow: none; padding: 0; margin: .75rem 0; color: var(--foreground); }
  .result-panel .result-attention ul { margin: 0; padding-left: 1.15rem; }
  .result-panel .result-attention ul:has(> li:only-child) { list-style: none; padding-left: 0; }
  .result-panel .result-knowledge { border: 0; border-top: 1px solid var(--border); background: transparent; box-shadow: none; border-radius: 0; padding: .25rem 0; }
  .result-panel .revision-from-comments { border: 0; background: transparent; box-shadow: none; padding: .5rem 0; }
  .result-panel .result-pin summary { font-size: .8125rem; min-height: 44px; display: flex; align-items: center; cursor: pointer; }
  .result-panel .diff-comment-limit { font-size: .75rem; }
  .chat-main .chat-plan { box-shadow: none; }
  .proposal-review-notes { margin: .5rem 0; padding-left: 1.15rem; overflow-wrap: anywhere; }
  .proposal-review-notes li + li { margin-top: .5rem; }
  .proposal-actions .button-link, .proposal-actions button { min-height: 44px; white-space: nowrap; }
  .chat-stop-confirm > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
  .task-chat-title-line h1, .task-main-title, .resume-target, .resume-ceremony, .proposal-task_action, .chat-stop-confirm { overflow-wrap: anywhere; }
  .chat-main .chat-task-back { display: none; }
  .knowledge-library .knowledge-intro { padding: .5rem 0 1.25rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
  .knowledge-library .knowledge-instructions { line-height: 1.65; margin-bottom: .5rem; }
  .knowledge-library .knowledge-editor summary { width: fit-content; font-size: .875rem; font-weight: 550; }
  .knowledge-library .knowledge-editor, .knowledge-library > details { border: 0; border-bottom: 1px solid var(--border); border-radius: 0; box-shadow: none; background: transparent; padding: 0; }
  .knowledge-library .knowledge-editor { border-bottom: 0; }
  .knowledge-library .card { border: 0; border-bottom: 1px solid var(--border); border-radius: 0; padding: 0 0 .5rem; margin: 0; box-shadow: none; background: transparent; }
  .knowledge-library .card[open] { padding-bottom: 1rem; }
  .knowledge-library .card > summary { padding: .85rem 0; }
  @media (prefers-reduced-motion: no-preference) {
    .chat-activity-row .activity-dot { animation: quiet-activity 1.8s ease-in-out infinite; }
    .chat-completed .chat-overview-item { transition: background-color 140ms ease; }
    @keyframes quiet-activity { 50% { opacity: .35; } }
  }
  @media (max-width: 600px) {
    .chat-workspace .result-panel { background: transparent; border-radius: 0; }
    .chat-completed .chat-overview-item { align-items: flex-start; flex-wrap: wrap; gap: .35rem; }
    .chat-completed .chat-overview-copy { flex-basis: 65%; }
    .task-live-summary .task-journey { gap: .5rem; }
  }
`;
