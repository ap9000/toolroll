/**
 * The flow gallery in the console (Flows → New and Settings → Flows): cards grouped by what they're for, each with
 * its promise, its steps in order, what it needs and "Use this". A template's page asks only what it
 * needs, previews in plain words what it will do and never do, and creates it — the same answers it previewed.
 * A template's tools show their marks and whether the project has them; one it lacks offers Connect first.
 */
import { brandMarkHtml } from "./brand-mark.js";
import { BLANK, GALLERY, GALLERY_GROUPS, galleryDiagram, galleryToolsOf, OUTDATED_COMMANDS, SEND_RESULT, sendsAlready, type GalleryAnswers, type GalleryPreview, type GalleryTemplate, type GalleryTool } from "./flow-gallery.js";
import { choiceTargets, type FlowDefinition, type FlowStage } from "./flows.js";
import { html, joinHtml, postForm, type Html } from "./html.js";

export const GALLERY_CSS = `.gallery{max-width:1120px;min-width:0}.gallery h2{margin:28px 0 10px;font-size:.9375rem}.gallery h2:first-of-type{margin-top:8px}` +
  `.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}` +
  `.gallery-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--so-line);border-radius:10px;background:var(--so-paper);min-width:0}` +
  `.gallery-card h3{margin:0;font-size:.9375rem}.gallery-card p{margin:0;overflow-wrap:anywhere}.gallery-card .gallery-promise{line-height:1.5;flex:1}` +
  // A template's steps in order, joined by arrows; a person's own steps carry the attention chip.
  `.gallery-steps{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;list-style:none;padding:0;margin:0;font-size:12px;font-weight:500;line-height:1.5;color:var(--so-ink)}` +
  `.gallery-steps li{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}.gallery-steps li>span[aria-hidden]{color:var(--so-muted)}` +
  `.gallery-steps b{font-weight:500;font-size:11.5px;line-height:18px;padding:1px 6px;border-radius:5px;background:var(--so-signal-soft);color:var(--so-signal)}` +
  `.gallery-needs{display:flex;flex-wrap:wrap;gap:4px;list-style:none;padding:0;margin:0}.gallery-needs li{font-size:11.5px;font-weight:500;line-height:18px;padding:1px 6px;border-radius:5px;background:var(--so-neutral-soft,var(--so-raised));color:var(--so-neutral-ink,var(--so-muted))}` +
  // An outline action in a list (the Quiet List Rule), over the workspace's ink default for .button-link.
  `.gallery .gallery-card a.button-link{align-self:flex-start;min-height:36px;background:var(--so-paper);color:var(--so-ink);border:1px solid var(--so-input-line)}` +
  `.gallery-blank{margin-top:20px}` +
  // A template's tools: the mark Settings → Integrations shows, its name and where the project stands.
  `.gallery-tools{display:grid;gap:6px;list-style:none;padding:0;margin:0}.gallery-tools li{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}.gallery-tools li>span:not(.brand-mark){min-width:0;overflow-wrap:anywhere}` +
  `.gallery-tools strong{font-weight:500;overflow-wrap:anywhere}.gallery-connect{display:grid;gap:10px;padding:12px 0;border-top:1px solid var(--so-line)}.gallery-connect:last-child{border-bottom:1px solid var(--so-line);margin-bottom:4px}` +
  `.gallery-connect form{display:grid;gap:8px;margin:0}.gallery-connect p{margin:0;overflow-wrap:anywhere}.gallery-connect .gallery-tool-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.gallery-connect button{justify-self:start;min-height:36px;white-space:nowrap;background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}` +
  `.gallery-use{max-width:720px;min-width:0}.gallery-use .gallery-steps{margin:4px 0 12px}.gallery-use form{display:grid;gap:12px;margin:0}.gallery-use label{display:grid;gap:4px;font-weight:500}` +
  `.gallery-use label small{font-weight:400;color:var(--so-muted)}.gallery-use label.gallery-check{display:flex;align-items:flex-start;gap:8px;font-weight:500}.gallery-use label.gallery-check input{margin-top:3px;width:16px;height:16px;min-height:0;flex:none}.gallery-use label.gallery-check small{display:block}` +
  `.gallery-use input:not([type=hidden]),.gallery-use select{box-sizing:border-box;width:100%;max-width:100%;min-height:32px;padding:0 10px;border:1px solid var(--so-input-line);border-radius:8px;background:var(--so-paper);color:var(--so-ink);font:inherit}` +
  `.gallery-preview{display:grid;gap:8px;padding:16px;border:1px solid var(--so-line);border-radius:10px;background:var(--so-paper);min-width:0}.gallery-preview h2{margin:0;font-size:.9375rem}` +
  `.gallery-preview ul{margin:0;padding-left:18px;line-height:1.55}.gallery-preview p{margin:0;overflow-wrap:anywhere}.gallery-preview .gallery-never{font-weight:600}` +
  `.gallery-preview details ol{margin:6px 0 0;padding-left:20px;white-space:pre-line;font-size:.875rem;line-height:1.5;color:var(--so-muted)}.gallery-preview details li{margin:0 0 6px;overflow-wrap:anywhere}` +
  `.gallery-preview summary{cursor:pointer;min-height:36px;display:flex;align-items:center;font-weight:500}` +
  `.gallery-actions{display:flex;flex-wrap:wrap;gap:8px;margin:0}.gallery-actions button{min-height:36px;white-space:nowrap}` +
  `.gallery-use .gallery-actions button[value=create]:not(.secondary){background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}.gallery-heading{margin:36px 0 0;font-size:1.05rem}` +
  `@media(max-width:760px){.gallery-grid{grid-template-columns:minmax(0,1fr)}.gallery-connect button{min-height:44px;justify-self:stretch}.gallery .gallery-card a.button-link{min-height:44px;align-self:stretch;justify-content:center}` +
  `.gallery-use input:not([type=hidden]),.gallery-use select{font-size:16px;min-height:44px}.gallery-actions button{flex:1 1 auto;min-height:44px}}`;

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

