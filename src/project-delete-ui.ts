/**
 * Settings → Project: what Toolroll holds for a project, and deleting
 * it. An instance operator deletes in two steps: type the project's name,
 * then read exactly what goes and confirm with their password (or a fresh
 * sign-in with the identity provider). The repository itself stays.
 */
import { advancedShownNow } from "./advanced-view.js";
import { entryMovesOnWords, entryWords, type FallbackSetting } from "./fallback.js";
import { sandboxRuntimeWords } from "./sandbox-runtime.js";
import type { ProjectSandbox } from "./project-sandbox.js";
import type { ProjectNetwork } from "./egress.js";
import type { WritesMode } from "./writes-mode.js";
import { CHECK_ACCESS_WARNINGS, signInHostsMissing, type CheckAccess } from "./check-access.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { holdingsWords, type ProjectHoldings } from "./project-delete.js";
import { acts, btn, codeLine, disclose, formRow, infoLine, input, note, notice, radios, settingsSection, switchInput, textarea } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";


/** Check access: a wider level's warning shows only under the option chosen. Everything else on the page is kit markup. */
export const PROJECT_DELETE_CSS = ".k-opt [data-check-access-warning]{display:none;color:var(--so-ink)}.k-opt:has(input:checked) [data-check-access-warning]{display:block}" +
  ".k-opt:has(input:disabled){cursor:default;opacity:.6}";

