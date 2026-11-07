import { STALE_KNOWLEDGE, type KnowledgeDraft, type KnowledgeSelection, type KnowledgeView } from './project-knowledge.js';
import { html, joinHtml, postForm, type Html } from './html.js';
import { lastIncludedWords, type MemoryUse } from './memory-use.js';
import { acts, btn, codeLine, disclose, formRow, input, note, notice, radios, settingsLink, settingsRecord, settingsSection, textarea } from './server/kit.js';
// Hidden fields as they always were: a missing value is an empty field.
const fields = (data:Record<string,unknown>):Record<string,string> => Object.fromEntries(Object.entries(data).map(([k,v])=>[k,String(v ?? '')]));
/** A section as a frame (after ReUI's Frame, MIT): its heading on the raised well, its body one paper panel. The
 * cards inside become hairline-divided rows of that panel, never cards in a card. */
export function framedSection(heading: string, body: Html | string, extra = ''): Html {
  return html`<section class="${`knowledge frame${extra ? ` ${extra}` : ''}`}"><div class="frame-head"><h2>${heading}</h2></div><div class="frame-panel">${body}</div></section>`;
}
export const KNOWLEDGE_CSS = `.knowledge{max-width:780px;min-width:0;overflow-wrap:anywhere}.knowledge .card{padding:20px;min-width:0;margin:16px 0}.knowledge h2{margin:0 0 12px}.knowledge form{display:grid;gap:12px;margin:0}.knowledge label{display:grid;gap:6px}.knowledge textarea,.knowledge input,.knowledge select{box-sizing:border-box;width:100%;min-width:0;max-width:100%}.knowledge textarea{resize:vertical;min-height:110px}.knowledge button,.knowledge summary,.knowledge .button-link{min-height:44px}.knowledge button{justify-self:start;white-space:nowrap}.knowledge summary{padding:12px 0;cursor:pointer}.knowledge pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.knowledge .knowledge-actions{display:flex;gap:12px;flex-wrap:wrap}.knowledge .meta{font-size:.86rem}.knowledge .knowledge-source{display:block}.knowledge details+details{border-top:1px solid var(--so-line)}.memory-stats{display:flex;flex-wrap:wrap;gap:.4rem}.memory-stats span+span::before{content:"·";margin-right:.4rem}.knowledge.frame{margin:0 0 16px}.knowledge.frame>.frame-head h2,.knowledge.frame>summary.frame-head{margin:0;font-size:13px;font-weight:600;line-height:1.4}.knowledge.frame>summary.frame-head{min-height:44px;padding:4px 10px}.knowledge.frame>.frame-panel{min-width:0}.knowledge.frame>.frame-panel>:first-child{margin-top:0}.knowledge.frame>.frame-panel>:last-child{margin-bottom:0}.knowledge .frame-panel>details.card,.knowledge .frame-panel .learning .card{margin:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none}.knowledge .frame-panel>details.card+details.card,.knowledge .frame-panel .learning .card+.card{border-top:1px solid var(--so-line);padding-top:4px}.knowledge.frame>summary.frame-head{justify-content:flex-start}.knowledge form.field-row{grid-template-columns:minmax(0,1fr) auto;align-items:end}.knowledge form.field-row>label,.knowledge form.field-row :is(input,select,button){margin:0}@media(max-width:600px){.knowledge .card{padding:16px}.knowledge h2{font-size:1.1rem}}`;
export function knowledgeHtml(view:KnowledgeView,csrf:string,canManage:boolean,draft?:KnowledgeDraft,error?:string,use:ReadonlyMap<string,MemoryUse>=new Map()):Html {
  const manage=canManage && !!csrf;
  const base={repo:view.repo,identity:view.identity,revision:view.revision};
  const form=(action:string,body:Html,extra:Record<string,unknown>={})=>postForm('/settings/knowledge/change',body,{hidden:fields({...base,action,...extra})});
  const referenceFields=(d:KnowledgeDraft,key:string)=>joinHtml([
    formRow('Name',null,input({id:`ref-${key}-title`,name:'title',value:d.title??'',attrs:{maxlength:120,required:true,'aria-label':'Name'}}),'wide'),
    formRow('Reference text',null,textarea({id:`ref-${key}-content`,name:'content',rows:5,value:d.content??'',attrs:{maxlength:12000,'aria-label':'Reference text'}}),'top'),
    disclose('Use a project document',formRow('Committed .md or .txt path','Uses the committed file instead of the text above. Save again to refresh it.',
      input({id:`ref-${key}-path`,name:'path',value:d.path??'',attrs:{placeholder:'docs/design-guide.md','aria-label':'Committed .md or .txt path'}}),'wide'),Boolean(d.path)),
    acts(btn('Save reference',{sm:true,type:'submit'})),
  ]);
  const refs=view.knowledge.references.map(ref=>settingsRecord({
    title:ref.title,
    sub:ref.path?html`<span class="k-mono">${ref.path} · ${ref.sourceRevision?.slice(0,7)}</span>`:'',
    when:lastIncludedWords(use.get(`reference:${ref.id}`)),
    more:joinHtml([
      disclose('Read reference',html`<pre class="k-scode">${ref.content}</pre>`,draft?.id===ref.id),
      manage?disclose('Edit reference',joinHtml([
        form('save',referenceFields(draft?.id===ref.id?draft:{title:ref.title,content:ref.path?'':ref.content,path:ref.path??''},String(ref.id)),{id:ref.id}),
        disclose('Remove reference',form('remove',joinHtml([note('Remove from future tasks. Previous run context stays available.'),acts(btn('Remove reference',{sm:true,variant:'danger',type:'submit'}))]),{id:ref.id})),
      ]),draft?.id===ref.id):'',
    ]),
  }));
  const history=view.history.map(h=>settingsLink({href:`/settings/knowledge?repo=${encodeURIComponent(view.repo)}&version=${h.revision}`,title:`Version ${h.revision}`,status:`${h.actor} · ${h.at.slice(0,16).replace('T',' ')} UTC`}));
  const problem=error?notice(error):'';
  if (view.stale) {
    // One notice, the saved knowledge on demand, one approver action. Editing waits until it is applied.
    const saved=view.stale.knowledge;
    const review=disclose('Review saved knowledge',joinHtml([html`<pre class="k-scode">${saved.instructions||'No project instructions.'}</pre>`,...saved.references.map(ref=>disclose(ref.title,html`<pre class="k-scode">${ref.content}</pre>`))]));
    return joinHtml([problem,settingsSection({id:'knowledge-stale',title:'Saved knowledge',body:joinHtml([
      html`<p class="k-notice info" role="status">${STALE_KNOWLEDGE}.</p>`,review,
      manage?form('apply',acts(btn('Apply saved knowledge',{variant:'primary',type:'submit'}))):'',
    ])})]);
  }
  const instructions = html`<pre class="k-scode">${view.knowledge.instructions||'No project instructions yet.'}</pre>`;
  const editor = manage ? disclose(view.knowledge.instructions?'Edit instructions':'Add instructions',form('instructions',joinHtml([
    textarea({id:'knowledge-instructions',name:'instructions',rows:5,value:draft?.instructions??view.knowledge.instructions,attrs:{'aria-label':'Project instructions',maxlength:4000,placeholder:'Goals, preferences, and what good work looks like…'}}),
    acts(btn('Save instructions',{sm:true,type:'submit'})),
  ])),draft?.instructions!==undefined) : '';
  const add = manage ? disclose('Add reference',form('save',referenceFields(draft?.id?{}:draft??{},'new')),Boolean(draft?.title&&!draft.id)) : '';
  return joinHtml([
    problem,
    settingsSection({id:'instructions',title:'Instructions',lead:'What every task in this project reads first.',body:joinHtml([instructions,editor])}),
    settingsSection({id:'references',title:'References',body:joinHtml([refs.length?joinHtml(refs):note('Add a spec, design guide, or useful project document.'),add])}),
    history.length?settingsSection({id:'knowledge-history',title:'Change history',body:html`<div class="k-slinks">${history}</div>`}):'',
  ]);
}
export function knowledgeContextHtml(snapshot:KnowledgeSelection|null):Html|'' {
  if (!snapshot) return '';
  return html`<details class="knowledge result-knowledge"><summary>Context used</summary><p class="meta">Project knowledge · version ${snapshot.revision}${snapshot.inheritedFrom===null?'':` · from run #${snapshot.inheritedFrom}`}</p>${snapshot.instructions?html`<details><summary>Instructions</summary><pre>${snapshot.instructions}</pre></details>`:html`<p>No project instructions were supplied.</p>`}${snapshot.references.map(r=>html`<details><summary>${r.title}</summary>${r.path?html`<p class="meta">${r.path} · ${r.sourceRevision}</p>`:''}<pre>${r.content}</pre></details>`)}${snapshot.omitted.length?html`<details><summary>Not included (${snapshot.omitted.length})</summary><ul>${snapshot.omitted.map(r=>html`<li>${r.title} — ${r.reason}</li>`)}</ul></details>`:''}</details>`;
}

