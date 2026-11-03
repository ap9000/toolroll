/** Flows in the console: the list of a person's flows, and one flow's canvas
 * (the React view's data, plus a plain fallback page the view replaces). */
import { liveAttemptOf, steerControlsFor } from "./steer-controls.js";
import type { BrowserFlowCard, BrowserFlowTrigger, BrowserFlowView } from "./browser-workspace.js";
import { draftFor, flowDefinitionOf } from "./flow-engine.js";
import { describeStandingOrder } from "./flow-schedule.js";
import { describeTrigger, triggerHeadline, FLOW_TRIGGER_KINDS, FLOW_TRIGGER_WORDS, githubRepoOf, HOOK_PATH, hookReady, planeStatusLink, readHooksBase, readLinearKey, senderOf, takesDeliveries, triggerConfigOf, type TriggerConfig } from "./flow-triggers.js";
import { SENDER_WORDS } from "./webhook-signing.js";
import { READER_CAPTURED } from "./webhook-readers.js";
import { hostOf, linkWords, provedWords, snapshotOf } from "./task-source.js";
import { deciderOf, FLOW_COLORS, FLOW_KIND_WORDS, FLOW_STAGE_KINDS } from "./flows.js";
import { nightlyHealthWords } from "./nightly-check.js";
import { flowInsights, troubleWords } from "./flow-insights.js";
import { parseSortDecision, sortChip } from "./flow-sort.js";
import { flowSecretNames, readEmailSettings, sendingReady } from "./flow-actions.js";
import { projectToolsOf, secretsSetFor, toolStanding } from "./project-tools.js";
import type { FlowCardRow, FlowRow, FlowTriggerRow, Store } from "./store.js";
import { flowFingerprint } from "./flow-live.js";
import { flowChoiceAt, readFlowSend, type FlowSendContent } from "./flow-send.js";
import { itemCaption, whyLines } from "./flow-items.js";
import { FLOW_FILE_MAX_BYTES, type FlowFile, type FlowImportPlan } from "./flow-share.js";
import { googleConnected } from "./google-mail.js";
import { mailboxReady } from "./mailbox.js";
import { labelOf, nameOf } from "./subagent-admin.js";
import { callWords, receiptWords } from "./subagent-tools.js";
import { undoFor } from "./subagent-week.js";
import { flowCardTaskLine } from "./flow-card-task.js";
import { unattendedViewOf } from "./flow-unattended.js";
import { browserViewOf } from "./flow-browser.js";
import { readFlowSecrets } from "./flow-secrets.js";
import { html, joinHtml, postForm, type Html, type HtmlValue } from "./html.js";
import { acts, btn, chip, count, disclose, doc, docHeader, dock, empty, field, group, infoLine, input as input_, note, notice, overlay, overlayTrigger, pageHeader, phoneHeader, row, segLinks, select, status } from "./server/kit.js";
import { agoWords } from "./lead-voice.js";
const projectName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

/** v126: what happens to deliveries turned away (refused with 503), as far as each sender is known to say: nothing
 * here claims a loss that a sender's own retries may still make good. */
function resendWords(config: TriggerConfig): string {
  if (config.kind === "github") return "GitHub doesn't retry on its own: resend them from the repository's Settings → Webhooks → this webhook → Recent Deliveries → Redeliver.";
  if (config.kind === "linear") return "Linear may retry a refused delivery. Look in the webhook's settings in Linear for its recent deliveries; any it doesn't resend can't be recovered here.";
  const sender = config.kind === "webhook" ? senderOf(config) : "none";
  return sender === "vercel" ? "Vercel retries refused deliveries for up to a day, so some may still arrive. Its webhook's delivery attempts are listed in Vercel's webhook settings; any it gives up on are lost."
    : sender === "sentry" ? "Sentry may retry a refused delivery. Your Internal Integration's Dashboard in Sentry (Developer Settings) shows its request log; any it doesn't resend are lost, though new alerts for the same issues still arrive."
    : "The sender may retry. Look in its webhook delivery log and resend from there if it offers it; any it doesn't resend are lost.";
}

/** v126: what a webhook trigger's row says about how its deliveries are proved. */
function hookView(trigger: FlowTriggerRow, config: TriggerConfig, dir: string | null): NonNullable<BrowserFlowTrigger["hook"]> {
  const ready = hookReady(trigger, dir);
  const dropped = trigger.droppedCount > 0 && trigger.droppedSince !== null ? { count: trigger.droppedCount, since: trigger.droppedSince, resend: resendWords(config) } : null;
  if (config.kind !== "webhook") return { ready, needsSecret: config.kind === "linear", sender: null, makesSecret: false, warning: null, readerNote: null, dropped, scope: null };
  const sender = senderOf(config);
  // What it needs first, first: an unset secret refuses everything, so that is said before any narrowing.
  const warning = trigger.hookHash === null && (sender === "none" || ready) ? "No address yet: choose New address to make one and give it to the sender."
    : sender === "none" ? "Unsigned: anyone with its address can add cards. Choose who signs its deliveries to close that."
    : !ready ? `Not set up: its deliveries are refused until ${sender === "sentry" || sender === "vercel" ? `${SENDER_WORDS[sender]}'s secret is pasted (with New address for the address to give it)` : "it is set up"}.`
    : (sender === "sentry" || sender === "vercel") && config.project == null ? `Any ${SENDER_WORDS[sender]} project this secret covers can add cards. Name the project to narrow it.`
    : null;
  // A sender that signs only the body: byte-identical requests are one delivery (§3).
  const repeats = sender === "github-style" ? "Identical requests count once. If the sender must send the same request again and have it count, use Standard Webhooks." : null;
  // A reader written from its sender's documentation, not yet from a captured delivery, says so on its own line,
  // whatever else the row says (webhook-readers.ts).
  const readerNote = (sender === "sentry" || sender === "vercel") && !READER_CAPTURED[sender]
    ? `Reader unverified: Toolroll reads ${SENDER_WORDS[sender]} deliveries from ${SENDER_WORDS[sender]}'s documented examples; no real delivery has been checked yet.` : null;
  return { ready, needsSecret: sender === "sentry" || sender === "vercel", sender, makesSecret: sender === "standard" || sender === "github-style", warning, readerNote: [readerNote, repeats].filter(one => one !== null).join(" ") || null, dropped,
    scope: sender === "sentry" || sender === "vercel" ? { project: config.project ?? null, team: config.team ?? null } : null };
}

