/**
 * The Teammates pages (v92): who is on the team, and one page per teammate —
 * what it asks you, its soul file, what it did and why, what you told it,
 * and its settings. Server-rendered forms, like the other settings pages.
 */
import type { Store, TeammateRow } from "./store.js";
import { labelOf, nameOf, summaryOf, TEAMMATE_MODELS, zonesOf } from "./teammate-admin.js";
import { TEAMMATE_TEMPLATES } from "./teammates.js";
import { projectToolsOf } from "./project-tools.js";
import { callWords, defaultRule, numberFields, receiptWords } from "./teammate-tools.js";
import { MEMORY_CHARS, searchMemories } from "./teammate-memory.js";
import { deskOf, localZone, routinesOf } from "./teammate-desk.js";
import { weekOf, weekWords } from "./teammate-week.js";
import { describeSchedule, parseSchedule } from "./flow-schedule.js";
import { html, joinHtml, postForm, type Html } from "./html.js";

/** v94: the Tools section's rule rows; a limit's fields show only while "Up to a limit" is chosen. */
export const TEAMMATE_CSS = `.teammate-tools .tool-grant{border-top:1px solid var(--so-line);padding-top:12px;margin-top:12px}.teammate-tools .tool-grant:first-of-type{border-top:0;margin-top:0;padding-top:0}.teammate-tools h3{font-size:1rem;margin:0 0 4px}.teammate-tools .tool-rule{display:grid;gap:6px;padding:10px 0;border-bottom:1px solid var(--so-line)}.teammate-tools .tool-rule:last-of-type{border-bottom:0}.teammate-tools .tool-rule .meta{display:block}.teammate-tools select,.teammate-tools input{max-width:100%;box-sizing:border-box}.teammate-tools .tool-limit{display:none;flex-wrap:wrap;align-items:center;gap:6px}.teammate-tools .tool-rule:has(option[value="limit"]:checked) .tool-limit{display:flex}.teammate-tools .tool-rule>select{width:auto;min-width:16em}.teammate-tools .tool-limit select{width:auto}.teammate-tools .tool-limit input{width:7em}.teammate-tools .tool-buttons{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.teammate-tools button{min-height:44px}.teammate-activity li{overflow-wrap:anywhere}.teammate-memory .memory-tell,.teammate-memory .memory-search{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:0 0 12px}.teammate-memory .memory-tell textarea{flex:1 1 280px}.teammate-memory .memory-search input{flex:1 1 220px}.teammate-memory button{min-height:44px}.teammate-memories{list-style:none;padding:0;margin:0}.teammate-memories li{padding:10px 0;border-top:1px solid var(--so-line);overflow-wrap:anywhere}.teammate-memories li:first-child{border-top:0}.teammate-memories .meta{display:block;font-size:.85rem}.teammate-memories details.memory-edit{border:0;padding:0;margin:2px 0 0;background:transparent;box-shadow:none}.memory-edit summary{cursor:pointer;min-height:32px;display:inline-flex;align-items:center;font-size:.85rem;font-weight:400;color:var(--so-muted)}.tool-undo{border:0;padding:0;margin:8px 0;background:transparent;box-shadow:none}.tool-undo summary{cursor:pointer;min-height:36px;display:inline-flex;align-items:center;font-size:.9rem}.tool-undo-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}.tool-undo-row select{width:auto}.teammate-overrides,.teammate-undo{padding-left:18px}.teammate-undo li{margin:6px 0}.teammate-undo form{display:inline}.teammate-week h3{font-size:1rem;margin:14px 0 4px}.teammate-week button{min-height:44px}.teammate-routines{list-style:none;padding:0;margin:8px 0}.teammate-routines li{display:grid;gap:4px;padding:10px 0;border-top:1px solid var(--so-line)}.teammate-routines li:first-child{border-top:0}.routine-buttons{display:flex;flex-wrap:wrap;gap:8px}.routine-buttons button,.routine-add button{min-height:44px}.routine-add{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:8px 0}.routine-add label{display:grid;gap:4px;flex:1 1 200px}.routine-add label:first-of-type{flex:0 1 180px}.teammate-actions,.question-options{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.teammate-actions form,.question-options form{margin:0}.memory-edit form{display:grid;gap:8px;margin-top:6px}.memory-buttons{display:flex;flex-wrap:wrap;gap:8px}@media(max-width:600px){.teammate-tools select,.teammate-tools input{font-size:16px}}`;