// ---- project memory: decisions and search (2026-09-21) ----------------------------
import type { Decision, MemoryHit } from './project-memory.js';
export const MEMORY_INTRO = 'What the lead and crew read before they work. Every change keeps its history. Last included is counted in runs.';
export function decisionsHtml(repo: string, decisions: Decision[], csrf: string, canManage: boolean, draft?: { claim?: string; why?: string }, error?: string, use: ReadonlyMap<string, MemoryUse> = new Map(), afterwards: (decision: Decision) => string | null = () => null): Html {
  const manage = canManage && !!csrf;
  const base = { repo };
  const form = (action: string, body: Html, extra: Record<string, unknown> = {}) => postForm('/settings/knowledge/decision', body, { hidden: fields({ ...base, action, ...extra }) });
  const rows = decisions.map(d => settingsRecord({
    title: d.claim, sub: d.why, when: html`<span class="k-num">#${d.id}</span> · ${d.decidedBy} · ${d.decidedAt.slice(0, 10)}`, attrs: { id: `decision-${d.id}` },
    more: joinHtml([
      note(lastIncludedWords(use.get(`decision:${d.id}`))),
      afterwards(d) === null ? '' : note(afterwards(d)!),
      note(`${d.sourceKind}${d.sourceRef ? ` · ${d.sourceRef}` : ''}${d.supersedes === null ? '' : ` · replaces #${d.supersedes}`}`),
      manage ? disclose('Retire', form('retire', joinHtml([
        formRow('Why it no longer holds', null, input({ id: `decision-${d.id}-reason`, name: 'reason', attrs: { maxlength: 500, required: true, 'aria-label': 'Why it no longer holds' } }), 'wide'),
        acts(btn('Retire', { sm: true, variant: 'danger', type: 'submit' })),
      ]), { decision: d.id })) : '',
    ]),
  }));
  const add = manage ? disclose('Record a decision', form('record', joinHtml([
    formRow('The choice, in one sentence', null, input({ id: 'decision-claim', name: 'claim', value: draft?.claim ?? '', attrs: { maxlength: 240, required: true, 'aria-label': 'The choice, in one sentence' } }), 'wide'),
    formRow('Why', null, textarea({ id: 'decision-why', name: 'why', rows: 3, value: draft?.why ?? '', attrs: { maxlength: 2000, required: true, 'aria-label': 'Why' } }), 'top'),
    acts(btn('Record', { sm: true, type: 'submit' })),
  ])), draft?.claim !== undefined) : '';
  return settingsSection({ id: 'decisions', title: 'Decisions', body: joinHtml([error ? notice(error) : '', rows.length ? joinHtml(rows) : note('No decisions yet. The lead suggests one when a conversation settles a choice.'), add]) });
}
export function memorySearchHtml(repo: string, query: string, hits: MemoryHit[] | null): Html {
  const kind = (h: MemoryHit) => h.kind === 'decision' ? html`<a class="k-link" href="#decision-${h.ref}">Decision #${h.ref}</a>` : h.kind === 'conversation' ? 'Conversation' : h.kind.charAt(0).toUpperCase() + h.kind.slice(1);
  const results = hits === null ? '' : hits.length === 0 ? note('Nothing in project memory matches.') : joinHtml(hits.map(h => settingsRecord({ title: html`${kind(h)} · ${h.title}`, sub: h.snippet })));
  return settingsSection({ id: 'memory-search', title: 'Search project memory', body: joinHtml([
    html`<form method="get" action="/settings/knowledge" class="k-acts k-picker" role="search"><input type="hidden" name="repo" value="${repo}">${input({ id: 'memory-query', name: 'memory', type: 'search', value: query, attrs: { maxlength: 300, placeholder: 'Search decisions, references, lessons…', autocomplete: 'off', 'aria-label': 'Search project memory' } })}${btn('Search', { sm: true, type: 'submit' })}</form>`,
    results,
  ]) });
}
import type { MemoryProposal } from './memory-pass.js';
import { NOTE_SURFACE } from './lesson-notes.js';
export function proposalsHtml(repo: string, proposals: MemoryProposal[], status: { surface: string; instructionBytes: number; budgetBytes: number; sessions: { total: number; analyzed: number; failed: number }; openGaps: number; pending: number } | null, csrf: string, canManage: boolean, who = ''): Html {
  const manage = canManage && !!csrf;
  const line = status === null ? '' : joinHtml([
    note(`${status.sessions.analyzed}/${status.sessions.total} sessions read${status.sessions.failed ? ` · ${status.sessions.failed} failed` : ''} · ${status.openGaps} open gap${status.openGaps === 1 ? '' : 's'} · Instructions ${status.instructionBytes}/${status.budgetBytes} bytes`),
    disclose('Read new sessions', joinHtml([note('Run this on this computer:'), codeLine(`toolroll memory propose --repo ${repo}`)])),
  ]);
  const decide = (p: MemoryProposal, decision: 'accept' | 'reject', label: string) => postForm('/settings/knowledge/proposal', btn(label, { sm: true, variant: decision === 'accept' ? 'outline' : 'ghost', type: 'submit' }), { hidden: fields({ repo, proposal: p.id, decision }) });
  // A lesson note: the facts, the failure line as output, and the person's own words in an edit box that starts as a draft.
  const lessonNote = (p: MemoryProposal): Html => settingsRecord({
    title: p.title, sub: html`<span class="k-num">#${p.id}</span> · Lesson note`,
    more: joinHtml([
      note(p.rationale),
      ...p.evidence.map(ev => html`<pre class="k-scode">${ev.quote}</pre>`),
      manage ? joinHtml([
        postForm('/settings/knowledge/note', joinHtml([
          formRow('Note', 'Say it in your own words before accepting.', textarea({ id: `note-${p.id}`, name: 'claim', rows: 3, value: p.afterText, attrs: { maxlength: 240, required: true, 'aria-label': 'Note' } }), 'top'),
          acts(btn(`Accept as ${who}`, { sm: true, type: 'submit' })),
        ]), { hidden: fields({ repo, proposal: p.id, decision: 'accept' }) }),
        postForm('/settings/knowledge/note', btn('Reject', { sm: true, variant: 'ghost', type: 'submit' }), { hidden: fields({ repo, proposal: p.id, decision: 'reject' }) }),
      ]) : '',
    ]),
  });
  const cards = proposals.map(p => p.surface === NOTE_SURFACE ? lessonNote(p) : settingsRecord({
    title: p.title, sub: html`<span class="k-num">#${p.id}</span> · ${p.kind} · ${p.sessions} sessions`,
    action: manage ? html`${decide(p, 'accept', 'Accept')}${decide(p, 'reject', 'Reject')}` : '',
    more: joinHtml([
      note(p.rationale),
      p.beforeText ? html`<pre class="k-scode">- ${p.beforeText}</pre>` : '',
      p.afterText ? html`<pre class="k-scode">+ ${p.afterText}</pre>` : '',
      html`<ul class="k-note">${p.evidence.map(ev => html`<li>“${ev.quote.slice(0, 200)}” · ${ev.session.split(':')[0] ?? ''}</li>`)}</ul>`,
    ]),
  }));
  return settingsSection({ id: 'proposals', title: 'Proposed changes', body: joinHtml([line, cards.length ? joinHtml(cards) : note('Nothing to review. Suggestions appear when the same mistake shows up in two sessions.')]) });
}

// ---- clean-up of project memory (docs/plans/learning-loops.md) ----------------------------
import type { TidyProposal } from './memory-tidy.js';
const CLEANUP_TITLES: Record<TidyProposal['kind'], string> = { retire: 'Retire unused', merge: 'Merge duplicates', contradiction: 'Contradiction', 'note-failing': 'Note keeps failing', restore: 'Restore', unmerge: 'Undo merge' };
const cleanupItem = (p: TidyProposal, item: TidyProposal['items'][number]): string => item.kind === 'decision' ? `Decision #${item.id} · version ${item.revision} · ${item.status}${p.titles[`decision:${item.id}`] ? ` · ${p.titles[`decision:${item.id}`]}` : ''}`
  : item.kind === 'lesson' ? `Lesson #${item.id} · version ${item.version}` : `Reference · knowledge version ${item.revision}`;
/** Radio choices for a proposal with no default: nothing is pre-selected. */
const choices = (name: string, options: readonly (readonly [string, string])[]): Html => radios({ name, legend: 'Choose one', current: '', items: options.map(([value, label]) => ({ value, label })) });
export function cleanUpHtml(repo: string, proposals: readonly TidyProposal[], manage: boolean): Html {
  const form = (body: Html, hidden: Record<string, unknown>) => postForm('/settings/knowledge/tidy', body, { hidden: fields({ repo, ...hidden }) });
  const accept = (p: TidyProposal): Html => {
    const tail = Array.isArray(p.evidence['tail']) ? p.evidence['tail'] as number[] : [];
    const decisions = p.items.flatMap(item => item.kind === 'decision' ? [item.id] : []);
    const extra = p.kind === 'contradiction' ? joinHtml([choices('choice', [...decisions.map(id => [`keep:${id}`, `Keep #${id}, retire the other`] as const), ['both', 'Keep both'], ['new', 'Write a new one']]),
        formRow('New decision', null, input({ id: `tidy-${p.id}-claim`, name: 'claim', attrs: { maxlength: 240, 'aria-label': 'New decision' } }), 'wide'), formRow('Why', null, input({ id: `tidy-${p.id}-why`, name: 'why', attrs: { maxlength: 500, 'aria-label': 'Why' } }), 'wide')])
      : p.kind === 'note-failing' ? joinHtml([choices('choice', [['rewrite', 'Rewrite it'], ['retire', 'Retire it']]),
        formRow('New note', null, input({ id: `tidy-${p.id}-claim`, name: 'claim', attrs: { maxlength: 240, 'aria-label': 'New note' } }), 'wide'), formRow('Why', null, input({ id: `tidy-${p.id}-why`, name: 'why', attrs: { maxlength: 500, 'aria-label': 'Why' } }), 'wide')])
      : (p.kind === 'restore' || p.kind === 'unmerge') && tail.length > 0 ? choices('choice', [['retire', `Retire ${tail.map(id => `#${id}`).join(', ')}`], ['keep', 'Keep both active']])
      : p.kind === 'merge' ? formRow('Merged decision', null, input({ id: `tidy-${p.id}-claim`, name: 'claim', value: p.afterText ?? '', attrs: { maxlength: 240, 'aria-label': 'Merged decision' } }), 'wide') : '';
    return form(joinHtml([extra, acts(btn('Accept', { sm: true, type: 'submit' }))]), { action: 'accept', proposal: p.id });
  };
  const rows = proposals.map(p => settingsRecord({
    title: CLEANUP_TITLES[p.kind], sub: p.rationale,
    more: joinHtml([
      html`<ul class="k-note">${p.items.map(item => html`<li>${cleanupItem(p, item)}</li>`)}</ul>`,
      manage ? joinHtml([accept(p), form(btn('Reject', { sm: true, variant: 'ghost', type: 'submit' }), { action: 'reject', proposal: p.id })]) : '',
    ]),
  }));
  return settingsSection({ id: 'clean-up', title: 'Clean up', body: joinHtml([
    rows.length ? joinHtml(rows) : note('Nothing to clean up.'),
    manage ? form(acts(btn('Clean up', { sm: true, type: 'submit' })), { action: 'propose' }) : '',
  ]) });
}
/** On a saved version's page: the references that aren't in current knowledge, each back as a new version. */
export function referenceRestoreHtml(repo: string, revision: number, references: readonly { id: string; title: string }[], manage: boolean): Html | '' {
  if (!manage || references.length === 0) return '';
  return settingsSection({ id: 'reference-restore', title: 'References no longer in use', body: joinHtml(references.map(ref => settingsRecord({ title: ref.title,
    action: postForm('/settings/knowledge/tidy', btn('Restore', { sm: true, variant: 'ghost', type: 'submit' }), { hidden: fields({ repo, action: 'reference', target: ref.id, revision }) }) }))) });
}
/** Retired decisions, undoable merges and disabled lessons, each with its way back. */
export function restoreHtml(repo: string, retired: readonly Decision[], merges: readonly { merge: number; successor: number; predecessors: number[] }[], lessons: readonly { id: number; observation: string }[], manage: boolean): Html | '' {
  if (retired.length + merges.length + lessons.length === 0) return '';
  const form = (label: string, action: string, target: number) => manage ? postForm('/settings/knowledge/tidy', btn(label, { sm: true, variant: 'ghost', type: 'submit' }), { hidden: fields({ repo, action, target }) }) : '';
  return html`<details class="knowledge frame"><summary class="frame-head">Retired</summary><div class="frame-panel">${joinHtml([
    ...merges.map(m => settingsRecord({ title: `Merge of ${m.predecessors.map(id => `#${id}`).join(', ')} into #${m.successor}`, action: form('Undo merge', 'unmerge', m.merge) })),
    ...retired.map(d => settingsRecord({ title: d.claim, sub: html`<span class="k-num">#${d.id}</span> · ${d.status}`, action: form('Restore', 'restore', d.id) })),
    ...lessons.map(l => settingsRecord({ title: l.observation, sub: 'Lesson', action: form('Use again', 'readopt', l.id) })),
  ])}</div></details>`;
}
