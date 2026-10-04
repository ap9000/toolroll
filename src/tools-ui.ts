/** Settings → Tools: one project's MCP servers, in plain words. Secrets are
 * entered here and nowhere else, and never shown again. */
import { toolCommandLine, toolStanding, type FoundTool, type ProjectTool, type ToolSpec } from "./project-tools.js";

const e = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hidden = (data: Record<string, string>) =>
  Object.entries(data).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join("");

export const TOOLS_CSS = `.tools{max-width:780px;min-width:0;overflow-wrap:anywhere}.tools .card{padding:16px 18px;margin:12px 0;min-width:0}.tools .card h2{font-size:1.05rem;margin:0;color:var(--so-ink);font-weight:600}.tools .tool-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.tools .tool-state{font-size:.85rem;flex-shrink:0;color:var(--so-muted)}.tools .tool-state[data-ready="false"]{color:var(--so-warning)}.tools .card>p{margin:6px 0 0}.tools code{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:.85rem}.tools form{display:grid;gap:10px;margin:0}.tools label{display:grid;gap:6px}.tools input,.tools select{box-sizing:border-box;width:100%;max-width:100%;min-width:0}.tools button{justify-self:start;white-space:nowrap;min-height:44px;max-width:100%;overflow:hidden;text-overflow:ellipsis}.tools details:not(.card){margin:6px 0 0;padding:0;border:0;border-radius:0;background:none;box-shadow:none}.tools details:not(.card)>summary{min-height:36px;display:flex;align-items:center;font-size:.9rem;color:var(--so-muted);cursor:pointer}.tools details:not(.card)[open]>summary{color:var(--so-ink)}.tools details.card>summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600}.tools summary{list-style:none;gap:10px}.tools summary::-webkit-details-marker{display:none}.tools summary::before{content:"";flex-shrink:0;width:6px;height:6px;margin:0 2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}.tools details[open]>summary::before{transform:rotate(45deg)}.tools details:not(.card) form{padding:4px 0 10px}.tools .tool-facts{margin:0 0 8px;display:grid;gap:4px;font-size:.9rem}.tools .tool-facts p{margin:0}.tools .tool-controls{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}.tools .tool-found{display:flex;gap:10px;align-items:flex-start}.tools .tool-found input{flex:0 0 auto;width:18px;height:18px;margin-top:3px}.tools .tool-found span{min-width:0}.tools .problem{padding:10px 12px;margin:8px 0 0}.tools .tool-connect{scroll-margin-top:72px}.tools .connect-wanted{background:var(--so-accent);color:var(--so-on-accent);border-color:var(--so-accent)}.tools .connect-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}.tools .connect-tile{display:grid;grid-template-columns:32px 1fr;column-gap:10px;align-items:center;justify-self:stretch;text-align:left;white-space:normal;padding:10px 12px;border:1px solid var(--so-line);border-radius:10px;background:var(--so-paper);color:var(--so-ink);min-height:60px;font:inherit;cursor:pointer;scroll-margin-top:96px}.tools .connect-tile:hover{border-color:var(--so-input-line);background:var(--so-raised)}.tools .connect-tile:target,.tools .connect-tile:focus-visible{outline:2px solid var(--so-accent);outline-offset:2px}.tools .connect-tile i{grid-row:span 2;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-style:normal;font-weight:600;background:var(--so-neutral-soft);color:var(--so-neutral-ink)}.tools .connect-tile strong{font-weight:600;line-height:1.3}.tools .connect-tile span{font-size:.8rem;color:var(--so-muted);line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.tools .connect-tile[data-state="connected"] span{color:var(--so-success)}.tools .connect-tile:disabled{cursor:default;opacity:.6}@media(max-width:600px){.tools .connect-grid{grid-template-columns:1fr 1fr}.tools .connect-tile span{display:none}.tools .connect-tile{grid-template-columns:28px 1fr;min-height:52px;padding:8px 10px}.tools .connect-tile i{grid-row:auto;width:28px;height:28px}.tools input,.tools select{font-size:16px}.tools .card{padding:14px}.tools .tool-heading{align-items:flex-start}}`;

export type ToolsView = {
  repo: string;
  project: string;
  /** Services connected by signing in, and the kit a Connect came from, if any. */
  connections: { id: string; label: string; about: string; state: "connected" | "open" | "taken" }[];
  kit: string | null;
  /** The service a link asked for (a kit's checklist, the lead): its own button under the password. */
  wanted: string | null;
  tools: { tool: ProjectTool; secretsSet: string[] }[];
  catalog: (ToolSpec & { label: string })[];
  found: FoundTool[];
  /** The person's other projects and the one-click services still open there: where a connection here can also go. */
  others?: { repo: string; project: string; open: string[] }[];
};

