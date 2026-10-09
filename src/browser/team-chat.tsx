import { useCallback, useEffect, useRef, useState } from 'react';
import { roomName, useLiveRoom } from './live.js';
import type { FormEvent, ReactNode } from 'react';
import type { TeamMessage, TeamOperation, TeamProposal, TeamResponse, TeamSnapshot } from '../team-contract.js';
import { Alert, Badge, Button, Disclosure, Input, Label, Textarea } from './ui/index.js';
import { ActionCards } from './chat-cards.js';

type Draft = { text: string; requestId: string; uncertain: boolean };
const fresh = (): Draft => ({ text: '', requestId: crypto.randomUUID(), uncertain: false });
function restore(key: string): Draft {
  try {
    const row: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (row && typeof row === 'object' && typeof (row as Draft).text === 'string' && typeof (row as Draft).requestId === 'string') return row as Draft;
  } catch { /* Private browsing can disable storage; keep the mounted draft. */ }
  return fresh();
}
export function teamMessageStatus(message: TeamMessage): string | null {
  return ({ queued: 'Queued', running: 'Working', failed: 'Could not finish', cancelled: 'Stopped', uncertain: 'Delivery unconfirmed', answered: null })[message.status];
}
/** Only existing relative task/result paths become links. Model text never becomes HTML. */
function messageText(text: string, conversationId?: string): ReactNode[] {
  return text.split(/(\/(?:t\/[^\s<>"')]+|r\/\d+(?:\?[^\s<>"')]+)?|chat\?task=[^\s<>"')]+))/g).map((part, index) => {
    if (!/^\/(?:t\/|r\/|chat\?task=)/.test(part)) return part;
    const clean = part.replace(/[.,;!]+$/, '');
    const href = conversationId && clean.startsWith('/chat?') ? clean + '&conversation=' + encodeURIComponent(conversationId) : clean;
    return <span key={index}><a href={href}>{href.startsWith('/r/') || href.includes('result=') ? 'Open result' : 'Open task'}</a>{part.slice(clean.length)}</span>;
  });
}
function Projects({ projects }: { projects: string[] }) {
  return <fieldset className="so-team-projects"><legend>Projects</legend>{projects.length === 0 ? <p>Add a project before creating a lead.</p> : projects.map(project => <label key={project}><input type="checkbox" name="projects" value={project} defaultChecked={projects.length === 1} /><span title={project}>{project.split('/').pop() || project}</span></label>)}</fieldset>;
}

function TeamProposals({ proposals, csrf, onChanged, readOnly }: { proposals: TeamProposal[]; csrf: string; onChanged: () => void; readOnly: boolean }) {
  if (!proposals.length) return null;
  return <div className="so-team-proposals">{proposals.map(proposal => proposal.card
    ? <ActionCards key={proposal.id} cards={[proposal.card]} csrf={csrf} onChanged={onChanged} readOnly={readOnly} />
    // Older snapshots still have a route to their saved proposal, without inventing controls or outcomes.
    : <article key={proposal.id}><strong>{proposal.title}</strong><Badge>{proposal.state === 'pending' ? 'Proposed' : proposal.state}</Badge><a href={proposal.href}>{proposal.state === 'pending' ? 'Review action' : 'Open outcome'}</a></article>)}</div>;
}

