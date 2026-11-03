/**
 * New flow (Flows → New): describe it to the lead, or start from a template. Templates are rows grouped by what
 * they're for, each with its promise, its steps in order, what it needs and one "Use this"; the starter kits ("With
 * an agent"), the recipes ("One-time work") and the starter flows join them as groups. A template's page asks only
 * what it needs, previews in plain words what it will do and never do, and creates it: the same answers it previewed.
 * A template's tools show their marks and whether the project has them; one it lacks offers Connect first.
 */
import { brandMarkHtml } from "./brand-mark.js";
import { BLANK, GALLERY, GALLERY_GROUPS, galleryAdmitsAnyone, galleryDiagram, galleryToolsOf, OUTDATED_COMMANDS, SEND_RESULT, sendsAlready, type GalleryAnswers, type GalleryPreview, type GalleryTemplate, type GalleryTool } from "./flow-gallery.js";
import { choiceTargets, type FlowDefinition, type FlowStage } from "./flows.js";
import { html, joinHtml, postForm, type Html, type HtmlValue, reauth } from "./html.js";
import { acts, btn, chip, composer, count, disclose, doc, docHeader, dock, field, group, infoLine, input as kInput, note, notice, phoneHeader, segLinks, select, sendButton } from "./server/kit.js";

export const GALLERY_CSS = `.fl-new .k-sec{gap:12px}.fl-th{display:grid;justify-items:start;gap:10px}.fl-th .k-seg{flex-wrap:wrap}.fl-tsel{justify-self:stretch}.fl-tsel form{display:flex;gap:8px;margin:0}.fl-tsel .k-selw{flex:1}` +
  `.fl-tlist{display:grid}.fl-tlist .k-grp{padding:0;margin-top:16px}.fl-tlist .k-grp:first-child{margin-top:0}` +
  `.fl-trow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px 0;border-bottom:1px solid var(--so-line)}` +
  `.fl-tmain{display:grid;gap:3px;min-width:0}.fl-tmain>b{font:500 13.5px/1.35 var(--so-font-sans);color:var(--so-ink)}.fl-tp{color:var(--so-muted);font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}` +
  `.fl-tline{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:12px;margin-top:3px;color:var(--so-muted);min-width:0;overflow-wrap:anywhere}.fl-ta .k-btn{min-width:108px}.fl-ta form{margin:0}` +
  // A template's steps in order, joined by arrows.
  `.gallery-steps{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 6px;list-style:none;padding:0;margin:0;font-size:12px;line-height:1.5;color:var(--so-ink)}` +
  `.gallery-steps li{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}.gallery-steps li>span[aria-hidden]{color:var(--so-muted)}.gallery-steps b{font-weight:500}` +
  `.gallery-tools{display:inline-flex;flex-wrap:wrap;gap:4px 10px;list-style:none;padding:0;margin:0}.gallery-tools li{display:inline-flex;align-items:center;gap:6px;min-width:0}` +
  `.fl-blank{padding-top:4px}.fl-describe-note{margin-top:2px}` +
  // A template's page: the tools to connect, the form, and what it will do.
  `.fl-use form{display:grid;gap:18px;margin:0}.fl-tool{display:grid;gap:10px;padding:12px 0;border-top:1px solid var(--so-line)}.fl-tool:last-child{border-bottom:1px solid var(--so-line)}.fl-tool form{gap:10px}` +
  `.fl-tool-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-size:13px;font-weight:500}.fl-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;font-weight:500;cursor:pointer}.fl-check input{margin-top:3px;width:16px;height:16px;flex:none}.fl-check .k-note{display:block;font-weight:400}` +
  `.fl-will{display:grid;gap:10px;padding:16px 0;border-top:1px solid var(--so-line);border-bottom:1px solid var(--so-line)}.fl-will ul{margin:0;padding-left:18px;font-size:13px;line-height:1.55}.fl-will ol{margin:6px 0 0;padding-left:20px;white-space:pre-line;font-size:12.5px;line-height:1.5;color:var(--so-muted)}.fl-will li{overflow-wrap:anywhere}.fl-never{margin:0;font-size:13px;font-weight:600}` +
  `@media(max-width:760px){.fl-page .k-btn.k-docked,.fl-new .k-btn.k-docked,.fl-use .k-btn.k-docked,.fl-kit .k-btn.k-docked{display:none}.fl-trow{grid-template-columns:minmax(0,1fr);gap:10px;padding:14px 0}.fl-ta .k-btn{width:100%}.fl-ta:empty{display:none}.fl-check input{width:20px;height:20px}}`;

