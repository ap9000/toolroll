/** Result-first review (workspace package 3, 2026-09-13): the pure parts
 * of ONE result presentation shared by the task chat receipt, the run
 * page, the review cockpit, and the chat's result detail.
 *
 * Nothing here reads a database or renders a full page. The server
 * assembles the same verified records it already reads (handoff, proof,
 * diff, matrix, publication, report) into `SharedResultFacts`; every
 * surface prints those facts through `resultFactsAttributeMap` (as html attributes), so a test —
 * or a person — can check that chat, run detail, and review agree on the
 * run, its head, its checks, its caveats, and its publication.
 *
 * The presentation leads with the deliverable itself: validated
 * screenshots for UI work, the escaped report for an investigation, a
 * concise change summary for code. Missing, corrupt, or truncated
 * evidence is named in `evidenceProblemsOf` and is never described as
 * validated. Three local views — Summary, Changes, Checks — are anchor
 * links (`?tab=`) the server honours, enhanced in the browser by
 * `RESULT_REVIEW_SCRIPT`, which also keeps a bounded review draft, the
 * selected tab, and the reading position in this tab's sessionStorage,
 * keyed by the server-named account, the task, and the run. */

import { resultStatusOf, type ResultFacts, type PublicationFacts, type DisplayStatus } from "./workspace-ui.js";

/** Add re-read evidence health to the existing result/review projection.
 * This is presentation only: the recorded verdict and acceptance stay intact. */
export function evidenceResultStatusOf(result: ResultFacts, publication: PublicationFacts, evidence: EvidenceHealth): DisplayStatus {
  const recorded = resultStatusOf({ ...result, review: null }, publication);
  let stored = recorded;
  if (!result.accepted && !["checks-failed", "evidence-mismatch"].includes(recorded.token) && (evidence.damaged > 0 || (result.role === "scout" && evidence.missing > 0))) {
    stored = {
      token: "evidence-damaged",
      label: "Result saved, but some saved material is unavailable",
      detail: `Some saved material is missing, damaged, or could not be read. The machine's verdict at completion is unchanged: ${result.verdict === "verified" ? "the approved check passed against it then" : recorded.label.toLowerCase()}.`,
      tone: "problem",
      action: { label: "See what is missing", kind: "open-result" },
    };
  }
  const shortened = evidenceShortenedWords(evidence);
  if (shortened) stored = { ...stored, detail: `${stored.detail} ${shortened}` };
  return stored;
}

export function evidenceShortenedWords(evidence: EvidenceHealth): string {
  const n = evidence.shortened;
  return n === 0 ? "" : `${n} stored record${n === 1 ? " was" : "s were"} shortened at storage; ${n === 1 ? "its download holds" : "their downloads hold"} only the stored part.`;
}

export type ResultTab = "summary" | "changes" | "checks";

export const RESULT_TABS: readonly { key: ResultTab; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "changes", label: "Changes" },
  { key: "checks", label: "Checks" },
];

/** The requested local view; anything unknown reads as Summary. */
export function parseResultTab(raw: string | null | undefined): ResultTab {
  return raw === "changes" || raw === "checks" ? raw : "summary";
}

/** What leads the Summary view — decided from the records present, never
 * from the outcome word: a scout's report leads even when a diff exists;
 * validated screenshots lead UI work; a sealed diff leads code; the
 * handoff alone leads when nothing else was captured. */
export type ResultLead = "report" | "screenshots" | "changes" | "summary";

export function resultLeadOf(input: { role: string; report: boolean; screenshots: number; diff: boolean }): ResultLead {
  if (input.role === "scout" || input.report) return "report";
  if (input.screenshots > 0) return "screenshots";
  if (input.diff) return "changes";
  return "summary";
}

/** One validated screenshot as the page will show it, or the reason it
 * cannot be shown. `problem` is set when the stored bytes no longer verify
 * against their record; such a shot is counted as unavailable and is
 * never rendered as an image or described as validated. */
export type ResultScreenshot = { path: string; caption: string; artifactId: number; problem: string | null };

