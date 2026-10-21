/**
 * Settings → Project: what Toolroll holds for a project, and deleting
 * it. An instance operator deletes in two steps: type the project's name,
 * then read exactly what goes and confirm with their password (or a fresh
 * sign-in with the identity provider). The repository itself stays.
 */
import type { ProjectNetwork } from "./egress.js";
import { html, postForm, type Html, reauth } from "./html.js";
import { holdingsWords, type ProjectHoldings } from "./project-delete.js";


export const PROJECT_DELETE_CSS = `.project-settings,.project-delete{max-width:720px;min-width:0}.project-settings .path,.project-delete .path{font-family:var(--font-mono);font-size:.8125rem;overflow-wrap:anywhere;word-break:break-all}` +
  `.project-settings details.danger-zone{margin-top:24px;border:1px solid var(--border);border-radius:10px;padding:0 14px}.project-settings details.danger-zone summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:500;color:var(--danger)}` +
  `.project-settings details.danger-zone[open]{padding-bottom:14px}.project-settings form,.project-delete form{display:grid;gap:12px;margin-top:12px}.project-settings label,.project-delete label{display:grid;gap:4px;font-size:.8125rem;font-weight:500}` +
  `.project-settings input,.project-delete input{max-width:100%;min-height:36px}.project-delete .removes{margin:12px 0;padding-left:20px}.project-delete .removes li{margin:2px 0}` +
  `.project-delete .actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.project-delete button.danger,.project-settings button.danger{background:var(--danger);color:#fff;border-color:var(--danger);white-space:nowrap}` +
  `.project-settings button,.project-delete button{justify-self:start;min-height:36px;white-space:nowrap}.project-delete .actions a{min-height:36px;display:inline-flex;align-items:center}` +
  `.project-settings .builds-at-once{margin-top:20px}.project-settings .builds-at-once h2{font-size:1rem;margin:0 0 4px}.project-settings .builds-at-once form{margin-top:4px;gap:4px}` +
  `.project-settings .builds-at-once .builds-row{display:flex;gap:8px;align-items:stretch}.project-settings .builds-at-once input{width:5.5rem;min-height:44px;margin:0;box-sizing:border-box}.project-settings .builds-at-once button{min-height:44px;margin:0}` +
  `.project-settings .builds-at-once .meta{margin:0}.project-settings form.remove-project{margin-top:20px;gap:4px}.project-settings form.remove-project button{min-height:44px}.project-settings form.remove-project .meta{margin:0}` +
  `.project-settings .build-access{margin-top:20px;min-width:0;overflow-wrap:anywhere}.project-settings .build-access h2{font:var(--so-typography-title-sm);margin:0 0 4px}.project-settings .build-access p{margin:0}` +
  `.project-settings .build-access .tool-name{font:var(--so-typography-mono)}.project-settings .build-access details{margin:4px 0 0}.project-settings .build-access summary{min-height:44px;display:inline-flex;align-items:center;cursor:pointer;color:var(--so-muted);font:var(--so-typography-label)}` +
  `.project-settings .build-access ul{margin:0 0 4px;padding-left:20px;font:var(--so-typography-body);color:var(--so-ink)}.project-settings .build-access li{margin:2px 0}.project-settings .build-access li .meta{color:var(--so-muted)}` +
  `.project-settings .build-access a.manage-tools{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:4px;padding:0 14px;white-space:nowrap;background:var(--so-paper);color:var(--so-ink);border:1px solid var(--so-input-line);border-radius:var(--so-radius-md);font:var(--so-typography-label);text-decoration:none}` +
  `.project-settings .build-access a.manage-tools:hover{background:var(--so-raised)}.project-settings .build-access a.manage-tools:focus-visible,.project-settings .build-access summary:focus-visible{outline:2px solid var(--so-ink);outline-offset:2px}`;

export type ProjectSettingsView = {
  remoteUrl?: string | null;
  repo: string; name: string; holdings: ProjectHoldings; running: string[]; canDelete: boolean;
  /** How many of its tasks build at once: the saved number, what its worker allows, how many build now. */
  builds?: { setting: number; capacity: number | null; building: number; canChange: boolean };
  /** What its builds can reach: the project's named tools and whether each loads (names and words only, never a
   * secret), or why they couldn't be read. */
  access?: { tools: { name: string; loads: boolean; words: string }[] } | { problem: string };
  /** Live view (live-detail.ts): whether running agents' commands and their output show, and whether this person may change it. */
  liveView?: { commands: boolean; canChange: boolean; nonce?: string };
  /** What its builds may reach on the network (egress.ts), and whether this person may change it. */
  network?: { setting: ProjectNetwork; canChange: boolean };
};