/** A flow's steps in order, joined by arrows; a person's decisions carry the accent. */
export function stepStrip(definition: FlowDefinition): Html {
  return html`<ol class="gallery-steps" aria-label="Steps">${mainPath(definition).map((one, i) => {
    const name = stepName(one);
    return html`<li>${i === 0 ? "" : html`<span aria-hidden="true">→</span>`}${one.kind === "choose" || one.kind === "approval" ? html`<b data-person>${name}</b>` : name}</li>`;
  })}</ol>`;
}

const needsList = (template: GalleryTemplate): Html | "" => template.needs.length === 0 ? (template.tools ?? []).length > 0 ? "" : html`<ul class="gallery-needs"><li>Nothing to connect</li></ul>`
  : html`<ul class="gallery-needs" aria-label="Needs">${template.needs.map(one => html`<li>${one}</li>`)}</ul>`;

/** A tool's state in words, as Settings → Integrations badges it; nothing without a project. */
const STATE: Record<NonNullable<GalleryTool["state"]>, [string, string]> = { connected: ["connected", "Connected"], open: ["not-set-up", "Not connected"], taken: ["not-set-up", "Added another way"] };
const toolState = (tool: GalleryTool): Html | "" => tool.state === null ? "" : html`<span class="integration-state integration-state--${STATE[tool.state][0]}"><i aria-hidden="true"></i>${STATE[tool.state][1]}</span>`;
const toolMark = (tool: GalleryTool) => brandMarkHtml(tool.id.replace(/-desktop$/, ""), tool.label, tool.state === "connected");
const toolsList = (tools: readonly GalleryTool[]): Html | "" => tools.length === 0 ? ""
  : html`<ul class="gallery-tools" aria-label="Tools">${tools.map(one => html`<li data-tool="${one.id}" data-state="${one.state ?? "unknown"}">${toolMark(one)}<strong>${one.label}</strong>${toolState(one)}</li>`)}</ul>`;

/** The gallery: every template, grouped, each with one "Use this". `repo` carries a chosen project to the template's page. */
export function galleryHtml(input: { repo: string | null; canUse: boolean; connections?: readonly { id: string; state: "connected" | "open" | "taken" }[] | null }): Html {
  const href = (id: string) => `/flows/new/${id}${input.repo === null ? "" : `?repo=${encodeURIComponent(input.repo)}`}`;
  const card = (template: GalleryTemplate) => {
    const definition = galleryDiagram(template);
    return html`<article class="gallery-card" data-template="${template.id}"><h3>${template.name}</h3><p class="gallery-promise">${template.promise}</p>${stepStrip(definition)}${toolsList(galleryToolsOf(template, definition, input.repo === null ? null : input.connections ?? null))}${needsList(template)}${input.canUse && html`<a class="button-link" href="${href(template.id)}" aria-label="Use ${template.name}">Use this</a>`}</article>`;
  };
  const groups = GALLERY_GROUPS.map(group => html`<h2 id="gallery-${group.id}">${group.label}</h2><div class="gallery-grid" data-group="${group.id}">${GALLERY.filter(one => one.group === group.id).map(card)}</div>`);
  return html`<section class="gallery">${groups}${input.canUse ? html`<p class="gallery-blank meta"><a href="${href(BLANK.id)}">Start from a blank flow</a></p>` : html`<p class="meta">An approver creates flows.</p>`}</section>`;
}