export type ResultEvidenceInput = {
  /** The proof artifact exists but cannot be shown (corrupt, unparseable). */
  proofProblem: string | null;
  /** The sealed diff's health: absent, unverifiable, or fine. */
  diff: { problem: string } | { truncated: boolean } | null;
  stat: { problem: string } | { filesTruncated: boolean } | null;
  /** The check log: absent, no longer verifying (`problem`), or stored
   * whole or shortened. */
  checkLog: { problem: string } | { truncated: boolean } | null;
  screenshots: readonly ResultScreenshot[];
  /** Screenshot paths the proof cites that no stored artifact answers. */
  uncapturedScreenshots: readonly string[];
  /** A scout's report record: absent, unverifiable, or fine (possibly
   * shortened when it was stored). */
  report: { problem: string } | { ok: true; truncated?: boolean } | null;
  /** Whether a report is owed (a scout's run) — absence is then a problem. */
  reportExpected: boolean;
  /** The handoff record: a no-change conclusion owes one. */
  handoffPresent: boolean;
  outcome: string | null;
};

/** What kind of evidence problem a record has (repair 2026-09-14):
 * `damaged` — the stored bytes no longer verify, cannot be read, or the
 * capture itself failed, so nothing can be shown for that record;
 * `shortened` — the record was cut at its storage cap, so its download is
 * the stored part only, never the full bytes; `missing` — a record the
 * result owes was never stored. */
export type EvidenceProblemKind = "damaged" | "shortened" | "missing";
export type EvidenceProblem = { kind: EvidenceProblemKind; words: string };

/** Every evidence problem, classified, in a stable order. Empty means
 * every record this result cites is present, whole, and verifies. */
export function evidenceProblemDetailsOf(input: ResultEvidenceInput): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  const damaged = (words: string): number => problems.push({ kind: "damaged", words });
  const shortened = (words: string): number => problems.push({ kind: "shortened", words });
  const missing = (words: string): number => problems.push({ kind: "missing", words });
  if (input.proofProblem !== null) damaged(`The agent's proof cannot be shown: ${input.proofProblem}.`);
  if (input.diff !== null && "problem" in input.diff) damaged(`The sealed diff is unavailable: ${input.diff.problem}.`);
  else if (input.diff !== null && input.diff.truncated) shortened("The sealed diff was shortened when it was stored; its download holds only the stored part, not the full change.");
  else if (input.diff === null && input.outcome === "no-change" && !input.reportExpected) missing("No sealed diff was captured, so the no-change conclusion is not verified.");
  if (input.stat !== null && "problem" in input.stat) damaged(`The change summary is unavailable: ${input.stat.problem}.`);
  else if (input.stat !== null && input.stat.filesTruncated) shortened("The changed-file list was cut short; the counts are complete.");
  if (input.checkLog !== null && "problem" in input.checkLog) damaged(`The check log no longer verifies (${input.checkLog.problem}); its output is not shown.`);
  else if (input.checkLog !== null && input.checkLog.truncated) shortened("The check output was shortened when it was stored; its download holds only the stored part.");
  for (const shot of input.screenshots) {
    if (shot.problem !== null) damaged(`Screenshot ${shot.path} no longer verifies (${shot.problem}) and is not shown.`);
  }
  for (const path of input.uncapturedScreenshots) missing(`The proof cites screenshot ${path}, but no validated image was stored.`);
  if (input.report !== null && "problem" in input.report) damaged(`The report cannot be shown: ${input.report.problem}.`);
  else if (input.report !== null && input.report.truncated === true) shortened("The report was shortened when it was stored; its download holds only the stored part.");
  else if (input.report === null && input.reportExpected) missing("This investigation stored no report.");
  if (!input.handoffPresent && input.outcome === "no-change" && !input.reportExpected) missing("The no-change conclusion has no handoff record.");
  return problems;
}

/** Every evidence problem in plain words, in a stable order. */
export function evidenceProblemsOf(input: ResultEvidenceInput): string[] {
  return evidenceProblemDetailsOf(input).map(one => one.words);
}

/** The counts the shared status reads: how many records are damaged,
 * shortened, or missing. A status is truthful only when it knows these. */
export type EvidenceHealth = { damaged: number; shortened: number; missing: number };

export function evidenceHealthOf(problems: readonly EvidenceProblem[]): EvidenceHealth {
  const health: EvidenceHealth = { damaged: 0, shortened: 0, missing: 0 };
  for (const one of problems) health[one.kind] += 1;
  return health;
}