/** The flow page's fallback rules, plus the Flows list and the import preview (kit pieces; only layout here). */
export const FLOWS_CSS = `.flows{max-width:880px;min-width:0}.flows .card{padding:16px 18px;margin:12px 0}.flows form{display:grid;gap:10px;margin:0}.flows label{display:grid;gap:6px}.flows input,.flows select{box-sizing:border-box;width:100%;max-width:100%}.flows button{justify-self:start;min-height:44px}.flows .flow-fallback ol{padding-left:20px}.flows summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600}.flows button.primary{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}.flows fieldset{border:0;padding:0;margin:0;display:grid;gap:10px;min-width:0}.flows legend{font-weight:600;padding:0;margin-bottom:6px}.flows textarea[hidden]{display:none}.flows button.secondary{background:transparent;color:var(--foreground);border:1px solid var(--border)}@media(max-width:600px){.flows input,.flows select{font-size:16px}}@media(max-width:760px){.flows .card{padding:10px 12px;margin:8px 0;position:relative}}` +
  // The list: the phone's project bar under the phone header; notices and the example in the page's gutter.
  `.fl-pbar{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--so-line)}.fl-pbar form{flex:1;display:flex;gap:8px;margin:0;min-width:0}.fl-pbar .k-selw{flex:1;min-width:0}` +
  `.fl-say{padding:12px 24px 0}.fl-try{display:grid;gap:10px;justify-items:start;padding:0 24px 24px}.fl-try form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}` +
  // The import drawer: the file chooser is a labelled outline button over the native input.
  `.fl-imp{display:grid;gap:18px;margin:0}.fl-file{display:flex;align-items:center;gap:10px;min-width:0}.fl-file input[type=file]{position:absolute;width:1px;height:1px;opacity:0}.fl-file label{cursor:pointer}.fl-file label:focus-within{outline:2px solid var(--so-ring);outline-offset:2px}.fl-file .k-note{min-width:0;overflow-wrap:anywhere}` +
  `.fl-imp textarea[hidden]{display:none}.fl-terms{list-style:none;padding:0;margin:0;display:grid;gap:8px;font-size:13px;line-height:1.5}.fl-terms li{white-space:pre-line;overflow-wrap:anywhere}` +
  `.fl-terms pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0}.fl-pv-form{display:grid;gap:16px;margin:0}.fl-pv-form fieldset{border:0;padding:0;margin:0;display:grid;gap:14px;min-width:0}.fl-pv-form legend{font:600 13px/1.3 var(--so-font-sans);padding:0;margin-bottom:10px}` +
  `@media(max-width:760px){.fl-say{padding:12px 16px 0}.fl-try{padding:0 16px 24px}.fl-file label{min-height:44px}}`;

