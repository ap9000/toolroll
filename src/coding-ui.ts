import { randomUUID } from 'node:crypto';
import type { CodingItem, CodingRequest, CodingSession, CodingSnapshot } from './coding-types.js';
import { html, joinHtml, postForm, type Html } from './html.js';

function linkedText(text: string): Html {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\x60([^\x60\n]+)\x60|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>]+)/g;
  let end = 0;
  const output: Html[] = [];
  for (const match of text.matchAll(pattern)) {
    output.push(html`${text.slice(end, match.index)}`);
    if (match[3] !== undefined) output.push(html`<code>${match[3]}</code>`);
    else if (match[4] !== undefined) output.push(html`<strong>${match[4]}</strong>`);
    else {
      const raw = match[2] ?? match[5]!;
      const url = raw.replace(/[.,;!?]+$/, '');
      output.push(html`<a href="${url}" target="_blank" rel="noopener noreferrer">${match[1] ?? url}</a>${raw.slice(url.length)}`);
    }
    end = match.index + match[0].length;
  }
  return html`${output}${text.slice(end)}`;
}
function friendlyCodingError(message: string): string {
  return /already has an active writer/i.test(message)
    ? 'This conversation is open in another Codex app. Close it there, then resume here.'
    : message;
}
function noticeHtml(message: string): Html {
  const friendly = friendlyCodingError(message);
  return html`${friendly}${friendly === message ? '' : html`<details><summary>Technical details</summary><pre>${message}</pre></details>`}`;
}
const sessionUrl = (id: string): string => `/code/${encodeURIComponent(id)}`;
const active = (status: string): boolean => ['starting', 'working', 'needs-input', 'stopping'].includes(status);
const stateLabel = (session: CodingSession, requests: CodingRequest[] = []): string => ({ starting: 'Starting Codex', ready: 'Ready', working: 'Working', 'needs-input': requests.some(r => r.kind !== 'questions') ? 'Permission needed' : 'Needs your answer', stopping: 'Stopping', interrupted: 'Stopped', failed: 'Stopped with an error', uncertain: 'Delivery not confirmed', closed: 'Session closed' }[session.status]);

function itemHtml(item: CodingItem): Html {
  if (item.type === 'reasoning') return html``;
  const role = ['user', 'userMessage'].includes(item.type) ? 'You' : ['agent', 'assistant', 'agentMessage'].includes(item.type) ? 'Codex' : null;
  if (role) return html`<article class="coding-message${role === 'You' ? ' coding-user' : ''}" data-coding-item="${item.id}"><strong>${role}</strong><div class="coding-text">${linkedText(item.text)}</div></article>`;
  const title = ({ commandExecution: 'Command', fileChange: 'File changes', mcpToolCall: 'Tool', reasoning: 'Reasoning', plan: 'Plan', error: 'Error' } as Record<string, string>)[item.type] ?? 'Activity';
  return html`<details class="coding-tool" data-coding-item="${item.id}"><summary>${title}${item.status ? html` <span class="coding-meta">${item.status}</span>` : ''}</summary><pre>${item.text}</pre></details>`;
}

function requestHtml(request: CodingRequest, session: string): Html {
  const questions = request.kind === 'questions';
  const body = questions ? request.questions.map((q, index) => html`<label>${q.question}<input type="text" name="question:${q.id}"${q.options.length ? html` list="coding-options-${request.id}-${index}"` : ''} required autocomplete="off">${q.options.length ? html`<datalist id="coding-options-${request.id}-${index}">${q.options.map(o => html`<option value="${o.label}">${o.description}</option>`)}</datalist>` : ''}</label>`) : html`<pre class="coding-permission-detail">${request.detail}</pre><label>Password to approve this request<input type="password" name="password" autocomplete="current-password" required></label>`;
  return html`<section class="coding-request" data-coding-request="${request.id}"><h3>${request.title || (questions ? 'Your answer' : 'Allow extra access?')}</h3>${postForm(`${sessionUrl(session)}/answer`, html`${body}<div class="coding-actions"><button type="submit" name="decision" value="accept">${questions ? 'Send answer' : 'Approve access'}</button><button type="submit" name="decision" value="decline" formnovalidate class="coding-secondary">${questions ? 'Cancel question' : 'Decline'}</button></div>`, { attrs: { 'data-coding-form': 'answer' }, hidden: { requestId: request.id } })}</section>`;
}

function controlsHtml(session: CodingSession): Html {
  if (active(session.status) && session.turnId) return postForm(`${sessionUrl(session.id)}/stop`, html`<button class="coding-secondary"${session.status === 'stopping' ? html` disabled` : ''}>Stop</button>`, { attrs: { 'data-coding-form': 'stop' } });
  if (session.status === 'uncertain') return postForm(`${sessionUrl(session.id)}/${session.deliveryReviewRequired ? 'continue' : 'recover'}`, html`<button>${session.deliveryReviewRequired ? (session.nativeThreadId ? 'Continue with saved work' : 'Keep work and close session') : 'Check saved session'}</button>`, { attrs: { 'data-coding-form': 'recover' } });
  if (!session.nativeThreadId && ['closed', 'failed', 'interrupted'].includes(session.status)) return html``;
  if (['failed', 'interrupted'].includes(session.status)) return postForm(`${sessionUrl(session.id)}/resume`, html`<button>Resume session</button>`, { attrs: { 'data-coding-form': 'resume' } });
  return html``;
}

