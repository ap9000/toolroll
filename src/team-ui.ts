import { html, type Html } from './html.js';
import type { TeamSnapshot } from './team-contract.js';
/** Readable fallback uses the same admitted projection as the interactive UI. */
export function teamWorkspaceHtml(snapshot: TeamSnapshot): Html {
  const selected = snapshot.selected;
  return html`<section class="team-workspace"><h1>${selected?.title ?? 'Team chat'}</h1>${
    selected ? html`<p>${selected.visibility === 'team' ? 'Team' : 'Private'} · ${snapshot.leads.find(lead => lead.id === selected.leadId)?.name ?? 'Lead'}</p>` : ''}${
    snapshot.messages.length ? snapshot.messages.map(message => html`<article><strong>${message.author}</strong><p style="white-space:pre-wrap;overflow-wrap:anywhere">${message.text}</p>${message.status === 'queued' || message.status === 'running' ? html`<p>${message.status === 'queued' ? 'Queued' : 'Working'}</p>` : ''}${message.error ? html`<p role="alert">${message.error}</p>` : ''}</article>`) : html`<p>Start a conversation with your team lead.</p>`}<noscript>Enable JavaScript to send messages and manage team conversations.</noscript><p><a href="/chat?private=1">Previous private chat</a></p></section>`;
}