/** "in 12 min", "in 5 h", "in 3 days": when a trigger next looks. */
function nextWords(at: string, now: Date): string {
  const minutes = Math.max(0, Math.round((Date.parse(at) - now.getTime()) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours} h` : `in ${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"}`;
}

/** What starts a flow, in a few words: its active triggers, else the paused ones, else that cards are added by hand. */
function triggerWords(store: Store, triggers: readonly FlowTriggerRow[]): string {
  const shown = triggers.filter(one => one.state === "active");
  const pick = shown.length > 0 ? shown : triggers.filter(one => one.state === "paused");
  const words = pick.flatMap(one => {
    const config = triggerConfigOf(one);
    if (config === null) return [];
    return [config.kind === "button" ? `When someone presses ${config.label}` : triggerHeadline(config, store).name];
  });
  if (words.length === 0) return "Cards added by hand";
  return words.length === 1 ? words[0]! : `${words[0]!} and ${words.length - 1} more`;
}

type FlowListGroup = "needs" | "running" | "on" | "paused";
const FLOW_LIST_GROUPS: ReadonlyArray<readonly [FlowListGroup, string]> = [["needs", "Needs you"], ["running", "Running"], ["on", "Turned on"], ["paused", "Paused"]];

/** One flow as a quiet row: what the store knows now (cards waiting on a decision, cards in progress, its triggers). */
function flowListRow(store: Store, flow: FlowRow, now: Date, options: { canAct: boolean; showProject: boolean }): { group: FlowListGroup; row: Html } {
  const cards = store.flowCards(flow.id, false);
  const definition = flowDefinitionOf(flow);
  const kindOf = (card: FlowCardRow) => definition?.stages.find(one => one.id === card.stage)?.kind ?? "";
  const waiting = cards.filter(card => ["approval", "choose"].includes(kindOf(card)));
  const triggers = store.flowTriggers(flow.id).filter(one => one.state !== "removed");
  const active = triggers.filter(one => one.state === "active");
  const button = active.flatMap(one => { const config = triggerConfigOf(one); return config?.kind === "button" ? [{ id: one.id, label: config.label }] : []; })[0];
  const trouble = troubleWords(flowInsights(store, flow, now, 7)) ?? nightlyHealthOf(store, flow);
  const starts = triggerWords(store, triggers);
  const next = active.map(one => one.nextAt).filter((one): one is string => one !== null).sort()[0];
  const meta = html`${options.showProject ? html`<span>${projectName(flow.repo)}</span>` : ""}${next !== undefined && active.length > 0 && waiting.length === 0 ? html`<span class="k-num">Next ${nextWords(next, now)}</span>` : ""}`;
  const start = button !== undefined && options.canAct ? btn(button.label, { sm: true, href: `/flows/${flow.id}?start=${button.id}` }) : html``;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const tail = trouble === null ? "" : ` · ${trouble}`;
  if (waiting.length > 0) {
    const first = waiting[0]!;
    const ask = kindOf(first) === "choose" ? chip("Choose", "ask") : chip("Approve", "ask");
    const said = waiting.length === 1 ? `${first.title} waits for your decision` : `${plural(waiting.length, "card")} wait for your decision`;
    return { group: "needs", row: row({ href: `/flows/${flow.id}`, chip: ask, title: flow.name, desc: `${starts} · ${said}${tail}`, meta, wait: true,
      action: btn("Review", { sm: true, href: `/flows/${flow.id}?card=${first.id}`, attrs: { "aria-label": `Review ${first.title}` } }), attrs: { "data-flow": flow.id } }) };
  }
  if (cards.length > 0) {
    return { group: "running", row: row({ href: `/flows/${flow.id}`, chip: status("running"), title: flow.name, desc: `${starts} · ${plural(cards.length, "card")} in progress${tail}`, meta, action: start, attrs: { "data-flow": flow.id } }) };
  }
  if (active.length > 0) {
    const failing = active.find(one => one.failures > 0);
    const last = active.filter(one => one.lastAt !== null).sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))[0];
    const chipNow = failing !== undefined || trouble !== null ? status("failed") : last === undefined ? chip("Not run yet", "", { dot: false }) : status("finished");
    const lastWords = failing !== undefined ? `last check failed ${agoWords(failing.lastAt ?? failing.updatedAt, now)}${failing.lastOutcome ? `: ${failing.lastOutcome}` : ""}`
      : last === undefined ? "not run yet" : `last ran ${agoWords(last.lastAt!, now)}${last.lastOutcome ? `: ${last.lastOutcome}` : ""}`;
    return { group: "on", row: row({ href: `/flows/${flow.id}`, chip: chipNow, title: flow.name, desc: `${starts} · ${lastWords}${tail}`, meta, action: start, attrs: { "data-flow": flow.id } }) };
  }
  const paused = triggers.length > 0;
  return { group: "paused", row: row({ href: `/flows/${flow.id}`, chip: chip(paused ? "Paused" : "Off", "", { dot: false }), title: flow.name,
    desc: paused ? `${starts} · paused${tail}` : `${starts} · nothing starts it on its own${tail}`, meta, attrs: { "data-flow": flow.id } }) };
}

/** The project field of a list form: a select when there's a choice. */
const projectSelect = (id: string, projects: readonly string[], current: string | null) => projects.length === 1
  ? html`<input type="hidden" name="repo" value="${projects[0]!}">`
  : field({ id, label: "Project", control: select({ id, name: "repo", items: projects.map(repo => [repo, projectName(repo)] as const), current: current ?? projects[0]!, wide: true }) });

/** The import form: a flow file chosen here or fetched from a gist, previewed in plain words before anything is made. */
function importFormHtml(projects: readonly string[], current: string | null): Html {
  return postForm("/flows/import", html`${note("A flow file from another Toolroll, a teammate or a gist. Nothing runs until you import it, and any script it brings waits for your approval.")}\
${projectSelect("fl-imp-project", projects, current)}\
<div class="k-field"><span class="k-label">File</span><div class="fl-file"><label class="k-btn k-btn-outline k-btn-sm"><input type="file" accept=".json,application/json" data-flow-file><span class="k-face">Choose a file</span></label><span class="k-note" data-flow-file-name>No file chosen</span></div></div>\
<textarea name="document" hidden data-flow-document></textarea>\
${field({ id: "fl-imp-url", label: "Or its address", control: input_({ id: "fl-imp-url", name: "url", type: "url", attrs: { inputmode: "url", placeholder: "https://gist.github.com/…" } }) })}\
<p class="k-notice" role="alert" data-flow-file-note hidden></p>${acts(btn("Preview import", { type: "submit" }))}`, { attrs: { class: "fl-imp", "data-flow-import": true } });
}

/**
 * Flows: the top bar (a project filter, More, New flow), then each flow as a quiet row under Needs you, Running,
 * Turned on and Paused. Words come only from what the store knows now: cards waiting on a decision, cards in
 * progress, and the triggers (on, paused, when they last looked and what they found).
 */
