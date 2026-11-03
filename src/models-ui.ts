/** Settings → Models, in the kit's Settings frame (a sub-page of "Agents and models"): what is in use and the one
 * choice (a preset, previewed before it applies), then the model for each role behind a disclosure, the CLIs on
 * this computer and the models that just arrived. Saving is an instance operator's step-up. */
import { html, postForm, type Html } from "./html.js";
import { approvalAsk, termsOf, type ApprovalFacts } from "./design/kit.js";
import { acts, btn, chip, disclose, dock, facts as factList, field, formRow, group, input, note, notice, radios, settingsShell } from "./server/kit.js";
import type { ModelOption, RuntimeState, SeenModel, WatchState } from "./model-catalog.js";
import { priceWords } from "./model-catalog.js";
import { whenUtc } from "./when-html.js";

const when = (iso: string | null) => iso === null ? "never" : whenUtc(iso);

/** The page's own layout on the kit: one-column preset cards, the role pickers in the form rows' control column. */
export const MODELS_CSS = `.models{display:grid;gap:24px;min-width:0;overflow-wrap:anywhere}.models .k-radios{grid-template-columns:minmax(0,1fr);padding-top:12px}` +
  `.models .k-secthead small{font-weight:400;color:var(--so-muted);font-size:12.5px}.models-presets{display:grid;gap:12px}.models-scope{display:flex;gap:8px;width:100%;max-width:300px;margin:0}.models-scope .k-selw{flex:1;min-width:0}.k-frow-c .models-scope .k-selw{max-width:none}.models-presets .k-acts{padding-top:4px}` +
  `.models .role{display:grid;gap:6px;width:100%;max-width:300px;min-width:0}.models .role .k-input{max-width:none}.models-editor{display:grid;gap:12px;padding-top:4px}` +
  `.models-editor > .k-field{max-width:300px}.models .k-grp{padding:16px 0 0}.models .k-disclose[open]>summary{margin-bottom:8px}.models-diff dd .k-mono{overflow-wrap:anywhere}` +
  `.models-sizing{display:grid;gap:8px;padding-top:4px}.models-sizing p{margin:0;max-width:66ch}` +
  `@media(max-width:760px){.models .role,.models-scope{max-width:none}.models-editor > .k-field{max-width:none}.models .k-btn.k-btn-primary.k-docked{display:none}}`;

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
  /** What this request's approval shows (approvalFactsNow): a step-up asks for the password unless Passwordless is on. */
  facts?: ApprovalFacts;
};

const sec = (id: string, title: string, state: string, body: HtmlValueLike): Html =>
  html`<section class="k-sec" aria-labelledby="models-${id}"><div class="k-secthead"><h3 id="models-${id}">${title}${state ? html` <small>· ${state}</small>` : ""}</h3></div>${body}</section>`;
type HtmlValueLike = Parameters<typeof acts>[0];

const back = (view: ModelsView): string => `/settings/models${view.scope.value === "installation" ? "" : `?scope=${encodeURIComponent(view.scope.value)}`}`;
const scopeQuery = (view: ModelsView): string => view.scope.value === "installation" ? "" : `&scope=${encodeURIComponent(view.scope.value)}`;
const factsOf = (view: ModelsView): ApprovalFacts => view.facts ?? { passwordless: false, remembered: false };
/** The step-up's password, only when the rules ask for it (never under Passwordless). Named `password`, as the
 * model posts read it; the server proves it again in the write. */
function password(view: ModelsView, id: string): Html | "" {
  return approvalAsk("step-up", factsOf(view)) === "password"
    ? field({ id, label: "Your password", control: input({ id, name: "password", type: "password", attrs: { autocomplete: "current-password", required: true } }) })
    : "";
}

function toolRow(one: RuntimeState, manage: boolean): Html {
  const state = one.installed === null ? "Version unknown" : one.behind ? `${one.installed} · ${one.latest} available` : `${one.installed} · up to date`;
  const action = manage && one.behind && one.updateCommand !== null
    ? postForm("/settings/models/update", btn(`Update ${one.name}`, { sm: true, type: "submit" }), { hidden: { tool: one.tool } })
    : one.behind ? html`<span class="k-note">Update it the way you installed it</span>` : html``;
  return formRow(one.name, one.problem === null ? state : `${state} · ${one.problem}`, action, "inline");
}

