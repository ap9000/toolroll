// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TeamChat } from './team-chat.js';
import type { TeamSnapshot } from '../team-contract.js';
import type { BrowserActionCard } from '../browser-workspace.js';
import { toast } from './components/ui/index.js';
import { FormToken } from './ui/index.js';
const fixture = (): TeamSnapshot => ({ leads: [{ id: 'lead', name: 'Team lead', instructions: '', projects: ['/project'], revision: 1, status: 'active', createdBy: 'alex' }], conversations: [], selected: { id: 'room', leadId: 'lead', title: 'Settings page', visibility: 'team', projects: ['/project'], revision: 1, threadId: 1, createdBy: 'alex', follow: false }, participants: [{ account: 'alex', role: 'manager', active: true }], messages: [], canManage: true, canSend: true, canCreateLead: true, cursor: 1, truncated: false, projects: ['/project'], accounts: ['alex', 'sam'], chatAuthorization: { enabled: true, provider: 'codex-app', model: 'configured-model', dailyTurns: 20, weeklyCeilingUsd: null, conversationCeilingUsd: null, termsDigest: 'terms' } });
class Events extends EventTarget { static latest: Events; static CLOSED = 2; readyState = 1; close = vi.fn(() => { this.readyState = 2; }); constructor(readonly url: string) { super(); Events.latest = this; } }
const revoke = () => act(async () => Events.latest.dispatchEvent(new MessageEvent('gone', { data: JSON.stringify({ room: 'team?conversation=room' }) })));
const json = (snapshot: TeamSnapshot) => new Response(JSON.stringify({ version: 1, ok: true, code: 'ok', message: 'Saved', snapshot }), { headers: { 'content-type': 'application/json' } });
let root: Root | null = null;
beforeEach(() => { document.body.innerHTML = ''; sessionStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', Events); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(snapshot = fixture()) { const element = document.createElement('div'); document.body.append(element); root = createRoot(element); await act(async () => root!.render(createElement(FormToken.Provider, { value: 'csrf' }, createElement(TeamChat, { initial: snapshot, user: 'alex', csrf: 'csrf' })))); }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
test('idle room opens a stream and never sends a model request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await mount(); expect(Events.latest.url).toBe('/live?room=team%3Fconversation%3Droom'); expect(fetcher).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('Team'); expect(document.body.textContent).toContain('What would you like to work on?');
  await act(async () => root!.unmount()); root = null; expect(Events.latest.close).toHaveBeenCalled();
});
test('lost message response preserves exact request identity and does not resend on reconnect', async () => {
  const snapshot = fixture(), text = 'Keep the email field optional.';
  sessionStorage.setItem('standing-orders:team-draft:alex:room', JSON.stringify({ text, requestId: 'request-one', uncertain: false }));
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.body && JSON.parse(String(options.body)).operation === 'send') throw Error('lost response');
    return json(snapshot);
  }); vi.stubGlobal('fetch', fetcher);
  await mount(snapshot);
  await act(async () => button('Send').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(document.body.textContent).toContain('response was not confirmed'); expect(button('Send')).toBeUndefined(); expect(button('Check messages')).toBeDefined();
  await act(async () => Events.latest.dispatchEvent(new Event('change')));
  expect(fetcher.mock.calls.filter(([, options]) => options?.body && JSON.parse(String(options.body)).operation === 'send')).toHaveLength(1);
  expect(JSON.parse(sessionStorage.getItem('standing-orders:team-draft:alex:room')!).requestId).toBe('request-one');
});
test('author attribution, queued edit controls and revoked access stay explicit', async () => {
  const snapshot = fixture(); snapshot.messages = [{ id: 1, author: 'sam', role: 'operator', text: 'Also support a long project name.', status: 'queued', revision: 3, createdAt: '', requestId: 'sam-one', turnId: null, error: null }];
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot)));
  await mount(snapshot); expect(document.body.textContent).toContain('sam'); expect(document.body.textContent).toContain('Queued'); expect(button('Withdraw')).toBeUndefined();
  await revoke();
  expect(document.body.textContent).toContain('Your access changed'); expect(button('Send')).toBeUndefined(); expect(Events.latest.close).toHaveBeenCalled();
});
test('provider spend terms appear before enabling replies and Send stays disabled', async () => {
  const snapshot = fixture(); snapshot.chatAuthorization = { enabled: false, provider: 'openrouter-api', model: 'configured-model', dailyTurns: 20, weeklyCeilingUsd: 10, conversationCeilingUsd: 2, termsDigest: 'terms-v1' };
  const fetcher = vi.fn(async () => json(snapshot)); vi.stubGlobal('fetch', fetcher);
  sessionStorage.setItem('standing-orders:team-draft:alex:room', JSON.stringify({ text: 'Plan the work', requestId: 'one', uncertain: false }));
  await mount(snapshot); expect(button('Send').disabled).toBe(true); expect(document.body.textContent).toContain('$10 per week and $2 for this conversation');
  await act(async () => button('Enable chat').click());
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: 'authorize', args: { conversationId: 'room', termsDigest: 'terms-v1', ceilingUsd: 2 } });
});
test('sentence punctuation does not corrupt the exact saved result link', async () => {
  const snapshot = fixture(); snapshot.messages = [{ id: 1, author: 'Team lead', role: 'assistant', text: 'Result: /chat?task=payout-rounding&result=1. Inspect the changes.', status: 'answered', revision: 1, createdAt: '', requestId: null, turnId: null, error: null }];
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot))); await mount(snapshot);
  expect(document.querySelector<HTMLAnchorElement>('.so-team-message a')?.getAttribute('href')).toBe('/chat?task=payout-rounding&result=1&conversation=room');
  expect(document.querySelector('.so-team-message-text')?.textContent).toContain('Open result. Inspect');
});

