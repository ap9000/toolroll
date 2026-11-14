/**
 * Settings: the overview and its group pages, in the revamp kit (src/design/KIT.md; the owner-approved prototype's
 * Settings area, docs/plans/settings-revamp.md §3). Server HTML only: every form posts to the route and fields it
 * posted to before, under its proof inventory row (settings-proofs.ts), and the kit's section forms
 * (settings-kit.ts kitSectionForm) save one section at a time. Nothing here reads a request or decides an act; the
 * page that calls it has already dropped what this person can't use, and every handler proves the act again.
 *
 * Groups (design/kit.ts SETTINGS_GROUPS): General, Agents and models, Chat apps and alerts, Approvals and safety,
 * Projects, People and sign-in, Spend (its own page, /spend), System.
 */
import { ACCENT_PRESETS, accentNote } from "./accent-colors.js";
import { type BrowserPhoneCard, type BrowserUpdates } from "./browser-workspace.js";
import { SETTINGS_GROUP_ICONS, SETTINGS_GROUPS, plural } from "./design/kit.js";
import { digestTimes } from "./digest-times.js";
import { html, joinHtml, postForm, type Html, type HtmlValue } from "./html.js";
import { RESULT_SHOT_CHOICES } from "./result-shots.js";
import { type UnattendedPermissionMode } from "./scope.js";
import { type QualityMode, qualityModeTitle } from "./quality.js";
import { type ResultScreenshots } from "./store.js";
import { kitSectionForm, SECRET_OPT_OUTS } from "./settings-kit.js";
import { ADVANCED_PAGES } from "./advanced-view.js";
import {
  btn, chip, codeLine, disclose, row, formRow, infoLine, input, needsPanel, note, notice, radios, select, settingsLink, settingsLinks, settingsRecord,
  settingsSection, settingsShell, switchInput,
} from "./server/kit.js";

export type SettingsGroup = "hub" | "general" | "agents" | "alerts" | "approval" | "projects" | "access" | "system" | "advanced";
/** The group pages this module draws (Spend is /spend; Approvals and safety is /settings/approval, its own handler). */
export const GROUP_PATHS: Readonly<Record<string, SettingsGroup>> = {
  "/settings": "hub", "/settings/general": "general", "/settings/agents": "agents", "/settings/alerts": "alerts",
  "/settings/projects": "projects", "/settings/access": "access", "/settings/system": "system", "/settings/advanced": "advanced",
};

type Tone = "ok" | "warn" | "off" | "neutral";
export type ProviderFacts = {
  provider: string; name: string; tone: Tone; words: string;
  connection: { words: string; facts: string } | null;
  usage: string; envName: string; subscriptionCapable: boolean; mode: "subscription" | "api-key"; set: boolean;
};
export type WorkerFacts = { name: string; tone: "ok" | "warn" | "off"; state: string; capacity: number; busy: number; running: { taskId: string; title: string; href: string; project: string | null }[] };
export type EmailFacts = { set: boolean; host: string; port: number; secure: boolean; user: string; from: string; imapHost: string; imapPort: number; google: { connected: string | null; clientId: string; redirect: string | null } };

/** What the overview and the group pages show, as the settings handler read it for this person. */
export type SettingsFacts = {
  /** The person: an approver (can manage and approve), an instance operator, signed in in a browser. */
  name: string; approver: boolean; operator: boolean; browser: boolean;
  /** Installation-wide settings are this person's to see: not a project-limited account (the bot token, defaults…). */
  installation: boolean;
  said: string | null; problem: string | null;
  theme: "system" | "light" | "dark"; accent: string;
  version: string | null;
  permission: { mode: UnattendedPermissionMode; canManage: boolean; changed: string | null } | null;
  quality: { mode: QualityMode; canManage: boolean; changed: string | null } | null;
  providers: ProviderFacts[] | null;
  workers: WorkerFacts[] | null;
  updates: BrowserUpdates | null;
  firstResult: string | null;
  chat: { mode: "quiet" | "all"; digestAt: string | null; screenshots?: ResultScreenshots; projects?: { repo: string; name: string; muted: boolean }[] } | null;
  messaging: { channel: string | null; implicit: boolean; configured: string[]; legacyWarning?: string } | null;
  push: { available: boolean; devices: { id: number; words: string; state: "ok" | "failing" | "expired"; removable: boolean }[] } | null;
  digest: { every: string; held: string | null } | null;
  telegram: { state: string; current: string; delivery: string | null; failing: boolean };
  email: EmailFacts | null;
  phone: BrowserPhoneCard | null;
  projects: { repo: string; name: string }[];
  people: { approvers: string[]; viewers: string[]; invites: number } | null;
  passwordless: boolean | null;
  sso: string | null;
  access: { sessions: number; tokens: number };
  backup: { failed: boolean; words: string } | null;
  /** Easy-start: local mode is on for this laptop install. `owner`: this is the local owner's own session (no password);
   * `passwordSet`: the owner has set one; `canTurnOff`: a full session of an instance operator. Absent when it is off. */
  local?: { owner: boolean; passwordSet: boolean; canTurnOff: boolean } | null;
  /** Settings → Advanced: this person's own switch (`on`), whether they can change it here (a browser sign-in), and
   * whether a visible project runs under an operating mode now (its link then stays, whatever the switch). */
  advanced?: { on: boolean; canChange: boolean; modeActive?: boolean };
  /** Settings → Projects → Projects folder: absent where it doesn't apply (an unscoped console opens anything). */
  projectsFolder?: ProjectsFolderFacts | null;
};

/** The projects folder as Settings shows it: each folder (its real path and how a person reads it), and what this
 * person can do about it. `blocked`: why they can't change it (null when they can). */
export type ProjectsFolderFacts = {
  folders: readonly { path: string; shown: string }[];
  blocked: null | "ask" | "set-password" | "sign-in" | "elsewhere";
};

const CHAT_APPS = [["telegram", "Telegram"], ["slack", "Slack"], ["discord", "Discord"], ["teams", "Teams"]] as const;
const and = (names: readonly string[]): string => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
const groupHref = (slug: string): string => SETTINGS_GROUPS.find(([, one]) => one === slug)?.[2] ?? "/settings";
const groupLabel = (slug: string): string => SETTINGS_GROUPS.find(([, one]) => one === slug)?.[0] ?? "Settings";
const sentence = (text: string): string => text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
/** A notice the handler sent back with the page (?said= or ?problem=), in place under the page's lead. */
const answered = (facts: SettingsFacts): Html => facts.problem ? notice(sentence(facts.problem)) : facts.said ? infoLine(sentence(facts.said)) : html``;

// ---- what waits on this person ----------------------------------------------------------------------------------

export type NeedsItem = { group: string; title: string; text: string; action: readonly [label: string, href: string] };
/** What waits on this person in Settings (never a task): no builder, a chat app failing, a failed backup. Read-only. */
export function settingsNeeds(facts: SettingsFacts): NeedsItem[] {
  const out: NeedsItem[] = [];
  if (facts.workers !== null && facts.approver && !facts.workers.some(one => one.tone === "ok")) {
    out.push({ group: "agents", title: facts.workers.length === 0 ? "Nothing is taking work" : "Nothing is taking work right now",
      text: "Approved work waits until a computer builds it. Run toolroll up on the computer with your projects.", action: ["Start taking work", "/settings/agents#workers"] });
  }
  if (facts.telegram.failing) out.push({ group: "alerts", title: "Telegram isn’t delivering", text: facts.telegram.delivery ?? "Alerts to your phone are failing.", action: ["Open Telegram", "/settings/telegram"] });
  if (facts.backup?.failed) out.push({ group: "system", title: "The last backup failed", text: facts.backup.words, action: ["Open backups", "/settings/backups"] });
  return out;
}
/** Which groups have something waiting, for the section nav's dot and the overview's rows. */
export function needsByGroup(items: readonly NeedsItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.group] = (out[item.group] ?? 0) + 1;
  return out;
}
const flagsOf = (counts: Record<string, number>): Record<string, boolean> => Object.fromEntries(Object.keys(counts).map(key => [key, true]));

// ---- the overview -----------------------------------------------------------------------------------------------