/** A template's page: its questions, then what it will do and never do, then Create. */
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
    const head = html`<p class="gallery-tool-head">${toolMark(tool)} <strong>${tool.label}</strong> ${toolState(tool)}</p>`;
    // Added another way, it is there: nothing to connect.
    if (tool.state === "connected" || tool.state === "taken" || input.csrf === "") return html`<div class="gallery-connect" data-tool="${tool.id}" data-state="${String(tool.state)}">${head}</div>`;
    const how = tool.id === "figma-desktop" ? "Open the Figma desktop app and turn on its Dev Mode MCP server in Preferences." : `You sign in on ${tool.label}, then come back here.`;
    return html`<div class="gallery-connect" data-tool="${tool.id}" data-state="open">${head}${postForm("/settings/tools/connect",
      html`<p class="meta">${how}</p><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label><button name="service" value="${tool.id}">Connect ${tool.label}</button>`,
      { hidden: { repo: input.repo, shown: input.repo, template: template.id } })}</div>`;
  };
  const toolsBlock = tools.length === 0 ? "" : html`<section class="gallery-tools-use" aria-label="Tools">${tools.map(connect)}</section>`;
  // Made without a tool, the preview names the zone that needs it.
  const zones = (tool: GalleryTool) => joinHtml(tool.zones.map(zone => html`“${zone}”`), " and ");
  const needing = html`${missing.filter(one => one.zones.length > 0).map(one => html`<p class="meta" data-needs-tool="${one.id}">${zones(one)} need${one.zones.length === 1 ? "s" : ""} ${one.label}, which isn't connected.</p>`)}${tools.filter(one => one.state === "taken" && one.zones.length > 0).map(one => html`<p class="meta" data-tool-taken="${one.id}">${zones(one)} use${one.zones.length === 1 ? "s" : ""} ${one.label}, added another way.</p>`)}`;
  const field = (ask: GalleryTemplate["asks"][number]) => {
    const value = input.answers[ask.key] ?? ask.default;
    const hint = ask.hint === undefined ? "" : html` <small>${ask.hint}</small>`;
    if (ask.key === "outdated") return html`<label>${ask.label}<select name="outdated">${Object.entries(OUTDATED_COMMANDS).map(([id, one]) => html`<option value="${id}"${id === value && html` selected`}>${one.label}</option>`)}</select></label>`;
    return html`<label>${ask.label}${hint}<input name="${ask.key}" value="${value}" required maxlength="${ask.key === "command" ? 500 : ask.key === "team" ? 12 : 100}"${ask.key === "command" ? html` spellcheck="false" autocapitalize="off"` : ask.key === "team" ? html` spellcheck="false" autocapitalize="characters"` : ""}></label>`;
  };
  const project = input.projects.length > 1
    ? html`<label>Project<select name="repo">${input.projects.map(one => html`<option value="${one.path}"${one.path === input.repo && html` selected`}>${one.name}</option>`)}</select></label>`
    : html`<input type="hidden" name="repo" value="${input.repo}">`;
  const preview = input.preview === null ? "" : html`<section class="gallery-preview" aria-labelledby="gallery-will"><h2 id="gallery-will">What it will do</h2><ul>${input.preview.built.does.map(one => html`<li>${one}</li>`)}</ul><p class="gallery-never">${input.preview.built.never}</p>${needing}${input.preview.startsFrom.length === 0 ? html`<p class="meta">Cards start when you add them.</p>` : input.preview.startsFrom.map(one => html`<p class="meta">Starts from: ${one}</p>`)}<details><summary>Every step</summary><ol>${input.preview.steps.map(one => html`<li>${one.replace(/^\d+\.\s/, "")}</li>`)}</ol></details></section>`;
  const sendResult = !sendsAlready(template) && html`<label class="gallery-check"><input type="checkbox" name="${SEND_RESULT.key}" value="yes"${input.answers[SEND_RESULT.key] === "yes" && html` checked`} data-send-result><span>${SEND_RESULT.title}<small>When a card finishes, what was done comes to you in your chat apps.</small></span></label>`;
  const actions = html`<p class="gallery-actions">${input.preview !== null && html`<button type="submit" name="intent" value="create"${missing.length > 0 && html` class="secondary" data-without-tools`}>Create flow</button>`}<button type="submit" name="intent" value="preview" class="secondary">${input.preview === null ? "Preview" : "Update preview"}</button></p>`;
  const form = postForm(`/flows/new/${template.id}`, html`${project}${template.asks.map(field)}<label>Name<input name="name" value="${input.name}" maxlength="80"></label>${sendResult}${preview}${actions}`,
    { attrs: { "data-gallery-use": true }, hidden: { previewed: input.preview?.digest ?? "" } });
  return html`<section class="gallery-use" data-gallery-template="${template.id}">${input.problem !== null && html`<p class="problem" role="alert">${input.problem}</p>`}${input.said ? html`<p role="status">${input.said}</p>` : ""}<p>${template.promise}</p>${input.diagram !== null && stepStrip(input.diagram)}${needsList(template)}${toolsBlock}${form}<p class="meta"><a href="/flows/new">All templates</a></p></section>`;
}