export function flowsListHtml(store: Store, flows: readonly FlowRow[], projects: readonly string[], canCreate: boolean, problem: string | null, filter: string | null = null, now: Date = new Date()): Html {
  const scope = filter !== null && projects.includes(filter) ? filter : null;
  const shown = scope === null ? flows : flows.filter(one => one.repo === scope);
  const making = canCreate && projects.length > 0;
  const href = (repo: string | null) => repo === null ? "/flows" : `/flows?project=${encodeURIComponent(repo)}`;
  const seg = projects.length > 1 ? segLinks("Project", scope ?? "all", [{ key: "all", label: "All", href: "/flows" }, ...projects.map(repo => ({ key: repo, label: projectName(repo), href: href(repo) }))]) : html``;
  const more = (id: string, phone: boolean) => overlayTrigger("More", "fl-more", { variant: phone ? "outline" : "ghost", sm: !phone, iconOnly: "more", ...(id === "" ? {} : { attrs: { id } }) });
  const create = making ? btn("New flow", { variant: "primary", sm: true, lead: "plus", href: "/flows/new" }) : html``;
  const header = pageHeader("Flows", { right: html`${seg}${more("", false)}${create}` });
  // On a phone the filter is a select (the form posts nothing: it's an address), beside More.
  const phoneBar = html`<div class="fl-pbar k-phone-only">${projects.length > 1 ? html`<form method="get" action="/flows">${select({ name: "project", label: "Project", items: [["", "All projects"], ...projects.map(repo => [repo, projectName(repo)] as const)], current: scope ?? "", wide: true, attrs: { "data-k-autosubmit": "" } })}<noscript>${btn("Show", { sm: true, type: "submit" })}</noscript></form>` : html`<span class="k-grow"></span>`}${more("", true)}</div>`;
  const menu = overlay({ id: "fl-more", kind: "menu", title: "More", body: html`${making ? html`<button type="button" data-k-open="fl-import" aria-haspopup="dialog" aria-controls="fl-import">Import a flow file…</button>` : ""}<a href="/flows/new?group=kits">Starter kits</a><a href="/settings/lead/subagents">Subagents</a>` });
  const importDrawer = making ? overlay({ id: "fl-import", kind: "drawer", title: "Import a flow file", body: importFormHtml(projects, scope) }) : html``;
  const say = problem !== null ? html`<div class="fl-say">${notice(problem)}</div>` : html``;
  let body: Html;
  if (flows.length === 0) {
    const example = making ? html`<div class="fl-try">${postForm("/flows/example", html`<span class="k-note">Or see one work: Claude drafts a reply to a sample customer question for you to approve.</span>${projects.length === 1 ? html`<input type="hidden" name="repo" value="${projects[0]!}">` : select({ name: "repo", label: "Project", items: projects.map(repo => [repo, projectName(repo)] as const), sm: true })}${btn("Try an example", { sm: true, type: "submit" })}`)}</div>` : html``;
    const words = { title: "No flows yet.", text: "A flow repeats work for you: run your tests every night, turn labelled issues into pull requests, draft replies to support mail." };
    body = html`${empty(making ? { ...words, action: acts(btn("Browse templates", { sm: true, href: "/flows/new" }), overlayTrigger("Import a flow file", "fl-import", { variant: "ghost", sm: true })) } : words)}${example}`;
  } else if (shown.length === 0) {
    body = empty({ title: `No flows in ${projectName(scope!)}.`, action: btn("Show all projects", { variant: "ghost", sm: true, href: "/flows" }) });
  } else {
    const rows = shown.map(flow => flowListRow(store, flow, now, { canAct: canCreate, showProject: scope === null && projects.length > 1 }));
    body = html`<div class="fl-rows" aria-label="Flows">${FLOW_LIST_GROUPS.map(([key, label]) => {
      const mine = rows.filter(one => one.group === key);
      return mine.length === 0 ? "" : html`${group(label, count(mine.length))}${mine.map(one => one.row)}`;
    })}</div>`;
  }
  return html`<div class="fl-page" data-kit-page>${header}${phoneBar}${say}${body}${menu}${importDrawer}${making ? dock(btn("New flow", { variant: "primary", lead: "plus", href: "/flows/new" })) : ""}</div>`;
}

/** Reads the chosen flow file into the form (the server reads it again, whole, before anything is made), and sends a
 * filter select's form when it changes. */
export const FLOW_IMPORT_SCRIPT = `(function(){document.querySelectorAll('select[data-k-autosubmit]').forEach(function(s){s.addEventListener('change',function(){if(s.form)s.form.requestSubmit();});});var form=document.querySelector('[data-flow-import]');if(!form)return;var input=form.querySelector('[data-flow-file]'),text=form.querySelector('[data-flow-document]'),note=form.querySelector('[data-flow-file-note]'),named=form.querySelector('[data-flow-file-name]'),address=form.querySelector('[name=url]');function say(words){note.textContent=words;note.hidden=words==='';}var reading=null;input.addEventListener('change',function(){text.value='';say('');var file=input.files&&input.files[0];if(named)named.textContent=file?file.name:'No file chosen';if(!file){reading=null;return;}if(file.size>${FLOW_FILE_MAX_BYTES}){say('That file is too big: a flow file is at most ${FLOW_FILE_MAX_BYTES / 1024} KB.');input.value='';if(named)named.textContent='No file chosen';reading=null;return;}reading=file.text().then(function(value){text.value=value;});});form.addEventListener('submit',function(event){if(reading!==null&&text.value===''){event.preventDefault();reading.then(function(){form.requestSubmit();});return;}if(text.value===''&&address.value.trim()===''){event.preventDefault();say('Choose a flow file or give its address.');}});})();`;

