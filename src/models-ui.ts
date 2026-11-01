/** Settings → Models: the CLIs on this computer, the default agent for each
 * role picked from live lists, and the models that just arrived. */
import { html, postForm, reauth, type Html } from "./html.js";
import type { ModelOption, RuntimeState, SeenModel, WatchState } from "./model-catalog.js";
import { priceWords } from "./model-catalog.js";
import { whenUtc } from "./when-html.js";

const when = (iso: string | null) => iso === null ? "never" : whenUtc(iso);

export const MODELS_CSS = `.models{max-width:780px;min-width:0;overflow-wrap:anywhere}.models .card{padding:16px 20px;margin:12px 0;min-width:0}.models h2{margin:24px 0 8px}.models form{margin:0}.models label{display:grid;gap:6px}.models select,.models input[type=search]{box-sizing:border-box;width:100%;max-width:100%;min-width:0}.models button,.models summary,.models .button-link{min-height:44px}.models button{white-space:nowrap}.models summary{padding:12px 0;cursor:pointer}.models .tool{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.models .role{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}.models .role-row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.models .role-row select{flex:1 1 240px;width:auto;min-width:0}.models .role-name{font-weight:600}.models .new{font-weight:600}.models ul{padding-left:20px}.models .meta{font-size:.86rem}.models .role-read{display:grid;gap:2px;padding:8px 0}.models .editor{display:grid;gap:14px}.models .editor .role select{width:100%}.models .tiers{border-top:1px solid var(--so-line)}.models .tiers .role{margin:0 0 14px}.models .mono{font-family:var(--font-mono,ui-monospace,monospace);font-size:.84rem}.models .preset{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.models .preset p{margin:4px 0 0}.models .preset>div{flex:1 1 280px;min-width:0}.models .button-link{display:inline-flex;align-items:center;padding:0 14px;border:1px solid var(--so-input-line);border-radius:8px;text-decoration:none;color:var(--so-ink);font-weight:600}.models table{width:100%;border-collapse:collapse}.models th,.models td{text-align:left;vertical-align:top;padding:8px 6px;border-bottom:1px solid var(--so-line)}.models .diff th{width:38%;font-weight:600}.models .diff ul{margin:4px 0 0}.models .preview{border-color:var(--so-input-line)}.models .preview form{display:grid;gap:10px;margin-top:12px}.models .preview .cancel{justify-self:start;display:inline-flex;align-items:center;min-height:44px}.models .sizing dt{font-weight:600;margin-top:8px}.models .sizing dd{margin:2px 0 0}.models .editor label:has(input[type=password]){margin-top:4px}@media(max-width:600px){.models .card{padding:14px}.models .diff th,.models .diff td{display:block;width:auto;border:0;padding:4px 0}.models .diff tr{display:block;border-bottom:1px solid var(--so-line);padding:6px 0}.models .recent td{display:block;border:0;padding:2px 0}.models .recent tr{display:block;border-bottom:1px solid var(--so-line);padding:6px 0}.models .recent thead{display:none}}`;

/** One row of the editor: a role at the scope being edited. */
export type RoleView = {
  /** The slot's form field (model-choices.ts slotKey). */
  key: string;
  label: string;
  /** "provider|model", or "" when this scope has no row of its own. */
  current: string;
  /** What runs now, in words, including what is inherited. */
  words: string;
  /** What "no row here" means for this role: "Same as the builder", "Same as the installation (…)", "Not set". */
  unset: string;
  groups: { label: string; provider: string; options: ModelOption[] }[];
  /** Behind the tiers disclosure. */
  tier: boolean;
};

export type DiffView = { role: string; before: string; after: string; notes: string[] };