export function TeamChat({ initial, user, csrf, onSnapshot }: { initial: TeamSnapshot; user: string; csrf: string; onSnapshot?: (snapshot: TeamSnapshot) => void }) {
  const [snapshot, setSnapshot] = useState(initial);
  const conversation = snapshot.selected;
  const key = `standing-orders:team-draft:${user}:${conversation?.id ?? 'new'}`;
  const [draft, setDraft] = useState<Draft>(() => restore(key));
  const [problem, setProblem] = useState('');
  const [disconnected, setDisconnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [storageProblem, setStorageProblem] = useState(false);
  const [checkedMissing, setCheckedMissing] = useState(false);
  const state = useRef({ snapshot, draft }); state.current = { snapshot, draft };
  const busyRef = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const lead = snapshot.leads.find(row => row.id === conversation?.leadId);
  const requestedLead = typeof window === 'undefined' ? null : new URL(window.location.href).searchParams.get('lead');
  const selectedLead = lead?.id ?? snapshot.leads.find(row => row.id === requestedLead)?.id ?? snapshot.leads[0]?.id ?? '';
  const [newLead, setNewLead] = useState(selectedLead);
  const currentLead = snapshot.leads.find(row => row.id === newLead);
  useEffect(() => { if (!snapshot.leads.some(row => row.id === newLead)) setNewLead(selectedLead); }, [snapshot.leads, newLead, selectedLead]);
  const storeDraft = useCallback((next: Draft) => {
    setDraft(next); setCheckedMissing(false);
    try { sessionStorage.setItem(key, JSON.stringify(next)); setStorageProblem(false); } catch { setStorageProblem(true); }
  }, [key]);
  const accept = useCallback((next: TeamSnapshot) => {
    setSnapshot(next); onSnapshot?.(next);
    const pending = state.current.draft;
    if (pending.text && next.messages.some(message => message.author === user && message.requestId === pending.requestId)) storeDraft(fresh());
  }, [storeDraft, user, onSnapshot]);
  const refresh = useCallback(async () => {
    const response = await fetch('/api/team' + (conversation ? '?conversation=' + encodeURIComponent(conversation.id) : ''), { credentials: 'same-origin', cache: 'no-store' });
    const value = await response.json() as TeamResponse;
    if (response.status === 401 || response.status === 403) { setRevoked(true); setProblem(value.message); return; }
    if (!value.ok || !value.snapshot) throw new Error(value.message || 'Updates are unavailable.');
    accept(value.snapshot); setDisconnected(false);
  }, [conversation?.id, accept]);
  // The conversation's room says when it changed; the read itself goes through /api/team.
  useLiveRoom(revoked ? null : roomName('team', null, { conversation: conversation?.id }), event => {
    if (event === 'change' || event === 'reload') void refresh().catch(() => setDisconnected(true));
    else if (event === 'gone') { setRevoked(true); setProblem('Your access changed. Reopen Chat or sign in again.'); }
    else if (event === 'lost') setDisconnected(true);
  });
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [snapshot.messages.length]);
  const lastMessage = snapshot.messages.at(-1)?.id;
  useEffect(() => {
    if (!conversation || !lastMessage || revoked || document.hidden) return;
    // Personal reading does not wake a model or invalidate the shared stream.
    void fetch('/api/team', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ operation: 'read', args: { conversationId: conversation.id, messageId: lastMessage } }) }).catch(() => undefined);
  }, [conversation?.id, lastMessage, revoked, csrf]);
  async function execute(operation: TeamOperation, args: Record<string, unknown>): Promise<TeamResponse | null> {
    if (busyRef.current || revoked) return null;
    busyRef.current = true; setBusy(true); setProblem('');
    try {
      const response = await fetch('/api/team', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ operation, args }) });
      const value = await response.json() as TeamResponse;
      if (value.snapshot) accept(value.snapshot);
      if (!value.ok) { setProblem(value.message); if (value.code === 'delivery-unconfirmed' && operation === 'send') storeDraft({ ...state.current.draft, uncertain: true }); return null; }
      return value;
    } catch {
      if (operation === 'send') storeDraft({ ...state.current.draft, uncertain: true });
      setProblem('The response was not confirmed. Check saved messages before sending again.');
      return null;
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!conversation || !draft.text.trim() || draft.uncertain) return;
    const sent = await execute('send', { conversationId: conversation.id, text: draft.text, requestId: draft.requestId });
    if (sent) storeDraft(fresh());
  }
  async function create(event: FormEvent<HTMLFormElement>, kind: 'create-lead' | 'create-conversation') {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const projects = form.getAll('projects');
    if (!projects.length) { setProblem('Choose at least one project.'); return; }
    const result = await execute(kind, kind === 'create-lead' ? { name: form.get('name'), instructions: form.get('instructions') ?? '', projects } : { leadId: newLead, title: form.get('title'), visibility: form.get('visibility'), projects });
    const resultId = result?.result && typeof result.result === 'object' ? result.result as Record<string, unknown> : {};
    if (result?.ok && kind === 'create-lead' && typeof resultId.leadId === 'string') window.location.assign('/chat?lead=' + encodeURIComponent(resultId.leadId));
    else if (result?.snapshot?.selected) window.location.assign('/chat?conversation=' + encodeURIComponent(result.snapshot.selected.id));
    else if (result?.ok) await refresh();
  }
  const createConversation = <form className="so-team-form" onSubmit={event => { void create(event, 'create-conversation'); }}>
    {snapshot.leads.length > 1 && <label>Lead<select name="leadId" value={newLead} onChange={event => setNewLead(event.target.value)}>{snapshot.leads.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
    <label>Conversation title<Input name="title" required maxLength={160} placeholder="What are we working on?" /></label>
    <label>Audience<select name="visibility" defaultValue="team"><option value="team">Team — invited people</option><option value="private">Private — only you</option></select></label>
    <Projects key={newLead} projects={currentLead?.projects ?? []} />
    <Button type="submit" disabled={busy || !currentLead}>Create conversation</Button>
  </form>;
  const canCreateLead = 'canCreateLead' in snapshot && snapshot.canCreateLead === true;
  const replyByTurn = new Map(snapshot.messages.filter(message => message.role === 'assistant' && message.turnId !== null).map(message => [message.turnId, message.id]));
  const proposalsByMessage = new Map<number | null, TeamProposal[]>();
  for (const proposal of snapshot.proposals ?? []) {
    if (proposal.state === 'drafting') continue;
    const messageId = replyByTurn.get(proposal.turnId) ?? null;
    const group = proposalsByMessage.get(messageId) ?? [];
    group.push(proposal); proposalsByMessage.set(messageId, group);
  }
  const proposalsAt = (messageId: number | null) => <TeamProposals proposals={proposalsByMessage.get(messageId) ?? []} csrf={csrf} readOnly={revoked}
    onChanged={() => { void refresh().catch(() => setDisconnected(true)); }} />;
  return <section className="so-team-chat" aria-label="Team conversation">
    <div className="so-team-toolbar">
      {snapshot.leads.length > 1 && <label className="so-team-lead-select"><span className="so-sr-only">Lead</span><select aria-label="Lead" value={selectedLead} onChange={event => window.location.assign('/chat?lead=' + encodeURIComponent(event.target.value))}>{snapshot.leads.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
      {conversation ? <><div className="so-team-title"><h2>{conversation.title}</h2>{snapshot.leads.length === 1 && <span>{lead?.name ?? 'Lead'}</span>}</div><Disclosure summary={conversation.visibility === 'team' ? 'Team' : 'Private'} className="so-team-audience"><h3>People</h3><ul>{snapshot.participants.filter(person => person.active).map(person => <li key={person.account}><span>{person.account}</span><span>{person.role}</span>{snapshot.canManage && person.account !== user && <Button variant="ghost" onClick={() => { void execute('member', { conversationId: conversation.id, account: person.account, role: person.role, active: false, expectedRevision: conversation.revision }); }} disabled={busy}>Remove</Button>}</li>)}</ul>
        {snapshot.canManage && conversation.visibility === 'team' && <form className="so-team-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void execute('member', { conversationId: conversation.id, account: form.get('account'), role: form.get('role'), active: true, expectedRevision: conversation.revision, joinLead: true, expectedLeadRevision: lead?.revision }); }}><label>Person<select name="account" required>{snapshot.accounts.filter(account => !snapshot.participants.some(person => person.account === account && person.active)).map(account => <option key={account}>{account}</option>)}</select></label><label>Access<select name="role" defaultValue="contributor"><option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="manager">Manager</option></select></label><p className="so-team-small">Adds access to this conversation and {lead?.name ?? 'the lead'} for these projects: {lead?.projects.map(project => project.split('/').pop()).join(', ')}. Existing private conversations stay private.</p><Button type="submit" disabled={busy}>Add person</Button></form>}
        <p className="so-team-small">Projects: {conversation.projects.map(project => project.split('/').pop()).join(', ')}</p></Disclosure></> : <h2>{snapshot.leads.length ? 'Start a conversation' : 'Your team lead'}</h2>}
    </div>
    <div className="so-team-content">
      {(problem || revoked) && <Alert tone="error">{problem || 'Your access changed.'}{revoked && <> <a href="/chat">Reopen Chat</a></>}</Alert>}
      {disconnected && !revoked && <Alert>Live updates disconnected. <Button variant="ghost" onClick={() => { void refresh().catch(() => setProblem('Updates are still unavailable. Your draft is saved.')); }}>Check messages</Button></Alert>}
      {!conversation && snapshot.leads.length > 0 && <>{snapshot.conversations.length > 0 && <nav className="so-team-room-list" aria-label="Conversations">{snapshot.conversations.map(room => <a key={room.id} href={'/chat?conversation=' + encodeURIComponent(room.id)}><strong>{room.title}</strong><span>{room.visibility === 'team' ? 'Team' : 'Private'}</span></a>)}</nav>}{createConversation}</>}
      {!conversation && snapshot.leads.length === 0 && <><p>{canCreateLead ? 'Create a lead, then invite people into a conversation.' : 'Ask a team administrator to invite you to a conversation.'}</p>{canCreateLead && <form className="so-team-form" onSubmit={event => { void create(event, 'create-lead'); }}><label>Lead name<Input name="name" defaultValue="Team lead" required maxLength={100} /></label><Projects projects={snapshot.projects} /><Disclosure summary="Working instructions"><Textarea name="instructions" rows={4} placeholder="What should this lead focus on?" /></Disclosure><Button type="submit" disabled={busy || !snapshot.projects.length}>Create lead</Button></form>}</>}
      {conversation && <><div className="so-team-messages" aria-live="polite" aria-relevant="additions text">{snapshot.messages.length === 0 && <div className="so-team-empty"><h3>What would you like to work on?</h3><p>{conversation.visibility === 'team' ? 'People you invite can join this conversation.' : 'Only you can read this conversation.'}</p></div>}{snapshot.messages.map(message => <article key={message.id} className={'so-team-message so-team-message--' + message.role} data-team-message={message.id}>
        <div className="so-team-message-meta"><strong>{message.author}</strong>{teamMessageStatus(message) && <Badge tone={['failed', 'uncertain'].includes(message.status) ? 'danger' : 'neutral'}>{teamMessageStatus(message)}</Badge>}</div>
        {editing === message.id ? <form className="so-team-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void execute('edit', { conversationId: conversation.id, messageId: message.id, expectedRevision: message.revision, text: form.get('text') }).then(value => { if (value) setEditing(null); }); }}><Label htmlFor={'team-edit-' + message.id}>Edit queued message</Label><Textarea id={'team-edit-' + message.id} name="text" defaultValue={message.text} required maxLength={2_000} rows={3} /><div><Button type="submit" disabled={busy}>Save edit</Button><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div></form> : <p className="so-team-message-text">{messageText(message.text, conversation.id)}</p>}
        {message.error && <Alert tone="error">{message.error}</Alert>}
        {message.status === 'queued' && message.author === user && !revoked && <div className="so-team-message-actions"><Button variant="ghost" onClick={() => setEditing(message.id)} disabled={busy}>Edit</Button><Button variant="ghost" onClick={() => { void execute('withdraw', { conversationId: conversation.id, messageId: message.id, expectedRevision: message.revision }); }} disabled={busy}>Withdraw</Button></div>}
        {proposalsAt(message.id)}
      </article>)}</div>{snapshot.truncated && <p className="so-team-small">Showing the most recent messages.</p>}</>}
      {proposalsAt(null)}
      <div ref={end} />
      <Disclosure summary="Conversations" className="so-team-settings">{conversation && <><nav className="so-team-room-list" aria-label="Other conversations">{snapshot.conversations.filter(room => room.id !== conversation.id).map(room => <a key={room.id} href={'/chat?conversation=' + encodeURIComponent(room.id)}>{room.title}</a>)}</nav><h3>New conversation</h3>{createConversation}</>}<a href="/chat?private=1">Previous private chat</a>{snapshot.canManage && lead && <Disclosure summary="Lead settings"><form className="so-team-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void execute('update-lead', { leadId: lead.id, expectedRevision: lead.revision, name: form.get('name'), instructions: form.get('instructions'), status: form.get('status') }); }}><label>Lead name<Input name="name" defaultValue={lead.name} required maxLength={100} /></label><label>Working instructions<Textarea name="instructions" defaultValue={lead.instructions} rows={4} /></label><label>Status<select name="status" defaultValue={lead.status}><option value="active">Active</option><option value="paused">Paused</option></select></label><p className="so-team-small">Projects: {lead.projects.map(project => project.split('/').pop()).join(', ')}</p><Button type="submit" disabled={busy}>Save lead</Button></form></Disclosure>}{canCreateLead && snapshot.leads.length > 0 && <Disclosure summary="Add a lead"><form className="so-team-form" onSubmit={event => { void create(event, 'create-lead'); }}><label>Lead name<Input name="name" required maxLength={100} /></label><Projects projects={snapshot.projects} /><label>Working instructions<Textarea name="instructions" rows={3} /></label><Button type="submit" disabled={busy}>Create lead</Button></form></Disclosure>}</Disclosure>
    </div>
    {conversation && <div className="so-team-composer"><TeamConsent snapshot={snapshot} execute={execute} busy={busy} />{snapshot.canSend && !revoked ? <form onSubmit={event => { void send(event); }}><Label htmlFor="team-message" className="so-sr-only">Message {lead?.name ?? 'the lead'}</Label><Textarea id="team-message" rows={3} value={draft.text} placeholder={'Message ' + (lead?.name ?? 'your lead')} onChange={event => storeDraft({ text: event.target.value, requestId: draft.uncertain ? crypto.randomUUID() : draft.requestId, uncertain: false })} disabled={busy || draft.uncertain} maxLength={2_000} /><div className="so-team-compose-actions">{snapshot.messages.some(message => message.status === 'running') && <Button variant="secondary" onClick={() => { void execute('stop', { conversationId: conversation.id, messageId: snapshot.messages.find(message => message.status === 'running')?.id }); }} disabled={busy}>Stop</Button>}{draft.uncertain ? <Button onClick={() => { void refresh().then(() => { if (state.current.draft.uncertain) { setCheckedMissing(true); setProblem('This message is not in saved history. You can send the saved message with its original request identity.'); } }).catch(() => setProblem('Saved messages could not be checked. Your draft is preserved.')); }}>Check messages</Button> : <Button type="submit" disabled={busy || !draft.text.trim() || !snapshot.chatAuthorization?.enabled}>{busy ? 'Saving…' : 'Send'}</Button>}{draft.uncertain && checkedMissing && <Button disabled={busy} onClick={() => { void execute('send', { conversationId: conversation.id, text: draft.text, requestId: draft.requestId }).then(result => { if (result) storeDraft(fresh()); }); }}>Send saved message</Button>}</div></form> : !revoked && <p className="so-team-small">You can read this conversation. Ask a manager for permission to send messages.</p>}{storageProblem && <Alert>Keep this tab open until your message is sent; draft storage is unavailable.</Alert>}</div>}
  </section>;
}
function TeamConsent({ snapshot, execute, busy }: { snapshot: TeamSnapshot; execute: (operation: TeamOperation, args: Record<string, unknown>) => Promise<TeamResponse | null>; busy: boolean }) {
  const auth = snapshot.chatAuthorization;
  if (!snapshot.selected || !auth || !snapshot.canSend) return null;
  if (auth.waitingReason) return <Alert>{auth.waitingReason}</Alert>;
  if (auth.enabled) return null;
  return <div className="so-team-consent"><p>Enable {auth.provider} · {auth.model} for your messages in this conversation, using the installation’s configured provider account.</p><p>{auth.dailyTurns} turns per day{auth.weeklyCeilingUsd === null ? '. Your provider subscription limits apply.' : `, $${auth.weeklyCeilingUsd} per week and $${auth.conversationCeilingUsd} for this conversation.`} Execution approvals still apply.</p><Button disabled={busy} onClick={() => { void execute('authorize', { conversationId: snapshot.selected!.id, termsDigest: auth.termsDigest, ceilingUsd: auth.conversationCeilingUsd }); }}>Enable chat</Button></div>;
}