/** An import's preview, a reading page: the plan in plain words, what it asks for, and one Import button after the terms. */
export function flowImportHtml(input: { plan: FlowImportPlan | null; file: FlowFile; document: string; repo: string; csrf: string; values: Record<string, string>; previewed: string; problem: string | null }): Html {
  const { plan, file } = input;
  const fields = file.parameters.map((one, index) => field({ id: `fl-param-${index}`, label: one.optional === true ? `${one.about} (optional)` : one.about,
    control: input_({ id: `fl-param-${index}`, name: `param.${one.id}`, value: input.values[one.id] ?? plan?.values[one.id] ?? one.default ?? "", attrs: { maxlength: 200, autocomplete: "off" } }) }));
  const list = (items: readonly string[]) => items.length === 0 ? "" : html`<ul class="fl-terms">${items.map(term => html`<li>${term}</li>`)}</ul>`;
  const section = (title: string, body: HtmlValue) => html`<section class="k-sec"><h3>${title}</h3>${body}</section>`;
  // The steps, what they mean, the triggers and the scripts; each script's code one tap away, as on the Scripts panel.
  const terms = plan === null ? "" : html`${plan.parts.about !== null && html`<p class="k-note">${plan.parts.about}</p>`}\
${section("Steps", html`${infoLine("Its instructions come from the file, not from you: read what each step is asked before you import.")}${list(plan.parts.steps)}`)}\
${plan.parts.triggers.length > 0 && section("Triggers", list(plan.parts.triggers))}\
${plan.parts.scripts.length + plan.parts.kept.length > 0 && section("Scripts", html`<ul class="fl-terms">${plan.scripts.add.map((one, index) => html`<li>${plan.parts.scripts[index]}${one.body !== undefined && disclose("Show the script", html`<pre class="k-mono">${one.body}</pre>`)}</li>`)}${plan.parts.kept.map(one => html`<li>${one}</li>`)}</ul>`)}\
${section("Good to know", list([...plan.parts.notes, ...(plan.parts.needs === null ? [] : [plan.parts.needs])]))}`;
  const importButton = plan !== null ? btn("Import flow", { variant: "primary", type: "submit", docked: true, attrs: { name: "confirm", value: "yes" } }) : html``;
  const form = postForm("/flows/import", html`<textarea name="document" hidden>${input.document}</textarea>${fields.length > 0 && html`<fieldset><legend>Fill in</legend>${fields}</fieldset>`}\
${acts(importButton, fields.length > 0 ? btn(plan === null ? "Preview" : "Update preview", { variant: plan === null ? "primary" : "outline", type: "submit", attrs: { name: "confirm", value: "" } }) : "", btn("Cancel", { variant: "ghost", href: "/flows" }))}`,
    { attrs: { class: "fl-pv-form", id: "fl-pv-form" }, hidden: { repo: input.repo, previewed: input.previewed } });
  return html`<div class="fl-page" data-kit-page>${phoneHeader(`Import ${file.name}`, { back: "/flows" })}${doc(docHeader({ title: `Import ${file.name}`, back: ["/flows", "Flows"], meta: `Into ${projectName(input.repo)}. Nothing is made until you import it.`, same: true }),
    input.problem !== null ? notice(input.problem) : "", terms, form)}${plan !== null ? dock(btn("Import flow", { variant: "primary", type: "submit", attrs: { form: "fl-pv-form", name: "confirm", value: "yes" } })) : ""}</div>`;
}

const historyText = (event: { fromStage: string | null; toStage: string; outcome: string; actor: string; note: string | null }, title: (id: string) => string, sorts: ReadonlySet<string> = new Set()): string => {
  const who = event.actor === "flow" ? "" : ` by ${event.actor}`;
  const note = event.note === null ? "" : `: ${event.note}`;
  switch (event.outcome) {
    case "created": return `Added to ${title(event.toStage)}${who}`;
    case "approved": return `Approved${who}${note}`;
    case "sent-back": return `Sent back to ${title(event.toStage)}${who}${note}`;
    case "fail": return `Moved to ${title(event.toStage)} after a problem${note}`;
    // "Ignore" on a choice closes the card (flow-send.ts): said as such, with what was chosen and where.
    case "cancelled": return event.note?.startsWith("Ignored") ? `Ignored${who}${event.note.slice("Ignored".length)}` : `Cancelled${who}`;
    case "ok": return event.fromStage !== null && sorts.has(event.fromStage) ? `Sorted into ${title(event.toStage)}` : `Moved on to ${title(event.toStage)}${note}`;
    default: return `Moved to ${title(event.toStage)}${who}${note}`;
  }
};