export type ModelsView = {
  runtimes: RuntimeState[];
  watch: WatchState;
  roles: RoleView[];
  chat: { words: string } | null;
  fresh: SeenModel[];
  csrf: string;
  canManage: boolean;
  said: string | null;
  problem: string | null;
  /** The scope being edited, the scopes on offer, and the digest of what this page shows. */
  scope: { value: string; label: string; options: { value: string; label: string }[]; digest: string };
  /** "Sized by job", "Opus for everything", or null for a custom set. */
  inUse: string | null;
  presets: { name: string; label: string; words: string; inUse: boolean; recommended: boolean }[];
  /** Newer models the watch has seen for exact ids in use here. */
  newer: { from: string; to: string; name: string; roles: string }[];
  /** A preset or switch's exact diff, shown before it applies. */
  preview: { title: string; rows: DiffView[]; hidden: Record<string, string> } | null;
  /** What still keeps tasks from being filed at this scope, or null. */
  unresolved: string | null;
  sizing: { small: string; routine: string; large: string; risky: string; classifier: string };
  routing: string;
  recent: { taskId: string; runId: number; role: string; chosen: string; ranOn: string }[];
  waiting: { taskId: string; title: string }[];
};

function toolRow(one: RuntimeState, manage: boolean): Html {
  const state = one.installed === null ? "Version unknown"
    : one.behind ? html`${one.installed} · <strong>${one.latest} available</strong>`
    : `${one.installed} · Up to date`;
  const action = manage && one.behind && one.updateCommand !== null
    ? postForm("/settings/models/update", html`<button type="submit">Update ${one.name}</button>`, { hidden: { tool: one.tool } })
    : one.behind ? html`<span class="meta">Update it the way you installed it</span>` : "";
  return html`<div class="card tool"><span><strong>${one.name}</strong> ${state}${one.problem === null ? "" : html`<br><span class="meta">${one.problem}</span>`}</span>${action}</div>`;
}

function roleForm(role: RoleView, manage: boolean): Html {
  if (!manage) return html`<div class="role-read"><span class="role-name">${role.label}</span><span>${role.words}</span></div>`;
  const known = role.groups.some(group => group.options.some(option => `${group.provider}|${option.value}` === role.current));
  const saved = !known && role.current !== "" ? html`<option value="${role.current}" selected>${role.words} · current</option>` : "";
  const groups = role.groups.map(group => html`<optgroup label="${group.label}">${group.options.map(option => {
    const value = `${group.provider}|${option.value}`;
    return html`<option value="${value}"${value === role.current ? html` selected` : ""}>${option.label}</option>`;
  })}</optgroup>`);
  const unset = html`<option value="clear"${role.current === "" ? html` selected` : ""}>${role.unset}</option>`;
  const count = role.groups.reduce((sum, group) => sum + group.options.length, 0);
  const id = `role-${role.key}`;
  return html`<div class="role"><label class="role-name" for="${id}">${role.label}</label>${
    count > 40 ? html`<input type="search" data-model-filter hidden aria-label="Search ${role.label.toLowerCase()} models" placeholder="Search ${count} models" autocomplete="off">` : ""}<select id="${id}" name="${role.key}">${unset}${saved}${groups}</select>${role.current === "" ? html`<span class="meta">${role.words}</span>` : ""}</div>`;
}

export function modelsHtml(view: ModelsView): Html {
  const manage = view.canManage && view.csrf !== "";
  const status = view.said === null ? "" : html`<p role="status">${view.said}</p>`;
  const problem = view.problem === null ? "" : html`<p class="problem" role="alert">${view.problem}</p>`;
  const tools = view.runtimes.length === 0
    ? html`<p class="meta">No Claude, Codex or Gemini CLI found on this computer yet.</p>`
    : view.runtimes.map(one => toolRow(one, manage));
  const check = manage
    ? postForm("/settings/models/check", html`<button type="submit" class="secondary">Check now</button>`, { attrs: { class: "inline" } })
    : "";
  const fresh = view.fresh.length === 0 ? "" :
    html`<h2>New models</h2><ul>${view.fresh.map(model => html`<li><span class="new">${model.name}</span> <span class="meta">${priceWords(model)}${model.releasedAt === null ? "" : ` · released ${model.releasedAt.slice(0, 10)}`}</span></li>`)}</ul>`;
  const watch = manage
    ? html`<details><summary>Automatic checks · ${view.watch.enabled ? "On" : "Off"}</summary>${postForm("/settings/models/watch", html`<p>Check every 6 hours and send a message when a new model or CLI update appears. It uses public lists and sends nothing about you or your projects.</p><button type="submit" class="secondary">${view.watch.enabled ? "Turn off" : "Turn on"}</button>`, { hidden: { enabled: view.watch.enabled ? "0" : "1" } })}</details>`
    : "";
  return html`<section class="models">${status}${problem}${previewCard(view, manage)}${editorSection(view, manage)}${presetsSection(view, manage)}${sizingSection(view)}${recentSection(view)}<h2>AI tools</h2>${tools}<p class="meta">Checked ${when(view.watch.checkedAt)} ${check}</p>${
    fresh}${
    view.chat === null ? "" : html`<h2>Chat</h2><p>${view.chat.words} · <a href="/settings/lead">Change</a></p>`}${
    watch}</section>`;
}