function roleRow(role: RoleView, manage: boolean): Html {
  if (!manage) return formRow(role.label, null, html`<span>${role.words}</span>`);
  const known = role.groups.some(group => group.options.some(option => `${group.provider}|${option.value}` === role.current));
  const saved = !known && role.current !== "" ? html`<option value="${role.current}" selected>${role.words} · current</option>` : "";
  const groups = role.groups.map(group => html`<optgroup label="${group.label}">${group.options.map(option => {
    const value = `${group.provider}|${option.value}`;
    return html`<option value="${value}"${value === role.current ? html` selected` : ""}>${option.label}</option>`;
  })}</optgroup>`);
  const unset = html`<option value="clear"${role.current === "" ? html` selected` : ""}>${role.unset}</option>`;
  const count = role.groups.reduce((sum, group) => sum + group.options.length, 0);
  const id = `role-${role.key}`;
  const control = html`<span class="role">${count > 40 ? html`<input class="k-input" type="search" data-model-filter hidden aria-label="Search ${role.label.toLowerCase()} models" placeholder="Search ${count} models" autocomplete="off">` : ""}\
<span class="k-selw wide"><select class="k-sel" id="${id}" name="${role.key}" aria-label="${role.label}">${unset}${saved}${groups}</select></span></span>`;
  return formRow(role.label, role.current === "" ? role.words : null, control);
}