/** One flow's canvas for one person. */
export function flowView(store: Store, flow: FlowRow, viewer: { name: string; approver: boolean }, selectedCard: number | null, setup: { dir: string | null; repos: readonly string[]; startTrigger?: number | null; sortReady?: boolean; toolHome?: string | undefined; now?: Date } = { dir: null, repos: [] }): BrowserFlowView {
  const definition = flowDefinitionOf(flow);
  const stages = definition?.stages ?? [];
  const browserNow = browserViewOf(store, flow);
  const browser = browserNow === null ? null : { ...browserNow, canApprove: viewer.approver && store.accountOf(viewer.name)?.projects === null };
  const title = (id: string) => stages.find(one => one.id === id)?.title ?? id;
  const sortZones = new Set(stages.filter(one => one.kind === "sort").map(one => one.id));
  const decisions = sortZones.size === 0 ? new Map<number, { decisionJson: string }>() : store.flowSortDecisions(flow.id);
  const mates = new Map(store.subagents([flow.repo]).map(one => [one.id, one] as const));
  const taskSecrets = new Map<string, string[]>();
  const secretsFor = (repo: string) => {
    if (!taskSecrets.has(repo)) taskSecrets.set(repo, Object.values(readFlowSecrets(setup.dir, repo)));
    return taskSecrets.get(repo)!;
  };
  const now = new Date();
  const cards: BrowserFlowCard[] = store.flowCards(flow.id, true).filter(card => card.state === "active" || Date.now() - Date.parse(card.updatedAt) < 7 * 86_400_000).map((card: FlowCardRow) => {
    const stage = stages.find(one => one.id === card.stage);
    const task = card.task ?? card.primaryTask;
    // Build zones may file into another project; the flow alone does not admit its task's detail.
    const taskRepo = card.task === null ? null : store.lookupRef(card.task)?.repo ?? null;
    const canReadTask = taskRepo !== null && (taskRepo === flow.repo || (setup.repos.includes(taskRepo) && store.accountCanAccess(viewer.name, taskRepo)));
    const discussion = store.flowComments(card.id);
    const watchers = store.flowCardWatchers(card.id);
    const decider = stage?.kind === "approval" ? deciderOf(stage, flow) : null;
    // While its subagent is deciding (v92), the card isn't anyone else's to decide yet.
    const subagentDeciding = stage?.subagent !== undefined && card.waiting !== null && card.waiting.endsWith(" is deciding");
    const canDecide = viewer.approver && card.state === "active" && stage?.kind === "approval" && (decider === null || decider === viewer.name) && !subagentDeciding;
    // History reads moves and ownership together, newest first.
    const owned = discussion.filter(one => one.kind === "owner").map(one => ({ text: one.body === "" ? `${one.author} left it without an owner` : one.body === one.author ? `${one.author} took it on` : `${one.author} made ${one.body} the owner`, at: one.at }));
    const moves = store.flowEvents(card.id).map(event => ({ text: historyText(event, title, sortZones), at: event.at }));
    const decision = parseSortDecision(decisions.get(card.id)?.decisionJson ?? null);
    const shown = stage?.kind === "approval" && definition !== null ? draftFor(definition, stage) : null;
    // v91: when a Wait zone gives up (or moves on), or a zone's time limit comes.
    // An "hours" wait has no deadline of its own: it goes on when the clock reaches its hours.
    const clock = stage?.wait?.for === "hours" ? stage.limit : stage?.wait ?? stage?.limit;
    const until = card.state !== "active" || stage === undefined || clock === undefined ? null : new Date(Date.parse(store.flowCardEnteredAt(card.id) ?? card.updatedAt) + clock.minutes * 60_000);
    const deadline = until === null || until.getTime() <= Date.now() ? null : {
      at: until.toISOString(),
      label: stage!.wait !== undefined && stage!.wait.for !== "hours" ? (stage!.wait.for === "reply" ? "No reply by" : "Moves on at") : stage!.limit!.to !== null ? `Moves to ${title(stage!.limit!.to)} at` : "Reminder at",
    };
    // Its open question: one of its own, or (v94) a tool call waiting for approval.
    const asked = card.state === "active" ? store.openSubagentQuestionOn(card.id, card.entry) : null;
    const pending = asked?.toolCall == null ? null : store.subagentCall(asked.toolCall);
    // A decision its subagent handed over carries what the subagent said (v92).
    const turn = card.state === "active" && stage?.kind === "approval" && stage.subagent !== undefined ? store.flowStepRun(card.id, card.entry) : null;
    let handoff: { from: string; note: string } | null = null;
    if (turn !== null && turn.kind === "subagent" && turn.state === "passed") {
      try {
        const said = JSON.parse(turn.decisionJson ?? "{}") as { action?: unknown; note?: unknown };
        const mate = store.subagentByHandle(flow.repo, stage!.subagent!);
        if (said.action === "hand_off" && typeof said.note === "string" && said.note !== "" && mate !== null) handoff = { from: labelOf(mate), note: said.note };
      } catch { handoff = null; }
    }
    const asker = asked === null || asked.state !== "open" ? null : store.getSubagent(asked.subagent);
    // "Person chooses" (flow-send.ts): what was sent, and the options, for the person it waits on; the latest send otherwise.
    const choosing = card.state === "active" && stage?.kind === "choose" ? flowChoiceAt(store, card.id, card.entry) : null;
    const latest = store.flowSends(card.id)[0] ?? null;
    const sentContent = latest === null ? null : readFlowSend(latest.contentJson);
    // On the card itself: where it came from (the card's title is right above), and only the links the panel doesn't already have.
    const own = new Set([`/flows/${flow.id}?card=${card.id}`, ...(task === null ? [] : [`/t/${encodeURIComponent(task)}`])]);
    const sentView = (content: FlowSendContent) => ({ title: content.from === undefined ? "What was done" : `From ${content.from}`, summary: content.summary,
      links: content.links.map(one => ({ label: one.label, href: "url" in one ? one.url : one.path })).filter(one => !own.has(one.href)),
      // After research: the same numbered items the message carried, each beside its screenshot.
      ...(content.items === undefined ? {} : { items: content.items.map((item, index) => ({ number: index + 1, title: item.title, lines: whyLines(item.why), source: item.source, url: item.url,
        image: item.shot === null || content.shots === null ? null : { src: `/r/${content.shots.run}/evidence/${item.shot}`, caption: itemCaption(index + 1, item) } })) }) });
    const browserWait = card.state === "active" && stage?.kind === "check" && stage.browser === true && browser !== null && browser.status !== "allowed"
      && card.waiting !== null && card.waiting.startsWith(`${stage.title} starts a browser`);
    return {
      id: card.id, title: card.title, description: card.description, stage: card.stage, state: card.state,
      waiting: card.state === "active" && card.task !== null && (stage?.kind === "task" || stage?.kind === "report")
        ? canReadTask ? flowCardTaskLine(store, card.task, taskRepo!, now, secretsFor(taskRepo!)) : "Task unavailable"
        // Waiting for browser use: the page offers Allow browser itself, so the command line the CLI shows is left off.
        : browserWait ? card.waiting!.replace(/ Approve it with: toolroll flows browser \d+ on$/, "") : card.waiting,
      ...(browserWait ? { browserWait: true as const } : {}),
      task: task === null ? null : { id: task, href: `/t/${encodeURIComponent(task)}`,
        // Its running attempt's composer, for an approver who may read the task (steer-controls.ts).
        ...(() => {
          const ref = card.state === "active" && canReadTask && viewer.approver ? store.lookupRef(task) : null;
          const run = ref === null ? null : liveAttemptOf(store, ref.id, now);
          const composer = run === null ? null : steerControlsFor(store, task, run, now, viewer.approver);
          return composer === null ? {} : { composer };
        })() },
      createdBy: card.createdBy, updatedAt: card.updatedAt,
      canDecide,
      // What a "Send to me" sent shows once, in its own box (sent), not again here; a report zone's items and full report
      // (`<id>.items`, `<id>.report`) are for later zones, and its summary is shown.
      outputs: Object.entries(card.outputs).filter(([id]) => !id.includes(".") && stages.find(one => one.id === id)?.kind !== "send").map(([id, text]) => ({ stage: id, title: title(id), text })),
      history: [...moves, ...owned].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
      // v126: an outside event's card says how it was proved and where its link goes, from what was kept at receipt.
      source: card.source === null ? null : (() => { const snapshot = snapshotOf(card.source); return snapshot === null ? card.source : { ...card.source, proved: provedWords(snapshot), host: hostOf(card.source.url), shown: card.source.url === null ? null : linkWords(card.source.url) }; })(),
      owner: card.owner, watchers, watching: watchers.includes(viewer.name),
      mine: card.owner === viewer.name || watchers.includes(viewer.name) || canDecide || choosing?.person === viewer.name,
      comments: discussion.filter(one => one.kind === "comment").map(one => ({ id: one.id, author: one.author, body: one.body, mentions: one.mentions, at: one.at })),
      sorted: decision === null ? null : { chip: sortChip(decision), confident: decision.confident },
      draft: shown === null || card.state !== "active" || card.outputs[shown.id] === undefined ? null : { zone: shown.id, title: shown.title, text: card.outputs[shown.id]! },
      deadline,
      handoff,
      choose: choosing === null || sentContent === null || latest?.entry !== card.entry ? null : { entry: card.entry, ...sentView(sentContent), person: choosing.person, mine: choosing.person === viewer.name,
        options: (sentContent.options ?? []).filter(one => choosing.stage.options?.[one.choice]?.label === one.label), reply: sentContent.reply === true },
      sent: sentContent === null || (choosing !== null && latest?.entry === card.entry) ? null : { ...sentView(sentContent), person: latest!.person, at: latest!.createdAt },
      question: asked === null || asked.state !== "open" || asker === null ? null
        : { id: asked.id, from: labelOf(asker), question: asked.question, options: asked.options, askedOf: asked.askedOf, mine: asked.askedOf === viewer.name,
          call: pending === null ? null : { why: pending.why, rule: pending.result ?? "" } },
      calls: store.subagentCallsOn(card.id).slice(-30).map(call => {
        const mate = mates.get(call.subagent) ?? null;
        // A person's undo (v97) reads as theirs, and its outcome says what it undid.
        return { id: call.id, who: call.undoOf !== null ? call.decidedBy ?? "A person" : mate === null ? "A subagent" : nameOf(mate), words: callWords(call.tool, call.action, call.input, 400), state: call.state, outcome: receiptWords(store, call),
          why: call.undoOf !== null ? "" : call.why, result: call.state === "asked" ? null : call.result, at: call.createdAt, subagent: call.subagent, undo: viewer.approver ? undoFor(store, call) : null };
      }),
    };
  });
  const triggers: BrowserFlowTrigger[] = store.flowTriggers(flow.id).map(trigger => {
    const config = triggerConfigOf(trigger);
    return {
      id: trigger.id, kind: trigger.kind, words: config === null ? "This trigger can't be read." : describeTrigger(config, store),
      ...(config === null ? { name: "Trigger", detail: "Can't be read" } : triggerHeadline(config, store)),
      zone: title(config?.zone ?? definition?.start ?? ""), zoneId: config?.zone ?? definition?.start ?? "", state: trigger.state, status: trigger.lastOutcome, statusLink: planeStatusLink(config, trigger.lastOutcome), statusAt: trigger.lastAt, failing: trigger.failures > 0,
      button: config?.kind === "button" ? { label: config.label, questions: config.questions } : null,
      hook: config !== null && takesDeliveries(config) ? hookView(trigger, config, setup.dir) : null,
      checkable: ((config?.kind === "github" || config?.kind === "linear") && config.delivery === "poll") || config?.kind === "email" || (config?.kind === "schedule" && config.script !== undefined) || config?.kind === "plane-review",
      shared: config?.kind === "button" && trigger.hookHash !== null,
      ...(config?.kind === "schedule" && config.order !== undefined ? { order: describeStandingOrder(config.order, flow.repo, config.schedule) } : {}),
    };
  });
  return {
    kind: "flow",
    flow: { id: flow.id, name: flow.name, project: projectName(flow.repo), revision: flow.revision, href: `/flows/${flow.id}`, owner: flow.owner },
    chatHref: `/chat?draft=${encodeURIComponent(`In the ${flow.name} flow, `)}`,
    triggers,
    triggerSetup: {
      kinds: FLOW_TRIGGER_KINDS.map(kind => ({ kind, label: FLOW_TRIGGER_WORDS[kind] })),
      githubRepo: githubRepoOf(flow.repo), linearKey: readLinearKey(setup.dir) !== null, hooksBase: readHooksBase(setup.dir), hooksPath: HOOK_PATH,
      mailbox: mailboxReady(setup.dir) ? googleConnected(setup.dir)?.address ?? readEmailSettings(setup.dir)?.from ?? null : null,
      otherFlows: store.listFlows(setup.repos).filter(one => one.id !== flow.id).map(one => ({ id: one.id, name: one.name, zones: (flowDefinitionOf(one)?.stages ?? []).map(stage => ({ id: stage.id, title: stage.title })) })),
    },
    startTrigger: setup.startTrigger ?? null,
    me: viewer.name,
    sortReady: setup.sortReady ?? false,
    subagents: store.subagents([flow.repo]).map(mate => ({ handle: mate.handle, label: labelOf(mate), name: nameOf(mate), working: mate.state === "active", href: `/settings/lead/subagents/${mate.id}` })),
    emailReady: sendingReady(setup.dir),
    requestSecrets: flowSecretNames(setup.dir, flow.repo),
    tools: projectToolsOf(store, flow.repo).map(tool => ({ name: tool.name, about: tool.spec.about, functions: tool.lastTest?.ok === true ? tool.lastTest.tools : [],
      ready: toolStanding(tool, secretsSetFor(flow.repo, tool.spec, setup.toolHome)).ready })),
    scripts: store.flowScripts(flow.repo).map(script => ({ name: script.name, about: script.about, body: script.body, timeoutMinutes: script.timeoutMinutes, version: script.version, savedBy: script.savedBy, savedAt: script.savedAt,
      language: script.language, file: script.file, held: script.held !== null,
      usedHere: stages.filter(stage => stage.kind === "check" && stage.script === script.name).map(stage => stage.title) })),
    start: definition?.start ?? stages[0]?.id ?? "",
    stages,
    cards,
    selectedCard,
    live: flowFingerprint(store, flow.id),
    canEdit: viewer.approver,
    unattended: unattendedViewOf(store, flow, viewer, setup.now ?? now),
    browser,
    approvers: store.listApprovers().map(one => one.name).filter(name => store.accountCanAccess(name, flow.repo)),
    projects: [flow.repo, ...setup.repos.filter(one => one !== flow.repo)].map(path => ({ path, name: projectName(path) })),
    kinds: FLOW_STAGE_KINDS.map(kind => ({ kind, label: FLOW_KIND_WORDS[kind].label, about: FLOW_KIND_WORDS[kind].about })),
    colors: [...FLOW_COLORS],
  };
}