/** Filters one long picker as you type; the saved choice always stays listed. */
export function modelsScript(): string {
  return `(function(){document.querySelectorAll('.models .role').forEach(function(form){
    var search=form.querySelector('[data-model-filter]'),select=form.querySelector('select');
    if(!search||!select)return;search.hidden=false;
    var groups=Array.from(select.querySelectorAll('optgroup')).map(function(g){return{g:g,options:Array.from(g.children)}});
    search.addEventListener('input',function(){var q=search.value.trim().toLowerCase(),chosen=select.value;
      groups.forEach(function(entry){entry.g.replaceChildren();entry.options.forEach(function(o){if(!q||o.value===chosen||(o.textContent+' '+o.value).toLowerCase().includes(q))entry.g.appendChild(o)})});
      select.value=chosen;});
  })})();`;
}

const scopeQuery = (view: ModelsView): string => view.scope.value === "installation" ? "" : `&scope=${encodeURIComponent(view.scope.value)}`;
const password = (): Html => reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label>`);

/** The roles at the scope being edited: one form, one save, one password. Sizes and tiers sit behind a disclosure. */
function editorSection(view: ModelsView, manage: boolean): Html {
  const scopes = view.scope.options.length < 2 ? "" : html`<form method="get" action="/settings/models" class="models-scope"><label for="models-scope">Settings for</label><div class="role-row"><select id="models-scope" name="scope">${
    view.scope.options.map(one => html`<option value="${one.value}"${one.value === view.scope.value ? html` selected` : ""}>${one.label}</option>`)}</select><button type="submit" class="secondary">Show</button></div></form>`;
  const main = view.roles.filter(role => !role.tier), tiers = view.roles.filter(role => role.tier);
  const inUse = html`<p class="meta">In use: ${view.inUse === null ? "a custom set" : view.inUse}${view.scope.value === "installation" ? "" : html` · ${view.scope.label}`}</p>`;
  const unresolved = view.unresolved === null ? "" : html`<p class="problem" role="alert">New tasks can't be filed here yet: ${view.unresolved}</p>`;
  const rows = html`${main.map(role => roleForm(role, manage))}<details class="tiers"${manage ? "" : html` open`}><summary>By task size</summary>${tiers.map(role => roleForm(role, manage))}</details>`;
  const body = manage
    ? postForm("/settings/models/agent", html`${rows}${password()}<button type="submit">Save</button>`, { attrs: { class: "card editor" }, hidden: { scope: view.scope.value, digest: view.scope.digest } })
    : html`<div class="card editor">${rows}</div>`;
  return html`<h2>Models for new tasks</h2>${scopes}${inUse}${unresolved}${body}<p class="meta">Changes apply to tasks filed from now on. Approved and waiting tasks keep the models they were filed with.</p>`;
}