const USES = [["free", "Do it"], ["limit", "Do it, up to a limit"], ["ask", "Ask first"], ["never", "Never"]] as const;

/** v94: which project tools it may use, and its rule for each action. */
function toolsSection(store: Store, mate: TeammateRow, canManage: boolean): Html | "" {
  const name = nameOf(mate);
  const tools = projectToolsOf(store, mate.repo);
  const grants = store.teammateGrants(mate.id);
  const toolsPage = `/settings/tools?repo=${encodeURIComponent(mate.repo)}`;
  const granted = grants.map(grant => {
    const gone = !tools.some(one => one.name === grant.tool);
    const rows = grant.actions.map(action => {
      const rule = grant.rules[action.name] ?? defaultRule(action);
      const use = rule.use === "free" && rule.limit !== undefined ? "limit" : rule.use;
      const numbers = numberFields(action);
      const words = rule.use === "never" ? "Never" : rule.use === "ask" ? "Ask first" : rule.limit === undefined ? "Do it" : `Do it up to ${rule.limit.field} ${rule.limit.over}, ask first above`;
      const about = action.about !== "" && html`<span class="meta">${action.about}</span>`;
      if (!canManage) return html`<li class="tool-rule"><span><strong>${action.name}</strong> · ${words}</span>${about}</li>`;
      const field = `${grant.tool}-${action.name}`.replace(/[^A-Za-z0-9_-]/g, "-");
      const limit = numbers.length > 0 && html`<span class="tool-limit">Ask first when <select name="field.${action.name}" aria-label="The number the limit is on">${numbers.map(one => html`<option value="${one}"${rule.limit?.field === one && html` selected`}>${one}</option>`)}</select> is over <input type="number" name="over.${action.name}" min="0" step="any" value="${rule.limit === undefined ? "" : rule.limit.over}" aria-label="The limit"></span>`;
      return html`<div class="tool-rule" data-tool-action="${action.name}"><label for="use-${field}"><strong>${action.name}</strong>${about}</label><select id="use-${field}" name="use.${action.name}">${USES.filter(([value]) => value !== "limit" || numbers.length > 0).map(([value, label]) => html`<option value="${value}"${value === use && html` selected`}>${label}</option>`)}</select>${limit}</div>`;
    });
    const head = html`<h3>${grant.tool}</h3>${gone && html`<p class="problem">This project doesn't have ${grant.tool} any more, so ${name} can't use it.</p>`}`;
    // v97: which action undoes which, for the Undo button on its receipts. Optional, so it's folded away.
    const undoing = grant.actions.filter(one => !one.readOnly).map(action => {
      const chosen = grant.rules[action.name]?.undo ?? "";
      return html`<label class="tool-undo-row">${action.name} is undone by<select name="undo.${action.name}"><option value="">nothing</option>${grant.actions.filter(other => other.name !== action.name).map(other => html`<option value="${other.name}"${other.name === chosen && html` selected`}>${other.name}</option>`)}</select></label>`;
    });
    const undoBox = undoing.length > 0 && html`<details class="tool-undo"${grant.actions.some(one => grant.rules[one.name]?.undo !== undefined) && html` open`}><summary>Undo</summary><p class="meta">When an action has an opposite, a person can press Undo on its receipts: the opposite is called with the same input.</p>${undoing}</details>`;
    return canManage
      ? html`<div class="tool-grant" data-tool-grant="${grant.tool}">${head}${postForm(`/teammates/${mate.id}/tools`, html`${rows}${undoBox}<div class="tool-buttons"><button name="op" value="rules">Save rules</button><button name="op" value="revoke" class="secondary">Stop using ${grant.tool}</button></div>`, { hidden: { tool: grant.tool } })}</div>`
      : html`<div class="tool-grant" data-tool-grant="${grant.tool}">${head}<ul>${rows}</ul></div>`;
  });
  const open = tools.filter(one => !grants.some(grant => grant.tool === one.name));
  const add = !canManage ? null : tools.length === 0 ? html`<p class="meta">This project has no tools yet. <a href="${toolsPage}">Add one</a>, then let ${name} use it here.</p>`
    : open.length === 0 ? null : postForm(`/teammates/${mate.id}/tools`, html`<label>Let ${name} use<select name="tool">${open.map(one => html`<option value="${one.name}">${one.name}${one.spec.about === "" ? "" : ` — ${one.spec.about.slice(0, 80)}`}</option>`)}</select></label><button>Add tool</button>`, { attrs: { class: "tool-add" }, hidden: { op: "grant" } });
  if (grants.length === 0 && add === null) return "";
  return html`<section class="card teammate-tools" id="tools"><h2>Tools</h2>${grants.length === 0 && html`<p class="meta">${name} doesn't use any tools yet. Reading starts as “Do it”; everything else asks you first.</p>`}${granted}${add}</section>`;
}

