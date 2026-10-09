import type { CodingHandoffPreview } from './coding-handoff.js';
import { html, postForm, type Html } from './html.js';

/** A reviewable handoff. The next screen retains the existing approval terms. */
export function codingShippingHtml(preview: CodingHandoffPreview, values?: URLSearchParams, error?: string): Html {
  const goal = values?.get('goal') ?? preview.title;
  const criteria = values?.get('acceptance') ?? '';
  const notice = error?.startsWith('Review screenshots are not ready.')
    ? html`<p class="coding-notice" role="alert">Screenshots needed. Ask Codex to capture and commit them, then try again.</p><details><summary>Technical details</summary><p>${error}</p></details>`
    : error ? html`<p class="coding-notice" role="alert">${error}</p>` : '';
  const form = postForm(`/code/${preview.sessionId}/ship`, html`<label>Outcome<textarea name="goal" rows="4" required maxlength="16000">${goal}</textarea></label><label>Checks for review<textarea name="acceptance" rows="4" required maxlength="16000" placeholder="One observable result per line">${criteria}</textarea></label><label class="coding-check"><input type="checkbox" name="visual" value="yes"${values?.get('visual') === 'yes' ? html` checked` : ''}>Include desktop and phone screenshots</label><details><summary>${preview.changedPaths.length} changed files · commit ${preview.candidate.slice(0, 8)}</summary><ul>${preview.changedPaths.map(path => html`<li><code>${path}</code></li>`)}</ul><p class="coding-meta">Review covers the complete change from ${preview.base} to ${preview.candidate}.</p></details><p class="coding-terms">Verification and publication use this project’s existing approval process.</p><button type="submit">Create review task</button>`,
    { attrs: { class: 'coding-start' }, hidden: { base: preview.base, candidate: preview.candidate, title: preview.title } });
  return html`<section class="coding-workspace coding-handoff" data-coding-session=""><h1>Review for shipping</h1><p>${preview.title}</p>${notice}${form}<p><a href="/code/${preview.sessionId}">Back to coding</a></p></section>`;
}

export const CODING_SHIPPING_CSS = `.coding-workspace.coding-handoff{display:block;max-width:780px}.coding-handoff h1{margin-bottom:12px}.coding-handoff>p{margin-top:12px}.coding-workspace .coding-check{display:flex;align-items:center;gap:10px;min-height:44px}.coding-workspace .coding-check input{width:20px;height:20px;flex:0 0 20px}`;