/** The project chooser: it opens the chosen project at once; without scripts, its button does. */
export function toolsProjectPicker(projects: readonly string[], chosen: string, keep: Record<string, string> = {}): string {
  if (projects.length < 2) return "";
  const options = projects.map(p => `<option value="${e(p)}"${p === chosen ? " selected" : ""}>${e(p.split(/[\\/]/).filter(Boolean).at(-1) ?? p)}</option>`).join("");
  return `<form class="tools" method="get" action="/settings/tools" data-autosave>${hidden(keep)}<label>Project<select name="repo" data-tools-project>${options}</select></label><button type="submit">Show project</button></form>`;
}

/** Choosing another project marks every form on the page as stale before it reloads, so a tap racing the reload is refused. */
export const TOOLS_PROJECT_SCRIPT = `(function(){var s=document.querySelector('select[data-tools-project]');if(!s)return;s.addEventListener('change',function(){document.querySelectorAll('input[name=shown]').forEach(function(i){i.value=s.value;});});})();`;

const password = '<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>';

function toolCard(one: { tool: ProjectTool; secretsSet: string[] }, base: Record<string, string>, manage: boolean, project: string): string {
  const { tool, secretsSet } = one;
  const standing = toolStanding(tool, secretsSet);
  // One line per secret: the disclosure is both where it stands and where it is set.
  const secrets = manage ? tool.spec.secrets.map(secret => {
    const set = secretsSet.includes(secret.name);
    return `<details><summary>${set ? `Replace ${e(secret.name)}` : `Set ${e(secret.name)}${secret.optional ? " (optional)" : ""}`}</summary><form method="post" action="/settings/tools/change">${hidden({ ...base, action: "secret", name: tool.name, secret: secret.name })}<label>${e(secret.name)}<input type="password" name="value" autocomplete="off" required></label>${password}<button>Save</button></form></details>`;
  }).join("") : "";
  const tested = tool.lastTest?.ok ? `<p>Tested ${e(tool.lastTest.at.slice(0, 16).replace("T", " "))} UTC: ${e(tool.lastTest.tools.join(", ") || "it lists no tools")}</p>` : "";
  const details = `<details><summary>Details</summary><div class="tool-facts"><p>Starts: <code>${e(toolCommandLine(tool.spec))}</code></p><p>From ${e(tool.source)} · added by ${e(tool.createdBy)}</p>${tested}</div></details>`;
  const failed = tool.lastTest !== null && !tool.lastTest.ok ? `<p class="problem" role="status">${e(tool.lastTest.problem ?? "The last test failed.")}</p>` : "";
  const controls = manage ? `<div class="tool-controls"><form method="post" action="/settings/tools/change">${hidden({ ...base, action: "test", name: tool.name })}<button aria-label="Test ${e(tool.name)} in ${e(project)}">Test</button></form><form method="post" action="/settings/tools/change">${hidden({ ...base, action: "remove", name: tool.name })}<button class="secondary">Remove from ${e(project)}</button></form></div>` : "";
  return `<article class="card" id="tool-${e(tool.name)}"><div class="tool-heading"><h2>${e(tool.name)}</h2><span class="tool-state" data-ready="${standing.ready}">${e(standing.words)}</span></div><p>${e(tool.spec.about)}</p>${failed}${secrets}${details}${controls}</article>`;
}

/** A service connected here, offered to the person's other projects: each button signs in again for that project (tokens are never copied). */
function elsewhere(view: ToolsView, base: Record<string, string>): string {
  const offers = view.connections.filter(one => one.state === "connected").flatMap(one =>
    (view.others ?? []).filter(other => other.open.includes(one.id)).map(other =>
      `<button name="also" value="${e(`${one.id}:${other.repo}`)}" class="secondary">Also connect ${e(one.label)} to ${e(other.project)}</button>`));
  if (offers.length === 0) return "";
  return `<details class="tool-elsewhere"><summary>Also connect to another project</summary><form method="post" action="/settings/tools/connect">${hidden({ ...base, ...(view.kit === null ? {} : { kit: view.kit }) })}${password}<div class="tool-controls">${offers.join("")}</div></form></details>`;
}