export function modelsHtml(view: ModelsView): Html {
  const manage = view.canManage && view.csrf !== "";
  const outcome = view.problem !== null ? notice(view.problem) : view.said !== null ? html`<p class="k-note" role="status">${view.said}</p>` : "";
  const preview = previewSection(view, manage);
  const previewing = manage && view.preview !== null && view.preview.rows.length > 0;
  const tools = view.runtimes.length === 0 ? note("No Claude, Codex or Gemini CLI found on this computer yet.") : view.runtimes.map(one => toolRow(one, manage));
  const checks = manage ? html`${formRow("Check for new versions", `Checked ${when(view.watch.checkedAt)}.`, postForm("/settings/models/check", btn("Check now", { sm: true, type: "submit" })), "inline")}\
${formRow("Automatic checks", `${view.watch.enabled ? "On" : "Off"}. Every 6 hours, with a message when a new model or CLI update appears. Uses public lists and sends nothing about you or your projects.`,
    postForm("/settings/models/watch", btn(view.watch.enabled ? "Turn off" : "Turn on", { sm: true, type: "submit" }), { hidden: { enabled: view.watch.enabled ? "0" : "1" } }), "inline")}`
    : note(`Checked ${when(view.watch.checkedAt)}.`);
  const fresh = view.fresh.length === 0 ? "" : sec("new", "New models", "", view.fresh.map(model => formRow(model.name, `${priceWords(model)}${model.releasedAt === null ? "" : ` · released ${model.releasedAt.slice(0, 10)}`}`, chip("New", "", { dot: false }), "inline")));
  const chat = view.chat === null ? "" : formRow("Chat", view.chat.words, btn("Change", { sm: true, variant: "ghost", href: "/settings/lead" }), "inline");
  const body = html`<div class="models">${outcome}${preview}${choiceSection(view, manage, previewing)}${recentSection(view)}${sec("tools", "AI tools on this computer", "", html`${tools}${checks}`)}${fresh}${chat}</div>`;
  return settingsShell({ group: "agents", sub: true, title: "Models", lead: "Which model plans, builds and reviews each task. Changes apply to tasks filed from now on.", body });
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

/** What is in use and the one choice (a preset, previewed before it applies); the model for each role behind a
 * disclosure, saved with one step-up; how tasks are sized, on demand. */
function choiceSection(view: ModelsView, manage: boolean, previewing: boolean): Html {
  const inUse = view.inUse === null ? "a custom set" : view.inUse;
  const scopes = view.scope.options.length < 2 ? "" : formRow("Settings for", "A project can follow these or choose its own.", html`<form method="get" action="/settings/models" class="models-scope">\
<span class="k-selw wide"><select class="k-sel" id="models-scope" name="scope" aria-label="Settings for">${view.scope.options.map(one => html`<option value="${one.value}"${one.value === view.scope.value ? html` selected` : ""}>${one.label}</option>`)}</select></span>${btn("Show", { sm: true, type: "submit" })}</form>`);
  const unresolved = view.unresolved === null ? "" : notice(`New tasks can't be filed here yet: ${view.unresolved}`);
  const current = view.preview?.hidden["preset"] ?? view.presets.find(one => one.inUse)?.name ?? "";
  const presetItems = view.presets.map(one => ({ value: one.name, label: one.label, text: `${one.words}${one.recommended ? " Recommended." : ""}${one.inUse ? " In use." : ""}` }));
  const presets = manage
    ? html`<form method="get" action="/settings/models" class="models-presets" id="models-preset">${view.scope.value === "installation" ? "" : html`<input type="hidden" name="scope" value="${view.scope.value}">`}\
${radios({ name: "preset", legend: "Preset", current, items: presetItems })}${acts(btn("Review changes", { variant: previewing ? "outline" : "primary", type: "submit", docked: !previewing }))}</form>`
    : factList(view.presets.map(one => [one.label, `${one.words}${one.inUse ? " In use." : ""}`] as const));
  const newer = view.newer.length === 0 ? "" : html`${group("Newer models")}${view.newer.map(one => formRow(one.name, `Newer than ${one.from}, used by ${one.roles}.`,
    manage ? btn("Switch to it", { sm: true, href: `/settings/models?switch=${encodeURIComponent(one.from)}&to=${encodeURIComponent(one.to)}${scopeQuery(view)}` }) : html``, "inline"))}`;
  const main = view.roles.filter(role => !role.tier), tiers = view.roles.filter(role => role.tier);
  const rows = html`${main.map(role => roleRow(role, manage))}${tiers.length === 0 ? "" : html`${group("By task size")}${tiers.map(role => roleRow(role, manage))}`}`;
  const editor = manage
    ? postForm("/settings/models/agent", html`${rows}${note(`Approved and waiting tasks keep the models they were filed with. ${termsOf("step-up", factsOf(view))}`)}${password(view, "models-agent-pw")}${acts(btn("Save models", { type: "submit" }))}`,
      { attrs: { class: "models-editor" }, hidden: { scope: view.scope.value, digest: view.scope.digest } })
    : html`<div class="models-editor">${rows}</div>`;
  const docked = !manage || previewing ? "" : dock(btn("Review changes", { variant: "primary", type: "submit", attrs: { form: "models-preset" } }));
  return html`${sec("choice", "Models for new tasks", `in use: ${inUse}${view.scope.value === "installation" ? "" : ` · ${view.scope.label}`}`, html`${scopes}${unresolved}${presets}${newer}`)}\
${disclose("Model for each role", editor)}${sizingSection(view)}${docked}`;
}

/** A preset or a switch shows exactly what it changes, and applies only with a second, step-up submit. */
function previewSection(view: ModelsView, manage: boolean): Html | "" {
  const preview = view.preview;
  if (preview === null || !manage) return "";
  if (preview.rows.length === 0) return sec("preview", preview.title, "", html`<p class="k-note" role="status">Already in use. Nothing would change.</p>${acts(btn("Back", { sm: true, href: back(view) }))}`);
  const rows = factList(preview.rows.map(row => [row.role, html`<span class="k-mono">${row.before}</span> → <span class="k-mono">${row.after}</span>${row.notes.length === 0 ? "" : html`<br><span class="k-note">${row.notes.join(" ")}</span>`}`] as const));
  const label = `Apply ${preview.rows.length} change${preview.rows.length === 1 ? "" : "s"}`;
  const form = postForm("/settings/models/apply", html`${note(`Tasks filed from now on use these. ${termsOf("step-up", factsOf(view))}`)}${password(view, "models-apply-pw")}${acts(btn(label, { variant: "primary", type: "submit", docked: true }), btn("Cancel", { variant: "ghost", href: back(view) }))}`,
    { hidden: preview.hidden, attrs: { id: "models-apply", class: "models-editor" } });
  return html`<div class="models-diff">${sec("preview", preview.title, "", html`${rows}${form}`)}</div>${dock(btn(label, { variant: "primary", type: "submit", attrs: { form: "models-apply" } }))}`;
}

/** How a task's size is decided, in plain words, and what routing does at filing; on demand. */
function sizingSection(view: ModelsView): Html {
  const waiting = view.waiting.length === 0 ? "" : html`<p>${view.waiting.length} plan${view.waiting.length === 1 ? "" : "s"} waiting for approval keep the models they were filed with: ${view.waiting.map((one, index) => html`${index === 0 ? "" : ", "}<a class="k-link" href="/t/${encodeURIComponent(one.taskId)}">${one.title}</a>`)}.</p>`;
  return disclose("How tasks are sized", html`<div class="models-sizing"><p>Each task is sized once, when it is filed. ${view.sizing.classifier} If it doesn't answer within 5 seconds, the size comes from the description.</p>${factList([
    ["Small", `${view.sizing.small}. Built by the builder for small tasks, with no plan.`],
    ["Routine", `${view.sizing.routine}. Planned and built by the planner and builder for routine tasks.`],
    ["Large or risky", `Large: ${view.sizing.large}. Risky: ${view.sizing.risky} Planned and built by the large or risky models.`],
  ])}<p>${view.routing}</p><p>Changing a model never re-sizes or re-routes a task that was already filed. One exception: an older build review saved without its own route uses the reviewer set here now.</p>${waiting}</div>`);
}

/** The model each recent run was set to, next to the model its provider reported. */
function recentSection(view: ModelsView): Html | "" {
  if (view.recent.length === 0) return "";
  return sec("recent", "Recent work", "", view.recent.map(one => formRow(one.role, `Chosen ${one.chosen} → ran on ${one.ranOn}`, html`<a class="k-link k-mono" href="/t/${encodeURIComponent(one.taskId)}">${one.taskId}</a>`, "inline")));
}