export function codingWorkspaceHtml(input: {
  projects: { path: string; name: string }[];
  sessions: CodingSession[];
  selected: CodingSnapshot | null;
  /** The page script posts with it (data-coding-csrf); the forms get theirs from postForm. */
  csrf: string;
  project: string | null;
  error?: string;
  draft?: string;
  available: boolean;
  owner?: string;
}): Html {
  const { selected, csrf } = input;
  const selectedRepo = selected?.session.repo ?? input.project;
  const projectName = (repo: string) => input.projects.find(p => p.path === repo)?.name ?? repo.split('/').filter(Boolean).at(-1) ?? repo;
  const newUrl = `/code${selectedRepo ? `?project=${encodeURIComponent(selectedRepo)}` : ''}`;
  const sessions = joinHtml(input.sessions.map(session => html`<li><a href="${sessionUrl(session.id)}"${selected?.session.id === session.id ? html` aria-current="page"` : ''}><span>${session.title}</span><small>${projectName(session.repo)} · <span data-coding-status-for="${session.id}">${stateLabel(session)}</span></small></a></li>`));
  const sessionItems = input.sessions.length ? sessions : html`<li class="coding-meta">No sessions yet.</li>`;
  const sidebar = html`<aside class="coding-sidebar"><div class="coding-sidebar-top"><h2>Sessions</h2>${selected ? html`<a class="coding-link-button" href="${newUrl}">New session</a>` : ''}</div><nav class="coding-session-list" aria-label="Coding sessions"><ul>${sessionItems}</ul></nav><details class="coding-mobile-sessions"><summary>Sessions${input.sessions.length ? ` (${input.sessions.length})` : ''}</summary><nav aria-label="Coding sessions"><ul>${sessionItems}</ul></nav></details></aside>`;
  const warning = !input.available ? html`<p class="coding-notice">Codex is unavailable on this installation. Install and sign in to Codex on the host to start coding.</p>` : '';
  const error = input.error ?? selected?.session.error ?? '';
  let main: Html;
  if (!selected) {
    const options = input.projects.map(p => html`<option value="${p.path}"${selectedRepo === p.path ? html` selected` : ''}>${p.name}</option>`);
    main = html`<header class="coding-header"><h1>Build with Codex</h1></header>${warning}${input.projects.length ? postForm('/code/start', html`<label>Project<select name="repo" required>${options}</select></label><label>What would you like to change?<textarea name="prompt" rows="5" required maxlength="24000" placeholder="Describe the result you want…">${input.draft ?? ''}</textarea></label><details class="coding-options"><summary>Session options</summary><label>Title <span class="coding-meta">Optional</span><input name="title" maxlength="160" autocomplete="off"></label><label>Model <span class="coding-meta">Optional; uses the installed default</span><input name="model" maxlength="120" placeholder="Installed default" autocomplete="off"></label></details><p class="coding-terms">Codex uses this installation’s login and edits a separate copy of this project. It can run commands and read files outside the project. Connected tools (MCP servers) keep their own access to this computer and connected services. Additional command and file access requires your approval.</p><label>Password to start<input type="password" name="password" autocomplete="current-password" required></label><button type="submit"${input.available ? '' : html` disabled`}>Start coding</button>`, { attrs: { 'data-coding-form': 'start', class: 'coding-start' }, hidden: { requestId: randomUUID() } }) : html`<div class="coding-empty"><p>Add a project to start coding.</p><a class="coding-link-button" href="/projects">Open projects</a></div>`}`;
  } else {
    const s = selected.session;
    const blocked = !s.nativeThreadId || !['ready', 'working', 'failed', 'interrupted'].includes(s.status);
    const messages = selected.items.filter(item => item.type !== 'reasoning').map(itemHtml);
    const composer = postForm(`${sessionUrl(s.id)}/send`, html`<label for="coding-prompt">Message Codex</label><textarea id="coding-prompt" name="prompt" rows="2" maxlength="24000" required placeholder="Describe a change or ask about the result…">${input.draft ?? ''}</textarea><div class="coding-actions"><button type="submit"${blocked ? html` disabled` : ''}>${s.status === 'working' ? 'Send update' : 'Send message'}</button></div>`, { attrs: { 'data-coding-form': 'send', class: 'coding-composer', hidden: s.status === 'closed' }, hidden: { requestId: randomUUID() } });
    main = html`<header class="coding-header"><div><h1>${s.title}</h1><p class="coding-meta">${projectName(s.repo)} · Codex${s.model ? html` · ${s.model}` : ''}</p></div><details class="coding-session-detail"><summary aria-label="Session details">Details</summary><dl><dt>Branch</dt><dd>${s.branch}</dd><dt>Worktree</dt><dd>${s.worktree}</dd><dt>Native session</dt><dd>${s.nativeThreadId ?? 'Not established'}</dd>${s.initialRequest ? html`<dt>Initial request</dt><dd class="coding-text">${s.initialRequest.prompt}</dd>` : ''}</dl></details></header><div class="coding-state-row"><p id="coding-state" role="status">${stateLabel(s, selected.requests)}</p><div id="coding-controls">${controlsHtml(s)}</div></div><div id="coding-requests">${selected.requests.map(r => requestHtml(r, s.id))}</div><div id="coding-conversation" class="coding-conversation" tabindex="0" aria-label="Conversation"${s.status === 'closed' && messages.length === 0 ? html` hidden` : ''}>${messages.length ? messages : html`<p class="coding-meta coding-no-messages">No messages yet.</p>`}</div><button type="button" id="coding-latest" class="coding-secondary" hidden>Latest update ↓</button>${composer}<details id="coding-changes" class="coding-changes"><summary>Changes</summary><div id="coding-change-content"><p class="coding-meta">Open to load the current changes.</p></div><button type="button" id="coding-refresh-changes" class="coding-secondary">Refresh changes</button><noscript><a href="${sessionUrl(s.id)}/changes">View changes</a></noscript><p id="coding-shipping"${['closed', 'uncertain'].includes(s.status) ? html` hidden` : ''}><a class="coding-link-button" href="${sessionUrl(s.id)}/ship">Review for shipping</a></p></details>`;
  }
  return html`<section class="coding-workspace" data-coding-session="${selected?.session.id ?? ''}" data-coding-owner="${selected?.session.owner ?? input.owner ?? ''}" data-coding-project="${selectedRepo ?? input.projects[0]?.path ?? ''}" data-coding-status="${selected?.session.status ?? ''}" data-coding-native-thread="${String(Boolean(selected?.session.nativeThreadId))}" data-coding-revision="${selected?.revision ?? -1}" data-coding-csrf="${csrf}">${sidebar}<div class="coding-main"><div id="coding-error" class="coding-notice" role="alert"${error ? '' : html` hidden`}>${noticeHtml(error)}</div><p id="coding-connection" class="coding-meta" role="status" hidden></p>${main}</div></section>`;
}

