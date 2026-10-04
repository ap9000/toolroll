/**
 * The flow gallery in the console (Flows → New and Settings → Flows): cards grouped by what they're for, each with
 * its promise, a small drawing of its zones, what it needs and "Use this". A template's page asks only what it
 * needs, previews in plain words what it will do and never do, and creates it — the same answers it previewed.
 * A template's tools show their marks and whether the project has them; one it lacks offers Connect first.
 */
import { brandMarkHtml } from "./brand-mark.js";
import { BLANK, GALLERY, GALLERY_GROUPS, galleryDiagram, galleryToolsOf, OUTDATED_COMMANDS, SEND_RESULT, sendsAlready, type GalleryAnswers, type GalleryPreview, type GalleryTemplate, type GalleryTool } from "./flow-gallery.js";
import { choiceTargets, type FlowDefinition } from "./flows.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const GALLERY_CSS = `.gallery{max-width:1120px;min-width:0}.gallery h2{margin:28px 0 10px;font-size:.9375rem}.gallery h2:first-of-type{margin-top:8px}` +
  `.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}` +
  `.gallery-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--so-line);border-radius:10px;background:var(--so-paper);min-width:0}` +
  `.gallery-card h3{margin:0;font-size:.9375rem}.gallery-card p{margin:0;overflow-wrap:anywhere}.gallery-card .gallery-promise{line-height:1.5;flex:1}` +
  `.gallery-zones{display:block;width:100%;height:56px;border-radius:8px;background:var(--so-raised)}.gallery-zones rect{fill:var(--so-paper);stroke:var(--so-input-line);stroke-width:1.5}` +
  `.gallery-zones rect[data-person="true"]{fill:var(--so-signal-soft,var(--so-raised));stroke:var(--so-ink)}.gallery-zones line{stroke:var(--so-input-line);stroke-width:1.5}` +
  `.gallery-needs{display:flex;flex-wrap:wrap;gap:4px;list-style:none;padding:0;margin:0}.gallery-needs li{font-size:11.5px;font-weight:500;line-height:18px;padding:1px 6px;border-radius:5px;background:var(--so-neutral-soft,var(--so-raised));color:var(--so-neutral-ink,var(--so-muted))}` +
  // An outline action in a list (the Quiet List Rule), over the workspace's ink default for .button-link.
  `.gallery .gallery-card a.button-link{align-self:flex-start;min-height:36px;background:var(--so-paper);color:var(--so-ink);border:1px solid var(--so-input-line)}` +
  `.gallery-blank{margin-top:20px}` +
  // A template's tools: the mark Settings → Integrations shows, its name and where the project stands.
  `.gallery-tools{display:grid;gap:6px;list-style:none;padding:0;margin:0}.gallery-tools li{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}.gallery-tools li>span:not(.brand-mark){min-width:0;overflow-wrap:anywhere}` +
  `.gallery-tools strong{font-weight:500;overflow-wrap:anywhere}.gallery-connect{display:grid;gap:10px;padding:12px 0;border-top:1px solid var(--so-line)}.gallery-connect:last-child{border-bottom:1px solid var(--so-line);margin-bottom:4px}` +
  `.gallery-connect form{display:grid;gap:8px;margin:0}.gallery-connect p{margin:0;overflow-wrap:anywhere}.gallery-connect .gallery-tool-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.gallery-connect button{justify-self:start;min-height:36px;white-space:nowrap;background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}` +
  `.gallery-use{max-width:720px;min-width:0}.gallery-use .gallery-zones{height:88px;margin:4px 0 12px}.gallery-use form{display:grid;gap:12px;margin:0}.gallery-use label{display:grid;gap:4px;font-weight:500}` +
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

/** A small drawing of a flow's zones where they sit on its canvas, with its paths; a person's decisions stand out. */
export function zonesDiagram(definition: FlowDefinition, label: string): string {
  const zones = definition.stages.map(one => one.zone);
  const minX = Math.min(...zones.map(one => one.x)), minY = Math.min(...zones.map(one => one.y));
  const maxX = Math.max(...zones.map(one => one.x + one.w)), maxY = Math.max(...zones.map(one => one.y + one.h));
  const pad = 40;
  const box = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  const centre = (id: string | null) => { const at = definition.stages.find(one => one.id === id)?.zone; return at === undefined ? null : { x: at.x + at.w / 2, y: at.y + at.h / 2 }; };
  const lines = definition.stages.flatMap(stage => [stage.next, ...(stage.sort?.answers.map(one => one.to) ?? []), ...(stage.routes?.map(one => one.to) ?? []), ...choiceTargets(stage)].map(to => {
    const from = centre(stage.id), end = centre(to);
    return from === null || end === null ? "" : `<line x1="${from.x}" y1="${from.y}" x2="${end.x}" y2="${end.y}" vector-effect="non-scaling-stroke"/>`;
  })).join("");
  const rects = definition.stages.map(one => `<rect x="${one.zone.x}" y="${one.zone.y}" width="${one.zone.w}" height="${one.zone.h}" rx="36" data-person="${one.kind === "approval" || one.kind === "choose"}" vector-effect="non-scaling-stroke"/>`).join("");
  return `<svg class="gallery-zones" viewBox="${box}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${e(label)}">${lines}${rects}</svg>`;
}