/** A flow's main path, as a person reads it: from the start, each step's first way on (a sort's first answer, a choose's
 * first option that goes somewhere, else next; a check's failure when passing just ends), never back to a step shown. */
export function mainPath(definition: FlowDefinition): FlowStage[] {
  const byId = new Map(definition.stages.map(one => [one.id, one]));
  const path: FlowStage[] = [];
  for (let at = byId.get(definition.start); at !== undefined && at.kind !== "done" && !path.includes(at);) {
    path.push(at);
    const ways = [...(at.sort?.answers.map(one => one.to) ?? []), ...choiceTargets(at), at.next, ...(at.routes?.map(one => one.to) ?? [])].map(id => id === null ? undefined : byId.get(id));
    if (at.kind === "check") ways.push(at.onFail === null ? undefined : byId.get(at.onFail));
    at = at.kind === "check" ? ways.find(one => one !== undefined && one.kind !== "done") : ways.find(one => one !== undefined);
  }
  return path;
}

/** A step's short name in the strip: a person's own steps from their side. */
const stepName = (stage: FlowStage) => stage.kind === "choose" ? "You choose" : stage.kind === "approval" ? "You approve" : stage.kind === "send" ? "Sent to you" : stage.title;

/** A flow's steps in order, joined by arrows. */
export function stepStrip(definition: FlowDefinition): Html {
  return html`<ol class="gallery-steps" aria-label="Steps">${mainPath(definition).map((one, i) => {
    const name = stepName(one);
    return html`<li>${i === 0 ? "" : html`<span aria-hidden="true">→</span>`}${one.kind === "choose" || one.kind === "approval" ? html`<b>${name}</b>` : name}</li>`;
  })}</ol>`;
}

/** What a template needs, in words: its needs, else its tools, else nothing to connect. */
const needsWords = (template: GalleryTemplate): string => template.needs.length > 0 ? `Needs ${template.needs.join(", ")}` : (template.tools ?? []).length > 0 ? "" : "Nothing to connect";

/** A tool's state in words, as Settings → Integrations says it; nothing without a project. */
const STATE: Record<NonNullable<GalleryTool["state"]>, string> = { connected: "Connected", open: "Not connected", taken: "Added another way" };
const toolState = (tool: GalleryTool): Html | "" => tool.state === null ? "" : chip(STATE[tool.state], tool.state === "connected" ? "done" : "", { dot: tool.state === "connected" });
const toolMark = (tool: GalleryTool) => brandMarkHtml(tool.id.replace(/-desktop$/, ""), tool.label, tool.state === "connected");
const toolsList = (tools: readonly GalleryTool[]): Html | "" => tools.length === 0 ? ""
  : html`<ul class="gallery-tools" aria-label="Tools">${tools.map(one => html`<li data-tool="${one.id}" data-state="${one.state ?? "unknown"}">${toolMark(one)}<span>${one.label}${one.state === "open" ? " (not connected)" : ""}</span></li>`)}</ul>`;

/** One row of New flow: name · promise · one line · one outline action (the same shape for templates, kits, recipes and starters). */
export function templateRow(options: { name: string; promise: string; line?: HtmlValue; action?: HtmlValue; attrs?: Html }): Html {
  return html`<div class="fl-trow"${options.attrs ?? ""}><div class="fl-tmain"><b>${options.name}</b><span class="fl-tp">${options.promise}</span>${options.line ? html`<span class="fl-tline">${options.line}</span>` : ""}</div><div class="fl-ta">${options.action ?? ""}</div></div>`;
}

/** The groups New flow filters by: the template groups, then kits, recipes and starter flows. */
export const NEW_FLOW_GROUPS: ReadonlyArray<readonly [key: string, label: string]> = [["all", "All"], ...GALLERY_GROUPS.map(one => [one.id, one.label] as const), ["kits", "With an agent"], ["recipes", "One-time work"], ["starters", "Starter flows"]];