/** Network: what the project's builds may reach, said plainly; an approver changes it with their password. */
function networkHtml(view: ProjectSettingsView): Html | "" {
  const network = view.network;
  if (network === undefined) return "";
  const { setting } = network;
  const reach = setting.mode === "open"
    ? html`<p>Builds may reach <strong>any host</strong>.</p>`
    : html`<p>Builds reach their agent's provider and the package registries this project uses${setting.hosts.length === 0 ? "" : html`, and <span class="tool-name">${setting.hosts.join(", ")}</span>`}. Everything else is refused.</p>`;
  const local = setting.loopback === "any"
    ? html`<p>On a Mac, builds may reach <strong>this Mac's local services</strong>: test servers, and anything else listening here.</p>`
    : html`<p>On a Mac, builds reach no local services. A project whose tests start a local server needs them on.</p>`;
  if (!network.canChange) return html`<section class="build-access network-setting" id="network" aria-labelledby="network-title"><h2 id="network-title">Network</h2>${reach}${local}<p class="meta">An approver for this project can change this.</p></section>`;
  const form = postForm("/settings/project/network", html`
    <label class="check"><input type="checkbox" name="local" value="any"${setting.loopback === "any" ? html` checked` : ""}> Builds may reach this Mac's local services</label>
    <p class="meta">Local test servers work, and so does anything else listening on this Mac (a local database, a dev proxy). Linux builds always have local services of their own.</p>
    <label>Other hosts builds may reach<textarea name="hosts" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="api.stripe.com&#10;*.example.com">${setting.hosts.join("\n")}</textarea></label>
    <label class="check"><input type="checkbox" name="mode" value="open"${setting.mode === "open" ? html` checked` : ""}> Open: builds may reach any host</label>
    <p class="meta">Tasks scoped from now on use this; tasks already approved keep the network they were approved with.</p>
    ${reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>`)}
    <button type="submit">Save</button>`, { hidden: { repo: view.repo } });
  return html`<section class="build-access network-setting" id="network" aria-labelledby="network-title"><h2 id="network-title">Network</h2>${reach}${local}<details><summary>Change</summary>${form}</details></section>`;
}

/** Live view: hidden by default; showing commands takes the password, hiding them is one step. */
function liveViewHtml(view: ProjectSettingsView): Html | "" {
  const live = view.liveView;
  if (live === undefined) return "";
  const said = live.commands
    ? html`<p>Commands and their output show in the live view of this project's agents. Secrets are hidden where they're recognised, which isn't guaranteed.</p>`
    : html`<p>Commands are hidden in the live view. You see which files an agent reads and edits, but not the commands it runs or their output.</p>`;
  const change = !live.canChange ? html`<p class="meta">An approver for this project can change this.</p>`
    : live.commands
      ? postForm("/settings/project/live-view", html`<button type="submit">Hide commands</button><p class="meta">From the next run.</p>`, { hidden: { repo: view.repo, act: "off" } })
      : postForm("/settings/project/live-view", html`<p class="meta">Output can include secrets the filter misses. Turn this on only where you're happy for anyone who can see this project to read it. From the next run.</p>${reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>`)}<button type="submit">Show commands</button>`, { hidden: { repo: view.repo, act: "on", nonce: live.nonce ?? "" } });
  return html`<section class="build-access live-view" aria-labelledby="live-view-title" data-live-view-setting="${live.commands ? "commands" : "base"}"><h2 id="live-view-title">Live view</h2>${said}${change}</section>`;
}

/** Build access: one sentence for what a build gets, the detail on demand, and the way to change it. */
function accessHtml(view: ProjectSettingsView): Html | "" {
  const access = view.access;
  if (access === undefined) return "";
  const manage = html`<a class="manage-tools" href="/settings/tools?repo=${encodeURIComponent(view.repo)}">Manage tools</a>`;
  const always = [
    "Your other projects, keys and sign-in files are out of reach.",
    "Your own Claude and Codex hooks, plugins and MCP servers don't load.",
    "Builds sign in with your existing Claude or Codex login.",
  ];
  if ("problem" in access) {
    return html`<section class="build-access" aria-labelledby="build-access-title"><h2 id="build-access-title">Build access</h2><p class="problem" role="alert">${access.problem}</p><details><summary>Details</summary><ul>${always.map(one => html`<li>${one}</li>`)}</ul></details>${manage}</section>`;
  }
  const loading = access.tools.filter(one => one.loads);
  const names = loading.map((one, at) => html`${at === 0 ? "" : ", "}<span class="tool-name">${one.name}</span>`);
  const outcome = loading.length === 0
    ? html`<p>Builds work in their task's folder, with no extra tools.</p>`
    : html`<p>Builds work in their task's folder, with ${loading.length === 1 ? "one tool" : `${loading.length} tools`}: ${names}.</p>`;
  const tools = access.tools.map(one => html`<li><span class="tool-name">${one.name}</span> <span class="meta">· ${one.words}</span></li>`);
  return html`<section class="build-access" aria-labelledby="build-access-title"><h2 id="build-access-title">Build access</h2>${outcome}<details><summary>Details</summary><ul>${always.map(one => html`<li>${one}</li>`)}${tools}</ul></details>${manage}</section>`;
}