export type ProjectSettingsView = {
  remoteUrl?: string | null;
  /** The code map's switch and, while it runs, the holdout's end date. */
  codeMap?: { on: boolean; enrollUntil: string | null; canEndHoldout: boolean; href: string };
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
  /** Who takes over when an agent runs out of its plan (fallback.ts), and whether this person may change it. */
  fallback?: { setting: FallbackSetting | null; canChange: boolean };
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

const mono = (text: string): Html => html`<span class="k-mono">${text}</span>`;
const list = (items: readonly HtmlItem[]): Html => html`<ul class="k-note">${items.map(one => html`<li>${one}</li>`)}</ul>`;
type HtmlItem = string | Html;
const SCOPED = "Tasks scoped from now on use this; tasks already approved keep what they were approved with.";
const APPROVER_CHANGES = note("An approver for this project can change this.");

/** Where builds may write, said plainly; an approver changes it with their password (always typed: it widens). */
function writesHtml(view: ProjectSettingsView): Html | "" {
  const writes = view.writes;
  if (writes === undefined) return "";
  const said = writes.setting === "workspace"
    ? "Builds write only their own checkout, its caches and its temp folder. Your shell profile, login items, agent settings and the repository's Git config and hooks stay as they are."
    : "Builds may write anywhere outside Toolroll's own folders, your credentials and other projects.";
  return settingsSection({ id: "writes", title: "Where builds write", state: writes.setting === "workspace" ? " · Only their workspace" : " · Anywhere", lead: said,
    body: !writes.canChange ? APPROVER_CHANGES : disclose("Change", kitSectionForm({ proof: "project-writes", action: "/settings/project/writes", id: "writes-form", gate: true, hidden: { repo: view.repo },
      body: joinHtml([
        formRow("Builds may write", null, radios({ name: "writes", legend: "Where builds write", current: writes.setting, items: [
          { value: "workspace", label: "Only their workspace (recommended)", text: "The checkout and its Git data, the project's own package caches, the build's temp folder, and what its agent needs to keep its session." },
          { value: "anywhere", label: "Anywhere outside Toolroll's fenced folders", text: "For a project whose tools must write elsewhere in your home folder or the shared temp folder. Credentials, Toolroll's own folders and other projects stay fenced." }] }), "wide"),
        note(SCOPED),
      ]) })) });
}

/** Home folder (project-sandbox.ts): what builds and checks can read there, said once; the paths they can't, and the
 * advanced list (macOS services), changed under Change with the approver's password. */
function sandboxHtml(view: ProjectSandboxView): Html | "" {
  const sandbox = view.sandbox;
  if (sandbox === undefined) return "";
  const { readDeny, machLookup } = sandbox.setting;
  const said = readDeny.length === 0
    ? "Builds and checks can read your home folder, as in Anthropic's sandbox runtime. Toolroll's own folders stay out of reach; other tasks' work is read, never written."
    : `Builds and checks can read your home folder except ${readDeny.length === 1 ? readDeny[0]! : `${readDeny.length} paths`}.`;
  const head = joinHtml([
    machLookup.length === 0 ? "" : note(`${machLookup.length} macOS ${machLookup.length === 1 ? "service" : "services"} allowed`),
    // The engine, named where the sandbox is set (sandbox-runtime.ts).
    html`<p class="k-note" data-sandbox-engine>Builds, checks and flows run in ${sandboxRuntimeWords()}.</p>`,
  ]);
  return settingsSection({ id: "sandbox", title: "Home folder", lead: said,
    body: joinHtml([head, !sandbox.canChange ? APPROVER_CHANGES : disclose("Change", kitSectionForm({ proof: "project-sandbox", action: "/settings/project/sandbox", id: "sandbox-form", gate: true, hidden: { repo: view.repo },
      body: joinHtml([
        formRow("Paths builds can't read", "One per line: ~/… or a full path.", textarea({ id: "sandbox-read-deny", name: "read-deny", value: readDeny.join("\n"), rows: 4, attrs: { placeholder: "~/.ssh\n~/.aws", "aria-label": "Paths builds can't read" } }), "top"),
        disclose("Advanced", formRow("macOS services builds may also use", null, textarea({ id: "sandbox-mach", name: "mach", value: machLookup.join("\n"), rows: 2, attrs: { "aria-label": "macOS services builds may also use" } }), "top")),
        note(SCOPED),
      ]) }))]) });
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
  const meaning: Record<CheckAccess, string | null> = { sandboxed: null, "sign-ins": "Checks can read your Claude, Codex and GitHub sign-ins.", unsandboxed: "Checks run with your full access to this machine and to Toolroll." };
  // The sign-ins never widen the network: how many hosts they'd still need, and where to add them (a change of its own).
  const missing = setting === "sign-ins" && network !== null ? signInHostsMissing(network) : [];
  const hosts = missing.length === 0 ? "" : joinHtml([
    html`<p class="k-note" data-sign-in-hosts>${missing.length} sign-in ${missing.length === 1 ? "host isn't" : "hosts aren't"} allowed yet · <a class="k-link" href="#network">Add them</a></p>`,
    disclose("Show hosts", html`<p class="k-note k-mono">${missing.join(", ")}</p>`),
  ]);
  const changed = access.changed === null ? "" : note(`Changed by ${access.changed.by}, ${new Date(access.changed.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`);
  // No OS sandbox here, and unconfined running allowed: checks run without a sandbox whatever is saved, and that is
  // what the page says first (never "sandboxed"); the saved level is named under it.
  const unconfinedHere = access.unconfinedHere === true;
  const shown: CheckAccess = unconfinedHere ? "unsandboxed" : setting;
  const head = unconfinedHere
    ? joinHtml([saved === "unsandboxed" ? "" : html`<p class="k-note" data-saved-level>Saved as ${names[saved]}.</p>`,
        html`<p class="k-note" data-unconfined-here>This machine can't sandbox checks, so they run without a sandbox whatever is chosen here.</p>`, changed])
    : joinHtml([setting !== saved ? html`<p class="k-note" data-sign-ins-unavailable>Saved with model and GitHub sign-ins, but checks run sandboxed: sign-ins can't be shared with checks safely yet.</p>` : "", hosts, changed]);
  const section = (body: Html) => settingsSection({ id: "check-access", title: "Check access", state: ` · ${names[shown]}`,
    lead: unconfinedHere ? undefined : meaning[setting] ?? undefined, body });
  if (!access.canNarrow && !access.canWiden) return section(head);
  const option = (value: CheckAccess, detail: string, warning: string | null) => {
    const allowed = (value === setting || access.canWiden || value === "sandboxed") && !(value === "sign-ins" && unavailable !== null);
    return html`<label class="k-opt"><input type="radio" name="level" value="${value}"${setting === value ? html` checked` : ""}${allowed ? "" : html` disabled`}><span><b>${names[value]}</b><span>${detail}</span>\
${warning === null ? "" : html`<span data-check-access-warning="${value}">${warning}</span>`}</span></label>`;
  };
  const open = network?.mode === "open";
  const choices = html`<fieldset class="k-radios"><legend class="k-sr">Check access</legend>\
${option("sandboxed", "Reads your home folder, as in Anthropic's sandbox runtime, except the folders this project hides (Home folder, above). Never Toolroll's folders or other tasks' work.", null)}\
${unavailable !== null ? option("sign-ins", unavailable, null) : option("sign-ins", `Also reads the files your Claude, Codex and GitHub sign-ins are kept in, on this project's network (${open ? "any host" : network === null || network.hosts.length === 0 ? "registries only" : `registries and ${network.hosts.length} ${network.hosts.length === 1 ? "host" : "hosts"}`}).`, CHECK_ACCESS_WARNINGS["sign-ins"])}\
${option("unsandboxed", "For projects whose checks create sandboxes themselves, such as Toolroll's own.", CHECK_ACCESS_WARNINGS.unsandboxed)}</fieldset>`;
  const confirmOpen = open && unavailable === null
    ? html`<label class="k-opt"><input type="checkbox" name="confirm-open" value="yes"><span><b>The network is open</b><span>With sign-ins, checks could send them to any host.</span></span></label>`
    : "";
  // A form that offers a wider level asks for an instance operator's password, typed now (the server decides).
  const form = kitSectionForm({ proof: access.canWiden ? "project-check-access-widen" : "project-check-access", action: "/settings/project/check-access", id: "check-access-form", gate: true, hidden: { repo: view.repo },
    body: joinHtml([formRow("How far checks reach", null, choices, "wide"), confirmOpen,
      note(`${access.canWiden ? "" : "Only an instance operator can widen this. "}Flow script steps always run sandboxed. Tasks already approved keep their level.`)]) });
  return section(joinHtml([head, disclose("Change", form)]));
}

/** Network: what the project's builds may reach, said plainly; an approver changes it with their password. */
function networkHtml(view: ProjectSettingsView): Html | "" {
  const network = view.network;
  if (network === undefined) return "";
  const { setting } = network;
  const reach = setting.mode === "open"
    ? html`Builds may reach any host.`
    : html`Builds reach their agent's provider and the package registries this project uses${setting.hosts.length === 0 ? "" : html`, and ${mono(setting.hosts.join(", "))}`}. Everything else is refused.`;
  const local = setting.loopback === "any"
    ? note("On a Mac, builds may reach this Mac's local services: test servers, and anything else listening here.")
    : note("On a Mac, builds reach no local services. A project whose tests start a local server needs them on.");
  return settingsSection({ id: "network", title: "Network", state: setting.mode === "open" ? " · Open" : "", lead: reach,
    body: joinHtml([local, !network.canChange ? APPROVER_CHANGES : disclose("Change", kitSectionForm({ proof: "project-network", action: "/settings/project/network", id: "network-form", gate: true, hidden: { repo: view.repo },
      body: joinHtml([
        formRow("This Mac's local services", "Local test servers work, and so does anything else listening on this Mac (a local database, a dev proxy). Linux builds always have local services of their own.",
          switchInput({ id: "network-local", name: "local", label: "Allowed", on: setting.loopback === "any", attrs: { value: "any", "aria-label": "Builds may reach this Mac's local services" } }), "inline"),
        formRow("Other hosts builds may reach", "One per line.", textarea({ id: "network-hosts", name: "hosts", value: setting.hosts.join("\n"), rows: 3,
          attrs: { autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "api.stripe.com\n*.example.com", "aria-label": "Other hosts builds may reach" } }), "top"),
        formRow("Open", "Builds may reach any host.", switchInput({ id: "network-open", name: "mode", label: "Open", on: setting.mode === "open", attrs: { value: "open", "aria-label": "Open: builds may reach any host" } }), "inline"),
        note("Tasks scoped from now on use this; tasks already approved keep the network they were approved with."),
      ]) }))]) });
}

function fallbackHtml(view: ProjectSettingsView): Html | "" {
  const fallback = view.fallback;
  if (fallback === undefined) return "";
  const { setting } = fallback;
  const lead = setting === null ? html`When an agent runs out of its plan, the task stops.` : html`When an agent runs out of its plan, the work moves to the next agent here.`;
  const lines = setting === null ? "" : joinHtml(setting.entries.map(one => note(`${entryWords(one)}. ${entryMovesOnWords(one)}.`)));
  return settingsSection({ id: "fallback", title: "Fallback agents", state: setting === null ? "" : ` · ${setting.entries.length}`, lead,
    body: joinHtml([lines, !fallback.canChange ? APPROVER_CHANGES : disclose("Change", kitSectionForm({ proof: "project-fallback", action: "/settings/project/fallback", id: "fallback-form", gate: true, hidden: { repo: view.repo },
      body: joinHtml([
        formRow("Agents, in order", "One per line: provider:model:plan or provider:model:api-key. Empty turns this off.", textarea({ id: "fallback-agents", name: "agents", value: setting === null ? "" : setting.entries.map(one => `${one.provider}:${one.model}:${one.authMode === "subscription" ? "plan" : "api-key"}`).join("\n"), rows: 3,
          attrs: { autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "codex:gpt-5.6:plan", "aria-label": "Fallback agents, in order" } }), "top"),
        formRow("Paid fallback", "An agent on an API key spends money. It runs only while this is on.", switchInput({ id: "fallback-paid", name: "paid", label: "Allowed", on: setting?.paidGrant != null, attrs: { value: "on", "aria-label": "Allow paid fallback agents to spend" } }), "inline"),
        note("Tasks scoped from now on use this; tasks already approved keep the chain they were approved with."),
      ]) }))]) });
}

/** Live view: hidden by default; showing commands takes the password, hiding them is one step. */
function liveViewHtml(view: ProjectSettingsView): Html | "" {
  const live = view.liveView;
  if (live === undefined) return "";
  const said = live.commands
    ? "Commands and their output show in the live view of this project's agents. Secrets are hidden where they're recognised, which isn't guaranteed."
    : "Commands are hidden in the live view. You see which files an agent reads and edits, but not the commands it runs or their output.";
  const change = !live.canChange ? APPROVER_CHANGES
    : live.commands
      ? postForm("/settings/project/live-view", joinHtml([note("From the next run."), acts(btn("Hide commands", { sm: true, type: "submit" }))]), { hidden: { repo: view.repo, act: "off" } })
      : kitSectionForm({ proof: "project-live-view", action: "/settings/project/live-view", id: "live-view-form", hidden: { repo: view.repo, act: "on", nonce: live.nonce ?? "" },
          save: { label: "Show commands", variant: "outline" }, confirm: "Show this project's commands in the live view",
          body: note("Output can include secrets the filter misses. Turn this on only where you're happy for anyone who can see this project to read it. From the next run.") });
  return settingsSection({ id: "live-view", title: "Live view", state: html`<span data-live-view-setting="${live.commands ? "commands" : "base"}"> · ${live.commands ? "Commands shown" : "Commands hidden"}</span>`,
    lead: said, body: change });
}

/** Build access: one sentence for what a build gets, the detail on demand, and the way to change it. */
function accessHtml(view: ProjectSettingsView): Html | "" {
  const access = view.access;
  if (access === undefined) return "";
  const manage = acts(btn("Manage tools", { sm: true, href: `/settings/tools?repo=${encodeURIComponent(view.repo)}` }));
  const always = [
    "Your other projects, keys and sign-in files are out of reach.",
    "Your own Claude and Codex hooks, plugins and MCP servers don't load.",
    "Builds sign in with your existing Claude or Codex login.",
  ];
  if ("problem" in access) {
    return settingsSection({ id: "build-access", title: "Build access", body: joinHtml([notice(access.problem), disclose("Details", list(always)), manage]) });
  }
  const loading = access.tools.filter(one => one.loads);
  const names = loading.map((one, at) => html`${at === 0 ? "" : ", "}${mono(one.name)}`);
  const outcome = loading.length === 0
    ? html`Builds work in their task's folder, with no extra tools.`
    : html`Builds work in their task's folder, with ${loading.length === 1 ? "one tool" : `${loading.length} tools`}: ${names}.`;
  const tools = access.tools.map(one => html`${mono(one.name)} · ${one.words}`);
  return settingsSection({ id: "build-access", title: "Build access", lead: outcome, body: joinHtml([disclose("Details", list([...always, ...tools])), manage]) });
}

/** Builds at once: one number, one Save. The worker's cap is said only when it lowers the number. */
function buildsHtml(view: ProjectSettingsView): Html | "" {
  const b = view.builds;
  if (b === undefined) return "";
  const capped = b.capacity !== null && b.capacity < b.setting ? ` Its builder runs ${b.capacity} at once, so ${b.capacity} for now.` : "";
  const now = `${b.building} building now.${capped}`;
  if (!b.canChange) return settingsSection({ id: "builds-at-once", title: "Builds at once", state: ` · Up to ${b.setting}`, body: note(now) });
  return settingsSection({ id: "builds-at-once", title: "Builds at once",
    body: postForm("/settings/project/concurrency", formRow("Builds at once", now, html`${input({ id: "builds-at-once-n", name: "concurrency", type: "number", value: String(b.setting),
      attrs: { min: 1, max: 64, step: 1, inputmode: "numeric", "aria-label": "Builds at once" } })}${btn("Save", { sm: true, type: "submit" })}`, "inline"), { hidden: { repo: view.repo } }) });
}

/** The project's page: its name and path, what Toolroll holds for it, its build settings, and (for an instance operator)
 * Remove and Delete. */
function codeMapHtml(view: ProjectSettingsView): Html {
  const map = view.codeMap;
  if (map === undefined) return html``;
  return settingsSection({ id: "code-map", title: "Code map", right: postForm("/settings/project/code-map", btn(map.on ? "Turn off" : "Turn on", { sm: true, type: "submit" }), { hidden: { repo: view.repo, on: map.on ? "0" : "1" } }),
    lead: map.on ? "Toolroll makes a map of main and gives it to builds." : "Off. No new maps are made, and builds get none.",
    body: joinHtml([
      html`<p><a class="k-link" href="${map.href}">Open code map</a></p>`,
      ...(map.enrollUntil === null ? [] : [formRow("Holdout", `About half of new builds run without the map until ${map.enrollUntil.slice(0, 10)}, to measure whether it helps.`,
        map.canEndHoldout ? postForm("/settings/project/code-map/holdout", btn("End holdout", { sm: true, type: "submit" }), { hidden: { repo: view.repo } }) : html``, "inline")]),
    ]) });
}

export function projectSettingsHtml(view: ProjectSettingsView, said: { said?: string | null; problem?: string | null }): Html {
  const answer = said.problem ? notice(said.problem) : said.said ? infoLine(said.said) : "";
  const project = settingsSection({ id: "project", title: view.name, lead: mono(view.repo),
    body: joinHtml([
      note(`Toolroll holds ${holdingsWords(view.holdings)} for this project.`),
      formRow("Recorded remote", view.remoteUrl ? null : "None. Landed work waits for your review.", view.remoteUrl ? mono(view.remoteUrl) : html``, view.remoteUrl ? "wide" : "inline"),
      disclose("Change remote", joinHtml([note("An owner or instance operator can run:"), codeLine("toolroll repos add <project> --remote <url>")])),
    ]) });
  // Settings → Advanced off: fallback agents, live view and the code map leave this page, except a fallback chain that is
  // set and live view commands that are on (an active setting keeps its state and its way to turn it off).
  const advanced = advancedShownNow();
  const settings = joinHtml([buildsHtml(view), accessHtml(view), networkHtml(view), advanced || (view.fallback?.setting ?? null) !== null ? fallbackHtml(view) : "",
    writesHtml(view), sandboxHtml(view), checkAccessHtml(view), advanced || view.liveView?.commands === true ? liveViewHtml(view) : "", advanced ? codeMapHtml(view) : ""]);
  if (!view.canDelete) return joinHtml([answer, project, settings, note("An instance operator can remove or delete a project.")]);
  const deleteBody = view.running.length > 0
    ? notice(`Its work is running: ${view.running.join(", ")}. Stop it before deleting the project.`)
    : joinHtml([note(`Removes everything Toolroll holds for ${view.name}. The repository and its own branches stay. There's no undo.`),
        postForm("/settings/project/delete", joinHtml([
          formRow(`Type ${view.name} to continue`, null, input({ id: "delete-name", name: "name", attrs: { autocomplete: "off", autocapitalize: "off", spellcheck: "false", required: true, "aria-label": `Type ${view.name} to continue` } })),
          acts(btn("Continue", { sm: true, type: "submit", variant: "danger" })),
        ]), { hidden: { repo: view.repo } })]);
  // Removing is the reversible step: off the lists and the builder, everything kept.
  const leave = settingsSection({ id: "remove", title: "Remove or delete",
    body: joinHtml([
      formRow("Remove from Toolroll", "Its tasks and results stay saved. Add it again to bring it back.",
        postForm("/projects/remove", btn("Remove from Toolroll", { sm: true, type: "submit" }), { hidden: { repo: view.repo } }), "inline"),
      disclose("Delete project", deleteBody, Boolean(said.problem)),
    ]) });
  return joinHtml([answer, project, settings, leave]);
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
  return joinHtml([
    problem === null ? "" : notice(problem),
    settingsSection({ id: "delete", title: "This removes",
      body: joinHtml([
        list(items),
        note(html`The repository at ${mono(view.repo)} and its own branches stay. The ledger keeps its history. There's no undo.`),
        // The answer is a page of its own (this page again with a refusal, or the project page), so it posts as a navigation.
        kitSectionForm({ proof: "project-delete", action: "/settings/project/delete", id: "delete-form", native: true, hidden: { repo: view.repo, name: view.name, step: "delete" },
          save: { label: "Delete project", variant: "danger" }, confirm: `Delete ${view.name}`,
          body: acts(btn("Cancel", { sm: true, variant: "ghost", href: `/settings/project?repo=${encodeURIComponent(view.repo)}` })) }),
      ]) }),
  ]);
}