/** The templates as rows, grouped (or one group): each with one "Use this". `repo` carries a chosen project to the template's page. */
export function galleryHtml(input: { repo: string | null; canUse: boolean; connections?: readonly { id: string; state: "connected" | "open" | "taken" }[] | null; group?: string }): Html {
  const href = (id: string) => `/flows/new/${id}${input.repo === null ? "" : `?repo=${encodeURIComponent(input.repo)}`}`;
  const rowOf = (template: GalleryTemplate) => {
    const definition = galleryDiagram(template);
    const needs = needsWords(template);
    return templateRow({ name: template.name, promise: template.promise, attrs: html` data-template="${template.id}"`,
      line: html`${stepStrip(definition)}${toolsList(galleryToolsOf(template, definition, input.repo === null ? null : input.connections ?? null))}${needs ? html`<span>· ${needs}</span>` : ""}`,
      action: input.canUse ? btn("Use this", { sm: true, href: href(template.id), attrs: { "aria-label": `Use ${template.name}` } }) : "" });
  };
  const shown = GALLERY_GROUPS.filter(one => input.group === undefined || input.group === "all" || input.group === one.id);
  return html`${shown.map(one => { const templates = GALLERY.filter(template => template.group === one.id); return html`${group(one.label, count(templates.length))}<div data-group="${one.id}">${templates.map(rowOf)}</div>`; })}`;
}

/**
 * New flow: describe it (the shared composer; the words go to the lead as a chat draft, the project on its bar), then
 * start from a template, filtered by group. Kits, recipes and starter flows arrive as their own rows.
 */
export function newFlowHtml(input: {
  repo: string | null; projects: readonly { path: string; name: string }[]; canUse: boolean; group: string;
  connections: readonly { id: string; state: "connected" | "open" | "taken" }[] | null;
  ask: { value: string; error: string | null }; kits: Html; recipes: Html; starters: Html; said: string | null; problem: string | null;
}): Html {
  const groupKey = NEW_FLOW_GROUPS.some(([key]) => key === input.group) ? input.group : "all";
  const keep = (key: string) => `/flows/new?${new URLSearchParams({ ...(key === "all" ? {} : { group: key }), ...(input.repo === null ? {} : { repo: input.repo }) }).toString()}`.replace(/\?$/, "");
  const current = input.projects.find(one => one.path === input.repo)?.name ?? input.projects[0]?.name ?? "";
  const describe = input.canUse ? html`<section class="k-sec" aria-labelledby="fl-dh"><h3 id="fl-dh">Describe what you want</h3>\
<form method="get" action="/flows/new" id="fl-ask-form">${composer({ id: "fl-ask", name: "describe", label: "What should happen", rows: 3, value: input.ask.value, error: input.ask.error,
    placeholder: "Every night, run npm run e2e. When it fails, find the cause, fix it and open a pull request.",
    project: { current, items: input.projects.map(one => one.name), name: "project" }, send: sendButton({ label: "Draft the flow" }),
    note: "Opens in chat: your lead drafts it for you to check. Nothing runs until you create it." })}</form></section>` : "";
  const show = (key: string) => groupKey === "all" || groupKey === key;
  const filter = html`<span class="k-desk-only">${segLinks("Templates", groupKey, NEW_FLOW_GROUPS.map(([key, label]) => ({ key, label, href: keep(key) })))}</span>\
<span class="k-phone-only fl-tsel"><form method="get" action="/flows/new">${input.repo === null ? "" : html`<input type="hidden" name="repo" value="${input.repo}">`}${select({ name: "group", label: "Templates", items: NEW_FLOW_GROUPS, current: groupKey, wide: true, attrs: { "data-k-autosubmit": "" } })}<noscript>${btn("Show", { sm: true, type: "submit" })}</noscript></form></span>`;
  const templates = GALLERY_GROUPS.some(one => show(one.id)) ? galleryHtml({ repo: input.repo, canUse: input.canUse, connections: input.connections, group: groupKey }) : "";
  const blank = input.canUse && groupKey === "all" ? html`<p class="k-note fl-blank"><a href="/flows/new/${BLANK.id}${input.repo === null ? "" : `?repo=${encodeURIComponent(input.repo)}`}">Start from a blank flow</a></p>` : "";
  const list = html`${templates}${show("kits") ? input.kits : ""}${show("recipes") ? input.recipes : ""}${show("starters") ? input.starters : ""}${blank}`;
  const said = input.problem ? notice(input.problem) : input.said ? infoLine(input.said) : "";
  return html`<div class="fl-new" data-kit-page>${phoneHeader("New flow", { back: "/flows" })}${doc(
    docHeader({ title: "New flow", back: ["/flows", "Flows"], meta: input.canUse ? "Describe it in a sentence, or start from a template." : "An approver creates flows.", same: true }),
    said, describe,
    html`<section class="k-sec" aria-labelledby="fl-th"><div class="fl-th"><h3 id="fl-th">Start from a template</h3>${filter}</div><div class="fl-tlist">${list}</div></section>`)}\
${input.canUse ? dock(btn("Draft the flow", { variant: "primary", type: "submit", attrs: { form: "fl-ask-form" } })) : ""}</div>`;
}