test('an enabled chat shows why saved messages are waiting without asking for consent again', async () => {
  const snapshot = fixture(); snapshot.chatAuthorization!.waitingReason = 'Your daily chat limit is reached. Saved messages will wait until tomorrow.';
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot))); await mount(snapshot);
  expect(document.body.textContent).toContain('Saved messages will wait until tomorrow.');
  expect(button('Enable chat')).toBeUndefined();
});
test('a reply stopped at its deadline reads once in the thread, with the proposal it made and a send box for the next message', async () => {
  const snapshot = fixture(), notice = 'The reply took too long and was stopped. What it proposed is below. Send your message again, or ask for less at once.';
  snapshot.messages = [
    { id: 1, author: 'alex', role: 'operator', text: 'Set up the weekly digest flow.', status: 'failed', revision: 2, createdAt: '', requestId: 'one', turnId: 7, error: null },
    { id: 2, author: 'Team lead', role: 'assistant', text: notice, status: 'answered', revision: 1, createdAt: '', requestId: null, turnId: 7, error: null },
  ];
  snapshot.proposals = [{ id: 1, turnId: 7, title: 'Weekly digest flow', state: 'pending', href: '/chat?conversation=room&proposal=1' }];
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot))); await mount(snapshot);
  expect(document.body.textContent!.split('took too long').length - 1).toBe(1);
  expect(document.querySelectorAll('[role="alert"], .so-alert')).toHaveLength(0);
  const review = [...document.querySelectorAll<HTMLAnchorElement>('.so-team-proposals a')];
  expect(review.map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Review action', '/chat?conversation=room&proposal=1']]);
  expect(review[0]!.closest('[data-team-message]')?.getAttribute('data-team-message')).toBe('2');
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
});