export function toolsHtml(view: ToolsView, csrf: string, canManage: boolean, message: { said?: string | null; problem?: string | null } = {}): string {
  const manage = canManage && csrf !== "";
  // `shown` is the project this page shows; the server refuses a post whose repo differs from it.
  const base = { csrf, repo: view.repo, shown: view.repo };
  const to = ` to ${e(view.project)}`;
  const intro = `<p>Builds in ${e(view.project)} use exactly these tools. MCP servers set up elsewhere on this computer aren't used.</p><details><summary>How tools work</summary><ul><li>A tool you add reaches work you approve from now on. Approve a task again to give it a new tool.</li><li>Removing a tool takes it away from every build right away.</li><li>Secrets stay on this computer, are never shown again, and go only to the tool that needs them.</li><li>Reviewers and the lead chat never get tools. Gemini builds don't use tools yet.</li></ul></details>`;
  const cards = view.tools.length === 0 ? '<p class="meta">No tools yet. Builds in this project get none.</p>' : view.tools.map(one => toolCard(one, base, manage, view.project)).join("");
  const fromList = view.catalog.length === 0 ? "" : `<form method="post" action="/settings/tools/change">${hidden({ ...base, action: "add-catalog" })}<label>Common tools<select name="catalog">${view.catalog.map(one => `<option value="${e(one.name)}">${e(one.label)}: ${e(one.about)}</option>`).join("")}</select></label>${password}<button>Add${to}</button></form>`;
  const custom = `<details><summary>Add your own</summary><form method="post" action="/settings/tools/change">${hidden({ ...base, action: "add-custom" })}<label>Name<input name="name" pattern="[a-z0-9][a-z0-9_\\-]{0,39}" maxlength="40" required placeholder="for example: postgres"></label><label>It runs as<select name="transport"><option value="stdio">A program on this computer</option><option value="http">A web address</option></select></label><label>Command or address<input name="target" required placeholder="npx -y some-mcp-server@1.2.3, or https://…"></label><label>Secrets it needs (names, comma separated)<input name="secrets" placeholder="for example: DATABASE_URL"></label><p class="meta">For a web address, the first secret is sent as its sign-in token. Set each secret's value after adding.</p>${password}<button>Add${to}</button></form></details>`;
  // One click: sign in on the service's own page. The password is the same as for adding any tool.
  const tiles = view.connections.map(one => one.state === "taken"
    ? `<button type="button" class="connect-tile" id="connect-${e(one.id)}" data-state="taken" disabled><i aria-hidden="true">${e(one.label.charAt(0))}</i><strong>${e(one.label)}</strong><span>Added another way</span></button>`
    : `<button name="service" value="${e(one.id)}" class="connect-tile" id="connect-${e(one.id)}" data-state="${one.state}" aria-label="${one.state === "connected" ? `${e(one.label)}, connected${to}. Sign in again` : `Connect ${e(one.label)}${to}`}"><i aria-hidden="true">${e(one.label.charAt(0))}</i><strong>${e(one.label)}</strong><span>${one.state === "connected" ? "Connected" : e(one.about)}</span></button>`).join("");
  const wanted = view.connections.find(one => one.id === view.wanted && one.state !== "taken");
  const first = wanted === undefined ? "" : `<button name="service" value="${e(wanted.id)}" class="connect-wanted">${wanted.state === "connected" ? `Sign in to ${e(wanted.label)} again for ${e(view.project)}` : `Connect ${e(wanted.label)}${to}`}</button>`;
  const connect = manage && view.connections.length > 0 ? `<section class="card tool-connect" id="connect" aria-labelledby="connect-heading"><h2 id="connect-heading">Connect${to}</h2><form method="post" action="/settings/tools/connect">${hidden({ ...base, ...(view.kit === null ? {} : { kit: view.kit }) })}${password}${first}<div class="connect-grid">${tiles}</div></form>${elsewhere(view, base)}</section>` : "";
  const add = manage ? `<details class="card"${view.tools.length === 0 ? " open" : ""}><summary>Add a tool</summary>${fromList}${custom}</details>` : "";
  const found = manage && view.found.length > 0 ? `<details class="card"><summary>Found on this computer (${view.found.length})</summary><p class="meta">MCP servers your other apps use. Adding one copies its settings, and any secrets it has, into this project.</p><form method="post" action="/settings/tools/change">${hidden({ ...base, action: "import" })}${view.found.map(one => `<label class="tool-found"><input type="checkbox" name="import" value="${e(one.spec.name)}"><span><strong>${e(one.spec.name)}</strong> · ${e(one.source)}<br><code>${e(toolCommandLine(one.spec))}</code>${one.spec.secrets.length === 0 ? "" : `<br><span class="meta">Brings ${e(one.spec.secrets.map(s => s.name).join(", "))}</span>`}</span></label>`).join("")}${password}<button>Add selected${to}</button></form></details>` : "";
  const note = message.problem ? `<p class="problem" role="alert">${e(message.problem)}</p>` : message.said ? `<p role="status">${e(message.said)}</p>` : "";
  return `<section class="tools">${note}${intro}${cards}${connect}${add}${found}</section>`;
}