const when = (at: string) => new Date(at).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const startOfDay = () => { const day = new Date(); day.setHours(0, 0, 0, 0); return day.toISOString(); };
/** Text whose line breaks show as breaks. */
const lines = (text: string) => joinHtml(text.split("\n"), html`<br>`);

/** A blank soul file: the sections a teammate reads, to fill in. */
export const BLANK_SOUL = `---\nname: \nrole: \n---\n\n## Who you are\n\n\n## How you write\n\n\n## What you know\n\n\n## Decide on your own\n- \n\n## Ask first\n- \n\n## Never\n- \n`;

export function teammatesListHtml(store: Store, mates: readonly TeammateRow[], projects: readonly string[], projectName: (repo: string) => string, canCreate: boolean, notice: { said?: string | null; problem?: string | null }): Html {
  const rows = mates.map(mate => {
    const today = store.teammateTurnsSince(mate.id, startOfDay());
    const open = store.openTeammateQuestions([mate.id]).length;
    return html`<article class="card" data-teammate="${mate.handle}"><div class="flow-row"><h2><a href="/teammates/${mate.id}">${labelOf(mate)}</a></h2><span class="flow-counts">${projectName(mate.repo)} · ${mate.state === "active" ? "Working" : "Paused"} · ${today} today${open > 0 ? ` · ${open} question${open === 1 ? "" : "s"} for you` : ""}</span></div></article>`;
  });
  const create = canCreate && projects.length > 0
    ? html`<details class="card"${mates.length === 0 && html` open`}><summary>New teammate</summary>${postForm("/teammates/new", html`<label>Start from<select name="template">${TEAMMATE_TEMPLATES.map(one => html`<option value="${one.id}">${one.label}: ${one.about}</option>`)}<option value="blank">Blank: write its soul file yourself</option></select></label><label>Name<input name="name" maxlength="40" placeholder="keep the template's name"></label>${projects.length === 1 ? html`<input type="hidden" name="repo" value="${projects[0]!}">` : html`<label>Project<select name="repo">${projects.map(repo => html`<option value="${repo}">${projectName(repo)}</option>`)}</select></label>`}<button>Add teammate</button>`, { attrs: { "data-new-teammate": true } })}</details>`
    : "";
  const intro = html`<p class="meta">AI teammates work your flows' cards within rules you write: they decide, reply and move cards on, and ask you when their rules say to. The quickest start is a <a href="/kits">starter kit</a>: a teammate and its flow, set up in one click.</p>`;
  return html`<section class="teammates">${notice.problem && html`<p class="problem" role="alert">${notice.problem}</p>`}${notice.said && html`<p class="said" role="status">${notice.said}</p>`}${intro}${rows.length > 0 ? rows : html`<p class="meta">No teammates yet.</p>`}${create}</section>`;
}