const themeWords = (theme: string): string => theme === "light" ? "Light" : theme === "dark" ? "Dark" : "Match this device";
function agentsWords(facts: SettingsFacts): string {
  const signed = facts.providers?.find(one => one.connection !== null && one.tone === "ok") ?? facts.providers?.find(one => one.tone === "ok");
  const builders = facts.workers === null ? null : facts.workers.filter(one => one.tone === "ok").length;
  return [signed ? `${signed.name}: ${signed.words}` : facts.providers === null ? "Models, chat and tools" : "No agent signed in yet",
    builders === null ? null : builders === 0 ? "not taking work yet" : "taking work"].filter(Boolean).join(" · ");
}
function alertsWords(facts: SettingsFacts): string {
  const configured = facts.messaging?.configured ?? [];
  if (configured.length === 0) return "No chat app yet: alerts stay in Toolroll";
  const receiving = facts.messaging?.channel ?? (configured.length === 1 ? configured[0]! : null);
  const name = (id: string) => CHAT_APPS.find(([one]) => one === id)?.[1] ?? id;
  return [receiving ? `${name(receiving)}: alerts go here` : "Several chat apps: choose one", facts.telegram.failing ? "Telegram is failing" : null].filter(Boolean).join(" · ");
}
function approvalWords(facts: SettingsFacts): string {
  return [facts.permission ? `New tasks: ${facts.permission.mode === "bypassPermissions" ? "Full access" : "Auto"}` : null,
    facts.quality ? `${qualityModeTitle(facts.quality.mode)} quality` : null, "Who approves, and what runs without asking"].filter(Boolean).join(" · ");
}
function accessWords(facts: SettingsFacts): string {
  const people = facts.people === null ? null : [facts.people.approvers.length ? `${and(facts.people.approvers)} can manage and approve` : "",
    facts.people.viewers.length ? `${and(facts.people.viewers)} can view` : ""].filter(Boolean).join(" · ");
  return [people || "Who can get in", facts.passwordless === null || passwordFree(facts) ? null : facts.passwordless ? "Passwordless on" : "Passwordless off"].filter(Boolean).join(" · ");
}
function systemWords(facts: SettingsFacts): string {
  const latest = facts.updates?.latest;
  const version = facts.updates === null ? (facts.version === null ? null : `Toolroll ${facts.version}`)
    : latest !== null && latest?.newer ? `Toolroll ${facts.updates.current} · ${latest.version} is available` : `Toolroll ${facts.updates.current}`;
  return [facts.backup?.failed ? "The last backup failed" : null, version, "backups, storage, retention, monitoring"].filter(Boolean).join(" · ");
}

/** The overview: what waits on this person, then one row per group with its state. Viewers see the groups they can open. */
/**
 * Easy-start C5: local mode, said once. The local owner without a password is offered the one way to more ("Let agents
 * work on their own" → /password/set); a full session of an operator sees it on, and can turn it off (a step-up, confirmed).
 */
function localModeSection(facts: SettingsFacts): Html {
  const local = facts.local;
  if (local === undefined || local === null) return html``;
  if (local.owner) {
    return local.passwordSet ? html`` : settingsSection({ id: "set-password", title: "Let agents work on their own",
      lead: "Agents can work on their own, merge and release only after you set a password.",
      body: html`<div class="k-acts">${btn("Set a password", { sm: true, href: "/password/set?next=%2Fsettings" })}</div>` });
  }
  if (!local.canTurnOff) return html``;
  return settingsSection({ id: "local-mode", title: "Local mode", state: " · on",
    lead: "A browser on this computer can file tasks, approve plans and add projects without your password.",
    body: kitSectionForm({ proof: "local-mode-off", action: "/settings/local-mode/off", id: "local-mode-form", save: { label: "Turn off", variant: "outline" },
      confirm: "Turn off local mode", body: html`` }) });
}

export function settingsHub(facts: SettingsFacts): Html {
  const items = settingsNeeds(facts);
  const counts = needsByGroup(items);
  const words: Record<string, string> = {
    general: [`Theme: ${themeWords(facts.theme).toLowerCase()}`, facts.version === null ? null : `Toolroll ${facts.version}`].filter(Boolean).join(" · "),
    agents: agentsWords(facts),
    alerts: alertsWords(facts),
    approval: approvalWords(facts),
    projects: facts.projects.length === 0 ? "No projects yet" : `${plural(facts.projects.length, "project", "projects")} · network, checks, pull requests and tools for each`,
    access: accessWords(facts),
    spend: "Monthly limits and the spend report",
    system: systemWords(facts),
  };
  const shown = SETTINGS_GROUPS.filter(([, slug]) => slug !== "spend" || facts.operator).filter(([, slug]) => slug !== "system" || facts.operator || facts.approver)
    .filter(([, slug]) => slug !== "spend" || advancedOn(facts));
  words["advanced"] = advancedWords(facts);
  const panel = needsPanel(items.map((item, index) => ({ title: item.title, text: item.text, action: btn(item.action[0], { variant: index === 0 ? "primary" : "outline", href: item.action[1] }) })));
  return settingsShell({
    group: "hub", title: "Settings", flags: flagsOf(counts),
    body: joinHtml([
      answered(facts),
      panel,
      facts.local?.owner === true ? localModeSection(facts) : "",
      settingsLinks(null, shown.map(([label, slug, href]) => settingsLink({ href, title: label, status: words[slug] ?? "", icon: SETTINGS_GROUP_ICONS[slug]!, needs: counts[slug] ?? 0 }))),
    ]),
  });
}

/** The hub's old anchors, forwarded to their group (fragments never reach the server). */
export const HUB_ANCHORS: Readonly<Record<string, string>> = {
  providers: "/settings/agents#providers", workers: "/settings/agents#workers", email: "/settings/alerts#email", "settings-chat-apps": "/settings/alerts#chat-apps",
  "telegram-token": "/settings/alerts#telegram-token", phone: "/settings/alerts#phone", notifications: "/settings/alerts#notifications",
  updates: "/settings/system#updates", accent: "/settings/general#appearance", appearance: "/settings/general#appearance",
};
export const HUB_ANCHOR_SCRIPT = `(function(){var m=${JSON.stringify(HUB_ANCHORS)};var h=decodeURIComponent(location.hash.slice(1));if(Object.prototype.hasOwnProperty.call(m,h))location.replace(m[h]);})();`;

// ---- General ----------------------------------------------------------------------------------------------------

const ACCENT_CHOICES = ACCENT_PRESETS.slice(0, 6);
export function generalGroup(facts: SettingsFacts, flags: Record<string, boolean>): Html {
  const themeButton = (value: string, label: string) =>
    html`<button type="submit" name="theme" value="${value}" aria-pressed="${String(facts.theme === value)}">${label}</button>`;
  const custom = ACCENT_CHOICES.some(one => one.hex === facts.accent) ? null : facts.accent;
  const accentNoteWords = accentNote(facts.accent);
  const appearance = settingsSection({
    id: "appearance", title: "Appearance", state: " · saved for this browser",
    body: joinHtml([
      formRow("Theme", "Light, dark, or whatever this device uses.", postForm("/settings/appearance", html`<div class="k-seg" role="group" aria-label="Theme">${themeButton("system", "Match device")}${themeButton("light", "Light")}${themeButton("dark", "Dark")}</div>`, { returnTo: "/settings/general" })),
      kitSectionForm({ proof: "appearance", action: "/settings/appearance", id: "accent", gate: true, hidden: { return: "/settings/general" },
        body: joinHtml([
          formRow("Accent", "Buttons, focus and what needs you.",
            select({ name: "accent", label: "Accent", current: facts.accent, items: [...ACCENT_CHOICES.map(one => [one.hex, one.id === "ink" ? "Ink (default)" : one.name] as const), ...(custom === null ? [] : [[custom, `Your own colour (${custom})`] as const])] })),
          accentNoteWords === null ? "" : note(accentNoteWords),
        ]) }),
      disclose("Use your own colour", kitSectionForm({ proof: "appearance", action: "/settings/appearance", id: "accent-own", gate: true, hidden: { return: "/settings/general" },
        body: formRow("Your own colour", "Six hex digits, like #6e56cf.", input({ id: "accent-hex", name: "accent", value: custom ?? "", attrs: { placeholder: "#6e56cf", spellcheck: "false", autocomplete: "off", "aria-label": "Your own colour", pattern: "#?[0-9a-fA-F]{6}", required: true } })) }), custom !== null),
    ]),
  });
  const browser = settingsSection({
    id: "this-browser", title: "This browser",
    body: joinHtml([
      formRow("Remembered password", "After you type your password, standard approvals skip it on this computer for 15 minutes. Forget ends that now.",
        facts.browser ? postForm("/session/forget-password", btn("Forget now", { sm: true, type: "submit" }), { returnTo: "/settings/general" }) : html``, "inline"),
    ]),
  });
  const password = settingsSection({
    id: "your-password", title: "Your password",
    body: joinHtml([
      formRow("Where it is", "If you started Toolroll with toolroll up, your password is saved on the computer running Toolroll. Toolroll never shows it in a browser. To read it, run this there:", html``, "wide"),
      codeLine("cat ~/.config/toolroll/.toolroll-secrets/up-login.txt"),
      facts.passwordless === null ? "" : formRow("Passwordless", "Sign in once; most approvals then need no password.", btn(`${facts.passwordless ? "On" : "Off"} · Change`, { sm: true, href: "/settings/passwordless" }), "inline"),
    ]),
  });
  const version = facts.version === null ? "" : settingsSection({
    id: "version", title: "Version",
    body: joinHtml([
      formRow("Toolroll", facts.firstResult ?? "Installed on this computer.", html`<span class="k-mono">${facts.version}</span>`, "inline"),
      facts.operator ? formRow("Updates", null, btn("Open updates", { sm: true, variant: "ghost", href: "/settings/updates" }), "inline") : "",
    ]),
  });
  // The password sections only where a password exists: a password-free owner has none to remember or look up.
  const withPassword = passwordFree(facts) ? [] : [browser, password];
  return settingsShell({ group: "general", title: "General", lead: "How Toolroll looks and behaves in this browser.", flags, body: joinHtml([answered(facts), appearance, ...withPassword, version]) });
}