/** Builds at once: one number, one Save. The worker's cap is said only when it lowers the number. */
function buildsHtml(view: ProjectSettingsView): Html | "" {
  const b = view.builds;
  if (b === undefined) return "";
  const capped = b.capacity !== null && b.capacity < b.setting ? ` Its worker runs ${b.capacity} at once, so ${b.capacity} for now.` : "";
  const now = `${b.building} building now.${capped}`;
  if (!b.canChange) return html`<section class="builds-at-once"><h2>Builds at once</h2><p>Up to ${b.setting}. ${now}</p></section>`;
  return html`<section class="builds-at-once"><h2>Builds at once</h2>${postForm("/settings/project/concurrency", html`<div class="builds-row"><input type="number" name="concurrency" min="1" max="64" step="1" inputmode="numeric" value="${b.setting}" aria-label="Builds at once" aria-describedby="builds-now"><button type="submit">Save</button></div><p class="meta" id="builds-now">${now}</p>`, { hidden: { repo: view.repo } })}</section>`;
}

const note = (notice: { said?: string | null; problem?: string | null }) =>
  notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";

/** The project's page: its path, what Toolroll holds for it, and (for an instance operator) Delete project. */
export function projectSettingsHtml(view: ProjectSettingsView, notice: { said?: string | null; problem?: string | null }): Html {
  const held = html`<p>Toolroll holds ${holdingsWords(view.holdings)} for <strong>${view.name}</strong>.</p>`;
  const remote = html`<section class="build-access recorded-remote" aria-labelledby="recorded-remote-title"><h2 id="recorded-remote-title">Recorded remote</h2>${view.remoteUrl
    ? html`<p class="path">${view.remoteUrl}</p>`
    : html`<p>No remote recorded. Landed work waits for your review.</p>`}<details><summary>Change remote</summary><p>An owner or instance operator can run:</p><p class="path">toolroll repos add &lt;project&gt; --remote &lt;url&gt;</p></details></section>`;
  const head = html`${note(notice)}<p class="path">${view.repo}</p>${held}${remote}${buildsHtml(view)}${accessHtml(view)}${networkHtml(view)}${liveViewHtml(view)}`;
  if (!view.canDelete) return html`<section class="project-settings">${head}<p class="meta">An instance operator can delete a project.</p></section>`;
  const body = view.running.length > 0
    ? html`<p class="problem">Its work is running: ${view.running.join(", ")}. Stop it before deleting the project.</p>`
    : html`<p>Removes everything Toolroll holds for ${view.name}. The repository and its own branches stay. There's no undo.</p>${
      postForm("/settings/project/delete", html`<label><span>Type <strong>${view.name}</strong> to continue</span><input name="name" autocomplete="off" autocapitalize="off" spellcheck="false" required></label><button type="submit">Continue</button>`, { hidden: { repo: view.repo } })}`;
  // Removing is the reversible step: off the lists and the builder, everything kept.
  const remove = postForm("/projects/remove", html`<button type="submit">Remove from Toolroll</button><p class="meta">Its tasks and results stay saved. Add it again to bring it back.</p>`, { attrs: { class: "remove-project" }, hidden: { repo: view.repo } });
  return html`<section class="project-settings">${head}${remove}<details class="danger-zone"${notice.problem ? html` open` : ""}><summary>Delete project</summary>${body}</details></section>`;
}

/** The second step: exactly what goes, and the password. */
export function projectDeleteConfirmHtml(view: ProjectSettingsView, problem: string | null): Html {
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
  return html`<section class="project-delete">${problem === null ? "" : html`<p class="problem" role="alert">${problem}</p>`}<p>This removes:</p><ul class="removes">${items.map(one => html`<li>${one}</li>`)}</ul><p>The repository at <span class="path">${view.repo}</span> and its own branches stay. The ledger keeps its history. There's no undo.</p>${
    postForm("/settings/project/delete", html`${reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label>`)}<div class="actions"><button type="submit" class="danger">Delete project</button><a href="/settings/project?repo=${encodeURIComponent(view.repo)}">Cancel</a></div>`, { hidden: { repo: view.repo, name: view.name, step: "delete" } })}</section>`;
}