export const CODING_CSS = `
.coding-workspace{display:grid;grid-template-columns:224px minmax(0,1fr);gap:24px;max-width:1220px;min-width:0;margin:0 auto;overflow-wrap:anywhere}
.coding-workspace *{box-sizing:border-box}.coding-workspace [hidden]{display:none!important}.coding-workspace h1{font-size:1.45rem;line-height:1.25;margin:0}.coding-workspace h2{font-size:1rem;margin:0}.coding-workspace h3{font-size:1rem;margin:0 0 12px}.coding-workspace p{margin:0 0 12px}.coding-main,.coding-sidebar{min-width:0}.coding-meta,.coding-workspace small{font-size:.83rem;color:var(--muted-foreground,#747981)}
.coding-sidebar-top,.coding-header,.coding-state-row,.coding-actions{display:flex;align-items:center;gap:12px;justify-content:space-between}.coding-sidebar-top{margin-bottom:12px}.coding-header{align-items:flex-start;margin-bottom:16px}.coding-header .coding-meta{margin:6px 0 0}.coding-session-detail{max-width:220px}.coding-session-detail summary{font-size:.82rem}.coding-session-detail dl{font-size:.82rem}.coding-session-detail dt{font-weight:600;margin-top:8px}.coding-session-detail dd{margin:2px 0 0}.coding-state-row{flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border,#353940);margin-bottom:12px}.coding-state-row p{margin:0;font-weight:600}.coding-state-row form{margin:0}
.coding-session-list{max-height:74vh;overflow:auto}.coding-sidebar ul{list-style:none;margin:0;padding:0;display:grid;gap:4px}.coding-sidebar nav a{display:block;padding:12px;border-radius:10px;text-decoration:none;color:inherit}.coding-sidebar nav a:hover,.coding-sidebar nav a[aria-current]{background:var(--muted,#22252a)}.coding-sidebar nav a[aria-current]{box-shadow:inset 3px 0 var(--primary,#90bfa7)}.coding-sidebar nav span,.coding-sidebar nav small{display:block}.coding-sidebar nav [data-coding-status-for]{display:inline}.coding-sidebar nav small{margin-top:5px}.coding-mobile-sessions{display:none}
.coding-workspace form:not(.coding-state-row form){display:grid;gap:12px;margin:0}.coding-workspace label{display:grid;gap:6px;font-size:.9rem;font-weight:500}.coding-workspace input,.coding-workspace textarea,.coding-workspace select{width:100%;min-width:0;max-width:100%;font-size:16px;border:1px solid var(--border,#353940);border-radius:8px;padding:11px 12px;background:var(--background,#14161a);color:var(--foreground,#f0f1f3)}.coding-workspace textarea{resize:vertical;line-height:1.5}.coding-workspace input:focus-visible,.coding-workspace textarea:focus-visible,.coding-workspace select:focus-visible,.coding-workspace button:focus-visible,.coding-workspace summary:focus-visible,.coding-workspace a:focus-visible{outline:2px solid var(--ring,#79acff);outline-offset:3px}.coding-workspace button,.coding-link-button{min-height:44px;padding:10px 15px;white-space:nowrap;border-radius:8px;max-width:100%;font-size:.9rem}.coding-workspace button{justify-self:start;cursor:pointer}.coding-workspace button:disabled{cursor:default;opacity:.55}.coding-workspace .coding-secondary{background:transparent;color:inherit;border:1px solid var(--border,#353940)}.coding-link-button{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:inherit;border:1px solid var(--border,#353940)}.coding-workspace summary{cursor:pointer;min-height:44px;padding:12px 0}.coding-actions{justify-content:flex-start;flex-wrap:wrap}.coding-start{max-width:680px}.coding-options label+label{margin-top:12px}.coding-terms{font-size:.9rem;line-height:1.6;margin:0!important}.coding-empty{padding:28px 0}
.coding-notice{border:1px solid var(--destructive,#bd7674);border-radius:10px;padding:12px;line-height:1.5;margin-bottom:16px}.coding-conversation{max-height:min(58vh,640px);min-height:140px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:4px 10px 12px 0}.coding-message{padding:14px 0}.coding-message strong{display:block;font-size:.78rem;margin-bottom:7px;color:var(--muted-foreground,#747981)}.coding-user{margin:8px 0 8px 32px;padding:14px 16px;border-radius:12px;background:var(--muted,#22252a)}.coding-text{white-space:pre-wrap;line-height:1.6;overflow-wrap:anywhere}.coding-tool{border-bottom:1px solid var(--border,#353940);font-size:.88rem}.coding-workspace pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font-size:.8rem;line-height:1.5;margin:0 0 12px}.coding-tool summary{display:list-item}.coding-tool summary span{margin-left:6px}.coding-composer{border-top:1px solid var(--border,#353940);padding-top:14px;margin-top:8px!important}.coding-composer label{font-size:.83rem}.coding-request{border:1px solid var(--border,#353940);border-radius:12px;padding:16px;margin:12px 0}.coding-permission-detail{max-height:240px;overflow:auto}.coding-changes{margin-top:20px;border-top:1px solid var(--border,#353940)}.coding-changes pre{max-height:min(50dvh,480px);overflow:auto}.coding-change-meta{font-size:.8rem}.coding-workspace #coding-latest{margin:8px 0}.coding-workspace #coding-connection{line-height:1.4}
.coding-workspace .coding-start>button[type="submit"],.coding-workspace .coding-composer button[type="submit"]{background:var(--primary,#171717);color:var(--primary-foreground,#fff);border:1px solid var(--primary,#171717);font-weight:600;box-shadow:none}.coding-workspace .coding-start>button[type="submit"]:not(:disabled):hover,.coding-workspace .coding-composer button[type="submit"]:not(:disabled):hover{filter:brightness(.9)}
.coding-workspace:not([data-coding-session=""]) .coding-main{display:flex;flex-direction:column;min-height:calc(100dvh - 180px)}.coding-main>.coding-header,.coding-main>.coding-state-row,.coding-main>#coding-requests,.coding-main>.coding-composer,.coding-main>.coding-changes,.coding-main>.coding-notice,.coding-main>#coding-connection{flex-shrink:0}.coding-workspace:not([data-coding-session=""]) .coding-conversation{flex:1 1 120px;min-height:100px;max-height:min(58dvh,640px)}.coding-workspace .coding-tool{margin:4px 0;padding:0 10px;border-radius:8px}.coding-workspace .coding-session-detail{margin:0;padding:0 10px;flex-shrink:0}.coding-workspace .coding-changes{padding:0 12px;margin-top:12px}.coding-text strong{display:inline;font-size:inherit;color:inherit;margin:0;font-weight:600}.coding-composer textarea{min-height:72px;max-height:180px}
@media(max-width:760px){.coding-workspace{grid-template-columns:minmax(0,1fr);gap:16px}.coding-sidebar{border-bottom:1px solid var(--border,#353940);padding-bottom:12px}.coding-sidebar-top h2,.coding-session-list{display:none}.coding-sidebar-top{float:right;margin:0 0 8px 12px}.coding-mobile-sessions{display:block;max-width:100%;margin:0}.coding-mobile-sessions>nav{max-height:260px;overflow:auto;clear:both}.coding-mobile-sessions>summary{min-height:44px}.coding-header{display:block}.coding-session-detail{max-width:none;margin-top:4px}.coding-session-detail summary{padding:10px 0}.coding-conversation{max-height:52vh;min-height:100px;padding-right:4px}.coding-user{margin-left:16px}.coding-workspace h1{font-size:1.25rem}.coding-workspace button,.coding-link-button{padding:10px 12px}.coding-start{max-width:none}}
@media(max-width:760px){.coding-workspace:not([data-coding-session=""]) .coding-main{min-height:calc(100dvh - 245px - env(safe-area-inset-bottom,0px))}.coding-workspace:not([data-coding-session=""]) .coding-conversation{min-height:80px}.coding-header{display:flex;gap:12px}.coding-header>div{min-width:0;flex:1}.coding-header:has(.coding-session-detail[open]){flex-wrap:wrap}.coding-workspace .coding-session-detail{max-width:100px}.coding-workspace .coding-session-detail[open]{max-width:100%;flex-basis:100%}.coding-session-detail summary{white-space:nowrap}.coding-workspace .coding-mobile-sessions{padding:0 12px}.coding-composer{gap:8px!important}.coding-composer textarea{height:72px}.coding-state-row{padding:8px 0;margin-bottom:8px}}
@media(prefers-reduced-motion:reduce){.coding-workspace *{scroll-behavior:auto!important}}
`;