/** A preset or a switch shows exactly what it changes, and applies only with a second, password-checked submit. */
function previewCard(view: ModelsView, manage: boolean): Html {
  const preview = view.preview;
  if (preview === null || !manage) return html``;
  const back = `/settings/models${view.scope.value === "installation" ? "" : `?scope=${encodeURIComponent(view.scope.value)}`}`;
  if (preview.rows.length === 0) return html`<div class="card preview" role="status"><h2>${preview.title}</h2><p>Already in use. Nothing would change.</p><a class="button-link" href="${back}">Back</a></div>`;
  const rows = preview.rows.map(row => html`<tr><th scope="row">${row.role}</th><td><span class="mono">${row.before}</span> → <span class="mono">${row.after}</span>${
    row.notes.length === 0 ? "" : html`<ul class="meta">${row.notes.map(note => html`<li>${note}</li>`)}</ul>`}</td></tr>`);
  return html`<div class="card preview"><h2>${preview.title}</h2><p>Review what changes for tasks filed from now on.</p><table class="diff"><tbody>${rows}</tbody></table>${
    postForm("/settings/models/apply", html`${password()}<button type="submit" class="primary">Apply ${preview.rows.length} change${preview.rows.length === 1 ? "" : "s"}</button><a class="cancel" href="${back}">Cancel</a>`, { hidden: preview.hidden })}</div>`;
}

function presetsSection(view: ModelsView, manage: boolean): Html {
  const presets = view.presets.map(one => html`<div class="card preset"><div><strong>${one.label}</strong>${one.recommended ? html` <span class="meta">Default</span>` : ""}<p>${one.words}</p></div>${
    one.inUse ? html`<span class="meta">In use</span>` : manage ? html`<a class="button-link" href="/settings/models?preset=${one.name}${scopeQuery(view)}">Review changes</a>` : ""}</div>`);
  const newer = view.newer.length === 0 ? "" : html`<h2>Newer models</h2>${view.newer.map(one => html`<div class="card preset"><div><strong>${one.name}</strong><p>Newer than <span class="mono">${one.from}</span>, used by ${one.roles}.</p></div>${
    manage ? html`<a class="button-link" href="/settings/models?switch=${encodeURIComponent(one.from)}&to=${encodeURIComponent(one.to)}${scopeQuery(view)}">Switch to it</a>` : ""}</div>`)}`;
  return html`<h2>Presets</h2>${presets}${newer}`;
}

/** How a task's size is decided, in plain words, and what routing does at filing. */
function sizingSection(view: ModelsView): Html {
  return html`<h2>How tasks are sized</h2><div class="card sizing"><p>Each task is sized once, when it is filed. ${view.sizing.classifier} If it doesn't answer within 5 seconds, the size comes from the description.</p><dl>
<dt>Small</dt><dd>${view.sizing.small}. Built by the builder for small tasks, with no plan.</dd>
<dt>Routine</dt><dd>${view.sizing.routine}. Planned and built by the planner and builder for routine tasks.</dd>
<dt>Large or risky</dt><dd>Large: ${view.sizing.large}. Risky: ${view.sizing.risky} Planned and built by the large or risky models.</dd></dl>
<details><summary>More about routing</summary><p>${view.routing}</p><p>Changing a model never re-sizes or re-routes a task that was already filed. One exception: an older build review saved without its own route uses the reviewer set here now.</p></details></div>${
    view.waiting.length === 0 ? "" : html`<details class="waiting"><summary>${view.waiting.length} plan${view.waiting.length === 1 ? "" : "s"} waiting for approval</summary><p class="meta">They keep the models they were filed with.</p><ul>${view.waiting.map(one => html`<li><a href="/t/${encodeURIComponent(one.taskId)}">${one.title}</a></li>`)}</ul></details>`}`;
}

/** The model each recent run was set to, next to the model its provider reported. */
function recentSection(view: ModelsView): Html {
  if (view.recent.length === 0) return html``;
  return html`<h2>Recent work</h2><table class="recent"><thead><tr><th scope="col">Task</th><th scope="col">Chosen → ran on</th></tr></thead><tbody>${view.recent.map(one => html`<tr><td><a href="/t/${encodeURIComponent(one.taskId)}">${one.taskId}</a> <span class="meta">${one.role}</span></td><td><span class="mono">${one.chosen}</span> → <span class="mono">${one.ranOn}</span></td></tr>`)}</tbody></table>`;
}