const card = (id: number, changes: Partial<BrowserActionCard> = {}): BrowserActionCard => ({ id, kind: 'hold', label: 'Pause work', state: 'pending', body: '<h3>Hold the launch</h3><p>Wait for the audit.</p>', said: null, links: [], primary: { kind: 'confirm', label: 'Hold', irreversible: false, native: false }, dismissable: true, note: null, ...changes });
const proposal = (id: number, turnId: number, changes: Partial<BrowserActionCard> = {}) => ({ id, turnId, title: 'Launch audit', state: changes.state ?? 'pending', href: `/chat?conversation=room&proposal=${id}`, card: card(id, changes) });
function proposed() {
  const snapshot = fixture();
  snapshot.messages = [
    { id: 1, author: 'alex', role: 'operator', text: 'Wait for the audit.', status: 'answered', revision: 1, createdAt: '', requestId: 'one', turnId: 7, error: null },
    { id: 2, author: 'Team lead', role: 'assistant', text: 'Here is the proposed hold.', status: 'answered', revision: 1, createdAt: '', requestId: null, turnId: 7, error: null },
  ];
  snapshot.proposals = [proposal(10, 7)];
  return snapshot;
}
test('shared cards attach once to the assistant reply; unmatched saved cards remain at the end', async () => {
  const snapshot = proposed();
  snapshot.messages.push({ ...snapshot.messages[1]!, id: 3, text: 'The audit is scheduled for Friday.' });
  snapshot.proposals!.push(proposal(11, 7, { kind: 'action', label: 'Create portfolio review' }), proposal(12, 99, { state: 'dismissed', primary: null, dismissable: false, note: 'Dismissed.' }), proposal(13, 7, { state: 'drafting' }));
  snapshot.truncated = true;
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot)));
  await mount(snapshot);
  expect(document.querySelectorAll('[data-view="chat-card"]')).toHaveLength(3);
  expect(document.querySelector('[data-team-message="1"] .so-action-cards')).toBeNull();
  expect(document.querySelector('[data-team-message="2"] .so-action-cards')).toBeNull();
  expect([...document.querySelectorAll('[data-team-message="3"] [data-action-card]')].map(node => node.getAttribute('data-action-card'))).toEqual(['10', '11']);
  expect(document.querySelector('[data-action-card="12"]')!.closest('[data-team-message]')).toBeNull();
  expect(document.querySelector('.so-team-messages')!.compareDocumentPosition(document.querySelector('[data-action-card="12"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.body.textContent).not.toContain('Review action');
});
test.each(['confirm', 'dismiss'] as const)('inline %s uses the existing CSRF route and waits for saved server state', async verb => {
  const snapshot = proposed();
  let current = snapshot;
  const fetcher = vi.fn(async (url: string) => url.includes('/chat/proposal/') ? new Response(JSON.stringify({ ok: true, said: 'Saved.' }), { headers: { 'content-type': 'application/json' } }) : json(current));
  vi.stubGlobal('fetch', fetcher);
  await mount(snapshot); fetcher.mockClear();
  await act(async () => document.querySelector<HTMLButtonElement>(`[data-card-${verb}]`)!.click());
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/chat/proposal/10/${verb}`);
  const options = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } });
  expect(String(options.body)).toBe('csrf=csrf');
  expect(document.querySelector('[data-action-card="10"]')!.getAttribute('data-card-state')).toBe('pending');
  const state = verb === 'confirm' ? 'confirmed' : 'dismissed';
  current = { ...snapshot, proposals: [proposal(10, 7, { state, primary: null, dismissable: false, said: verb === 'confirm' ? 'Held.' : null, note: verb === 'dismiss' ? 'Dismissed.' : null })] };
  await act(async () => Events.latest.dispatchEvent(new Event('change')));
  expect(document.querySelector('[data-action-card="10"]')!.getAttribute('data-card-state')).toBe(state);
  expect(document.querySelector('[data-card-confirm]')).toBeNull();
});
test('a refused or lost confirmation stays pending and reports the problem; a failed refresh is recoverable', async () => {
  const snapshot = proposed(), error = vi.spyOn(toast, 'error');
  let lost = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (lost) throw Error('connection lost');
    return url.includes('/chat/proposal/') ? new Response(JSON.stringify({ ok: false, said: 'The current turn is still running.' }), { status: 409, headers: { 'content-type': 'application/json' } }) : json(snapshot);
  }));
  await mount(snapshot);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-card-confirm]')!.click());
  expect(error).toHaveBeenCalledWith('The current turn is still running.');
  lost = true;
  await act(async () => document.querySelector<HTMLButtonElement>('[data-card-confirm]')!.click());
  expect(error).toHaveBeenLastCalledWith("That didn't go through. Check your connection and try again.");
  expect(document.querySelector('[data-action-card="10"]')!.getAttribute('data-card-state')).toBe('pending');
  expect(button('Check messages')).toBeDefined();
});
test('server blocking reasons and secure review links survive inline rendering; revocation removes actions', async () => {
  const snapshot = proposed();
  snapshot.proposals = [proposal(10, 7, { primary: null, dismissable: false, note: 'Enable chat in this conversation before acting on a proposal.' }), proposal(11, 7, { primary: { kind: 'link', label: 'Review action', href: '/chat/proposal/11/review' } })];
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot))); await mount(snapshot);
  expect(document.querySelector('[data-action-card="10"]')!.textContent).toContain('Enable chat in this conversation');
  expect(document.querySelector('[data-action-card="10"] button')).toBeNull();
  expect(document.querySelector('[data-action-card="11"] a')!.getAttribute('href')).toBe('/chat/proposal/11/review');
  await revoke();
  expect(document.querySelector('[data-action-card="11"] a, [data-card-dismiss]')).toBeNull();
});
test('decision acknowledgements and native forms keep the lead card confirmation fields', async () => {
  const snapshot = proposed();
  snapshot.proposals = [proposal(10, 7, { kind: 'answer', primary: { kind: 'confirm', label: 'Confirm answer', irreversible: true, native: false } }), proposal(11, 7, { kind: 'task_action', primary: { kind: 'confirm', label: 'Resume task', irreversible: false, native: true } })];
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => url.includes('/chat/proposal/') ? new Response(JSON.stringify({ ok: true, said: 'Answered.' }), { headers: { 'content-type': 'application/json' } }) : json(snapshot));
  vi.stubGlobal('fetch', fetcher); await mount(snapshot); fetcher.mockClear();
  expect(button('Confirm answer').disabled).toBe(true);
  await act(async () => document.querySelector<HTMLInputElement>('[data-action-card="10"] input[type="checkbox"]')!.click());
  await act(async () => button('Confirm answer').click());
  expect(String(fetcher.mock.calls[0]![1]!.body)).toBe('csrf=csrf&confirm=yes');
  const form = document.querySelector<HTMLFormElement>('[data-action-card="11"] form')!;
  expect(form.getAttribute('action')).toBe('/chat/proposal/11/confirm');
  expect(new FormData(form).get('csrf')).toBe('csrf');
  expect(new FormData(form).get('return')).toBe(window.location.pathname + window.location.search);
});