/** v97: its week: what it did and cost, what people overrode, and calls that can be undone. */
function weekSection(store: Store, mate: TeammateRow, canManage: boolean): Html {
  const week = weekOf(store, mate, new Date());
  const overrides = week.overrides.length > 0 && html`<h3>What you overrode</h3><ul class="teammate-overrides">${week.overrides.map(one => html`<li>${one.said}${one.href !== null && html` · <a href="${one.href}">open</a>`} <span class="meta">${when(one.at)}</span></li>`)}</ul>`;
  const undo = week.undoable.length > 0 && html`<h3>Undo</h3><ul class="teammate-undo">${week.undoable.map(one => html`<li data-undo="${one.call}"><span>${one.words}</span> <span class="meta">${when(one.at)}${one.href !== null && html` · <a href="${one.href}">open</a>`}</span>${canManage && postForm(`/teammates/${mate.id}/week`, html`<button name="op" value="undo" class="secondary">Undo with ${one.undo}</button>`, { hidden: { id: one.call } })}</li>`)}</ul>`;
  const send = canManage && postForm(`/teammates/${mate.id}/week`, html`<button name="op" value="send" class="secondary">Send the week's report</button>`);
  return html`<details class="card teammate-week" id="week" open><summary>This week</summary><p class="teammate-week-said">${lines(weekWords(mate, week))}</p>${overrides}${undo}${send}</details>`;
}