const needsList = (template: GalleryTemplate) => template.needs.length === 0 ? (template.tools ?? []).length > 0 ? "" : `<ul class="gallery-needs"><li>Nothing to connect</li></ul>`
  : `<ul class="gallery-needs" aria-label="Needs">${template.needs.map(one => `<li>${e(one)}</li>`).join("")}</ul>`;

/** A tool's state in words, as Settings → Integrations badges it; nothing without a project. */
const STATE: Record<NonNullable<GalleryTool["state"]>, [string, string]> = { connected: ["connected", "Connected"], open: ["not-set-up", "Not connected"], taken: ["not-set-up", "Added another way"] };
const toolState = (tool: GalleryTool) => tool.state === null ? "" : `<span class="integration-state integration-state--${STATE[tool.state][0]}"><i aria-hidden="true"></i>${STATE[tool.state][1]}</span>`;
const toolMark = (tool: GalleryTool) => brandMarkHtml(tool.id.replace(/-desktop$/, ""), tool.label, tool.state === "connected");
const toolsList = (tools: readonly GalleryTool[]) => tools.length === 0 ? ""
  : `<ul class="gallery-tools" aria-label="Tools">${tools.map(one => `<li data-tool="${e(one.id)}" data-state="${one.state ?? "unknown"}">${toolMark(one)}<strong>${e(one.label)}</strong>${toolState(one)}</li>`).join("")}</ul>`;

/** The gallery: every template, grouped, each with one "Use this". `repo` carries a chosen project to the template's page. */
export function galleryHtml(input: { repo: string | null; canUse: boolean; connections?: readonly { id: string; state: "connected" | "open" | "taken" }[] | null }): string {
  const href = (id: string) => `/flows/new/${id}${input.repo === null ? "" : `?repo=${encodeURIComponent(input.repo)}`}`;
  const card = (template: GalleryTemplate) => {
    const definition = galleryDiagram(template);
    return `<article class="gallery-card" data-template="${e(template.id)}"><h3>${e(template.name)}</h3><p class="gallery-promise">${e(template.promise)}</p>` +
      zonesDiagram(definition, `Zones: ${definition.stages.map(one => one.title).join(", ")}`) + toolsList(galleryToolsOf(template, definition, input.repo === null ? null : input.connections ?? null)) + needsList(template) +
      (input.canUse ? `<a class="button-link" href="${e(href(template.id))}" aria-label="Use ${e(template.name)}">Use this</a>` : "") + `</article>`;
  };
  const groups = GALLERY_GROUPS.map(group => `<h2 id="gallery-${group.id}">${e(group.label)}</h2><div class="gallery-grid" data-group="${group.id}">${GALLERY.filter(one => one.group === group.id).map(card).join("")}</div>`).join("");
  return `<section class="gallery">${groups}${input.canUse ? `<p class="gallery-blank meta"><a href="${e(href(BLANK.id))}">Start from a blank flow</a></p>` : `<p class="meta">An approver creates flows.</p>`}</section>`;
}