export function codingWorkspaceScript(): string {
  return String.raw`(() => {
  const root = document.querySelector('.coding-workspace');
  if (!root || root.dataset.codingMounted) return;
  root.dataset.codingMounted = 'true';
  const session = root.dataset.codingSession;
  const csrf = root.dataset.codingCsrf;
  const base = session ? '/code/' + encodeURIComponent(session) : '/code';
  const errorBox = root.querySelector('#coding-error');
  const connection = root.querySelector('#coding-connection');
  const composer = root.querySelector('[data-coding-form="send"], [data-coding-form="start"]');
  const prompt = composer && composer.querySelector('[name="prompt"]');
  const requestField = composer && composer.querySelector('[name="requestId"]');
  let status = root.dataset.codingStatus;
  let revision = Number(root.dataset.codingRevision);
  let timer;
  let polling = false;
  let disposed = false;
  let authLost = false;
  let pendingSend = null;
  let busy = false;
  let changesBusy = false;
  let hasChanges = null;
  let followLatest = true;
  let automaticScrollTop = null;
  const jumpToLatest = () => {
    const conversation = root.querySelector('#coding-conversation');
    if (!conversation || conversation.hidden) return;
    followLatest = true;
    const lastReply = Array.from(conversation.querySelectorAll('.coding-message:not(.coding-user)')).at(-1);
    if (status === 'ready' && lastReply) conversation.scrollTop += lastReply.getBoundingClientRect().top - conversation.getBoundingClientRect().top;
    else conversation.scrollTop = conversation.scrollHeight;
    automaticScrollTop = conversation.scrollTop;
    root.querySelector('#coding-latest').hidden = true;
  };
  const e = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const linkedText = text => {
    const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\x60([^\x60\n]+)\x60|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>]+)/g;
    let end = 0; let output = '';
    for (const match of text.matchAll(pattern)) { output += e(text.slice(end,match.index)); if (match[3] !== undefined) output += '<code>' + e(match[3]) + '</code>'; else if (match[4] !== undefined) output += '<strong>' + e(match[4]) + '</strong>'; else { const raw = match[2] || match[5]; const url = raw.replace(/[.,;!?]+$/, ''); output += '<a href="' + e(url) + '" target="_blank" rel="noopener noreferrer">' + e(match[1] || url) + '</a>' + e(raw.slice(url.length)); } end = match.index + match[0].length; }
    return output + e(text.slice(end));
  };
  const h = values => Object.entries(values).map(([name,value]) => '<input type="hidden" name="' + e(name) + '" value="' + e(value) + '">').join('');
  const isActive = value => ['starting','working','needs-input','stopping'].includes(value);
  const draftKey = () => 'standing-orders:coding-draft:' + root.dataset.codingOwner + ':' + (session || 'new:' + (composer.querySelector('[name="repo"]')?.value || root.dataset.codingProject));
  const storage = (operation, key, value) => { try { return sessionStorage[operation](key, value); } catch { return null; } };
  const requestSignal = () => typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30000) : undefined;
  const saveDraft = () => {
    if (!prompt || !root.dataset.codingOwner) return;
    storage('setItem', draftKey(), JSON.stringify({text:prompt.value, requestId:requestField.value, pending:pendingSend, at:Date.now()}));
  };
  const restoreDraft = () => {
    if (!prompt || !root.dataset.codingOwner) return;
    try {
      const saved = JSON.parse(storage('getItem',draftKey()) || 'null');
      if (saved && typeof saved.text === 'string' && Date.now() - saved.at < 86400000) {
        if (!prompt.value) prompt.value = saved.text;
        if (/^[0-9a-f-]{36}$/i.test(saved.requestId || '')) requestField.value = saved.requestId;
        if (saved.pending && typeof saved.pending.prompt === 'string' && saved.pending.requestId === requestField.value) {
          pendingSend = saved.pending;
          prompt.value = pendingSend.prompt;
          prompt.readOnly = true;
        }
      }
    } catch {}
  };
  const friendlyCodingError = ${friendlyCodingError.toString()};
  const showError = (message, savedSession) => {
    const friendly = friendlyCodingError(message || '');
    errorBox.textContent = friendly; errorBox.hidden = !message;
    if (friendly !== message && message) {
      const details = document.createElement('details'), summary = document.createElement('summary'), raw = document.createElement('pre');
      summary.textContent = 'Technical details'; raw.textContent = message; details.append(summary, raw); errorBox.append(details);
    }
    if (message && /^[a-f0-9]{32}$/.test(savedSession || '')) {
      const link = document.createElement('a'); link.href = '/code/' + savedSession; link.textContent = 'View saved session'; errorBox.append(document.createTextNode(' '), link);
    }
  };
  const showConnection = message => { connection.textContent = message || ''; connection.hidden = !message; };
  const signedOut = () => {
    authLost = true; saveDraft();
    connection.replaceChildren(document.createTextNode('Sign in again to reconnect. Your draft is saved. '));
    const link = document.createElement('a'); link.href = '/login?return=' + encodeURIComponent(location.pathname + location.search); link.textContent = 'Sign in'; connection.append(link); connection.hidden = false;
    updateComposer();
  };
  let nativeThread = root.dataset.codingNativeThread === 'true';
  const updateComposer = () => {
    if (!composer) return;
    composer.hidden = Boolean(session && status === 'closed');
    const button = composer.querySelector('button[type="submit"]');
    if (session) button.disabled = busy || authLost || !nativeThread || !['ready','working','failed','interrupted'].includes(status);
    else if (busy || authLost) button.disabled = true;
    button.textContent = pendingSend ? 'Retry send' : session ? status === 'working' ? 'Send update' : 'Send message' : 'Start coding';
    if (pendingSend && !authLost && (!session || nativeThread) && !['uncertain','closed'].includes(status) && !busy) button.disabled = false;
    prompt.readOnly = Boolean(pendingSend);
    if (!session) composer.querySelectorAll('[name="repo"], [name="title"], [name="model"]').forEach(field => { if (field.tagName === 'SELECT') field.disabled = Boolean(pendingSend); else field.readOnly = Boolean(pendingSend); });
  };
  const updateShipping = () => {
    const shipping = root.querySelector('#coding-shipping');
    if (shipping) shipping.hidden = ['closed','uncertain'].includes(status) || hasChanges === false;
  };
  const requestHtml = request => {
    const questions = request.kind === 'questions';
    const body = questions ? request.questions.map((q,index) => '<label>' + e(q.question) + '<input type="text" name="question:' + e(q.id) + '"' + (q.options.length ? ' list="coding-options-' + e(request.id) + '-' + index + '"' : '') + ' required autocomplete="off">' + (q.options.length ? '<datalist id="coding-options-' + e(request.id) + '-' + index + '">' + q.options.map(o => '<option value="' + e(o.label) + '">' + e(o.description) + '</option>').join('') + '</datalist>' : '') + '</label>').join('') : '<pre class="coding-permission-detail">' + e(request.detail) + '</pre><label>Password to approve this request<input type="password" name="password" autocomplete="current-password" required></label>';
    return '<section class="coding-request" data-coding-request="' + e(request.id) + '"><h3>' + e(request.title || (questions ? 'Your answer' : 'Allow extra access?')) + '</h3><form method="post" action="' + base + '/answer" data-coding-form="answer">' + h({csrf,requestId:request.id}) + body + '<div class="coding-actions"><button type="submit" name="decision" value="accept">' + (questions ? 'Send answer' : 'Approve access') + '</button><button type="submit" name="decision" value="decline" formnovalidate class="coding-secondary">' + (questions ? 'Cancel question' : 'Decline') + '</button></div></form></section>';
  };
  const render = snapshot => {
    nativeThread = Boolean(snapshot.session.nativeThreadId);
    if (!snapshot || !snapshot.session || snapshot.session.id !== session || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.requests)) throw new Error('Could not read this session.');
    status = snapshot.session.status;
    root.dataset.codingStatus = status;
    updateComposer(); updateShipping();
    if (snapshot.revision === revision) return;
    revision = snapshot.revision;
    root.dataset.codingRevision = String(revision);
    const labels = {starting:'Starting Codex',ready:'Ready',working:'Working','needs-input':snapshot.requests.some(r => r.kind !== 'questions') ? 'Permission needed' : 'Needs your answer',stopping:'Stopping',interrupted:'Stopped',failed:'Stopped with an error',uncertain:'Delivery not confirmed',closed:'Session closed'};
    root.querySelector('#coding-state').textContent = labels[status] || 'Status unavailable';
    root.querySelectorAll('[data-coding-status-for]').forEach(node => { if (node.dataset.codingStatusFor === session) node.textContent = labels[status] || 'Status unavailable'; });
    if (snapshot.session.error) showError(snapshot.session.error);
    else if (!pendingSend) showError('');
    const controls = root.querySelector('#coding-controls');
    const nextControls = isActive(status) && snapshot.session.turnId ? '<form method="post" action="' + base + '/stop" data-coding-form="stop">' + h({csrf}) + '<button class="coding-secondary"' + (status === 'stopping' ? ' disabled' : '') + '>Stop</button></form>' : status === 'uncertain' ? '<form method="post" action="' + base + '/' + (snapshot.session.deliveryReviewRequired ? 'continue' : 'recover') + '" data-coding-form="recover">' + h({csrf}) + '<button>' + (snapshot.session.deliveryReviewRequired ? (snapshot.session.nativeThreadId ? 'Continue with saved work' : 'Keep work and close session') : 'Check saved session') + '</button></form>' : !snapshot.session.nativeThreadId && ['closed','failed','interrupted'].includes(status) ? '' : ['failed','interrupted'].includes(status) ? '<form method="post" action="' + base + '/resume" data-coding-form="resume">' + h({csrf}) + '<button>Resume session</button></form>' : '';
    const controlKey = status + ':' + (snapshot.session.turnId || '') + ':' + Boolean(snapshot.session.deliveryReviewRequired) + ':' + Boolean(snapshot.session.nativeThreadId);
    if (controls.dataset.status !== controlKey) { controls.innerHTML = nextControls; controls.dataset.status = controlKey; }
    const requests = root.querySelector('#coding-requests');
    const live = new Set(snapshot.requests.map(request => request.id));
    requests.querySelectorAll('[data-coding-request]').forEach(node => {
      if (!live.has(node.dataset.codingRequest)) {
        const focused = node.contains(document.activeElement); node.remove();
        if (focused) { root.querySelector('#coding-state').tabIndex = -1; root.querySelector('#coding-state').focus(); showConnection('That request has been resolved.'); }
      }
    });
    snapshot.requests.forEach(request => {
      if (!Array.from(requests.children).some(node => node.dataset.codingRequest === request.id)) requests.insertAdjacentHTML('beforeend', requestHtml(request));
    });
    const conversation = root.querySelector('#coding-conversation');
    const nearBottom = followLatest || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
    const items = new Set(snapshot.items.filter(item => item.type !== 'reasoning').map(item => item.id));
    conversation.querySelectorAll('[data-coding-item]').forEach(node => { if (!items.has(node.dataset.codingItem)) node.remove(); });
    conversation.hidden = status === 'closed' && items.size === 0;
    if (items.size) conversation.querySelector('.coding-no-messages')?.remove();
    else if (!conversation.querySelector('.coding-no-messages')) { const empty = document.createElement('p'); empty.className = 'coding-meta coding-no-messages'; empty.textContent = 'No messages yet.'; conversation.append(empty); }
    snapshot.items.filter(item => item.type !== 'reasoning').forEach(item => {
      const role = ['user','userMessage'].includes(item.type) ? 'You' : ['agent','assistant','agentMessage'].includes(item.type) ? 'Codex' : null;
      let node = Array.from(conversation.children).find(child => child.dataset.codingItem === item.id);
      if (!node) {
        node = document.createElement(role ? 'article' : 'details'); node.dataset.codingItem = item.id;
        node.className = role ? 'coding-message' + (role === 'You' ? ' coding-user' : '') : 'coding-tool';
        if (role) { const who = document.createElement('strong'); who.textContent = role; node.append(who); const body = document.createElement('div'); body.className = 'coding-text'; node.append(body); }
        else { node.append(document.createElement('summary'),document.createElement('pre')); }
        conversation.append(node);
      }
      if (role) { const body = node.querySelector('.coding-text'); if (body && node.dataset.codingText !== item.text) { body.innerHTML = linkedText(item.text); node.dataset.codingText = item.text; } }
      else {
        const title = ({commandExecution:'Command',fileChange:'File changes',mcpToolCall:'Tool',reasoning:'Reasoning',plan:'Plan',error:'Error'})[item.type] || 'Activity';
        node.querySelector('summary').textContent = title + (item.status ? ' · ' + item.status : '');
        const text = node.querySelector('pre'); if (text.textContent !== item.text) text.textContent = item.text;
      }
    });
    if (nearBottom) jumpToLatest();
    root.querySelector('#coding-latest').hidden = conversation.hidden || nearBottom;
  };
  const poll = async () => {
    if (!session || polling || disposed || authLost) return;
    polling = true; clearTimeout(timer);
    try {
      const response = await fetch(base + '/state?revision=' + encodeURIComponent(String(revision)), {headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store',signal:requestSignal()});
      if (response.status === 401 || response.redirected) { signedOut(); return; }
      if (!response.ok) throw new Error('Could not refresh the session.');
      const snapshot = await response.json();
      if (snapshot.unchanged !== true) render(snapshot);
      if (!pendingSend) showConnection('');
    } catch { if (!disposed) showConnection('Connection lost. Reconnecting… Your draft is saved.'); saveDraft(); }
    finally { polling = false; if (!disposed && !authLost) timer = setTimeout(poll, isActive(status) ? 1000 : 5000); }
  };
  const loadChanges = async () => {
    if (changesBusy || authLost) return;
    changesBusy = true;
    const area = root.querySelector('#coding-change-content');
    const button = root.querySelector('#coding-refresh-changes'); button.disabled = true;
    try {
      const response = await fetch(base + '/changes', {headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store',signal:requestSignal()});
      if (response.status === 401 || response.redirected) { signedOut(); return; }
      if (!response.ok) throw new Error('Could not load changes. Try Refresh changes.');
      const changes = await response.json();
      hasChanges = Boolean(changes.diff || changes.status); updateShipping();
      area.replaceChildren();
      const meta = document.createElement('p'); meta.className = 'coding-meta'; meta.textContent = changes.diff ? 'Changes since this session started.' : changes.status ? 'Changed files are listed below.' : 'No file changes.'; area.append(meta);
      if (changes.status) {
        const files = document.createElement('ul');
        changes.status.split('\n').filter(line => line.trim()).forEach(line => { const file = document.createElement('li'); const code = line.slice(0,2); const label = code.includes('?') || code.includes('A') ? 'Added' : code.includes('D') ? 'Removed' : code.includes('R') ? 'Renamed' : 'Modified'; file.textContent = label + ': ' + line.slice(3); files.append(file); });
        area.append(files);
      }
      if (changes.diff) { const pre = document.createElement('pre'); pre.tabIndex = 0; pre.setAttribute('aria-label','Current diff'); pre.textContent = changes.diff; area.append(pre); }
      if (changes.truncated) { const note = document.createElement('p'); note.textContent = 'This diff is shortened. Inspect the complete changes in the worktree before shipping.'; area.append(note); }
    } catch (error) { area.textContent = error.message || 'Could not load changes.'; }
    finally { changesBusy = false; button.disabled = false; }
  };
  restoreDraft(); updateComposer();
  if (pendingSend) showConnection('Delivery not confirmed. Retry the same message to check its receipt.');
  prompt?.addEventListener('input',saveDraft);
  composer?.querySelector('[name="repo"]')?.addEventListener('change',() => { prompt.value = ''; pendingSend = null; requestField.value = crypto.randomUUID(); restoreDraft(); updateComposer(); });
  root.querySelector('#coding-latest')?.addEventListener('click',jumpToLatest);
  root.querySelector('#coding-conversation')?.addEventListener('scroll',event => {
    const conversation = event.target;
    if (automaticScrollTop !== null && Math.abs(conversation.scrollTop - automaticScrollTop) < 1) { automaticScrollTop = null; return; }
    automaticScrollTop = null;
    followLatest = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
    if (followLatest) root.querySelector('#coding-latest').hidden = true;
  });
  root.querySelector('#coding-changes')?.addEventListener('toggle',event => { if (event.target.open) void loadChanges(); });
  root.querySelector('#coding-refresh-changes')?.addEventListener('click',loadChanges);
  root.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-coding-form]')) return;
    event.preventDefault();
    if (form.dataset.busy || authLost) return;
    const kind = form.dataset.codingForm;
    if (kind === 'send' && status === 'closed') return;
    if (kind === 'send' && status === 'uncertain') { showError('Delivery is not confirmed. Inspect the session before sending again.'); return; }
    const submitter = event.submitter;
    const decision = submitter?.value || 'accept';
    if (!(submitter && submitter.formNoValidate) && !form.reportValidity()) return;
    const data = new URLSearchParams();
    new FormData(form).forEach((value,key) => { if (typeof value === 'string') data.append(key,value); });
    if (kind === 'answer') {
      data.set('decision',decision);
      const answers = {};
      form.querySelectorAll('[name^="question:"]').forEach(field => { answers[field.name.slice(9)] = {answers:[field.value]}; });
      if (Object.keys(answers).length) data.set('answers',JSON.stringify(answers));
    }
    if (kind === 'send' || kind === 'start') {
      if (pendingSend) Object.entries(pendingSend).forEach(([key,value]) => data.set(key,value));
      else {
        pendingSend = {prompt:data.get('prompt'),requestId:data.get('requestId')};
        if (kind === 'start') ['repo','title','model'].forEach(key => pendingSend[key] = data.get(key) || '');
      }
      busy = true; saveDraft(); updateComposer();
      if (kind === 'send') jumpToLatest();
    }
    form.dataset.busy = 'true';
    const buttons = Array.from(form.querySelectorAll('button')); buttons.forEach(button => button.disabled = true);
    try {
      const response = await fetch(form.getAttribute('action'), {method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},credentials:'same-origin',body:data.toString(),signal:requestSignal()});
      if (response.status === 401 || response.redirected) { signedOut(); return; }
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if ((kind === 'send' || kind === 'start') && result.delivery === 'rejected') {
          pendingSend = null; prompt.readOnly = false; requestField.value = crypto.randomUUID(); showConnection(''); saveDraft();
        }
        throw Object.assign(new Error(result.error || 'Could not complete this action.'), {sessionId:result.sessionId,delivery:result.delivery});
      }
      showError('');
      if (kind === 'send' || kind === 'start') {
        pendingSend = null; prompt.value = ''; prompt.readOnly = false; requestField.value = crypto.randomUUID(); storage('removeItem',draftKey());
        if (kind === 'start' && result.id) { location.assign('/code/' + encodeURIComponent(result.id)); return; }
      }
      if (kind === 'recover' && form.getAttribute('action').endsWith('/continue')) { pendingSend = null; requestField.value = crypto.randomUUID(); saveDraft(); }
      if (kind === 'answer') form.closest('[data-coding-request]')?.remove();
      if (session) void poll();
    } catch (error) { showError(error.message || 'Could not complete this action.', error.sessionId); if (pendingSend) showConnection(error.delivery === 'pending' ? 'The request is still in progress. Your draft is saved.' : 'Delivery not confirmed. Retry the same message to check its receipt.'); }
    finally { form.querySelectorAll('[type="password"]').forEach(field => field.value = ''); delete form.dataset.busy; buttons.forEach(button => button.disabled = false); busy = false; saveDraft(); updateComposer(); }
  });
  window.addEventListener('pagehide',() => { disposed = true; clearTimeout(timer); saveDraft(); });
  window.addEventListener('pageshow',event => { if (event.persisted) { disposed = false; void poll(); } });
  document.addEventListener('visibilitychange',() => { if (!document.hidden) void poll(); });
  if (session) requestAnimationFrame(jumpToLatest);
  if (session) timer = setTimeout(poll, isActive(status) ? 1000 : 5000);
})();`;
}
