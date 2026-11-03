/** Settings → Tools: one project's MCP servers, in plain words. Secrets are
 * entered here and nowhere else, and never shown again. Built from the revamp kit (src/design/KIT.md): each tool and
 * each service is a record with one action; the password is asked only once a tool or service is picked. */
import { html, joinHtml, postForm, type Html } from "./html.js";
import { brandMarkHtml } from "./brand-mark.js";
import { signedIn } from "./oauth-run-token.js";
import { credentialModeOf, toolCommandLine, toolStanding, type FoundTool, type ProjectTool, type ToolSpec } from "./project-tools.js";
import { acts, btn, chip, codeLine, disclose, facts, formRow, icon, infoLine, input, note, notice, select, settingsRecord, settingsSection } from "./server/kit.js";
import { kitSectionForm, SECRET_OPT_OUTS } from "./settings-kit.js";

const hidden = (data: Record<string, string>) =>
  Object.entries(data).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);

/** Kept for the console's style bundle (server/chrome.ts): the page is built from the kit and needs none of its own. */
export const TOOLS_CSS = "";

export type ToolsView = {
  repo: string;
  project: string;
  /** Services connected by signing in, and the kit a Connect came from, if any. */
  connections: { id: string; label: string; about: string; state: "connected" | "open" | "taken"; local?: true; research?: string }[];
  kit: string | null;
  /** The service a link asked for (a kit's checklist, the lead): listed first, its Connect the page's one primary. */
  wanted: string | null;
  tools: { tool: ProjectTool; secretsSet: string[] }[];
  catalog: (ToolSpec & { label: string })[];
  found: FoundTool[];
  /** Where this computer keeps tool secrets (project-tools.ts toolSecretStorage): said plainly when it's files only. */
  storage?: { words: string; filesOnly: boolean; problem?: string };
  /** The person's other projects and the one-click services still open there: where a connection here can also go. */
  others?: { repo: string; project: string; open: string[] }[];
};

/** The project chooser: it opens the chosen project at once; without scripts, its button does. */
export function toolsProjectPicker(projects: readonly string[], chosen: string, keep: Record<string, string> = {}): Html | "" {
  if (projects.length < 2) return "";
  const items = projects.map(p => [p, p.split(/[\\/]/).filter(Boolean).at(-1) ?? p] as const);
  return html`<form method="get" action="/settings/tools" class="k-acts k-picker" data-autosave>${hidden(keep)}\
${select({ name: "repo", label: "Project", current: chosen, items, attrs: { "data-tools-project": true } })}${btn("Show project", { sm: true, type: "submit" })}</form>`;
}

/** Choosing another project marks every form on the page as stale before it reloads, so a tap racing the reload is refused. */
export const TOOLS_PROJECT_SCRIPT = `(function(){var s=document.querySelector('select[data-tools-project]');if(!s)return;s.addEventListener('change',function(){document.querySelectorAll('input[name=shown]').forEach(function(i){i.value=s.value;});});})();`;

type Base = { repo: string; shown: string };
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A tool secret's own field: masked, never given a value, kept out of password managers. */
function secretField(id: string, label: string): Html {
  return html`<input class="k-input" id="${id}" type="password" name="value" autocomplete="off" spellcheck="false" autocapitalize="none" data-so-secret \
data-1p-ignore data-lpignore="${SECRET_OPT_OUTS["data-lpignore"]}" data-bwignore data-form-type="other" required aria-label="${label}">`;
}

