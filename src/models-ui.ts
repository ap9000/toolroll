/** Settings → Models: the CLIs on this computer, the default agent for each
 * role picked from live lists, and the models that just arrived. */
import { html, postForm, type Html } from "./html.js";
import type { ModelOption, RuntimeState, SeenModel, WatchState } from "./model-catalog.js";
import { priceWords } from "./model-catalog.js";
import { whenUtc } from "./when-html.js";

const when = (iso: string | null) => iso === null ? "never" : whenUtc(iso);

export const MODELS_CSS = `.models{max-width:780px;min-width:0;overflow-wrap:anywhere}.models .card{padding:16px 20px;margin:12px 0;min-width:0}.models h2{margin:24px 0 8px}.models form{margin:0}.models label{display:grid;gap:6px}.models select,.models input[type=search]{box-sizing:border-box;width:100%;max-width:100%;min-width:0}.models button,.models summary,.models .button-link{min-height:44px}.models button{white-space:nowrap}.models summary{padding:12px 0;cursor:pointer}.models .tool{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.models .role{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}.models .role-row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.models .role-row select{flex:1 1 240px;width:auto;min-width:0}.models .role-name{font-weight:600}.models .new{font-weight:600}.models ul{padding-left:20px}.models .meta{font-size:.86rem}@media(max-width:600px){.models .card{padding:14px}}`;

export type RoleView = {
  phase: "plan" | "build" | "review" | "repair";
  label: string;
  /** "provider|model", or "inherit" for a repair that follows the builder. */
  current: string;
  words: string;
  groups: { label: string; provider: string; options: ModelOption[] }[];
  /** Repair only: offer "Same as the builder". */
  inherit?: boolean;
};

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
  if (!manage) return html`<div class="card role"><strong>${role.label}</strong><span>${role.words}</span></div>`;
  const known = role.groups.some(group => group.options.some(option => `${group.provider}|${option.value}` === role.current));
  const saved = !known && role.current !== "inherit" && role.current !== "" ? html`<option value="${role.current}" selected>${role.words} · current</option>` : "";
  const groups = role.groups.map(group => html`<optgroup label="${group.label}">${group.options.map(option => {
    const value = `${group.provider}|${option.value}`;
    return html`<option value="${value}"${value === role.current ? html` selected` : ""}>${option.label}</option>`;
  })}</optgroup>`);
  const inherit = role.inherit ? html`<option value="inherit"${role.current === "inherit" ? html` selected` : ""}>Same as the builder</option>` : "";
  const long = role.groups.reduce((sum, group) => sum + group.options.length, 0) > 40;
  const count = role.groups.reduce((sum, group) => sum + group.options.length, 0);
  const id = `role-${role.phase}`;
  return postForm("/settings/models/agent", html`<label class="role-name" for="${id}">${role.label}</label>${
    long ? html`<input type="search" data-model-filter hidden aria-label="Search ${role.label.toLowerCase()} models" placeholder="Search ${count} models" autocomplete="off">` : ""}<div class="role-row"><select id="${id}" name="agent">${inherit}${saved}${groups}</select><button type="submit" class="secondary">Save</button></div>`,
    { attrs: { class: "card role" }, hidden: { phase: role.phase } });
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
  return html`<section class="models">${status}${problem}<h2>AI tools</h2>${tools}<p class="meta">Checked ${when(view.watch.checkedAt)} ${check}</p>${
    fresh}<h2>Default agents</h2><p class="meta">New tasks use these. Approved tasks keep the agents they were approved with.</p>${
    view.roles.map(role => roleForm(role, manage))}${
    view.chat === null ? "" : html`<h2>Chat</h2><p>${view.chat.words} · <a href="/settings/lead">Change</a></p>`}${
    watch}</section>`;
}

/** Filters one long picker as you type; the saved choice always stays listed. */
export function modelsScript(): string {
  return `(function(){document.querySelectorAll('.models form.role').forEach(function(form){
    var search=form.querySelector('[data-model-filter]'),select=form.querySelector('select');
    if(!search||!select)return;search.hidden=false;
    var groups=Array.from(select.querySelectorAll('optgroup')).map(function(g){return{g:g,options:Array.from(g.children)}});
    search.addEventListener('input',function(){var q=search.value.trim().toLowerCase(),chosen=select.value;
      groups.forEach(function(entry){entry.g.replaceChildren();entry.options.forEach(function(o){if(!q||o.value===chosen||(o.textContent+' '+o.value).toLowerCase().includes(q))entry.g.appendChild(o)})});
      select.value=chosen;});
  })})();`;
}