// ---- Agents and models ------------------------------------------------------------------------------------------

const toneChip = (tone: Tone, words: string): Html => chip(words, tone === "ok" ? "done" : tone === "warn" ? "failed" : "");
function providerRecord(one: ProviderFacts): Html {
  const form = kitSectionForm({ proof: "provider-key", action: "/settings/provider-key", id: `provider-${one.provider}`, gate: true, hidden: { provider: one.provider }, save: { label: `Save ${one.name}` },
    body: joinHtml([
      one.connection === null ? "" : formRow("Sign-in", `${one.connection.words}${one.connection.facts ? ` · ${one.connection.facts}` : ""}`,
        html`<button class="k-btn k-btn-ghost k-btn-sm" type="submit" formaction="/settings/connection/check" formnovalidate><span class="k-face">Check again</span></button>`, "inline"),
      one.subscriptionCapable ? formRow("How it’s paid", `${one.usage} · ${one.envName}`, select({ name: "auth-mode", label: `How ${one.name} is paid`, current: one.mode, items: [["subscription", `${one.name} subscription`], ["api-key", "API key"]] })) : note(`${one.usage} · ${one.envName}`),
      formRow(`${one.name} API key`, "Stored privately on this computer and never shown again. Saving a key needs no password; it isn’t a way into Toolroll.",
        html`<input class="k-input" id="key-${one.provider}" type="password" name="value" autocomplete="off" spellcheck="false" autocapitalize="none" data-so-secret data-1p-ignore data-lpignore="${SECRET_OPT_OUTS["data-lpignore"]}" data-bwignore data-form-type="other" aria-label="${one.name} API key" placeholder="${one.set ? "Paste to replace the stored key" : "Paste a key"}">`),
    ]) });
  const remove = one.set ? kitSectionForm({ proof: "provider-key", action: "/settings/provider-key-clear", id: `provider-${one.provider}-clear`, hidden: { provider: one.provider }, save: { label: "Remove key", variant: "danger" },
    body: note("Runs that use this API key stop until you add one again.") }) : "";
  return settingsRecord({ title: html`${one.name} ${toneChip(one.tone, one.words)}`, sub: one.connection === null ? one.usage : `${one.connection.words}${one.connection.facts ? ` · ${one.connection.facts}` : ""}`,
    attrs: { "data-provider": one.provider }, more: disclose(`Manage ${one.name}`, joinHtml([form, remove])) });
}
function workersSection(workers: WorkerFacts[]): Html {
  return settingsSection({
    id: "workers", title: "Builders", lead: "The computers that build approved work, and what each runs now.",
    body: workers.length === 0
      ? joinHtml([note("No builder is connected. Run this on the computer with your projects:"), codeLine("toolroll up")])
      : joinHtml([
          ...workers.map(one => settingsRecord({
            title: html`<span class="k-mono">${one.name}</span> ${chip(one.state, one.tone === "ok" ? "done" : one.tone === "off" ? "failed" : "")}`,
            sub: one.running.length === 0 ? "Nothing running" : joinHtml(one.running.map(task => html`<a class="k-link" href="${task.href}">${task.title}</a>${task.project === null ? "" : html` <span class="k-muted">${task.project}</span>`}`), " · "),
            when: html`<span class="k-num">${one.busy} of ${one.capacity}</span> running`, attrs: { "data-worker": one.name },
          })),
          note(html`To change how many a builder runs at once: <code class="k-mono">toolroll runner capacity &lt;name&gt; &lt;n&gt;</code>`),
        ]),
  });
}
export function agentsGroup(facts: SettingsFacts, flags: Record<string, boolean>): Html {
  const providers = facts.providers === null ? "" : settingsSection({
    id: "providers", title: "How agents are paid for", lead: "A plan first; an API key is used when the agent is set to it, or for agents without a plan. Keys stay on this computer.",
    body: joinHtml([...facts.providers.map(providerRecord), note(html`<a class="k-link" href="/control">Set up a project’s builder</a>`)]),
  });
  const links = settingsLinks("In this group", [
    settingsLink({ href: "/settings/models", title: "Models", status: "Which model plans, builds and reviews" }),
    settingsLink({ href: "/settings/lead", title: "Chat", status: "The assistant you chat with" }),
    ...(advancedOn(facts) ? [settingsLink({ href: "/settings/lead/subagents", title: "Subagents", status: "Helpers the lead looks after" })] : []),
    settingsLink({ href: "/settings/tools", title: "Tools", status: "What builds can use, per project" }),
    ...(advancedOn(facts) ? [settingsLink({ href: "/settings/skills", title: "Skills", status: "Reusable instructions for agents" })] : []),
    settingsLink({ href: "/settings/knowledge", title: "Knowledge", status: "What agents know about each project" }),
    ...(advancedOn(facts) ? [settingsLink({ href: "/settings/learning", title: "Learning", status: "Lessons kept from finished work" })] : []),
  ]);
  return settingsShell({
    group: "agents", title: "Agents and models", lead: "Which agent does the work, how it’s paid for, and which model plans, builds and reviews.", flags,
    body: joinHtml([answered(facts), providers, facts.workers === null ? "" : workersSection(facts.workers), links]),
  });
}

// ---- Chat apps and alerts ---------------------------------------------------------------------------------------