/** A template's page, a reading page: its steps and tools, its questions, what it will do and never do, then Create. */
export function galleryUseHtml(input: {
  template: GalleryTemplate; projects: readonly { path: string; name: string }[]; repo: string; answers: GalleryAnswers; name: string;
  preview: GalleryPreview | null; problem: string | null; csrf: string; diagram: FlowDefinition | null;
  /** The template's tools in this project; `said` is how the last Connect went. */
  tools?: readonly GalleryTool[]; said?: string | null;
}): Html {
  const { template } = input;
  const tools = input.tools ?? input.preview?.tools ?? [];
  // A tool added another way is there: only one the project lacks is missing.
  const missing = tools.filter(one => one.state !== "connected" && one.state !== "taken");
  // Each tool with its state; one the project lacks offers its own Connect (the Tools page's, with the same password), and comes back here.
  const connect = (tool: GalleryTool) => {
    const head = html`<p class="fl-tool-h">${toolMark(tool)} ${tool.label} ${toolState(tool)}</p>`;
    // Added another way, it is there: nothing to connect.
    if (tool.state === "connected" || tool.state === "taken" || input.csrf === "") return html`<div class="fl-tool" data-tool="${tool.id}" data-state="${String(tool.state)}">${head}</div>`;
    const how = tool.id === "figma-desktop" ? "Open the Figma desktop app and turn on its Dev Mode MCP server in Preferences." : `You sign in on ${tool.label}, then come back here.`;
    const fieldId = `fl-connect-${tool.id}`;
    return html`<div class="fl-tool" data-tool="${tool.id}" data-state="open">${head}${postForm("/settings/tools/connect",
      html`${note(how)}${reauth(field({ id: fieldId, label: "Your Toolroll password", control: kInput({ id: fieldId, name: "password", type: "password", attrs: { autocomplete: "current-password", required: true } }) }))}${acts(btn(`Connect ${tool.label}`, { type: "submit", attrs: { name: "service", value: tool.id } }))}`,
      { hidden: { repo: input.repo, shown: input.repo, template: template.id } })}</div>`;
  };
  const toolsBlock = tools.length === 0 ? "" : html`<section class="k-sec" aria-label="Tools"><h3>Tools</h3><div>${tools.map(connect)}</div></section>`;
  // Made without a tool, the preview names the zone that needs it.
  const zones = (tool: GalleryTool) => joinHtml(tool.zones.map(zone => html`“${zone}”`), " and ");
  const needing = html`${missing.filter(one => one.zones.length > 0).map(one => html`<p class="k-note" data-needs-tool="${one.id}">${zones(one)} need${one.zones.length === 1 ? "s" : ""} ${one.label}, which isn't connected.</p>`)}${tools.filter(one => one.state === "taken" && one.zones.length > 0).map(one => html`<p class="k-note" data-tool-taken="${one.id}">${zones(one)} use${one.zones.length === 1 ? "s" : ""} ${one.label}, added another way.</p>`)}`;
  const ask = (one: GalleryTemplate["asks"][number], index: number) => {
    const value = input.answers[one.key] ?? one.default;
    const id = `fl-ask-${index}`;
    if (one.key === "outdated") return field({ id, label: one.label, control: select({ id, name: "outdated", items: Object.entries(OUTDATED_COMMANDS).map(([key, command]) => [key, command.label] as const), current: value, wide: true }) });
    return field({ id, label: one.label, ...(one.hint === undefined ? {} : { hint: one.hint }), control: kInput({ id, name: one.key, value, hint: one.hint !== undefined,
      attrs: { required: true, maxlength: one.key === "command" ? 500 : one.key === "team" ? 12 : 100, ...(one.key === "command" ? { spellcheck: "false", autocapitalize: "off" } : one.key === "team" ? { spellcheck: "false", autocapitalize: "characters" } : {}) } }) });
  };
  const project = input.projects.length > 1
    ? field({ id: "fl-use-project", label: "Project", control: select({ id: "fl-use-project", name: "repo", items: input.projects.map(one => [one.path, one.name] as const), current: input.repo, wide: true }) })
    : html`<input type="hidden" name="repo" value="${input.repo}">`;
  const preview = input.preview === null ? "" : html`<section class="k-sec fl-will" aria-labelledby="fl-will"><h3 id="fl-will">What it will do</h3><ul>${input.preview.built.does.map(one => html`<li>${one}</li>`)}</ul><p class="fl-never">${input.preview.built.never}</p>${needing}\
${input.preview.startsFrom.length === 0 ? note("Cards start when you add them.") : input.preview.startsFrom.map(one => note(`Starts from: ${one}`))}${disclose("Every step", html`<ol>${input.preview.steps.map(one => html`<li>${one.replace(/^\d+\.\s/, "")}</li>`)}</ol>`)}</section>`;
  const sendResult = !sendsAlready(template) && html`<label class="fl-check"><input type="checkbox" name="${SEND_RESULT.key}" value="yes"${input.answers[SEND_RESULT.key] === "yes" && html` checked`} data-send-result><span>${SEND_RESULT.title}<span class="k-note">When a card finishes, what was done comes to you in your chat apps.</span></span></label>`;
  // A flow that brings in items from anyone takes the password to make (chat-management.md §0a.3): a step-up, which Passwordless stands in for.
  const anyone = input.preview !== null && galleryAdmitsAnyone(template);
  const step = anyone ? reauth(field({ id: "fl-use-password", label: "Your password", hint: "It brings in items from anyone.", control: kInput({ id: "fl-use-password", name: "password", type: "password", hint: true, attrs: { autocomplete: "current-password" } }) })) : "";
  const creates = input.preview !== null;
  const createButton = (docked: boolean) => btn("Create flow", { variant: missing.length > 0 ? "outline" : "primary", type: "submit", ...(docked ? { docked: true } : {}),
    attrs: { name: "intent", value: "create", ...(missing.length > 0 ? { "data-without-tools": "" } : {}) } });
  const actions = html`${step}${acts(creates ? createButton(true) : "", btn(creates ? "Update preview" : "Preview", { variant: creates ? "outline" : "primary", type: "submit", attrs: { name: "intent", value: "preview" } }))}${creates ? note(anyone ? "Creating it asks for your password: it brings in items from anyone." : "Creating it needs no password.") : ""}`;
  const form = postForm(`/flows/new/${template.id}`, html`${project}${template.asks.map(ask)}${field({ id: "fl-use-name", label: "Name", control: kInput({ id: "fl-use-name", name: "name", value: input.name, attrs: { maxlength: 80 } }) })}${sendResult}${preview}${actions}`,
    { attrs: { "data-gallery-use": true, id: "fl-use-form" }, hidden: { previewed: input.preview?.digest ?? "" } });
  const needs = needsWords(template);
  const steps = input.diagram === null && !needs ? "" : html`<section class="k-sec" aria-label="Steps">${input.diagram !== null && stepStrip(input.diagram)}${needs ? note(needs) : ""}</section>`;
  return html`<div class="fl-use" data-kit-page data-gallery-template="${template.id}">${phoneHeader(template.name, { back: "/flows/new" })}${doc(
    docHeader({ title: template.name, back: ["/flows/new", "New flow"], meta: template.promise, same: true }),
    input.problem !== null ? notice(input.problem) : "", input.said ? infoLine(input.said) : "", steps, toolsBlock, form)}\
${creates ? dock(btn("Create flow", { variant: "primary", type: "submit", attrs: { form: "fl-use-form", name: "intent", value: "create" } })) : dock(btn("Preview", { variant: "primary", type: "submit", attrs: { form: "fl-use-form", name: "intent", value: "preview" } }))}</div>`;
}
