/**
 * Settings → Project: what Toolroll holds for a project, and deleting
 * it. An instance operator deletes in two steps: type the project's name,
 * then read exactly what goes and confirm with their password (or a fresh
 * sign-in with the identity provider). The repository itself stays.
 */
import { sandboxRuntimeWords } from "./sandbox-runtime.js";
import type { ProjectSandbox } from "./project-sandbox.js";
import type { ProjectNetwork } from "./egress.js";
import type { WritesMode } from "./writes-mode.js";
import { CHECK_ACCESS_WARNINGS, signInHostsMissing, type CheckAccess } from "./check-access.js";
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
  // A radio or checkbox choice sits beside its words, at its natural size, not as a full-width grid row.
  `.project-settings .build-access label.check{display:flex;align-items:center;gap:8px;min-height:44px;font:var(--so-typography-body);font-weight:500}` +
  `.project-settings .build-access label.check input{width:auto;min-height:0;margin:0;flex:none}.project-settings .build-access form .meta{margin:-8px 0 0 26px}` +
  // Check access: a warning shows only under the option chosen; the folds draw the console's own chevron (as a diff's).
  `.project-settings .check-access-setting .option .warning{display:none;color:var(--so-ink)}.project-settings .check-access-setting .option:has(input:checked) .warning{display:block}` +
  `.project-settings .check-access-setting form{margin-top:0;gap:10px}.project-settings .check-access-setting .option{display:grid;gap:2px}` +
  `.project-settings .check-access-setting .option .meta{margin:0 0 0 26px}.project-settings .check-access-setting label.check{min-height:36px}` +
  `.project-settings .check-access-setting details > summary{list-style:none;display:flex;align-items:center;gap:10px;min-height:40px;padding:0}` +
  `.project-settings .check-access-setting details > summary::-webkit-details-marker{display:none}.project-settings .check-access-setting details > summary::marker{content:""}` +
  `.project-settings .check-access-setting details > summary::before{content:"";flex:none;width:.35rem;height:.35rem;border-right:1.5px solid var(--so-muted);border-bottom:1.5px solid var(--so-muted);transform:rotate(-45deg);transition:transform .15s ease}` +
  `.project-settings .check-access-setting details[open] > summary::before{transform:rotate(45deg) translateY(-.1rem)}` +
  // Show hosts: a quiet fold in the line, not a card.
  `.project-settings .check-access-setting details.hosts{border:0;background:none;padding:0;margin:0}.project-settings .check-access-setting details.hosts > summary{min-height:32px;font-size:.8125rem}` +
  `.project-settings .check-access-setting details.hosts .tool-name{margin:0 0 4px;font-size:.75rem}` +
  `.project-settings .check-access-setting button.primary{background:var(--so-signal);color:var(--so-on-signal);border-color:var(--so-signal)}` +
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
  /** Where its builds may write (writes-mode.ts), and whether this person may change it. */
  writes?: { setting: WritesMode; canChange: boolean };
  /** What its builds and checks may not read, and the macOS services and protected files they may still use
   * (project-sandbox.ts), and whether this person may change it. */
  sandbox?: { setting: ProjectSandbox; canChange: boolean };
  /** How far its checks reach (check-access.ts): the level, who changed it last, and whether this person may narrow it
   * (an approver for the project) or also widen it (an instance operator). */
  checkAccess?: { setting: CheckAccess; changed: { by: string; at: string } | null; canNarrow: boolean; canWiden: boolean;
    /** This machine can't sandbox checks at all, and an operator allowed them to run anyway: every level runs unsandboxed. */
    unconfinedHere?: boolean;
    /** Why sign-ins can't be chosen (off for now), or null: they can. */
    signInsUnavailable?: string | null };
};