/** v96: its desk — where messages to it by name and its routines land — and its routines. */
function deskSection(store: Store, mate: TeammateRow, canManage: boolean): Html {
  const name = nameOf(mate);
  const desk = deskOf(store, mate);
  const routines = routinesOf(store, mate);
  const intro = html`<p class="meta">Message ${name} by name in your chat app, like “@${mate.handle} where's order 1042?”. It lands on ${desk === null ? "its desk" : html`<a href="/flows/${desk.id}">${name}'s desk</a>`}, and the answer comes back to you.</p>`;
  const list = routines.length > 0 && html`<ul class="teammate-routines">${routines.map(one => html`<li data-routine="${one.id}"><span><strong>${scheduleWords(one.schedule)}</strong> · ${one.text}</span><span class="meta">${one.state === "paused" ? "Paused" : one.nextAt === null ? "" : `Next ${when(one.nextAt)}`}${one.lastAt !== null && ` · last ${when(one.lastAt)}${one.lastOutcome === null ? "" : `: ${one.lastOutcome}`}`}</span>${canManage && postForm(`/teammates/${mate.id}/routines`, html`<button name="op" value="run" class="secondary">Run now</button><button name="op" value="remove" class="secondary">Remove</button>`, { attrs: { class: "routine-buttons" }, hidden: { id: one.id } })}</li>`)}</ul>`;
  const add = canManage && postForm(`/teammates/${mate.id}/routines`, html`<label>When<input type="text" name="schedule" maxlength="80" placeholder="weekdays 09:00" required></label><label>What to do<input type="text" name="text" maxlength="200" placeholder="Look up yesterday's refunds and tell me the total." required></label><button>Add routine</button>`, { attrs: { class: "routine-add" }, hidden: { op: "add" } });
  return html`<section class="card teammate-desk" id="desk"><h2>Desk and routines</h2>${intro}${list}${add}${canManage && html`<p class="meta">A routine puts a card on its desk on that schedule (“weekdays 09:00”, “daily 17:00”, “monday 09:00”, “every 2 hours”; times are this computer's, ${localZone()}, unless you name one); the answer goes to ${mate.manager}.</p>`}</section>`;
}

/** A schedule's stored form ("weekdays:09:00@Europe/London") in words. */
const scheduleWords = (text: string) => { const parsed = parseSchedule(text); return parsed === null ? text : describeSchedule(parsed); };

/** v95: what it remembers — what its people told it, and what it kept from cards — to search, edit and forget. */
function memorySection(store: Store, mate: TeammateRow, canManage: boolean, query: string | null): Html {
  const name = nameOf(mate);
  const all = store.teammateMemories(mate.id, { limit: 500 });
  const shown = query === null || query.trim() === "" ? all.slice(0, 30) : searchMemories(store, mate, query);
  const tell = canManage && postForm(`/teammates/${mate.id}/note`, html`<label class="sr-only" for="teammate-note">Tell ${name} something</label><textarea id="teammate-note" name="note" rows="2" maxlength="${MEMORY_CHARS}" placeholder="For example: this week, offer free shipping instead of a refund when you can."></textarea><button>Tell ${name}</button>`, { attrs: { class: "memory-tell" } });
  const search = (all.length > 8 || (query ?? "") !== "") && html`<form method="get" action="/teammates/${mate.id}#memory" class="memory-search" role="search"><label class="sr-only" for="memory-q">Search what ${name} remembers</label><input id="memory-q" type="search" name="q" value="${query ?? ""}" placeholder="Search what ${name} remembers"><button class="secondary">Search</button></form>`;
  const items = shown.map(one => {
    const card = one.card === null ? null : store.getFlowCard(one.card);
    const whence = one.source === "person" ? `${one.createdBy} told it` : card === null ? "it kept this" : html`it kept this from <a href="/flows/${card.flow}?card=${card.id}">${card.title.slice(0, 60)}</a>`;
    const edit = canManage && html`<details class="memory-edit"><summary>Edit</summary>${postForm(`/teammates/${mate.id}/memory`, html`<label class="sr-only" for="memory-${one.id}">Memory</label><textarea id="memory-${one.id}" name="text" rows="2" maxlength="${MEMORY_CHARS}">${one.text}</textarea><div class="memory-buttons"><button name="op" value="edit">Save</button><button name="op" value="forget" class="secondary">Forget</button></div>`, { hidden: { id: one.id } })}</details>`;
    return html`<li data-memory="${one.id}" data-source="${one.source}"><span>${one.text}</span> <span class="meta">${whence} · ${when(one.updatedAt)}</span>${edit}</li>`;
  });
  const empty = (query ?? "") !== "" ? html`<p class="meta">Nothing ${name} remembers matches that.</p>` : html`<p class="meta">Nothing yet. What you tell ${name} is kept here, and it keeps short facts from the cards it works.</p>`;
  return html`<section class="card teammate-memory" id="memory"><h2>Memory</h2>${tell}${search}${shown.length === 0 ? empty : html`<ul class="teammate-memories">${items}</ul>`}${query === null && all.length > shown.length && html`<p class="meta">${all.length - shown.length} older ${all.length - shown.length === 1 ? "memory" : "memories"}: search to find them.</p>`}</section>`;
}

export function teammatePageHtml(store: Store, mate: TeammateRow, viewer: string, projectName: (repo: string) => string, canManage: boolean, approvers: readonly string[], notice: { said?: string | null; problem?: string | null; soulDraft?: string | null; query?: string | null }): Html {
  const name = nameOf(mate);
  const questions = store.openTeammateQuestions([mate.id]);
  const asked = questions.map(question => {
    const card = store.getFlowCard(question.card);
    const flow = card === null ? null : store.getFlow(card.flow);
    const mine = question.askedOf === viewer;
    const cardLink = card === null || flow === null ? "a card" : html`<a href="/flows/${flow.id}?card=${card.id}">${card.title}</a>`;
    const answer = mine && html`<div class="question-options">${question.options.map(one => postForm(`/teammates/questions/${question.id}/answer`, html`<button>${one.label}</button>`, { hidden: { choice: one.id } }))}</div>${postForm(`/teammates/questions/${question.id}/answer`, html`<label>Or answer in your words<textarea name="text" rows="2" maxlength="2000"></textarea></label><button>Answer</button>`, { attrs: { class: "question-reply" } })}`;
    return html`<article class="card teammate-question" data-question="${question.id}"${question.suggestion !== null && html` data-suggestion`}><p class="meta">${question.suggestion === null ? html`About ${cardLink}` : "Suggests a rule change"} · ${when(question.createdAt)}${!mine && ` · for ${question.askedOf}`}</p><p><strong>${question.question}</strong></p>${answer}</article>`;
  });
  const zones = zonesOf(store, mate);
  const where = zones.length === 0
    ? html`<p class="meta">Not on any zone yet. In a flow, choose ${name} under “Who decides” on a “Person decides” zone, or add a “Teammate handles it” zone.</p>`
    : html`<ul>${zones.map(one => html`<li><a href="/flows/${one.flow}">${one.flowName}</a> · ${one.kind === "decides" ? "decides" : "handles"} ${one.title}</li>`)}</ul>`;
  // What it did and why, with every tool call it made or asked to make (v94), newest first.
  const events = [
    ...store.teammateEvents(mate.id, 40).filter(one => one.kind !== "note").map(one => ({ kind: one.kind as string, said: one.said, card: one.card, at: one.at })),
    ...store.teammateCallsOf(mate.id, 40).map(one => ({ kind: "call", said: `Used ${callWords(one.tool, one.action, one.input, 200)} · ${receiptWords(store, one)}`, card: one.card as number | null, at: one.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  const activity = events.length === 0 ? html`<p class="meta">Nothing yet.</p>` : html`<ul class="teammate-activity">${events.map(one => {
    const card = one.card === null ? null : store.getFlowCard(one.card);
    return html`<li data-event="${one.kind}">${one.said}${card !== null && html` · <a href="/flows/${card.flow}?card=${card.id}">open</a>`} <span class="meta">${when(one.at)}</span></li>`;
  })}</ul>`;
  const versions = store.teammateVersions(mate.id);
  const latest = versions[0];
  const manage = canManage && html`<div class="teammate-actions">${postForm(`/teammates/${mate.id}/state`, html`<button${mate.state === "active" && html` class="secondary"`}>${mate.state === "active" ? `Pause ${name}` : `Resume ${name}`}</button>`, { hidden: { state: mate.state === "active" ? "paused" : "active" } })}${postForm(`/teammates/${mate.id}/summary`, html`<button class="secondary">Send today's summary</button>`)}</div>`;
  const soul = html`<details class="card"${canManage && html` open`}><summary>Soul file</summary><p class="meta">Who ${name} is and its rules, read every turn. Version ${mate.version}${latest !== undefined && ` · saved by ${latest.savedBy}, ${when(latest.savedAt)}`} · <a href="/teammates/${mate.id}/soul.md" download>Download</a></p>${canManage
    ? postForm(`/teammates/${mate.id}/soul`, html`<label class="sr-only" for="teammate-soul">Soul file</label><textarea id="teammate-soul" name="soul" rows="24" class="mono" maxlength="12000" spellcheck="false">${notice.soulDraft ?? mate.soul}</textarea><button>Save</button>`, { attrs: { "data-soul-form": true } })
    : html`<pre class="mono">${mate.soul}</pre>`}</details>`;
  const settings = canManage && html`<details class="card"><summary>Settings</summary>${postForm(`/teammates/${mate.id}/settings`, html`<label>Model<select name="model">${TEAMMATE_MODELS.map(one => html`<option value="${one}"${(mate.model ?? "default") === one && html` selected`}>${one === "default" ? "The lead chat's model" : one[0]!.toUpperCase() + one.slice(1)}</option>`)}</select></label><label>Turns a day, at most<input type="number" name="dailyTurns" min="1" max="2000" value="${mate.dailyTurns}"></label><label>Reports to<select name="manager">${[...new Set([mate.manager, ...approvers])].map(one => html`<option value="${one}"${one === mate.manager && html` selected`}>${one}</option>`)}</select></label><button>Save settings</button>`)}${postForm(`/teammates/${mate.id}/state`, html`<button class="danger">Remove ${name} from the team</button>`, { attrs: { class: "danger-zone" }, hidden: { state: "removed" } })}</details>`;
  return html`${notice.problem && html`<p class="problem" role="alert">${notice.problem}</p>`}${notice.said && html`<p class="said" role="status">${notice.said}</p>`}<p class="meta">${projectName(mate.repo)} · ${mate.state === "active" ? "Working" : "Paused: its decisions go to people"} · reports to ${mate.manager}</p>${manage}${questions.length > 0 && html`<section><h2>Questions</h2>${asked}</section>`}<section class="card"><h2>Today</h2><p class="teammate-summary">${lines(summaryOf(store, mate, startOfDay()).said)}</p></section>${weekSection(store, mate, canManage)}<section class="card"><h2>Works on</h2>${where}</section>${toolsSection(store, mate, canManage)}${deskSection(store, mate, canManage)}${memorySection(store, mate, canManage, notice.query ?? null)}${soul}<details class="card"><summary>What ${name} did</summary>${activity}</details>${settings}`;
}
