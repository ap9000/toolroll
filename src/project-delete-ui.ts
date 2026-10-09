/**
 * Settings → Project: what Toolroll holds for a project, and deleting
 * it. An instance operator deletes in two steps: type the project's name,
 * then read exactly what goes and confirm with their password (or a fresh
 * sign-in with the identity provider). The repository itself stays.
 */
import { holdingsWords, type ProjectHoldings } from "./project-delete.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PROJECT_DELETE_CSS = `.project-settings,.project-delete{max-width:720px;min-width:0}.project-settings .path,.project-delete .path{font-family:var(--font-mono);font-size:.8125rem;overflow-wrap:anywhere;word-break:break-all}` +
  `.project-settings details.danger-zone{margin-top:24px;border:1px solid var(--border);border-radius:10px;padding:0 14px}.project-settings details.danger-zone summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:500;color:var(--danger)}` +
  `.project-settings details.danger-zone[open]{padding-bottom:14px}.project-settings form,.project-delete form{display:grid;gap:12px;margin-top:12px}.project-settings label,.project-delete label{display:grid;gap:4px;font-size:.8125rem;font-weight:500}` +
  `.project-settings input,.project-delete input{max-width:100%;min-height:36px}.project-delete .removes{margin:12px 0;padding-left:20px}.project-delete .removes li{margin:2px 0}` +
  `.project-delete .actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.project-delete button.danger,.project-settings button.danger{background:var(--danger);color:#fff;border-color:var(--danger);white-space:nowrap}` +
  `.project-settings button,.project-delete button{justify-self:start;min-height:36px;white-space:nowrap}.project-delete .actions a{min-height:36px;display:inline-flex;align-items:center}` +
  `.project-settings .builds-at-once{margin-top:20px}.project-settings .builds-at-once h2{font-size:1rem;margin:0 0 4px}.project-settings .builds-at-once form{margin-top:4px;gap:4px}` +
  `.project-settings .builds-at-once .builds-row{display:flex;gap:8px;align-items:stretch}.project-settings .builds-at-once input{width:5.5rem;min-height:44px;margin:0;box-sizing:border-box}.project-settings .builds-at-once button{min-height:44px;margin:0}` +
  `.project-settings .builds-at-once .meta{margin:0}.project-settings form.remove-project{margin-top:20px;gap:4px}.project-settings form.remove-project button{min-height:44px}.project-settings form.remove-project .meta{margin:0}`;

export type ProjectSettingsView = {
  repo: string; name: string; holdings: ProjectHoldings; running: string[]; canDelete: boolean;
  /** How many of its tasks build at once: the saved number, what its worker allows, how many build now. */
  builds?: { setting: number; capacity: number | null; building: number; canChange: boolean };
};

/** Builds at once: one number, one Save. The worker's cap is said only when it lowers the number. */
function buildsHtml(view: ProjectSettingsView, csrf: string): string {
  const b = view.builds;
  if (b === undefined) return "";
  const capped = b.capacity !== null && b.capacity < b.setting ? ` Its worker runs ${b.capacity} at once, so ${b.capacity} for now.` : "";
  const now = `${b.building} building now.${capped}`;
  if (!b.canChange) return `<section class="builds-at-once"><h2>Builds at once</h2><p>Up to ${b.setting}. ${e(now)}</p></section>`;
  return `<section class="builds-at-once"><h2>Builds at once</h2><form method="post" action="/settings/project/concurrency">` +
    `<input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="repo" value="${e(view.repo)}">` +
    `<div class="builds-row"><input type="number" name="concurrency" min="1" max="64" step="1" inputmode="numeric" value="${b.setting}" aria-label="Builds at once" aria-describedby="builds-now"><button type="submit">Save</button></div>` +
    `<p class="meta" id="builds-now">${e(now)}</p></form></section>`;
}

const note = (notice: { said?: string | null; problem?: string | null }) =>
  notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : notice.said ? `<p role="status">${e(notice.said)}</p>` : "";

/** The project's page: its path, what Toolroll holds for it, and (for an instance operator) Delete project. */
export function projectSettingsHtml(view: ProjectSettingsView, csrf: string, notice: { said?: string | null; problem?: string | null }): string {
  const held = `<p>Toolroll holds ${e(holdingsWords(view.holdings))} for <strong>${e(view.name)}</strong>.</p>`;
  const head = `<section class="project-settings">${note(notice)}<p class="path">${e(view.repo)}</p>${held}${buildsHtml(view, csrf)}`;
  if (!view.canDelete) return `${head}<p class="meta">An instance operator can delete a project.</p></section>`;
  const body = view.running.length > 0
    ? `<p class="problem">Its work is running: ${e(view.running.join(", "))}. Stop it before deleting the project.</p>`
    : `<p>Removes everything Toolroll holds for ${e(view.name)}. The repository and its own branches stay. There's no undo.</p>` +
      `<form method="post" action="/settings/project/delete"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="repo" value="${e(view.repo)}">` +
      `<label><span>Type <strong>${e(view.name)}</strong> to continue</span><input name="name" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>` +
      `<button type="submit">Continue</button></form>`;
  // Removing is the reversible step: off the lists and the builder, everything kept.
  const remove = `<form class="remove-project" method="post" action="/projects/remove"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="repo" value="${e(view.repo)}">` +
    `<button type="submit">Remove from Toolroll</button><p class="meta">Its tasks and results stay saved. Add it again to bring it back.</p></form>`;
  return `${head}${remove}<details class="danger-zone"${notice.problem ? " open" : ""}><summary>Delete project</summary>${body}</details></section>`;
}

/** The second step: exactly what goes, and the password. */
export function projectDeleteConfirmHtml(view: ProjectSettingsView, csrf: string, problem: string | null): string {
  const h = view.holdings;
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const items = [
    `${count(h.tasks, "task")}${h.versions > 0 ? ` and ${count(h.versions, "version")}` : ""}, with ${count(h.runs, "run")} and their evidence`,
    "The checkouts and branches Toolroll made",
    ...(h.chats > 0 ? [count(h.chats, "chat")] : []),
    ...(h.flows > 0 ? [`${count(h.flows, "flow")} and ${count(h.cards, "card")}`] : []),
    ...(h.subagents > 0 ? [count(h.subagents, "subagent")] : []),
    "Its budgets, settings and knowledge",
  ];
  return `<section class="project-delete">${problem === null ? "" : `<p class="problem" role="alert">${e(problem)}</p>`}` +
    `<p>This removes:</p><ul class="removes">${items.map(one => `<li>${e(one)}</li>`).join("")}</ul>` +
    `<p>The repository at <span class="path">${e(view.repo)}</span> and its own branches stay. The ledger keeps its history. There's no undo.</p>` +
    `<form method="post" action="/settings/project/delete"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="repo" value="${e(view.repo)}"><input type="hidden" name="name" value="${e(view.name)}"><input type="hidden" name="step" value="delete">` +
    `<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label>` +
    `<div class="actions"><button type="submit" class="danger">Delete project</button><a href="/settings/project?repo=${e(encodeURIComponent(view.repo))}">Cancel</a></div></form></section>`;
}