/** Where builds may write, said plainly; an approver changes it with their password. */
function writesHtml(view: ProjectSettingsView): Html | "" {
  const writes = view.writes;
  if (writes === undefined) return "";
  const said = writes.setting === "workspace"
    ? html`<p>Builds write <strong>only their own checkout</strong>, its caches and its temp folder. Your shell profile, login items, agent settings and the repository's Git config and hooks stay as they are.</p>`
    : html`<p>Builds may write <strong>anywhere</strong> outside Toolroll's own folders, your credentials and other projects.</p>`;
  if (!writes.canChange) return html`<section class="build-access writes-setting" id="writes" aria-labelledby="writes-title"><h2 id="writes-title">Where builds write</h2>${said}<p class="meta">An approver for this project can change this.</p></section>`;
  const option = (value: WritesMode, label: string, detail: string) => html`<label class="check"><input type="radio" name="writes" value="${value}"${writes.setting === value ? html` checked` : ""}> ${label}</label><p class="meta">${detail}</p>`;
  const form = postForm("/settings/project/writes", html`
    ${option("workspace", "Only their workspace (recommended)", "The checkout and its Git data, the project's own package caches, the build's temp folder, and what its agent needs to keep its session.")}
    ${option("anywhere", "Anywhere outside Toolroll's fenced folders", "For a project whose tools must write elsewhere in your home folder or the shared temp folder. Credentials, Toolroll's own folders and other projects stay fenced.")}
    <p class="meta">Tasks scoped from now on use this; tasks already approved keep what they were approved with.</p>
    ${reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>`)}
    <button type="submit">Save</button>`, { hidden: { repo: view.repo } });
  return html`<section class="build-access writes-setting" id="writes" aria-labelledby="writes-title"><h2 id="writes-title">Where builds write</h2>${said}<details><summary>Change</summary>${form}</details></section>`;
}

/** Home folder (project-sandbox.ts): what builds and checks can read there, said once; the paths they can't, and the
 * advanced list (macOS services), changed under Change with the approver's password. */
function sandboxHtml(view: ProjectSandboxView): Html | "" {
  const sandbox = view.sandbox;
  if (sandbox === undefined) return "";
  const { readDeny, machLookup } = sandbox.setting;
  const said = readDeny.length === 0
    ? html`<p>Builds and checks can read your home folder, as in Anthropic's sandbox runtime. Toolroll's own folders stay out of reach; other tasks' work is read, never written.</p>`
    : html`<p>Builds and checks can read your home folder except <strong>${readDeny.length === 1 ? readDeny[0]! : `${readDeny.length} paths`}</strong>.</p>`;
  const extra = machLookup.length === 0 ? "" : html`<p class="meta">${machLookup.length} macOS ${machLookup.length === 1 ? "service" : "services"} allowed</p>`;
  // The engine, named where the sandbox is set (sandbox-runtime.ts).
  const engine = html`<p class="meta" data-sandbox-engine>Builds, checks and flows run in ${sandboxRuntimeWords()}.</p>`;
  const head = html`<h2 id="sandbox-title">Home folder</h2>${said}${extra}${engine}`;
  if (!sandbox.canChange) return html`<section class="build-access sandbox-setting" id="sandbox" aria-labelledby="sandbox-title">${head}<p class="meta">An approver for this project can change this.</p></section>`;
  const form = postForm("/settings/project/sandbox", html`
    <label>Paths builds can't read<textarea name="read-deny" rows="4" placeholder="~/.ssh&#10;~/.aws">${readDeny.join("\n")}</textarea></label>
    <p class="meta">One per line: <code>~/…</code> or a full path.</p>
    <details><summary>Advanced</summary>
      <label>macOS services builds may also use<textarea name="mach" rows="2">${machLookup.join("\n")}</textarea></label>
    </details>
    <p class="meta">Tasks scoped from now on use this; tasks already approved keep what they were approved with.</p>
    ${reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>`)}
    <button type="submit">Save</button>`, { hidden: { repo: view.repo } });
  return html`<section class="build-access sandbox-setting" id="sandbox" aria-labelledby="sandbox-title">${head}<details><summary>Change</summary>${form}</details></section>`;
}
type ProjectSandboxView = Pick<ProjectSettingsView, "sandbox" | "repo">;

/** Check access (check-access.ts): how far the project's checks reach, said once. Collapsed: the level, what it means
 * when it isn't the default, and who changed it. Inside Change: a line per level, and each wider level's warning under it
 * only while it is chosen. An instance operator widens it with a password typed now; an approver narrows it. */
function checkAccessHtml(view: ProjectSettingsView): Html | "" {
  const access = view.checkAccess;
  if (access === undefined) return "";
  const saved = access.setting;
  // Sign-ins aren't available (off for now): a saved sign-ins level runs sandboxed, and the page says so.
  const unavailable = access.signInsUnavailable ?? null;
  const setting: CheckAccess = unavailable !== null && saved === "sign-ins" ? "sandboxed" : saved;
  const network = view.network?.setting ?? null;
  const names: Record<CheckAccess, string> = { sandboxed: "Sandboxed", "sign-ins": "Sandboxed, with model and GitHub sign-ins", unsandboxed: "Not sandboxed" };
  const meaning: Record<CheckAccess, string | null> = { sandboxed: null, "sign-ins": "Checks can read your Claude, Codex and GitHub sign-ins, and on a Mac your Keychain (any item every program may read).", unsandboxed: "Checks run with your full access to this machine and to Toolroll." };
  // The sign-ins never widen the network: how many hosts they'd still need, and where to add them (a change of its own).
  const missing = setting === "sign-ins" && network !== null ? signInHostsMissing(network) : [];
  const hosts = missing.length === 0 ? "" : html`<p class="meta" data-sign-in-hosts>${missing.length} sign-in ${missing.length === 1 ? "host isn't" : "hosts aren't"} allowed yet · <a href="#network">Add them</a></p><details class="hosts"><summary>Show hosts</summary><p class="tool-name">${missing.join(", ")}</p></details>`;
  const changed = access.changed === null ? "" : html`<p class="meta">Changed by ${access.changed.by}, ${new Date(access.changed.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}</p>`;
  // Said before anything else: on a machine with no OS sandbox, every level runs without one.
  const unconfined = access.unconfinedHere === true ? html`<p class="meta warning-line" data-unconfined-here>This machine can't sandbox checks, so they run without a sandbox whatever is chosen here.</p>` : "";
  const runsSandboxed = setting !== saved && access.unconfinedHere !== true ? html`<p class="meta warning-line" data-sign-ins-unavailable>Saved with model and GitHub sign-ins, but checks run sandboxed: sign-ins can't be shared with checks safely yet.</p>` : "";
  // No OS sandbox here, and unconfined running allowed: checks run without a sandbox whatever is saved, and that is
  // what the page says first (never "sandboxed"); the saved level is named under it.
  const head = access.unconfinedHere === true
    ? html`<h2 id="check-access-title">Check access</h2><p><strong>${names.unsandboxed}</strong></p>${saved === "unsandboxed" ? "" : html`<p class="meta" data-saved-level>Saved as ${names[saved]}.</p>`}${unconfined}${changed}`
    : html`<h2 id="check-access-title">Check access</h2><p><strong>${names[setting]}</strong></p>${meaning[setting] === null ? "" : html`<p class="meta">${meaning[setting]}</p>`}${runsSandboxed}${hosts}${changed}`;
  if (!access.canNarrow && !access.canWiden) return html`<section class="build-access check-access-setting" id="check-access" aria-labelledby="check-access-title">${head}</section>`;
  const option = (value: CheckAccess, detail: string, warning: string | null) => {
    const allowed = (value === setting || access.canWiden || value === "sandboxed") && !(value === "sign-ins" && unavailable !== null);
    return html`<div class="option"><label class="check"><input type="radio" name="level" value="${value}"${setting === value ? html` checked` : ""}${allowed ? "" : html` disabled`}> ${names[value]}</label><p class="meta">${detail}</p>${warning === null ? "" : html`<p class="meta warning" data-check-access-warning="${value}">${warning}</p>`}</div>`;
  };
  const open = network?.mode === "open";
  const form = postForm("/settings/project/check-access", html`
    ${option("sandboxed", "Reads your home folder, as in Anthropic's sandbox runtime, except the folders this project hides (Home folder, above). Never Toolroll's folders or other tasks' work.", null)}
    ${unavailable !== null ? option("sign-ins", unavailable, null) : option("sign-ins", `Also reads the files your Claude, Codex and GitHub sign-ins are kept in, on this project's network (${open ? "any host" : network === null || network.hosts.length === 0 ? "registries only" : `registries and ${network.hosts.length} ${network.hosts.length === 1 ? "host" : "hosts"}`}).`, CHECK_ACCESS_WARNINGS["sign-ins"])}
    ${option("unsandboxed", "For projects whose checks create sandboxes themselves, such as Toolroll's own.", CHECK_ACCESS_WARNINGS.unsandboxed)}
    ${open && unavailable === null ? html`<label class="check"><input type="checkbox" name="confirm-open" value="yes"> The network is open: with sign-ins, checks could send them to any host</label>` : ""}
    ${reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>`)}
    <button type="submit" class="primary">Save</button>
    <p class="meta">${access.canWiden ? "" : "Only an instance operator can widen this. "}Flow script steps always run sandboxed. Tasks already approved keep their level.</p>`, { hidden: { repo: view.repo } });
  return html`<section class="build-access check-access-setting" id="check-access" aria-labelledby="check-access-title">${head}<details class="change"><summary>Change</summary>${form}</details></section>`;
}

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
  const head = html`${note(notice)}<p class="path">${view.repo}</p>${held}${remote}${buildsHtml(view)}${accessHtml(view)}${networkHtml(view)}${writesHtml(view)}${sandboxHtml(view)}${checkAccessHtml(view)}${liveViewHtml(view)}`;
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