/** The facts every result surface must agree on. */
export type SharedResultFacts = {
  runId: number;
  /** The exact commits, from the sealed diff summary when it verifies,
   * else from the run record — `headSource` says which. */
  base: string | null;
  head: string | null;
  headSource: "sealed diff" | "run record" | null;
  /** Signed criteria passed, from the machine's matrix; null = no rubric. */
  checks: { passed: number; total: number } | null;
  caveats: readonly string[];
  evidenceProblems: readonly string[];
  /** How many of the problems above are damaged, shortened, or missing
   * records — what the shared status reads (repair 2026-09-14). */
  evidenceHealth: EvidenceHealth;
  /** The observed publication state, "none" when nothing was intended. */
  publicationState: string;
  publicationWords: string;
};

/** The `data-result-*` attributes every surface stamps on its result
 * element. Values are short, escaped, and deterministic for one run, so
 * two surfaces rendering the same result carry byte-identical attributes. */
/** The shared facts as the panel's data attributes, unescaped (the rebuilt
 * result page sets them through React). */
export function resultFactsAttributeMap(facts: SharedResultFacts): Record<string, string> {
  return {
    "data-result-run": String(facts.runId),
    "data-result-head": facts.head === null ? "" : facts.head.slice(0, 12),
    "data-result-base": facts.base === null ? "" : facts.base.slice(0, 12),
    "data-result-head-source": facts.headSource ?? "none",
    "data-result-checks": facts.checks === null ? "none" : `${facts.checks.passed}/${facts.checks.total}`,
    "data-result-caveats": String(facts.caveats.length),
    "data-result-evidence": facts.evidenceProblems.length === 0 ? "ok" : `problems:${facts.evidenceProblems.length}`,
    "data-result-publication": facts.publicationState,
  };
}

/** The shared fact names, in the order `resultFactsAttributeMap` lists them. */
export const RESULT_FACT_KEYS = ["run", "head", "base", "head-source", "checks", "caveats", "evidence", "publication"] as const;

/** Parse the shared facts back — the test-side and proof-side reader.
 * Only the shared keys are read; a panel's own presentation attributes
 * (place, lead, task, user) are not facts and are left out. */
export function resultFactsFromHtml(html: string): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  const tag = /<[a-z]+\b[^>]*\bdata-result-run="[^"]*"[^>]*>/g;
  const keys = new Set<string>(RESULT_FACT_KEYS);
  for (const match of html.matchAll(tag)) {
    const facts: Record<string, string> = {};
    for (const pair of match[0].matchAll(/data-result-([a-z-]+)="([^"]*)"/g)) {
      if (keys.has(pair[1] as string)) facts[pair[1] as string] = unescapeAttribute(pair[2] as string);
    }
    found.push(facts);
  }
  return found;
}

/** Where a result form may send its reader back: the review cockpit's
 * own deep link, the chat's result detail, the page of a task named in
 * `tasks` (the run's own), or the run page. Anything else lands on the run
 * page. Matched exactly — never a bare open redirect. */
export function resultReturnTarget(raw: string | null | undefined, runId: number, tasks: readonly string[] = []): string {
  if (raw !== null && raw !== undefined) {
    const review = /^\/review\?result=[A-Za-z0-9._~%-]{1,200}(?:&run=([0-9]{1,15}))?(?:&tab=(?:summary|changes|checks))?$/.exec(raw);
    if (review !== null && (review[1] === undefined || Number(review[1]) === runId)) return raw;
    const chat = /^\/chat\?task=([A-Za-z0-9._~%-]{1,200})&result=([0-9]{1,15})(?:&conversation=[A-Za-z0-9-]{1,128})?$/.exec(raw);
    if (chat !== null && Number(chat[2]) === runId) return raw;
    // The run's own task page, which offered Run checks in place; never another task's.
    if (tasks.some(task => raw === `/t/${encodeURIComponent(task)}`)) return raw;
  }
  return `/r/${runId}`;
}

/** A form's own request token, minted per render — the same shape the
 * chat composer uses. A replayed submission carries the same token, so
 * the server can recognise it and mint nothing twice. */