function chatAppsSection(facts: SettingsFacts): Html {
  const configured = facts.messaging?.configured ?? [];
  const receiving = facts.messaging?.channel ?? (configured.length === 1 ? configured[0]! : null);
  return settingsSection({
    id: "chat-apps", title: "Chat apps", lead: "Get alerts on your phone and answer from it. Each app has its own steps.",
    body: settingsLinks(null, CHAT_APPS.map(([id, name]) => settingsLink({
      href: `/settings/${id}`, title: name, needs: id === "telegram" && facts.telegram.failing ? 1 : 0,
      status: facts.messaging === null ? "Set up" : !configured.includes(id) ? "Not set up" : id === "telegram" && facts.telegram.failing ? "Has a problem" : receiving === id && !facts.messaging.implicit ? "Alerts go here" : "Connected",
    })), { label: "Chat apps" }),
  });
}
function reachSection(facts: SettingsFacts): Html {
  if (facts.chat === null) return html``;
  const chat = facts.chat;
  const form = kitSectionForm({ proof: "notifications", action: "/settings/notifications", id: "reach-form", gate: true,
    body: joinHtml([
      formRow("Chat messages", null, radios({ name: "mode", legend: "Chat messages", current: chat.mode, items: [
        { value: "quiet", label: "Only when I’m needed", text: "One message per task, updated as it moves." },
        { value: "all", label: "Every step", text: "A new message for each update." }] }), "wide"),
      formRow("Evening digest", "One message: what finished, what waits, what failed.", select({ name: "digest", label: "Evening digest", current: chat.digestAt ?? "off", items: digestTimes(chat.digestAt) })),
      formRow("Screenshots with results", null, select({ name: "screenshots", label: "Screenshots with results", current: chat.screenshots ?? "off", items: RESULT_SHOT_CHOICES })),
    ]) });
  const projects = (chat.projects ?? []).length === 0 ? "" : joinHtml([
    ...chat.projects!.map(one => kitSectionForm({ proof: "notifications-mute", action: "/settings/notifications/mute", id: `mute-${one.repo.replace(/[^a-z0-9]+/gi, "-")}`, gate: true, hidden: { repo: one.repo },
      body: formRow(one.name, one.muted ? "Muted: no pings" : "Pings on", switchInput({ id: `pings-${one.repo.replace(/[^a-z0-9]+/gi, "-")}`, name: "pings", label: "Pings", on: !one.muted, attrs: { "aria-label": `Pings for ${one.name}` } }), "inline") })),
    note("Muted projects still show in Tasks and the evening digest."),
  ]);
  return settingsSection({ id: "notifications", title: "What reaches you", body: joinHtml([form, projects]) });
}
function serviceSection(facts: SettingsFacts): Html {
  const services = facts.messaging;
  if (services === null || services.configured.length < 2 && !services.implicit) return html``;
  const name = (id: string) => CHAT_APPS.find(([one]) => one === id)?.[1] ?? id;
  return settingsSection({ id: "alert-service", title: "Where alerts go", lead: "Alerts go through one app, so you are never notified twice. Telegram still takes taps and replies when another app sends alerts.",
    body: kitSectionForm({ proof: "messaging", action: "/settings/messaging", id: "messaging-form", gate: true,
      body: joinHtml([services.implicit ? note("Several are connected and none was chosen. Pick one.") : "",
        radios({ name: "primary", legend: "Where alerts go", current: services.channel ?? "", items: services.configured.map(one => ({ value: one, label: name(one), text: one === "telegram" ? "Answer buttons and replies" : "Messages with links; acting stays here" })) })]) }) });
}
function digestSection(facts: SettingsFacts): Html {
  if (facts.digest === null) return html``;
  return settingsSection({ id: "telegram-digest", title: "Telegram digest", lead: "Bundle routine updates. Anything that needs you still arrives at once.",
    body: kitSectionForm({ proof: "telegram-digest", action: "/settings/telegram-digest", id: "digest-form", gate: true, said: facts.digest.held,
      body: formRow("Send a digest", null, select({ name: "every", label: "Send a digest", current: facts.digest.every, items: [["off", "Off: send each update"], ["30", "Every 30 minutes"], ["60", "Every hour"], ["240", "Every 4 hours"], ["720", "Every 12 hours"], ["1440", "Once a day"]] })) }) });
}
function pushSection(facts: SettingsFacts): Html {
  if (facts.push === null) return html``;
  const push = facts.push;
  const enrol = push.available
    ? kitSectionForm({ proof: "push-subscribe", action: "/push/subscribe", id: "push-form", hidden: { endpoint: "", p256dh: "", auth: "" }, save: { label: "Get alerts on this device", variant: "outline" }, native: true,
        confirm: "Get alerts on this device", body: html`<p class="k-note" id="push-state" aria-live="polite"></p>` })
    : note("Alerts need a secure (https) address for this app.");
  return settingsSection({ id: "this-device", title: "This device", lead: "A notification when something needs you. On iPhone, add this app to your Home Screen first.",
    body: joinHtml([
      ...push.devices.map(one => settingsRecord({ title: one.words, sub: one.state === "ok" ? "" : one.state === "failing" ? "Failing" : "Expired",
        action: one.removable ? postForm("/push/remove", btn(`Remove ${one.words.split(" · ")[0] ?? "device"}`, { sm: true, variant: "ghost", type: "submit" }), { hidden: { id: one.id } }) : "" })),
      enrol,
    ]) });
}
/** Enrolling this device fills the subscription the form posts; it never reads the password beside it. With the kit's
 * section forms (section-forms.ts) it answers their `k-prepare` hook after the password is confirmed, so the post
 * goes exactly once under the pending guard; without them it holds the plain submit, then posts. */