/** A template's page: its questions, then what it will do and never do, then Create. */
export function galleryUseHtml(input: {
  template: GalleryTemplate; projects: readonly { path: string; name: string }[]; repo: string; answers: GalleryAnswers; name: string;
  preview: GalleryPreview | null; problem: string | null; csrf: string; diagram: FlowDefinition | null;
  /** The template's tools in this project; `said` is how the last Connect went. */
  tools?: readonly GalleryTool[]; said?: string | null;
}): string {
  const { template } = input;
  const tools = input.tools ?? input.preview?.tools ?? [];
  // A tool added another way is there: only one the project lacks is missing.
  const missing = tools.filter(one => one.state !== "connected" && one.state !== "taken");
  // Each tool with its state; one the project lacks offers its own Connect (the Tools page's, with the same password), and comes back here.
  const connect = (tool: GalleryTool) => {
    const head = `<p class="gallery-tool-head">${toolMark(tool)} <strong>${e(tool.label)}</strong> ${toolState(tool)}</p>`;
    // Added another way, it is there: nothing to connect.
    if (tool.state === "connected" || tool.state === "taken" || input.csrf === "") return `<div class="gallery-connect" data-tool="${e(tool.id)}" data-state="${tool.state}">${head}</div>`;
    const how = tool.id === "figma-desktop" ? "Open the Figma desktop app and turn on its Dev Mode MCP server in Preferences." : `You sign in on ${tool.label}, then come back here.`;
    return `<div class="gallery-connect" data-tool="${e(tool.id)}" data-state="open">${head}<form method="post" action="/settings/tools/connect">` +
      `<input type="hidden" name="csrf" value="${e(input.csrf)}"><input type="hidden" name="repo" value="${e(input.repo)}"><input type="hidden" name="shown" value="${e(input.repo)}"><input type="hidden" name="template" value="${e(template.id)}">` +
      `<p class="meta">${e(how)}</p><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>` +
      `<button name="service" value="${e(tool.id)}">Connect ${e(tool.label)}</button></form></div>`;
  };
  const toolsBlock = tools.length === 0 ? "" : `<section class="gallery-tools-use" aria-label="Tools">${tools.map(connect).join("")}</section>`;
  // Made without a tool, the preview names the zone that needs it.
  const zones = (tool: GalleryTool) => tool.zones.map(zone => `“${e(zone)}”`).join(" and ");
  const needing = missing.filter(one => one.zones.length > 0).map(one => `<p class="meta" data-needs-tool="${e(one.id)}">${zones(one)} need${one.zones.length === 1 ? "s" : ""} ${e(one.label)}, which isn't connected.</p>`).join("") +
    tools.filter(one => one.state === "taken" && one.zones.length > 0).map(one => `<p class="meta" data-tool-taken="${e(one.id)}">${zones(one)} use${one.zones.length === 1 ? "s" : ""} ${e(one.label)}, added another way.</p>`).join("");
  const field = (ask: GalleryTemplate["asks"][number]) => {
    const value = input.answers[ask.key] ?? ask.default;
    const hint = ask.hint === undefined ? "" : ` <small>${e(ask.hint)}</small>`;
    if (ask.key === "outdated") return `<label>${e(ask.label)}<select name="outdated">${Object.entries(OUTDATED_COMMANDS).map(([id, one]) => `<option value="${id}"${id === value ? " selected" : ""}>${e(one.label)}</option>`).join("")}</select></label>`;
    return `<label>${e(ask.label)}${hint}<input name="${ask.key}" value="${e(value)}" required maxlength="${ask.key === "command" ? 500 : ask.key === "team" ? 12 : 100}"${ask.key === "command" ? ' spellcheck="false" autocapitalize="off"' : ask.key === "team" ? ' spellcheck="false" autocapitalize="characters"' : ""}></label>`;
  };
  const project = input.projects.length > 1
    ? `<label>Project<select name="repo">${input.projects.map(one => `<option value="${e(one.path)}"${one.path === input.repo ? " selected" : ""}>${e(one.name)}</option>`).join("")}</select></label>`
    : `<input type="hidden" name="repo" value="${e(input.repo)}">`;
  const preview = input.preview === null ? "" : `<section class="gallery-preview" aria-labelledby="gallery-will">` +
    `<h2 id="gallery-will">What it will do</h2><ul>${input.preview.built.does.map(one => `<li>${e(one)}</li>`).join("")}</ul>` +
    `<p class="gallery-never">${e(input.preview.built.never)}</p>${needing}` +
    (input.preview.startsFrom.length === 0 ? `<p class="meta">Cards start when you add them.</p>` : input.preview.startsFrom.map(one => `<p class="meta">Starts from: ${e(one)}</p>`).join("")) +
    `<details><summary>Every step</summary><ol>${input.preview.steps.map(one => `<li>${e(one.replace(/^\d+\.\s/, ""))}</li>`).join("")}</ol></details></section>`;
  return `<section class="gallery-use" data-gallery-template="${e(template.id)}">` +
    (input.problem === null ? "" : `<p class="problem" role="alert">${e(input.problem)}</p>`) + (input.said ? `<p role="status">${e(input.said)}</p>` : "") +
    `<p>${e(template.promise)}</p>${input.diagram === null ? "" : zonesDiagram(input.diagram, `Zones: ${input.diagram.stages.map(one => one.title).join(", ")}`)}${needsList(template)}${toolsBlock}` +
    `<form method="post" action="/flows/new/${e(template.id)}" data-gallery-use><input type="hidden" name="csrf" value="${e(input.csrf)}">` +
    `<input type="hidden" name="previewed" value="${e(input.preview?.digest ?? "")}">${project}${template.asks.map(field).join("")}` +
    `<label>Name<input name="name" value="${e(input.name)}" maxlength="80"></label>` +
    (sendsAlready(template) ? "" : `<label class="gallery-check"><input type="checkbox" name="${SEND_RESULT.key}" value="yes"${input.answers[SEND_RESULT.key] === "yes" ? " checked" : ""} data-send-result><span>${e(SEND_RESULT.title)}<small>When a card finishes, what was done comes to you in your chat apps.</small></span></label>`) + preview +
    `<p class="gallery-actions">${input.preview === null ? "" : `<button type="submit" name="intent" value="create"${missing.length > 0 ? ' class="secondary" data-without-tools' : ""}>Create flow</button>`}<button type="submit" name="intent" value="preview" class="secondary">${input.preview === null ? "Preview" : "Update preview"}</button></p>` +
    `</form><p class="meta"><a href="/flows/new">All templates</a></p></section>`;
}