export const REQUEST_TOKEN = /^[a-f0-9]{32}$/;

/** The dedupe key a review note is stored under when the form carried a
 * request token: bound to the account and the token, never to the words,
 * so the same person saying the same thing twice on purpose still lands. */
export function commentSourceKey(user: string, request: string | null | undefined): string | undefined {
  return request !== null && request !== undefined && REQUEST_TOKEN.test(request) ? `review:${user}:${request}` : undefined;
}

/** The revision form's exact batch (repair 2026-09-14): the ids of the
 * live notes the page DISPLAYED, oldest first, joined by commas, plus the
 * source scope digest the page rendered against ("none" when the task has
 * no scope). A seal binds to exactly these — never to "whatever is live
 * when the POST arrives" — so a replayed or second-tab submission can
 * only ever consume the notes its own reader saw. */
export function revisionBatchOf(comments: readonly { id: number }[]): string {
  return comments.map(one => String(one.id)).join(",");
}

/** User feedback requests work; a reviewer's observations only do so when
 * they are problems. The original findings always remain on record. */
export function isRevisionFeedback(comment: { reviewerRun: number | null; severity: string | null }): boolean {
  return comment.reviewerRun === null || comment.severity === "problem";
}

export const REVISION_BATCH_CAP = 500;

/** Parse a posted batch back into distinct positive ids, or null when the
 * field is absent or malformed (an out-of-date form, a hand-built POST). */
export function parseRevisionBatch(raw: string | null | undefined): number[] | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || !/^[0-9]{1,15}(,[0-9]{1,15})*$/.test(text)) return null;
  const ids = text.split(",").map(Number);
  if (ids.length > REVISION_BATCH_CAP || ids.some(one => !Number.isSafeInteger(one) || one < 1)) return null;
  return new Set(ids).size === ids.length ? ids : null;
}

/** The source binding the revision form carries: the scope digest the
 * page was rendered against, or "none". */
export function revisionSourceOf(scopeDigest: string | null): string {
  return scopeDigest === null ? "none" : scopeDigest;
}

export const REVIEW_DRAFT_PREFIX = "standing-orders:review-draft:";
export const RESULT_SCROLL_PREFIX = "standing-orders:result-scroll:";

/** The in-page half of the result presentation. Everything it does is
 * presentational or a bounded draft: no fetch, no endpoint, no submit.
 *
 * - Tabs: the anchor links switch the visible view in place and record
 *   `?tab=` with replaceState, so refresh and Back land on the same view
 *   the server would render for that URL.
 * - Diff modes: View hides the line pins; Annotate shows them. A pin or a
 *   file button copies its target into the Request changes form, opens
 *   the pin disclosure, and focuses the note.
 * - Review draft: the note, file, and line are kept in sessionStorage
 *   under the account, task, and run the form names, for at most a day,
 *   and restored on load. The draft clears only when the page carries the
 *   receipt for THIS draft's request token (`?noted=<token>`); a refused
 *   submission leaves it in place. Other accounts' drafts on this tab are
 *   dropped, never restored.
 * - Request identity (repair 2026-09-14): the form's request token is
 *   bound to the exact note, file, and line last displayed, even when
 *   FormData is sent directly. An unchanged retry keeps the token, so the server
 *   records it once; editing any of the three after a submission mints a
 *   fresh token, so the edited words are a new note and can never be
 *   swallowed by the earlier one's receipt. A refusal that comes back with
 *   `?conflict=<token>` rotates that token too, keeping the words.
 * - Reading position: the page's scroll offset is kept under the same
 *   account/task and the URL's own result and tab, and restored on load
 *   when the URL carries no hash, so Back to chat and refresh return the
 *   reader to where they were. */