function toolRecord(one: { tool: ProjectTool; secretsSet: string[] }, base: Base, manage: boolean, project: string, research: string | null = null): Html {
  const { tool, secretsSet } = one;
  const standing = toolStanding(tool, secretsSet);
  // How its runs get credentials, in one line; what that means is in Details.
  const mode = credentialModeOf(tool.spec, secretsSet);
  const sub = html`${tool.spec.about}${mode === null ? "" : html` · <span data-credential="${mode.mode}">${mode.words}</span>`}`;
  // One form per secret: the disclosure is both where it stands and where it is set. A service connected by signing
  // in gets its tokens only by signing in again (its Connect): no token of it is ever pasted here.
  const secrets = manage && !signedIn(tool.spec) ? tool.spec.secrets.map(secret => {
    const set = secretsSet.includes(secret.name);
    const id = `secret-${slug(tool.name)}-${slug(secret.name)}`;
    return disclose(set ? `Replace ${secret.name}` : `Set ${secret.name}${secret.optional ? " (optional)" : ""}`, kitSectionForm({
      proof: "tools-change", action: "/settings/tools/change", id, gate: true, hidden: { ...base, action: "secret", name: tool.name, secret: secret.name },
      save: { label: `Save ${secret.name}` }, confirm: `Set ${secret.name} for ${tool.name} in ${project}`,
      body: formRow(secret.name, "Stored privately on this computer and never shown again.", secretField(`${id}-value`, secret.name)),
    }));
  }) : [];
  const tested = tool.lastTest?.ok ? `${tool.lastTest.at.slice(0, 16).replace("T", " ")} UTC: ${tool.lastTest.tools.join(", ") || "it lists no tools"}` : null;
  const details = disclose("Details", facts([
    ...(mode?.detail == null ? [] : [["Keys", mode.detail] as const]),
    ["Starts", codeLine(toolCommandLine(tool.spec))],
    ["Added", `From ${tool.source} · by ${tool.createdBy}`],
    ...(tested === null ? [] : [["Last test", tested] as const]),
  ]));
  const failed = tool.lastTest !== null && !tool.lastTest.ok ? notice(tool.lastTest.problem ?? "The last test failed.") : "";
  // Connected, but research can't use it (its grant writes): said once, with the one way to fix it.
  const reconnect = research === null || !manage ? "" : kitSectionForm({
    proof: "tools-connect", action: "/settings/tools/connect", id: `reconnect-${slug(tool.name)}`, native: true, hidden: { ...base, service: tool.name, access: "read" },
    save: { label: "Reconnect read-only", variant: "outline" }, confirm: `Reconnect ${tool.name} read-only for ${project}`, body: html``,
  });
  const limited = research === null ? "" : html`${infoLine(research)}${reconnect}`;
  const test = manage ? postForm("/settings/tools/change", btn("Test", { sm: true, type: "submit", attrs: { "aria-label": `Test ${tool.name} in ${project}` } }), { hidden: { ...base, action: "test", name: tool.name } }) : "";
  const remove = manage ? postForm("/settings/tools/change", acts(btn(`Remove from ${project}`, { sm: true, variant: "danger", type: "submit" })), { hidden: { ...base, action: "remove", name: tool.name } }) : "";
  return settingsRecord({
    title: html`${brandMarkHtml(tool.source === "custom" ? null : tool.name, tool.name, standing.ready)}<span>${tool.name}</span>${chip(standing.words, standing.ready ? "done" : "")}`,
    sub, action: test, attrs: { id: `tool-${tool.name}`, "data-ready": String(standing.ready) },
    more: joinHtml([failed, limited, ...secrets, details, remove]),
  });
}

/** One service to connect by signing in on its own page: one record, one Connect. The password is asked after it is picked. */
function connectRecord(one: ToolsView["connections"][number], view: ToolsView, base: Base, problem: Html | ""): Html {
  const mark = brandMarkHtml(one.id.replace(/-desktop$/, ""), one.label, one.state === "connected");
  const attrs = { id: `connect-${one.id}`, "data-state": one.state };
  if (one.state === "taken") return settingsRecord({ title: html`${brandMarkHtml(one.id, one.label, false)}<span>${one.label}</span>`, sub: "Added another way", attrs });
  const to = ` to ${view.project}`;
  const connected = one.state === "connected";
  const label = connected ? (one.local ? "Connect again" : "Sign in again") : "Connect";
  const confirm = connected && !one.local ? `Sign in to ${one.label} again for ${view.project}` : `Connect ${one.label}${to}`;
  const action = kitSectionForm({
    proof: "tools-connect", action: "/settings/tools/connect", id: `connect-${one.id}-form`, native: true,
    hidden: { ...base, ...(view.kit === null ? {} : { kit: view.kit }), service: one.id },
    save: { label, variant: one.id === view.wanted ? "primary" : "outline" }, confirm, body: html``,
  });
  return settingsRecord({ title: html`${mark}<span>${one.label}</span>${connected ? chip("Connected", "done") : ""}`, sub: connected ? "" : one.about, action, attrs, more: problem });
}

/** A service connected here, offered to the person's other projects: each act signs in again for that project (tokens are never copied). */
function elsewhere(view: ToolsView, base: Base): Html | "" {
  const offers = view.connections.filter(one => one.state === "connected").flatMap(one =>
    (view.others ?? []).filter(other => other.open.includes(one.id)).map(other => kitSectionForm({
      proof: "tools-connect", action: "/settings/tools/connect", id: `also-${slug(one.id)}-${slug(other.project)}`, native: true,
      hidden: { ...base, ...(view.kit === null ? {} : { kit: view.kit }), also: `${one.id}:${other.repo}` },
      save: { label: `Also connect ${one.label} to ${other.project}`, variant: "outline" }, confirm: `Connect ${one.label} to ${other.project}`, body: html``,
    })));
  if (offers.length === 0) return "";
  return settingsSection({ id: "connect-elsewhere", title: "Also connect to another project", lead: "Signs in again for that project. Tokens are never copied between projects.", body: joinHtml(offers) });
}