/** The page the canvas replaces when scripts can't run: each zone and its cards, in order. */
export function flowFallbackHtml(view: BrowserFlowView): Html {
  const own = view.unattended.active;
  return html`<section class="flows flow-fallback"><p class="meta">${view.flow.project}</p>${own !== null && html`<p data-flow-unattended>Runs on its own until ${own.untilWords}</p>`}${view.browser !== null && html`<p data-flow-browser="${view.browser.status}">${view.browser.words}</p>`}<ol>${view.stages.map(stage => {
    const cards = view.cards.filter(card => card.stage === stage.id && card.state === "active");
    return html`<li><strong>${stage.title}</strong> · ${FLOW_KIND_WORDS[stage.kind].label}${cards.length > 0 && html`<ul>${cards.map(card => html`<li>${card.title}${card.waiting !== null && ` — ${card.waiting}`}</li>`)}</ul>`}</li>`;
  })}</ol></section>`;
}

/** The nightly check's own health on its flow (release-once.md, part 3): nothing since the last firing for 26 hours. */
function nightlyHealthOf(store: Store, flow: FlowRow): string | null {
  const nightly = store.flowTriggers(flow.id).find(one => one.state === "active" && triggerConfigOf(one)?.kind === "schedule" && (triggerConfigOf(one) as { order?: { check?: unknown } }).order?.check !== undefined);
  return nightly === undefined ? null : nightlyHealthWords(store, flow.repo, nightly.updatedAt, new Date());
}