export const RESULT_REVIEW_SCRIPT = String.raw`
(function(){
  var panel=document.querySelector('[data-result-panel]');
  var user=panel?panel.getAttribute('data-result-user')||'':'';
  var task=panel?panel.getAttribute('data-result-task')||'':'';
  var run=panel?panel.getAttribute('data-result-run')||'':'';
  var draftPrefix='standing-orders:review-draft:',scrollPrefix='standing-orders:result-scroll:';
  var day=86400000,storage=true,rememberPosition=null;
  function read(key){try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch(e){return null;}}
  function write(key,value){try{if(value===null)sessionStorage.removeItem(key);else sessionStorage.setItem(key,JSON.stringify(value));}catch(e){storage=false;}}
  // Prune: anything older than a day, and anything another account left on this tab.
  try{
    for(var i=sessionStorage.length-1;i>=0;i--){var k=sessionStorage.key(i);if(!k)continue;
      if(k.indexOf(draftPrefix)===0||k.indexOf(scrollPrefix)===0){var item=read(k);var owner=k.split(':')[2]||'';
        if(!item||typeof item.at!=='number'||item.at<Date.now()-day||(user&&owner!==user))sessionStorage.removeItem(k);}}
  }catch(e){storage=false;}
  // ---- tabs -----------------------------------------------------------
  if(panel){
    var tabs=panel.querySelectorAll('[data-result-tab]'),views=panel.querySelectorAll('[data-result-view]');
    function show(name){
      var tabField=panel.querySelector('#comment-form input[name="tab"]');if(tabField)tabField.value=name;
      Array.prototype.forEach.call(views,function(view){var on=view.getAttribute('data-result-view')===name;view.hidden=!on;});
      Array.prototype.forEach.call(tabs,function(tab){var on=tab.getAttribute('data-result-tab')===name;tab.setAttribute('aria-selected',on?'true':'false');tab.tabIndex=on?0:-1;});
    }
    Array.prototype.forEach.call(tabs,function(tab){
      tab.addEventListener('click',function(ev){
        if(ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey||ev.button!==0)return;
        ev.preventDefault();var name=tab.getAttribute('data-result-tab');show(name);
        try{var url=new URL(location.href);url.searchParams.set('tab',name);url.hash='';history.replaceState(history.state,'',url.toString());}catch(e){}
        if(rememberPosition)rememberPosition();
      });
      tab.addEventListener('keydown',function(ev){
        var list=Array.prototype.slice.call(tabs),at=list.indexOf(tab),next=null;
        if(ev.key==='ArrowRight')next=list[(at+1)%list.length];else if(ev.key==='ArrowLeft')next=list[(at-1+list.length)%list.length];else if(ev.key==='Home')next=list[0];else if(ev.key==='End')next=list[list.length-1];
        if(next){ev.preventDefault();next.focus();next.click();}
      });
    });
  }
  // ---- diff modes and line pins ------------------------------------------
  var form=document.getElementById('comment-form');
  var review=document.querySelector('[data-review-diff]');
  if(review){
    review.setAttribute('data-mode','view');
    review.addEventListener('click',function(ev){
      var mode=ev.target&&ev.target.closest?ev.target.closest('button[data-diff-mode]'):null;if(!mode)return;
      var value=mode.getAttribute('data-diff-mode')==='annotate'?'annotate':'view';review.setAttribute('data-mode',value);
      review.querySelectorAll('button[data-diff-mode]').forEach(function(one){one.setAttribute('aria-pressed',String(one===mode));});
    });
  }
  // The feedback form waits behind "Request changes"; anything that points
  // at it (a line pin, the result's own link, a saved draft) opens it first.
  var formShell=form?form.closest('details.result-request-open'):null;
  function openForm(){if(formShell&&!formShell.open)formShell.open=true;}
  if(formShell&&location.hash==='#request-changes')openForm();
  document.addEventListener('click',function(ev){var link=ev.target&&ev.target.closest?ev.target.closest('a[href="#request-changes"]'):null;if(link)openForm();});
  if(form){
    var noteBox=form.querySelector('[name=note]'),pathBox=form.querySelector('[name=path]'),lineBox=form.querySelector('[name=line]'),pin=form.querySelector('details.result-pin');
    var limit=document.getElementById('comment-note-limit'),requestBox=form.querySelector('[name=request]');
    function updateActions(){
      var typed=!!(noteBox&&noteBox.value.trim()),batch=form.querySelector('[name=batch]');
      var requestAction=form.querySelector('[data-request-changes]'),saveAction=form.querySelector('[data-save-feedback]');
      if(requestAction)requestAction.disabled=!typed&&!(batch&&batch.value);
      if(saveAction)saveAction.disabled=!typed;
    }
    updateActions();if(noteBox)noteBox.addEventListener('input',updateActions);
    if(noteBox&&limit&&noteBox.maxLength>0){
      var tally=function(){limit.textContent=noteBox.value.length===0?'up to '+noteBox.maxLength+' characters':noteBox.value.length+' of '+noteBox.maxLength+' characters';};
      tally();noteBox.addEventListener('input',tally);
    }
    document.addEventListener('click',function(ev){
      var button=ev.target&&ev.target.closest?ev.target.closest('button.pick-file,button.pick-line'):null;if(!button)return;
      var reviewNote=button.getAttribute('data-review-note');
      if(reviewNote!==null&&noteBox&&noteBox.value&&!window.confirm('Replace the feedback draft with this note?'))return;
      if(reviewNote!==null&&noteBox)noteBox.value=reviewNote;
      if(pathBox)pathBox.value=button.getAttribute('data-path')||'';
      if(lineBox)lineBox.value=button.getAttribute('data-line')||'';
      if(pin)pin.open=true;
      openForm();
      save();
      form.scrollIntoView({behavior:window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});if(noteBox){noteBox.dispatchEvent(new Event('input',{bubbles:true}));noteBox.focus();}
    });
    // The bounded draft: this account, this task, this run.
    var draftKey=draftPrefix+user+':'+task+':'+run;
    var noted=null,conflict=null;try{var here=new URL(location.href);noted=here.searchParams.get('noted');conflict=here.searchParams.get('conflict');}catch(e){}
    var saved=read(draftKey);
    var recorded=form.querySelector('[data-recorded-requests]');
    if(saved&&saved.request!==conflict&&recorded&&recorded.value.split(',').includes(saved.request)){write(draftKey,null);saved=null;}
    if(saved&&noted&&saved.request===noted){write(draftKey,null);saved=null;}
    // A fresh request identity: 16 random bytes as hex, the server's own shape.
    function mint(){var bytes=new Uint8Array(16);try{crypto.getRandomValues(bytes);}catch(e){for(var i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);}
      var hex='';for(var j=0;j<16;j++)hex+=(bytes[j]<16?'0':'')+bytes[j].toString(16);return hex;}
    function payload(){return JSON.stringify([noteBox?noteBox.value:'',pathBox?pathBox.value:'',lineBox?lineBox.value:'']);}
    // What the current token was last submitted with; null = never sent.
    var sent=null,bound=null;
    // The server refused this token for a different note or another result:
    // the words stay, the identity does not.
    if(saved&&conflict&&saved.request===conflict){saved.request=mint();saved.sent=null;write(draftKey,saved);}
    // The receipt lands with a fragment: browsers skip autofocus on a
    // fragment URL and move focus to the fragment's target on load, so the
    // just-posted form's note box is focused after that step.
    if(noted&&noteBox&&!noteBox.value){
      openForm();
      var focusNote=function(){setTimeout(function(){noteBox.focus({preventScroll:true});},0);};
      if(document.readyState==='complete')focusNote();else window.addEventListener('load',focusNote);
    }
    if(saved&&typeof saved.note==='string'&&saved.note.length<=2000){
      if(noteBox&&!noteBox.value)noteBox.value=saved.note;
      if(saved.note)openForm();
      if(pathBox&&!pathBox.value&&typeof saved.path==='string')pathBox.value=saved.path;
      if(lineBox&&!lineBox.value&&typeof saved.line==='string')lineBox.value=saved.line;
      if(pin&&(pathBox&&pathBox.value||lineBox&&lineBox.value))pin.open=true;
      if(typeof saved.request==='string'&&/^[a-f0-9]{32}$/.test(saved.request)&&requestBox)requestBox.value=saved.request;
      if(typeof saved.sent==='string')sent=saved.sent;
      bound=JSON.stringify([saved.note,saved.path||'',saved.line||'']);
      if(noteBox)noteBox.dispatchEvent(new Event('input'));
    }
    function save(){
      var note=noteBox?noteBox.value:'',path=pathBox?pathBox.value:'',line=lineBox?lineBox.value:'';
      // Bind every observed payload, including FormData sent without a
      // submit event. A changed note, path, or line always gets a new token.
      var current=payload();
      if((bound!==null&&current!==bound)||(sent!==null&&current!==sent)){sent=null;if(requestBox)requestBox.value=mint();}
      bound=current;
      if(!note&&!path&&!line){write(draftKey,null);return;}
      write(draftKey,{note:note,path:path,line:line,request:requestBox?requestBox.value:'',sent:sent,at:Date.now()});
      if(!storage&&limit)limit.textContent='Draft stays on this page only. Browser storage is unavailable.';
    }
    form.addEventListener('input',save);
    // A double click never posts twice; a refused post keeps the draft.
    // On a chat page the conversation's own delegated latch owns
    // aria-busy (it runs after this form-level listener and would refuse
    // a form already marked busy), so the latch is added only elsewhere.
    var chatLatch=document.querySelector('.composer[data-chat-session]')!==null;
    form.addEventListener('submit',function(event){
      save();
      // Bind the identity to exactly what is being sent.
      sent=payload();var draft=read(draftKey);if(draft){draft.sent=sent;write(draftKey,draft);}
      if(chatLatch)return;
      if(form.getAttribute('aria-busy')==='true'){event.preventDefault();return;}
      form.setAttribute('aria-busy','true');
    });
    window.addEventListener('pageshow',function(){form.removeAttribute('aria-busy');});
  }
  // ---- reading position ---------------------------------------------------
  // Kept under the account, the task, and the URL's own result and view,
  // read again at every save so a tab switched in place records under the
  // view the URL now names.
  var returnKey=scrollPrefix+user+':'+task+':return';
  function scrollKeyFor(){var url=null;try{url=new URL(location.href);}catch(e){}
    return scrollPrefix+user+':'+task+':'+(url?(url.searchParams.get('result')||run)+':'+(url.searchParams.get('tab')||'summary'):run);}
  // Once a navigation has begun (pageswap / beforeunload) the document's
  // scroll is no longer the reader's — a cross-document transition can
  // move it to the top while it is captured — so remembering stops.
  var leaving=false;
  window.addEventListener('pageswap',function(){leaving=true;});
  window.addEventListener('beforeunload',function(){leaving=true;});
  if(panel&&user&&task){
    var pending=false;
    var remember=function(){pending=false;if(leaving)return;write(scrollKeyFor(),{y:window.scrollY,at:Date.now()});};
    rememberPosition=remember;
    window.addEventListener('scroll',function(){if(!pending){pending=true;requestAnimationFrame(remember);}},{passive:true});
    // Leaving the result view marks the way back, so the conversation can
    // return the reader to where they were. The position itself is taken
    // from the last scroll, never at pagehide: a navigation's transition
    // can already have moved the document by then.
    window.addEventListener('pagehide',function(){write(returnKey,{at:Date.now()});});
    var where=read(scrollKeyFor());
    if(where&&typeof where.y==='number'&&!location.hash){
      try{if('scrollRestoration' in history)history.scrollRestoration='manual';}catch(e){}
      window.scrollTo({top:where.y,behavior:'instant'});
    }
  }
  // Chat pages remember where the reader was, so opening a result and
  // coming back lands on the same message (the page itself, no panel).
  var composer=document.querySelector('.composer[data-chat-session]');
  if(!panel&&composer&&composer.dataset.chatTask){
    var chatUser=composer.dataset.chatUser||'',chatTask=composer.dataset.chatTask;
    var chatKey=scrollPrefix+chatUser+':'+chatTask+':chat',chatReturn=scrollPrefix+chatUser+':'+chatTask+':return';
    var chatPending=false;
    function rememberChat(){chatPending=false;if(leaving)return;write(chatKey,{y:window.scrollY,at:Date.now()});}
    window.addEventListener('scroll',function(){if(!chatPending){chatPending=true;requestAnimationFrame(rememberChat);}},{passive:true});
    var came=read(chatReturn);write(chatReturn,null);
    var back=read(chatKey);
    if(came&&typeof came.at==='number'&&came.at>Date.now()-600000&&back&&typeof back.y==='number'&&!location.hash){
      try{if('scrollRestoration' in history)history.scrollRestoration='manual';}catch(e){}
      window.scrollTo({top:back.y,behavior:'instant'});
    }
  }
})();`;

function unescapeAttribute(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