export function toolsHtml(view: ToolsView, csrf: string, canManage: boolean, message: { said?: string | null; problem?: string | null } = {}): Html {
  const manage = canManage && csrf !== "";
  // `shown` is the project this page shows; the server refuses a post whose repo differs from it.
  const base: Base = { repo: view.repo, shown: view.repo };
  const to = ` to ${view.project}`;
  const keptIn = view.storage === undefined || view.storage.filesOnly ? "Secrets stay on this computer" : view.storage.words.replace(/\.$/, "");
  // No keychain here: said once, plainly, where it can't be missed.
  const storage = view.storage?.problem !== undefined ? notice(view.storage.problem)
    : view.storage?.filesOnly === true ? infoLine(view.storage.words) : "";
  const how = disclose("How tools work", html`<ul class="k-note"><li>A tool you add reaches work you approve from now on. Approve a task again to give it a new tool.</li><li>Removing a tool takes it away from every build right away.</li><li>${keptIn}, are never shown again, and go only to the tool that needs them.</li><li>Reviewers and the lead chat never get tools. Gemini builds don't use tools yet.</li></ul>`);
  const records = view.tools.length === 0 ? note("No tools yet. Builds in this project get none.")
    : joinHtml(view.tools.map(one => toolRecord(one, base, manage, view.project, view.connections.find(c => c.id === one.tool.name && c.state === "connected")?.research ?? null)));
  const tools = settingsSection({ id: "tools", title: `Tools in ${view.project}`, lead: `Builds in ${view.project} use exactly these tools. MCP servers set up elsewhere on this computer aren't used.`, body: joinHtml([storage, records, how]) });

  const connecting = manage && view.connections.length > 0;
  // A Connect that failed says why at its service, focused so it is heard and seen there (not only at the top).
  const atButton = connecting && view.wanted !== null && view.connections.some(one => one.id === view.wanted) && Boolean(message.problem);
  const failed = atButton ? html`<p class="k-notice" id="connect-problem" role="alert" tabindex="-1" autofocus>${icon("alert", true)}<span>${message.problem}</span></p>` : "";
  // The service a link asked for comes first; its Connect is the page's one primary.
  const ordered = [...view.connections.filter(one => one.id === view.wanted), ...view.connections.filter(one => one.id !== view.wanted)];
  const connect = connecting ? settingsSection({ id: "connect", title: `Connect${to}`, lead: "Sign in on the service's own page. Toolroll asks for your password once you pick one.",
    body: joinHtml(ordered.map(one => connectRecord(one, view, base, one.id === view.wanted ? failed : ""))) }) : "";

  const fromList = view.catalog.length === 0 ? "" : kitSectionForm({
    proof: "tools-change", action: "/settings/tools/change", id: "tools-add-catalog", hidden: { ...base, action: "add-catalog" }, save: { label: `Add${to}`, variant: "outline" }, confirm: `Add a tool${to}`,
    body: formRow("Common tools", null, select({ id: "tools-catalog", name: "catalog", label: "Common tools", wide: true, items: view.catalog.map(one => [one.name, `${one.label}: ${one.about}`] as const) }), "wide"),
  });
  const custom = disclose("Add your own", kitSectionForm({
    proof: "tools-change", action: "/settings/tools/change", id: "tools-add-custom", hidden: { ...base, action: "add-custom" }, save: { label: `Add${to}`, variant: "outline" }, confirm: `Add your own tool${to}`,
    body: joinHtml([
      formRow("Name", "Lowercase letters, numbers, - and _.", input({ id: "tools-custom-name", name: "name", attrs: { pattern: "[a-z0-9][a-z0-9_\\-]{0,39}", maxlength: 40, required: true, placeholder: "for example: postgres", "aria-label": "Name" } })),
      formRow("It runs as", null, select({ id: "tools-custom-transport", name: "transport", label: "It runs as", items: [["stdio", "A program on this computer"], ["http", "A web address"]] })),
      formRow("Command or address", null, input({ id: "tools-custom-target", name: "target", attrs: { required: true, placeholder: "npx -y some-mcp-server@1.2.3, or https://…", "aria-label": "Command or address" } }), "wide"),
      formRow("Secrets it needs", "Names, comma separated. For a web address, the first one is sent as its sign-in token. Set each value after adding.",
        input({ id: "tools-custom-secrets", name: "secrets", attrs: { placeholder: "for example: DATABASE_URL", "aria-label": "Secrets it needs" } })),
    ]),
  }));
  const add = manage ? settingsSection({ id: "add", title: "Add a tool", body: joinHtml([fromList, custom]) }) : "";
  const found = manage && view.found.length > 0 ? settingsSection({ id: "found", title: "Found on this computer", state: ` · ${view.found.length}`,
    lead: "MCP servers your other apps use. Adding one copies its settings, and any secrets it has, into this project.",
    body: kitSectionForm({
      proof: "tools-change", action: "/settings/tools/change", id: "tools-import", hidden: { ...base, action: "import" }, save: { label: `Add selected${to}`, variant: "outline" }, confirm: `Add tools found on this computer${to}`,
      body: html`<fieldset class="k-sopts"><legend class="k-sr">Found on this computer</legend>${view.found.map(one => html`<label class="k-sopt"><input type="checkbox" name="import" value="${one.spec.name}">\
<span><b>${one.spec.name}</b><span>${one.source} · <span class="k-mono">${toolCommandLine(one.spec)}</span>${one.spec.secrets.length === 0 ? "" : ` · brings ${one.spec.secrets.map(s => s.name).join(", ")}`}</span></span></label>`)}</fieldset>`,
    }) }) : "";
  const answer = atButton ? "" : message.problem ? notice(message.problem) : message.said ? infoLine(message.said) : "";
  return joinHtml([answer, tools, connect, connecting ? elsewhere(view, base) : "", add, found]);
}