export function pushScriptOf(facts: SettingsFacts): string | null {
  if (facts.push === null || !facts.push.available) return null;
  return `(function(){` +
    `if(!("serviceWorker" in navigator)||!("PushManager" in window))return;` +
    `var link=document.createElement("link");link.rel="manifest";link.href="/manifest.webmanifest";document.head.appendChild(link);` +
    `navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(function(){});` +
    `function fill(form){var state=document.getElementById("push-state");` +
    `return Notification.requestPermission().then(function(granted){` +
    `if(granted!=="granted")return "Notifications are blocked for this site in the browser settings.";` +
    `return fetch("/push/key").then(function(r){return r.json();}).then(function(d){` +
    `return navigator.serviceWorker.ready.then(function(reg){` +
    `return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(d.key.replace(/-/g,"+").replace(/_/g,"/")),function(c){return c.charCodeAt(0);})});});` +
    `}).then(function(sub){var raw=sub.toJSON();` +
    `form.querySelector("[name=endpoint]").value=sub.endpoint;` +
    `form.querySelector("[name=p256dh]").value=(raw.keys.p256dh||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
    `form.querySelector("[name=auth]").value=(raw.keys.auth||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
    `return null;});` +
    `}).catch(function(){return "Couldn’t subscribe: the browser said no.";}).then(function(problem){if(problem&&state)state.textContent=problem;return problem;});}` +
    `function wire(){var form=document.getElementById("push-form");if(!form||form.dataset.pushWired)return;form.dataset.pushWired="1";` +
    `form.setAttribute("data-k-prepare","");` +
    `form.addEventListener("k-prepare",function(e){fill(form).then(function(problem){e.detail.done(problem);});});` +
    `form.addEventListener("submit",function(event){if(document.documentElement.classList.contains("k-js")||form.dataset.ready==="1")return;` +
    `event.preventDefault();fill(form).then(function(problem){if(problem)return;form.dataset.ready="1";form.submit();});});}` +
    `wire();window.addEventListener("standing-orders:workspace-rendered",wire);` +
    `})();`;
}
function emailSection(email: EmailFacts): Html {
  const google = email.google.connected;
  const status = google !== null ? `${google}, through Google` : email.set ? `From ${email.from} through ${email.host}${email.imapHost === "" ? "" : ` · reads ${email.imapHost}`}` : "Not set up";
  const smtp = kitSectionForm({ proof: "email", action: "/settings/email", id: "email-form", gate: true, save: { label: "Save email" },
    body: joinHtml([
      note("For Gmail: smtp.gmail.com, port 587, your address, and an app password. To read mail too, add imap.gmail.com."),
      formRow("Mail server", null, input({ id: "email-host", name: "host", value: email.host, attrs: { placeholder: "smtp.gmail.com", required: true, "aria-label": "Mail server" } })),
      formRow("Port", null, input({ id: "email-port", name: "port", type: "number", value: String(email.port), attrs: { min: 1, max: 65535, required: true, "aria-label": "Port" } })),
      formRow("Send from", null, input({ id: "email-from", name: "from", type: "email", value: email.from, attrs: { placeholder: "you@example.com", required: true, "aria-label": "Send from" } })),
      formRow("Username", "Usually the same address.", input({ id: "email-user", name: "user", value: email.user, attrs: { autocomplete: "off", "aria-label": "Username" } })),
      formRow("Mail server password", email.set ? "Leave empty to keep the saved one." : "An app password.", html`<input class="k-input" id="email-password" type="password" name="password" autocomplete="off" data-so-secret data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" aria-label="Mail server password">`),
      formRow("Use SSL from the start", "Port 465.", switchInput({ id: "email-secure", name: "secure", label: "SSL", on: email.secure, attrs: { "aria-label": "Use SSL from the start" } }), "inline"),
      formRow("Read mail from", "Optional.", input({ id: "email-imap", name: "imapHost", value: email.imapHost, attrs: { placeholder: "imap.gmail.com", "aria-label": "Read mail from" } })),
      formRow("Reading port", null, input({ id: "email-imap-port", name: "imapPort", type: "number", value: String(email.imapPort), attrs: { min: 1, max: 65535, "aria-label": "Reading port" } })),
    ]) });
  const tests = email.set ? postForm("/settings/email-test", html`<div class="k-acts">${btn("Send a test email", { sm: true, type: "submit" })}${email.imapHost === "" ? "" : btn("Check the inbox", { sm: true, type: "submit", attrs: { formaction: "/settings/email-read-test" } })}</div>`) : "";
  const googleConnected = google === null ? "" : postForm("/settings/google/disconnect", joinHtml([
    note(html`Signed in with Google as <b>${google}</b>. Mail is sent and read through it.`),
    html`<div class="k-acts">${btn("Send a test email", { sm: true, type: "submit", attrs: { formaction: "/settings/email-test" } })}${btn("Check the inbox", { sm: true, type: "submit", attrs: { formaction: "/settings/email-read-test" } })}${btn("Disconnect Google", { sm: true, variant: "ghost", type: "submit" })}</div>`,
  ]));
  const googleSetup = google !== null ? "" : disclose("Or sign in with a Google account", kitSectionForm({ proof: "google", action: "/settings/google", id: "google-form", save: { label: "Connect Google" }, native: true,
    body: joinHtml([
      html`<ol class="k-note"><li>In Google Cloud Console, make an OAuth client of type Web application, and set the consent screen to In production (while it’s in Testing, Google ends the connection after 7 days).</li>\
${email.google.redirect === null ? html`<li>Open these settings on this computer (localhost) or at your https address to see the redirect address to add.</li>` : html`<li>Add this as an authorized redirect address: <code class="k-mono" data-google-redirect>${email.google.redirect}</code></li>`}\
<li>Paste the client ID and secret here, then connect. Google warns that it hasn’t verified the app: it’s your own, so continue.</li></ol>`,
      formRow("Client ID", null, input({ id: "google-id", name: "clientId", value: email.google.clientId, attrs: { placeholder: "….apps.googleusercontent.com", required: true, "aria-label": "Client ID" } })),
      formRow("Client secret", email.google.clientId !== "" ? "Leave empty to keep the saved one." : null, html`<input class="k-input" id="google-secret" type="password" name="clientSecret" autocomplete="off" data-so-secret data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" aria-label="Client secret">`),
    ]) }), email.google.clientId !== "" && !email.set);
  return settingsSection({ id: "email", title: "Email", state: ` · ${status}`, lead: "Send email steps send from this account, and Email inbox triggers read it.",
    body: google !== null ? googleConnected : joinHtml([disclose(email.set ? "Change the mail server" : "Set up a mail server", joinHtml([smtp, tests]), !email.set && email.google.clientId === ""), googleSetup]) });
}
function telegramTokenSection(facts: SettingsFacts): Html {
  return settingsSection({ id: "telegram-token", title: "Telegram bot token", state: ` · ${facts.telegram.state}`,
    body: joinHtml([
      note(`Current: ${facts.telegram.current}`),
      facts.telegram.delivery === null ? "" : html`<p class="k-note" data-telegram-delivery>${facts.telegram.delivery}</p>`,
      kitSectionForm({ proof: "telegram-token", action: "/settings/telegram-token", id: "telegram-token-form", gate: true, save: { label: "Save token" },
        body: formRow("Token from @BotFather", "Stored privately on this computer. Then pair your phone on the Telegram page.",
          html`<input class="k-input" id="telegram-token-field" type="password" name="token" autocomplete="off" data-so-secret data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" aria-label="Token from @BotFather">`) }),
      note(html`In Telegram, send <code class="k-mono">/status</code>, <code class="k-mono">/task &lt;id&gt;</code> or <code class="k-mono">/help</code>; these use no AI model.`),
    ]) });
}
function phoneSection(phone: BrowserPhoneCard): Html {
  return settingsSection({ id: "phone", title: "Phone access", lead: "Open Toolroll itself on your phone, over your own private network.",
    body: html`<p class="k-note" data-phone-tailnet>${phone.tailnet === null ? html`Install <a class="k-link" href="https://tailscale.com/download">Tailscale</a> on this computer and your phone, then reload this page for the address.`
      : phone.tailnet.restart === null ? html`On your phone, open <code class="k-mono">${phone.tailnet.address}</code> and sign in.`
      : html`Start Toolroll with <code class="k-mono">${phone.tailnet.restart}</code>, then on your phone open <code class="k-mono">${phone.tailnet.address}</code> and sign in.`}</p>` });
}
export function alertsGroup(facts: SettingsFacts, flags: Record<string, boolean>): Html {
  const legacy = facts.messaging?.legacyWarning ? note(html`Legacy webhooks are deprecated. Connect <a class="k-link" href="/settings/slack">Slack</a> or <a class="k-link" href="/settings/discord">Discord</a> instead.`) : "";
  return settingsShell({
    group: "alerts", title: "Chat apps and alerts", lead: "What reaches you, where, and how.", flags,
    body: joinHtml([answered(facts), legacy, chatAppsSection(facts), reachSection(facts), serviceSection(facts), digestSection(facts), pushSection(facts),
      facts.phone === null ? "" : phoneSection(facts.phone), facts.email === null ? "" : emailSection(facts.email), facts.approver && facts.browser && facts.installation ? telegramTokenSection(facts) : ""]),
  });
}

// ---- Approvals and safety (its own handler supplies the project's rules) ----------------------------------------

export type ApprovalGroupFacts = {
  facts: Pick<SettingsFacts, "permission" | "quality" | "said" | "problem">;
  flags: Record<string, boolean>;
  projects: { repo: string; name: string }[];
  chosen: string;
  /** The project's approval rules and release approval, drawn by approval-rules-ui.ts (kit markup). */
  rules: Html;
  mode: string;
  /** Settings → Advanced: this person's switch, whether a project they can see runs under an operating mode now, and
   * the organisation policy in words when any restriction applies (advanced.ts policyInForce; null: none). */
  advanced?: { on: boolean; modeActive: boolean; policy?: string | null };
};
export function approvalGroup(view: ApprovalGroupFacts): Html {
  const facts = view.facts;
  const defaults = facts.permission === null && facts.quality === null ? "" : settingsSection({
    id: "defaults", title: "Defaults for new tasks", lead: "Approved tasks keep their own setting.",
    body: joinHtml([
      facts.permission === null ? "" : facts.permission.canManage
        ? kitSectionForm({ proof: "permission-default", action: "/settings/permission-default", id: "permission-form", gate: true, proofWhen: ["permission-mode", "bypassPermissions"],
            said: facts.permission.changed, confirm: "Start new tasks with Full access",
            body: formRow("Unattended permissions", "Full access lets builds run any command without asking. Choosing it asks for your password.",
              radios({ name: "permission-mode", legend: "Unattended permissions", current: facts.permission.mode, items: [
                { value: "auto", label: "Auto", text: "Asks before risky actions." },
                { value: "bypassPermissions", label: "Full access", text: "Never asks and can change files anywhere on this computer. Trusted repositories only." }] }), "wide") })
        : formRow("Unattended permissions", "An approver can change this.", html`<span>${facts.permission.mode === "bypassPermissions" ? "Full access" : "Auto"}</span>`, "inline"),
      facts.quality === null ? "" : facts.quality.canManage
        ? kitSectionForm({ proof: "quality-default", action: "/settings/quality-default", id: "quality-form", gate: true, said: facts.quality.changed,
            body: formRow("Quality", "Publishing and deploying still need their own approval.", radios({ name: "quality-mode", legend: "Quality", current: facts.quality.mode, items: [
              { value: "default", label: "Default", text: "Everyday agents and the repository check." },
              { value: "strict", label: "Strict / release", text: "Strongest agents. Release approval stays separate." }] }), "wide") })
        : formRow("Quality", "An approver can change this.", html`<span>${qualityModeTitle(facts.quality.mode)}</span>`, "inline"),
    ]),
  });
  const picker = view.projects.length > 1
    ? html`<form method="get" action="/settings/approval" class="k-acts">${select({ name: "repo", label: "Project", current: view.chosen, items: view.projects.map(one => [one.repo, one.name] as const) })}${btn("Show", { sm: true, type: "submit" })}</form>`
    : html``;
  const rules = view.chosen === "" ? settingsSection({ id: "rules", title: "Approval rules", body: note("Add a project to set its approval rules.") })
    : joinHtml([picker, view.rules]);
  const links = settingsLinks("In this group", [
    // Settings → Advanced off: Operating mode stays while a mode is active (its terms and End it live there).
    ...(view.advanced === undefined || view.advanced.on || view.advanced.modeActive ? [settingsLink({ href: "/mode", title: "Operating mode", status: view.mode })] : []),
    // Policy stays while any restriction applies (or can't be read), with what it is now.
    ...(view.advanced === undefined || view.advanced.on || (view.advanced.policy ?? null) !== null
      ? [settingsLink({ href: "/settings/policy", title: "Policy", status: view.advanced?.policy ?? "Limits no task can go past, whatever its mode or approver" })] : []),
    settingsLink({ href: "/caps", title: "Requirements", status: "What builders are missing for waiting work" }),
    settingsLink({ href: "/settings/projects", title: "Network, writes and sandbox", status: "Set for each project" }),
  ]);
  return settingsShell({
    group: "approval", title: "Approvals and safety", lead: "How much runs without asking, and who approves the rest.", flags: view.flags,
    body: joinHtml([answered(facts as SettingsFacts), defaults, rules,
      note(html`<b>Which setting wins:</b> protected work and policy limits always apply; then a project’s operating mode; then these defaults.`), links]),
  });
}

// ---- Projects, People and sign-in, System -----------------------------------------------------------------------

export function projectsGroup(facts: SettingsFacts, flags: Record<string, boolean>): Html {
  const rows = facts.projects.map(one => settingsLink({ href: `/settings/project?repo=${encodeURIComponent(one.repo)}`, title: one.name, status: html`<span class="k-mono">${one.repo}</span>` }));
  const per = facts.projects.length === 0 ? "" : settingsLinks("For each project", [
    settingsLink({ href: "/settings/checks", title: "Checks", status: "What runs after each build" }),
    settingsLink({ href: "/settings/pull-requests", title: "Pull requests", status: "How finished work reaches GitHub" }),
    settingsLink({ href: "/settings/tools", title: "Tools", status: "What builds can use" }),
    settingsLink({ href: "/control", title: "Builder setup", status: "Agent, model and preparation command" }),
  ]);
  return settingsShell({
    group: "projects", title: "Projects", lead: "Each project has its own network, writes, checks, pull requests and tools.", flags,
    body: joinHtml([answered(facts), projectsFolderSection(facts.projectsFolder ?? null),
      facts.projects.length === 0
        ? settingsSection({ id: "projects", title: "Projects", body: note(html`No projects yet. <a class="k-link" href="/projects">Add one on Projects</a>.`) })
        : settingsLinks("Projects", rows),
      per]),
  });
}

/** What a person who can't choose the projects folder reads instead, by why. */
export function projectsFolderBlockedHtml(blocked: Exclude<ProjectsFolderFacts["blocked"], null>, next = "/settings/projects"): Html {
  if (blocked === "set-password") return joinHtml([note("Choosing a projects folder needs a password. Set one first."),
    html`<div class="k-acts">${btn("Set a password", { sm: true, href: `/password/set?next=${encodeURIComponent(next)}` })}</div>`]);
  if (blocked === "sign-in") return note("Sign in with your password to choose a projects folder.");
  if (blocked === "elsewhere") return note("This Toolroll’s projects folder is set where it’s started.");
  return note("Ask whoever runs this Toolroll to choose a projects folder.");
}

/** Settings → Projects → Projects folder: the folder Toolroll adds projects from, with Change (the picker) and Stop
 * using. Stopping only narrows, so it is one click; choosing is the picker's step-up. */
function projectsFolderSection(view: ProjectsFolderFacts | null): Html {
  if (view === null) return html``;
  const can = view.blocked === null;
  const rows = view.folders.map(one => formRow("Folder", null, html`<span class="k-mono">${one.shown}</span>${can
    ? kitSectionForm({ proof: "projects-folder-remove", action: "/settings/projects-folder/remove", id: `pf-remove-${view.folders.indexOf(one)}`, hidden: { path: one.path, return: "/settings/projects" },
      save: { label: "Stop using", variant: "outline" }, body: html`` })
    : ""}`, "inline"));
  return settingsSection({
    id: "projects-folder", title: "Projects folder", state: view.folders.length === 0 ? " · not chosen" : "",
    lead: "Toolroll can add any git repository inside it.",
    body: joinHtml([
      ...rows,
      can ? html`<div class="k-acts">${btn(view.folders.length === 0 ? "Choose a folder" : "Change folder", { sm: true, variant: view.folders.length === 0 ? "primary" : "outline", href: "/settings/projects-folder" })}</div>`
        : projectsFolderBlockedHtml(view.blocked ?? "ask"),
    ]),
  });
}

export function accessGroup(facts: SettingsFacts, flags: Record<string, boolean>): Html {
  const people = facts.people;
  const links = [
    settingsLink({ href: "/people", title: "People", status: people === null ? "Your own access" : [accessWords({ ...facts, passwordless: null }), people.invites === 0 ? "no open invites" : plural(people.invites, "open invite", "open invites")].join(" · ") }),
    settingsLink({ href: "/settings/sessions", title: "Sessions and tokens", status: `Signed in on ${plural(facts.access.sessions, "device", "devices")} · ${plural(facts.access.tokens, "API token", "API tokens")}` }),
    // Settings → Advanced off: each stays while it is set up or on (its state and its off switch), and goes otherwise.
    ...(facts.operator && (advancedOn(facts) || facts.sso !== null) ? [
      settingsLink({ href: "/settings/sign-in", title: "Sign-in with a provider", status: facts.sso === null ? "Not set up: everyone uses a password" : `People sign in with ${facts.sso}` })] : []),
    ...(facts.operator && (advancedOn(facts) || facts.passwordless === true) ? [
      settingsLink({ href: "/settings/passwordless", title: "Passwordless", status: facts.passwordless ? "On: signing in is the only password" : "Off: approvals ask for your password" })] : []),
  ];
  return settingsShell({ group: "access", title: "People and sign-in", lead: "Who can get in, how they sign in, and the ways in they hold.", flags,
    body: joinHtml([answered(facts), localModeSection(facts), settingsLinks(null, links, { label: "People and sign-in" })]) });
}

function updatesSection(updates: BrowserUpdates): Html {
  const latest = updates.latest;
  const newer = latest !== null && latest.newer ? latest : null;
  const state = newer ? html`${newer.version} is available` : !updates.check.on ? "Checks are off" : latest === null ? "Not checked yet" : "Up to date";
  return settingsSection({ id: "updates", title: "Updates", state: html` · ${state}`,
    body: joinHtml([
      formRow("This version", newer?.security ? "The newer version has security fixes." : null, html`<span class="k-mono">${updates.current}</span>`, "inline"),
      newer === null ? "" : joinHtml([note("Run this on this computer, then restart Toolroll:"), codeLine(updates.updateCommand),
        html`<div class="k-acts">${btn("Release notes", { sm: true, variant: "ghost", href: newer.url })}</div>`,
        newer.notes === "" ? "" : disclose(`What’s new in ${newer.version}`, html`<pre class="k-scode">${newer.notes}</pre>`)]),
      updates.check.canManage && !updates.check.byEnv
        ? postForm("/settings/updates/checks", formRow("Check once a day", "One anonymous request to npm and GitHub. Nothing about you is sent.",
            btn(updates.check.on ? "Turn off" : "Turn on", { sm: true, type: "submit" }), "inline"), { hidden: { check: updates.check.on ? "off" : "on" } })
        : updates.check.byEnv ? note("Daily checks are off by TOOLROLL_NO_UPDATE_CHECK.") : "",
      ...updates.workers.map(one => formRow(one.name, one.older ? "Older than this computer" : null, html`<span class="k-mono">${one.version ?? "Version not reported"}</span>`, "inline")),
    ]) });
}
export function systemGroup(facts: SettingsFacts, flags: Record<string, boolean>): Html {
  const links = facts.operator ? settingsLinks("In this group", [
    settingsLink({ href: "/settings/updates", title: "Updates", status: facts.updates === null ? "Toolroll’s own version" : `Toolroll ${facts.updates.current}` }),
    settingsLink({ href: "/settings/backups", title: "Backups", status: facts.backup?.words ?? "When and where the database is copied", needs: facts.backup?.failed ? 1 : 0 }),
    settingsLink({ href: "/settings/storage", title: "Storage", status: "Task folders on this computer, and cleaning them up" }),
    settingsLink({ href: "/settings/retention", title: "Retention", status: "How long run logs and chats are kept" }),
    ...(advancedOn(facts) ? [settingsLink({ href: "/settings/monitoring", title: "Monitoring", status: "Send the audit stream and traces to your own systems" })] : []),
    settingsLink({ href: "/settings/data", title: "Data export", status: "Everything except secrets, as one download" }),
    settingsLink({ href: "/settings/integrations", title: "Integrations", status: "Which connected services work" }),
    ...(advancedOn(facts) ? [settingsLink({ href: "/fleet", title: "Builders", status: "Every computer that builds, on Agents" })] : []),
  ]) : settingsLinks("In this group", [
    settingsLink({ href: "/settings/integrations", title: "Integrations", status: "Which connected services work" }),
    ...(advancedOn(facts) ? [settingsLink({ href: "/fleet", title: "Builders", status: "Every computer that builds" })] : []),
  ]);
  return settingsShell({ group: "system", title: "System", lead: "This Toolroll’s version, backups, storage and what leaves this computer.", flags,
    body: joinHtml([answered(facts), facts.updates === null ? "" : updatesSection(facts.updates), links]) });
}

/** One group page by its slug. */
export function settingsGroupPage(group: SettingsGroup, facts: SettingsFacts): Html {
  const flags = flagsOf(needsByGroup(settingsNeeds(facts)));
  switch (group) {
    case "hub": return settingsHub(facts);
    case "general": return generalGroup(facts, flags);
    case "agents": return agentsGroup(facts, flags);
    case "alerts": return alertsGroup(facts, flags);
    case "projects": return projectsGroup(facts, flags);
    case "access": return accessGroup(facts, flags);
    case "system": return systemGroup(facts, flags);
    case "advanced": return advancedGroup(facts, flags);
    case "approval": return settingsHub(facts);
  }
}
export const groupTitle = (group: SettingsGroup): string => group === "hub" ? "Settings" : groupLabel(group);
export { groupHref };

/** A settings sub-page in the frame: the group's breadcrumb, the page's title, its old body inside. */
export function settingsSubPage(group: string, title: string, body: HtmlValue, options: { lead?: string; flags?: Record<string, boolean> } = {}): Html {
  return settingsShell({ group, title, sub: true, body, ...(options.lead === undefined ? {} : { lead: options.lead }), ...(options.flags === undefined ? {} : { flags: options.flags }) });
}

// ---- Operating mode (/mode) -------------------------------------------------------------------------------------

export type ModePageView = {
  project: string; name: string; maxDays: number; approver: boolean; hasMergeGrant: boolean;
  said: string | null; problem: string | null;
  live: { name: string; signedBy: string; until: string; words: string[] } | null;
};
/** /mode: the mode a project runs under now, and (for an approver) the choices to sign a new one. Reading the terms is
 * the next page (/mode/confirm), where the password signs exactly what it shows. */
export function modePageHtml(view: ModePageView): Html {
  const now = settingsSection({ id: "mode-now", title: "Now",
    body: view.live === null
      ? formRow("Locked", "No mode is signed: every plan and merge waits for a person. That is the default.", html`<span class="k-muted">No mode signed</span>`, "inline")
      : joinHtml([
          settingsRecord({ title: html`${view.name} ${chip(view.live.name === "hands-off" ? "Hands-off" : "Standard", "live")}`, sub: `Signed by ${view.live.signedBy} · ends ${view.live.until}`,
            action: view.approver ? postForm("/mode/revoke", btn("End this mode now", { sm: true, type: "submit" })) : "" }),
          html`<ul class="k-note">${view.live.words.map(words => html`<li>${words}</li>`)}</ul>`,
          view.approver ? note("Ending it is one click: every act it covered goes back to asking a person.") : "",
        ]) });
  const sign = !view.approver ? note("An approver of this project signs its operating mode.") : settingsSection({
    id: "mode-sign", title: view.live === null ? `Sign a mode for ${view.name}` : `Replace it with a new mode for ${view.name}`,
    lead: "Choose what may run without asking. The next page shows every term in words, and your password signs exactly those.",
    body: postForm("/mode/confirm", joinHtml([
      formRow("Preset", null, radios({ name: "name", legend: "Preset", current: "standard", items: [
        { value: "standard", label: "Standard", text: "Approvals stay with you." },
        { value: "hands-off", label: "Hands-off", text: "Tasks you file approve themselves and run with full permissions." }] }), "wide"),
      formRow("Lasts", `Days, from now: 1 to ${view.maxDays}.`, input({ id: "mode-days", name: "days", type: "number", value: "1", attrs: { min: 1, max: view.maxDays, "aria-label": "Lasts, in days" } })),
      formRow("Merges", view.hasMergeGrant ? null : "Merging by itself needs a merge grant on the project first.", select({ name: "publication", label: "Merges", current: "notify",
        items: [["notify", "Wait for me"], ...(view.hasMergeGrant ? [["automerge", "Merge when CI passes on the exact commit"] as const] : [])] })),
      formRow("Tasks I file", null, select({ name: "auto-approve", label: "Tasks I file", current: "",
        items: [["", "The preset’s choice"], ["1", "Approve them as I file them"], ["0", "Wait for their own approval"]] })),
      formRow("Plans", "Needs tasks to approve as you file them. Changed scope and open questions still wait for you.", select({ name: "plan-auto", label: "Plans", current: "0",
        items: [["0", "Wait for a person"], ["1", "Approve plans that keep what I filed"]] })),
      formRow("Approving from a chat app", "Plans that widen permissions, go past the attempt limit or touch protected paths still open Toolroll.", select({ name: "chat-approve", label: "Approving from a chat app", current: "",
        items: [["", "Here, with my password"], ["1", "In my paired chat app, two taps"]] })),
      formRow("Failed checks", "A repair stays inside the plan you approved. When it can't, or the tries run out, it comes to you.", select({ name: "repair-auto", label: "Failed checks", current: "",
        items: [["", "Wait for me to start a repair"], ["1", "Repair them, up to 2 tries"]] })),
      html`<div class="k-acts">${btn("Review the terms", { variant: "primary", type: "submit" })}</div>`,
    ])) });
  const answer = view.problem ? notice(sentence(view.problem)) : view.said ? infoLine(sentence(view.said)) : "";
  return settingsSubPage("approval", "Operating mode", joinHtml([answer, now, sign]),
    { lead: "A signed, time-limited mode that lets more run without asking. It ends on its own. Scope changes, agent questions and requested revisions still wait for you." });
}

/** /mode/confirm: every resolved term in words; the password signs exactly this digest (a changed form is refused). */
export function modeCeremonyHtml(view: { name: string; project: string; words: string[]; chatApprove: boolean; repairAuto: boolean; hidden: Readonly<Record<string, string>> }): Html {
  return settingsSubPage("approval", `Sign the ${view.name} mode`, joinHtml([
    settingsSection({ id: "mode-terms", title: `What you sign for ${view.project}`,
      body: html`<ul class="k-ssec-lead">${view.words.map(words => html`<li>${words}</li>`)}</ul>` }),
    kitSectionForm({ proof: view.repairAuto ? "mode-sign-repair" : view.chatApprove ? "mode-sign-chat-approve" : "mode-sign", action: "/mode/sign", id: "mode-sign-form", native: true, hidden: view.hidden,
      save: { label: "Sign it" }, confirm: `Sign the ${view.name} mode for ${view.project}`, body: html`` }),
    note(html`<a class="k-link" href="/mode">Back, and sign nothing</a>`),
  ]));
}

// ---- People (/people) -------------------------------------------------------------------------------------------

export type PersonView = {
  name: string; you: boolean; approver: boolean; projects: readonly string[] | null; projectNames: string;
  revoked: string | null; seen: string; joined: string; activity: string; acts: string[];
};
export type PeopleView = {
  operator: boolean; you: string; said: string | null; problem: string | null;
  people: PersonView[];
  invites: { id: number; role: "approver" | "viewer"; projects: string; from: string; expires: string; attempts: number }[];
  projects: { repo: string; name: string }[];
  /** The project the invite form starts with (the open one). */
  openProject: string | null;
  filers: { name: string; words: string }[];
};
const roleWords = (approver: boolean): string => approver ? "Can manage and approve" : "Can view";
function accessFields(id: string, projects: PeopleView["projects"], selected: readonly string[] | null): Html {
  return joinHtml([
    formRow("Projects", "With all projects, someone who can manage and approve also manages this Toolroll.", select({ name: "access", label: "Project access", current: selected === null ? "all" : "selected",
      items: [["selected", "Only the projects ticked below"], ["all", "All projects"]] })),
    projects.length === 0 ? note("Add a project before giving access to some projects only.")
      : html`<fieldset class="k-sopts"><legend class="k-sr">Projects</legend>${projects.map((one, at) => html`<label class="k-sopt" for="${id}-p${at}"><input type="checkbox" id="${id}-p${at}" name="projects" value="${one.repo}"${selected?.includes(one.repo) ? html` checked` : ""}><span><b>${one.name}</b></span></label>`)}</fieldset>`,
  ]);
}
/** People: who can get in, what each can do and where, open invites, and inviting someone. Inviting and widening
 * access always ask for the password typed now; removing someone or cancelling an invite is a step-up. */
export function peopleHtml(view: PeopleView): Html {
  const answer = view.problem ? notice(sentence(view.problem)) : view.said ? infoLine(sentence(view.said)) : "";
  const people = settingsSection({ id: "people", title: "People", state: html` <span class="k-count">${view.people.filter(one => one.revoked === null).length}</span>`,
    body: joinHtml(view.people.map((one, index) => {
      const slug = `person-${index}`;
      const edit = !view.operator || one.revoked !== null ? "" : joinHtml([
        kitSectionForm({ proof: "people-projects", action: "/people/projects", id: `${slug}-access`, gate: true, hidden: { name: one.name }, save: { label: "Save access" },
          confirm: `Change ${one.name}’s projects`, body: joinHtml([accessFields(`${slug}-access`, view.projects, one.projects), note("Changing access signs this person out and ends their sessions and modes. Work they approved stays recorded.")]) }),
        one.you ? "" : kitSectionForm({ proof: "people-close", action: "/people/revoke", id: `${slug}-remove`, hidden: { name: one.name }, save: { label: `Remove ${one.name}`, variant: "danger" },
          confirm: `Remove ${one.name}’s sign-in`, body: note("Ends their access and everything it signed. History stays.") }),
      ]);
      const recent = one.acts.length === 0 ? note("No recorded acts yet.") : note(`Recent: ${one.acts.slice(0, 3).join(" · ")}`);
      return settingsRecord({
        title: html`${one.name}${one.you ? html` <span class="k-muted">(you)</span>` : ""}${one.revoked === null ? "" : html` ${chip("Removed", "")}`}`,
        sub: one.revoked ?? `${roleWords(one.approver)} · ${one.projectNames}`, when: one.seen,
        action: btn("Activity", { sm: true, variant: "ghost", href: one.activity }),
        more: edit === "" ? (view.operator ? recent : "") : disclose(`Edit ${one.name}`, joinHtml([recent, edit])),
        attrs: { "data-person": one.name },
      });
    })) });
  const invites = !view.operator ? "" : settingsSection({ id: "invites", title: "Invites",
    body: joinHtml([
      view.invites.length === 0 ? note("No open invites.") : joinHtml(view.invites.map(one => settingsRecord({
        title: roleWords(one.role === "approver"), sub: `${one.projects} · from ${one.from}${one.attempts > 0 ? ` · ${plural(one.attempts, "failed attempt", "failed attempts")}` : ""}`, when: `Expires ${one.expires}`,
        action: kitSectionForm({ proof: "people-close", action: "/people/invite-revoke", id: `invite-${one.id}-cancel`, hidden: { id: one.id }, save: { label: "Cancel invite", variant: "outline" }, confirm: "Cancel this invite", body: html`` }),
      }))),
      disclose("Invite someone", kitSectionForm({ proof: "people-invite", action: "/people/invite", id: "invite-form", native: true, save: { label: "Create invite link" }, confirm: "Invite someone",
        body: joinHtml([
          formRow("They can", null, radios({ name: "role", legend: "They can", current: "viewer", items: [
            { value: "viewer", label: "Can view", text: "Read work in their projects." },
            { value: "approver", label: "Can manage and approve", text: "Create, manage and approve work in their projects." }] }), "wide"),
          accessFields("invite", view.projects, view.openProject === null ? [] : [view.openProject]),
          note("The link works once, for one person, and expires in 72 hours. An invite creates a new way in, so it always asks for your password."),
        ]) }), view.invites.length === 0),
    ]) });
  const filers = view.filers.length === 0 ? "" : settingsSection({ id: "agent-filers", title: "Agent filers", lead: "Agents that can propose tasks. You approve what runs.",
    body: joinHtml([...view.filers.map(one => settingsRecord({ title: html`<span class="k-mono">${one.name}</span>`, sub: one.words })),
      note(html`To revoke one, run <code class="k-mono">toolroll coordinator revoke &lt;cid&gt; --as you</code> on this computer.`)]) });
  return settingsSubPage("access", "People", joinHtml([answer, people, invites, filers]), { lead: "Who can see and approve work in this Toolroll." });
}

/** People for someone limited to some projects: their own access, in words. */
export function ownAccessHtml(view: { name: string; approver: boolean; projects: string[]; activity: string }): Html {
  return settingsSubPage("access", "Your access", joinHtml([
    settingsSection({ id: "your-access", title: `${view.name} · ${roleWords(view.approver)}`, lead: view.approver ? "You can create, manage and approve work in these projects." : "You can read work in these projects.",
      body: joinHtml([...view.projects.map(name => formRow(name, null, html``, "inline")), note("An instance operator manages invites and project access."),
        html`<div class="k-acts">${btn("Your activity", { sm: true, href: view.activity })}</div>`]) }),
  ]));
}

/** The invite link, once, on a page with no script: selectable text, what it lets them do, and where to cancel it. */
export function inviteLinkHtml(view: { link: string; approver: boolean; projects: string; expires: string }): Html {
  return settingsSubPage("access", "Invite link", joinHtml([
    settingsSection({ id: "invite-link", title: "Shown once, so copy it now",
      body: joinHtml([html`<p class="k-secret-val">${view.link}</p>`,
        note(`Send it to one person. It works once, lets them ${view.approver ? "manage and approve work" : "read work"} in ${view.projects}, and expires ${view.expires}. Cancel it any time on People.`),
        html`<div class="k-acts">${btn("Back to People", { sm: true, href: "/people" })}</div>`]) }),
  ]));
}

// ---- Passwordless (/settings/passwordless) ----------------------------------------------------------------------

/** The switch and the trade in plain words. Turning it on is a way in: it always asks for the password typed now.
 * Turning it off is one click. */
export function passwordlessHtml(view: { on: boolean; since: string | null; trade: string; said: string | null; problem: string | null }): Html {
  const answer = view.problem ? notice(sentence(view.problem)) : view.said ? infoLine(sentence(view.said)) : "";
  const control = view.on
    ? postForm("/settings/passwordless", html`<div class="k-acts">${btn("Turn Passwordless off", { type: "submit" })}</div>`, { hidden: { action: "off" } })
    : kitSectionForm({ proof: "passwordless-on", action: "/settings/passwordless", id: "passwordless-form", hidden: { action: "on" }, save: { label: "Turn Passwordless on" },
        confirm: "Turn Passwordless on", body: html`` });
  return settingsSubPage("access", "Passwordless", joinHtml([
    answer,
    settingsSection({ id: "passwordless", title: `Passwordless is ${view.on ? "on" : "off"}`, state: view.since === null ? "" : ` · ${view.since}`,
      lead: "When it’s on, signing in is the only password: approvals, settings, budgets, signing a mode and starting a terminal no longer ask again, in the browser, on the phone, and in this computer’s toolroll command (through its remembered login).",
      body: joinHtml([note(view.trade), control]) }),
  ]), { lead: "Sign in once; most approvals then need no password." });
}

/** Which project a per-project settings page shows: a GET form (an address, not a save). */
export function projectPicker(action: string, projects: readonly { repo: string; name: string }[], chosen: string): Html {
  if (projects.length < 2) return html``;
  return html`<form method="get" action="${action}" class="k-acts k-picker">${select({ name: "repo", label: "Project", current: chosen, items: projects.map(one => [one.repo, one.name] as const) })}${btn("Show", { sm: true, type: "submit" })}</form>`;
}

/** The local owner's own session with no password set (local mode): password words and sections are left out. Presentation
 * only: what needs a password is decided where it is asked, never here. */
function passwordFree(facts: SettingsFacts): boolean {
  return facts.local?.owner === true && !facts.local.passwordSet;
}

// ---- Advanced (/settings/advanced; the eight plan, W4) -----------------------------------------------------------

/** This person's switch as the facts carry it: absent (an older caller) reads on, so nothing hides by accident. */
function advancedOn(facts: SettingsFacts): boolean { return facts.advanced === undefined || facts.advanced.on; }
function advancedWords(facts: SettingsFacts): string {
  return advancedOn(facts) ? "On: every page shows in the menus" : "Off: menus show only the main steps";
}

/** Settings → Advanced: the person's own switch, then every advanced page, always (whatever the switch says). */
export function advancedGroup(facts: SettingsFacts, flags: Record<string, boolean>): Html {
  const on = advancedOn(facts);
  const change = facts.advanced?.canChange === true
    ? postForm("/settings/advanced", btn(on ? "Turn off" : "Turn on", { sm: true, type: "submit" }), { hidden: { advanced: on ? "off" : "on" } })
    : html``;
  const toggle = settingsSection({ id: "show-advanced", title: "Show advanced features", state: on ? " · on" : " · off", right: change,
    lead: "Flows, other computers, spend limits, operating modes and the rest, in your menus. They keep working either way, and each opens from below.",
    body: html`` });
  const pages = ADVANCED_PAGES.filter(one => one.operator !== true || facts.operator)
    .map(one => settingsLink({ href: one.href, title: one.title, status: one.words }));
  return settingsShell({ group: "advanced", title: "Advanced", lead: "Everything beyond filing, approving and accepting work.", flags,
    body: joinHtml([answered(facts), toggle, settingsLinks("Advanced pages", pages)]) });
}
