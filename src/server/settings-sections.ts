/**
 * Settings sections (the eight settings plan v2 §2): admission, data scope and action capability decided BEFORE any
 * of a section's readers run, the one canonical project a Settings page shows, the check a session-bound act makes
 * against the project its form was rendered for, and the General area's sections.
 *
 * - `admitSection` runs the section's pinned route policy (the console's own `holdsRole`, callers, the project-limited
 *   and local-owner rules) and its named read checks. A section it refuses is never loaded, drawn or sent.
 * - Loaders get only a `SectionContext`: the admitted person, the canonical project, the clock, the person's own view
 *   preferences, and the data scopes and act capabilities admission decided. Never the request.
 * - `renderArea` draws an area's admitted sections: each section's summary, and its detail only when asked
 *   (`?section=<id>&open=1`); `changeDocument` draws one section's change document.
 *
 * Nothing here proves an act: every form posts to its existing route, which proves it again.
 */
import { ADVANCED_PAGES } from "../advanced-view.js";
import { accentNote, ACCENT_PRESETS } from "../accent-colors.js";
import type { Authority } from "../local-owner.js";
import { installModeLine, justMeAllowed, TEAM_FACT_WORDS, type InstallModeRead, type TeamFact } from "../install-mode.js";
import { html, joinHtml, postForm, type Html } from "../html.js";
import { kitSectionForm } from "../settings-kit.js";
import { evaluateRoutePolicy, holdsRole, type RoutePrincipal } from "./route-policy.js";
import type { LimitedAccess, ProjectResolver } from "./route-table.js";
import { btn, codeLine, disclose, doc, docHeader, formRow, infoLine, input, notice, phoneHeader, select, settingsLink, settingsSection } from "./kit.js";
import { changeDocumentOf, changeHref, sectionHref, SETTINGS_SECTIONS, type SectionDeclaration, type SectionGate, type SettingsArea } from "./settings-section-table.js";

// ---- who is asking -------------------------------------------------------------------------------------------------

/** The person a Settings page is drawn for, as the console proved them (no request, no cookie). */
export type SectionPerson = {
  readonly name: string;
  readonly via: "cookie" | "bearer";
  readonly role: "approver" | "viewer";
  /** A browser session's own authority (an API token is full). */
  readonly authority: Authority;
  readonly operator: boolean;
  /** A project-limited account. */
  readonly restricted: boolean;
  /** Installation-wide settings are theirs to see (settingsHome's `!minimal`). */
  readonly installation: boolean;
  /** The demo's sandbox (it registers and retires nothing). */
  readonly demo: boolean;
  readonly passwordSet: boolean;
  /** The request's proven capability, exactly as the console hands it to evaluateRoutePolicy (serve.ts): an API
   * token's own scope (a read token reads, whatever its person's role), else the person's role. */
  readonly principal: RoutePrincipal;
  /** The console shows every project with none open (no opener), so `needsProject` never applies. */
  readonly unscopedConsole: boolean;
};

/** Whether one named check holds for this person. */
export function gateHolds(gate: SectionGate, person: SectionPerson): boolean {
  switch (gate) {
    case "installation": return person.installation && !person.restricted;
    case "cookie-session": return person.via === "cookie";
    case "full-session": return person.via === "cookie" && person.authority === "full";
    // An instance operator's browser session, as the old handlers' inline `operator` read it.
    case "operator": return person.via === "cookie" && person.operator;
    case "approver": return person.role === "approver";
    case "password-holder": return !(person.via === "cookie" && person.authority !== "full" && !person.passwordSet);
    case "whole-installation": return !person.restricted;
    case "not-demo": return !person.demo;
  }
}

export type Admission =
  | { readonly ok: true; readonly scopes: ReadonlySet<string>; readonly can: Readonly<Record<string, boolean>> }
  | { readonly ok: false; readonly why: "caller" | "scope" | "project" | "local" | "limited" | "role" | `read:${SectionGate}` };

/**
 * READ admission, then DATA SCOPE and ACTION CAPABILITY, for one section, in the console's own order and with its own
 * functions: the local owner's mark; evaluateRoutePolicy with the request's proven capability (callers, scope, then the
 * project: the project-limited rule and a project the page needs); holdsRole; then the section's own read checks.
 * Runs before any of the section's loaders.
 */
/** The project resolvers and project-limited rules a Settings section may carry; anything else is refused. */
const SECTION_RESOLVERS: ReadonlySet<ProjectResolver> = new Set<ProjectResolver>(["none", "session", "form", "form-path"]);
const SECTION_LIMITED: ReadonlySet<LimitedAccess> = new Set<LimitedAccess>(["deny", "collection", "unscoped", "self", "conversation"]);

export function admitSection(declaration: Pick<SectionDeclaration, "policy" | "read" | "scope" | "act">, person: SectionPerson, project: string | null = null): Admission {
  const policy = declaration.policy;
  if (person.via === "cookie" && person.authority !== "full" && policy.local !== "allow") return { ok: false, why: "local" };
  let why: "limited" | "project" | null = null;
  const projectAdmits = (source: ProjectResolver): boolean => {
    // Only the project rules Settings sections are built for: a section page resolves no other kind of object (a task,
    // a run, a proposal, a conversation, an adapter), so any other resolver or limited rule is refused before a loader
    // runs rather than approximated (fail closed; Codex settings F0 r2).
    if (!SECTION_RESOLVERS.has(source) || !SECTION_LIMITED.has(policy.limited)) { why = "project"; return false; }
    // guards.ts projectRequestAllowed: what a project-limited account may do here, by the policy's `limited` column.
    if (person.restricted && (policy.limited === "deny" || policy.limited === "conversation")) { why = "limited"; return false; }
    if (person.restricted && policy.limited !== "unscoped" && policy.limited !== "self" && project === null) { why = "limited"; return false; }
    // serve.ts handleGet: a browser session with nothing open is sent to the opener first where the page needs one.
    if (policy.needsProject && person.via === "cookie" && project === null && !person.unscopedConsole) { why = "project"; return false; }
    return true;
  };
  const checked = evaluateRoutePolicy(policy, person.principal, projectAdmits);
  if (!checked.ok) return { ok: false, why: checked.reason === "project" ? why ?? "project" : checked.reason };
  if (!holdsRole(policy, person, name => name === person.name && person.operator)) return { ok: false, why: "role" };
  for (const gate of declaration.read) if (!gateHolds(gate, person)) return { ok: false, why: `read:${gate}` };
  const scopes = new Set(Object.entries(declaration.scope).filter(([, gates]) => gates.every(gate => gateHolds(gate, person))).map(([name]) => name));
  const can = Object.fromEntries(Object.entries(declaration.act).map(([act, gates]) => [act, gates.every(gate => gateHolds(gate, person))]));
  return { ok: true, scopes, can };
}

// ---- the one project a Settings page shows (plan v2 §2.3) ---------------------------------------------------------

export type ProjectResolution = { readonly ok: true; readonly project: string | null; readonly requested: boolean } | { readonly ok: false; readonly status: 400 | 404; readonly message: string };
/** One message for an unknown project and a foreign one, so nothing says whether it exists. */
export const PROJECT_NOT_AVAILABLE = "That project is not available in this workspace.";

/**
 * The canonical project of a Settings request, decided once before admission: the one `repo` it names (two is a 400),
 * else the session's open project, else none. A named project must be one this console shows AND one this person may
 * open; anything else is one 404 with the same words.
 */
export function resolveSettingsProject(url: URL, session: string | null, deps: { readonly projects: () => readonly string[]; readonly canOpen: (repo: string) => boolean }): ProjectResolution {
  const named = url.searchParams.getAll("repo");
  if (named.length > 1) return { ok: false, status: 400, message: "Name one project." };
  if (named.length === 1) {
    const repo = named[0]!;
    if (repo === "" || !deps.projects().includes(repo) || !deps.canOpen(repo)) return { ok: false, status: 404, message: PROJECT_NOT_AVAILABLE };
    return { ok: true, project: repo, requested: true };
  }
  return { ok: true, project: session, requested: false };
}

export type SessionProjectCheck = { readonly ok: true; readonly project: string } | { readonly ok: false; readonly rendered: string | null; readonly session: string | null; readonly message: string };
/**
 * Round 2, change 2: immediately before a session-bound act (operating mode, setup, control), the project the form was
 * drawn for (its hidden `repo`) must still be the session's open project. Another tab may have opened a different one
 * since; then nothing changes and the person is offered to open the drawn project again.
 */
export function sessionProjectCheck(posted: readonly string[], session: string | null, projectName: (repo: string) => string): SessionProjectCheck {
  if (posted.length !== 1 || posted[0] === "") return { ok: false, rendered: null, session, message: "This form names no project. Open the project and try again." };
  const rendered = posted[0]!;
  if (session === null || rendered !== session) {
    return { ok: false, rendered, session, message: `${projectName(rendered)} is no longer the open project${session === null ? "" : ` (${projectName(session)} is)`}. Nothing changed.` };
  }
  return { ok: true, project: rendered };
}

/** The recovery a refused session-bound act offers: open the project the form was drawn for, then come back. */
export function openProjectAgain(rendered: string, name: string, back: string): Html {
  return postForm("/projects/select", btn(`Open ${name}`, { sm: true, type: "submit", variant: "primary" }), { hidden: { path: rendered, return: back } });
}

// ---- what a section is given ----------------------------------------------------------------------------------------

/** A person's own view preferences, as their request carries them (presentation only). */
export type SectionPrefs = { readonly theme: "system" | "light" | "dark"; readonly accent: string; readonly advanced: boolean };

export type SectionContext = {
  readonly person: SectionPerson;
  readonly project: string | null;
  readonly now: Date;
  readonly prefs: SectionPrefs;
  /** The data scopes and act capabilities admission decided for this section. */
  readonly scopes: ReadonlySet<string>;
  readonly can: Readonly<Record<string, boolean>>;
};

export type SectionView<S, D> = {
  readonly declaration: SectionDeclaration;
  readonly ctx: SectionContext;
  readonly summary: S;
  readonly detail: D | null;
  /** This section is the one `?section=` names. */
  readonly asked: boolean;
  /** The attributes its root element carries (`data-section`, and focus for the asked one). */
  readonly attrs: Readonly<Record<string, string | null>>;
};

export type SectionImpl<S = unknown, D = unknown> = {
  /** The section's summary facts, or null when it has nothing to show this person. */
  readonly loadSummary: (ctx: SectionContext) => S | null;
  /** Its detail, read only on `?section=<id>&open=1`. */
  readonly loadDetail?: (ctx: SectionContext) => D;
  readonly render: (view: SectionView<S, D>) => Html;
  /** Its change document's body (the form), for a section with one; `summary` null: nothing to change now. */
  readonly renderChange?: (view: Omit<SectionView<S | null, D>, "summary"> & { summary: S | null; problem: string | null; document: string }) => { title: string; body: Html };
  /** What a person without the act capability hears on the change document. */
  readonly refusal?: string;
};
export type SectionImpls = Readonly<Record<string, SectionImpl<never, never>>>;

/** What `?section=` and `open=1` ask for (one value each, else nothing). */
export function askedSection(url: URL): { section: string | null; open: boolean } {
  const sections = url.searchParams.getAll("section");
  const section = sections.length === 1 && /^[a-z][a-z-]{0,39}$/.test(sections[0]!) ? sections[0]! : null;
  return { section, open: section !== null && url.searchParams.getAll("open").length === 1 && url.searchParams.get("open") === "1" };
}

/** What a page hands its sections: the admitted person, the canonical project, the clock and their own preferences. */
export type SectionBase = { person: SectionPerson; project: string | null; now: Date; prefs: SectionPrefs };
type Base = SectionBase;

/** An area's admitted sections, in table order: each one's summary, and the asked one's detail when it opens. */
export function renderArea(area: SettingsArea, impls: SectionImpls, base: Base, asked: { section: string | null; open: boolean }, declarations: readonly SectionDeclaration[] = SETTINGS_SECTIONS): { sections: Html[]; jump: Html; shown: string[] } {
  const sections: Html[] = [];
  const shown: string[] = [];
  let jump: Html = html``;
  for (const declaration of declarations.filter(one => one.area === area)) {
    const impl = impls[declaration.id] as SectionImpl<unknown, unknown> | undefined;
    if (impl === undefined) throw new Error(`settings section ${declaration.id} has no implementation`);
    const admitted = admitSection(declaration, base.person, base.project);
    if (!admitted.ok) continue;
    const ctx: SectionContext = { ...base, scopes: admitted.scopes, can: admitted.can };
    const summary = impl.loadSummary(ctx);
    if (summary === null) continue;
    const isAsked = asked.section === declaration.id;
    const detail = isAsked && asked.open && declaration.opens && impl.loadDetail !== undefined ? impl.loadDetail(ctx) : null;
    sections.push(impl.render({ declaration, ctx, summary, detail, asked: isAsked, attrs: { "data-section": declaration.id, tabindex: isAsked ? "-1" : null } }));
    shown.push(declaration.id);
    // Without scripts the page still says where the asked section is, once, at the top.
    if (isAsked) jump = html`<p class="k-note k-jump"><a href="#${declaration.id}">Jump to ${declaration.title}</a></p>`;
  }
  return { sections, jump, shown };
}

export type ChangeAnswer = { ok: true; title: string; body: Html } | { ok: false; status: 403 | 404; message: string };
/** One section's change document: admitted as the section is, and only for a person with its act capability. */
export function changeDocument(id: string, impls: SectionImpls, base: Base, problem: string | null): ChangeAnswer {
  const change = changeDocumentOf(id);
  const declaration = change?.section;
  const impl = declaration === undefined ? undefined : impls[declaration.id] as SectionImpl<unknown, unknown> | undefined;
  if (change === undefined || declaration === undefined || impl?.renderChange === undefined) return { ok: false, status: 404, message: "There's no page at this address." };
  const admitted = admitSection(declaration, base.person, base.project);
  if (!admitted.ok || admitted.can[change.act] !== true) return { ok: false, status: 403, message: impl.refusal ?? "You can't change this here." };
  const ctx: SectionContext = { ...base, scopes: admitted.scopes, can: admitted.can };
  const drawn = impl.renderChange({ declaration, ctx, summary: impl.loadSummary(ctx), detail: null, asked: true, attrs: {}, problem, document: change.id });
  return { ok: true, ...drawn };
}

// ---- General (/settings/general) ------------------------------------------------------------------------------------

/** What General's sections read, none of it from the request. */
export type GeneralDeps = {
  /** The version Settings → Updates reports to this person (null where updates aren't set up here). */
  readonly updatesVersion: (name: string) => string | null;
  readonly packageVersion: string;
  /** When the first Ready result arrived, in words. */
  readonly firstResult: (now: Date) => string | null;
  readonly passwordless: () => boolean;
  /** Local mode as saved: on, or not. */
  readonly localModeOn: () => boolean;
  /** The install's solo or team mode, as the server derives it now (install-mode.ts). */
  readonly installMode: () => InstallModeRead;
  /** Task sizing by a quick model call, as saved (task-sizing.ts taskSizingSetting). */
  readonly taskSizing: () => { on: boolean; chosen: boolean; sizer: "claude" | "jev" | null; available: "claude" | "jev"; byEnv: boolean };
  /** Interactive agent threads (beta), as saved (flexible-available.ts flexibleSetting). */
  readonly flexible: () => { on: boolean };
};

const ACCENT_CHOICES = ACCENT_PRESETS.slice(0, 6);
const back = "/settings/general";

function appearanceSection(): SectionImpl<SectionPrefs> {
  return {
    loadSummary: ctx => ctx.prefs,
    render: ({ summary: prefs, attrs }) => {
      const themeButton = (value: string, label: string) =>
        html`<button type="submit" name="theme" value="${value}" aria-pressed="${String(prefs.theme === value)}">${label}</button>`;
      const custom = ACCENT_CHOICES.some(one => one.hex === prefs.accent) ? null : prefs.accent;
      const accentNoteWords = accentNote(prefs.accent);
      return settingsSection({
        id: "appearance", title: "Appearance", state: " · saved for this browser", attrs,
        body: joinHtml([
          formRow("Theme", "Light, dark, or whatever this device uses.", postForm("/settings/appearance", html`<div class="k-seg" role="group" aria-label="Theme">${themeButton("system", "Match device")}${themeButton("light", "Light")}${themeButton("dark", "Dark")}</div>`, { returnTo: back })),
          kitSectionForm({ proof: "appearance", action: "/settings/appearance", id: "accent", gate: true, hidden: { return: back },
            body: joinHtml([
              formRow("Accent", "Buttons, focus and what needs you.",
                select({ name: "accent", label: "Accent", current: prefs.accent, items: [...ACCENT_CHOICES.map(one => [one.hex, one.id === "ink" ? "Ink (default)" : one.name] as const), ...(custom === null ? [] : [[custom, `Your own colour (${custom})`] as const])] })),
              accentNoteWords === null ? "" : html`<p class="k-note">${accentNoteWords}</p>`,
            ]) }),
          disclose("Use your own colour", kitSectionForm({ proof: "appearance", action: "/settings/appearance", id: "accent-own", gate: true, hidden: { return: back },
            body: formRow("Your own colour", "Six hex digits, like #6e56cf.", input({ id: "accent-hex", name: "accent", value: custom ?? "", attrs: { placeholder: "#6e56cf", spellcheck: "false", autocomplete: "off", "aria-label": "Your own colour", pattern: "#?[0-9a-fA-F]{6}", required: true } })) }), custom !== null),
        ]),
      });
    },
  };
}

function thisBrowserSection(): SectionImpl<{ forget: boolean }> {
  return {
    loadSummary: ctx => ({ forget: ctx.can["forget"] === true }),
    render: ({ summary, attrs }) => settingsSection({
      id: "this-browser", title: "This browser", attrs,
      body: formRow("Remembered password", "After you type your password, standard approvals skip it on this computer for 15 minutes. Forget ends that now.",
        summary.forget ? postForm("/session/forget-password", btn("Forget now", { sm: true, type: "submit" }), { returnTo: back }) : html``, "inline"),
    }),
  };
}

function yourPasswordSection(deps: GeneralDeps): SectionImpl<{ passwordless: boolean | null }> {
  return {
    // Passwordless's state is installation data: read only for a person whose scope includes it.
    loadSummary: ctx => ({ passwordless: ctx.scopes.has("passwordless") ? deps.passwordless() : null }),
    render: ({ summary, attrs }) => settingsSection({
      id: "your-password", title: "Your password", attrs,
      body: joinHtml([
        formRow("Where it is", "If you started Toolroll with toolroll up, your password is saved on the computer running Toolroll. Toolroll never shows it in a browser. To read it, run this there:", html``, "wide"),
        codeLine("cat ~/.config/toolroll/.toolroll-secrets/up-login.txt"),
        summary.passwordless === null ? "" : formRow("Passwordless", "Sign in once; most approvals then need no password.", btn(`${summary.passwordless ? "On" : "Off"} · Change`, { sm: true, href: "/settings/passwordless" }), "inline"),
      ]),
    }),
  };
}

function versionSection(deps: GeneralDeps): SectionImpl<{ version: string; firstResult: string | null; updates: boolean }> {
  return {
    loadSummary: ctx => {
      // Settings → Updates' version is installation data; an operator's browser session always has the package's own.
      const version = (ctx.scopes.has("updates-version") ? deps.updatesVersion(ctx.person.name) : null) ?? (ctx.scopes.has("package-version") ? deps.packageVersion : null);
      return version === null ? null : { version, firstResult: deps.firstResult(ctx.now), updates: ctx.can["updates"] === true };
    },
    render: ({ summary, attrs }) => settingsSection({
      id: "version", title: "Version", attrs,
      body: joinHtml([
        formRow("Toolroll", summary.firstResult ?? "Installed on this computer.", html`<span class="k-mono">${summary.version}</span>`, "inline"),
        summary.updates ? formRow("Updates", null, btn("Open updates", { sm: true, variant: "ghost", href: "/settings/updates" }), "inline") : "",
      ]),
    }),
  };
}

type AdvancedSummary = { on: boolean; canSwitch: boolean };
/** Settings → Advanced, retired to General (F0): the switch always; every advanced page on request. */
function advancedSection(): SectionImpl<AdvancedSummary, readonly { title: string; href: string; words: string }[]> {
  return {
    loadSummary: ctx => ({ on: ctx.prefs.advanced, canSwitch: ctx.can["switch"] === true }),
    // Operator-only pages are listed only to an operator (their data scope).
    loadDetail: ctx => ADVANCED_PAGES.filter(one => one.operator !== true || ctx.scopes.has("operator-pages")),
    render: ({ declaration, summary, detail, attrs }) => {
      const change = summary.canSwitch
        ? postForm("/settings/advanced", btn(summary.on ? "Turn off" : "Turn on", { sm: true, type: "submit" }), { hidden: { advanced: summary.on ? "off" : "on" } })
        : html``;
      // Every advanced page opens from here whatever the switch says: listed on request (?section=advanced&open=1).
      const pages = detail === null
        ? html`<div class="k-acts">${btn("See advanced pages", { sm: true, variant: "ghost", href: `${sectionHref(declaration, { open: true })}#advanced` })}</div>`
        : html`<div class="k-slinks" aria-label="Advanced pages">${detail.map(one => settingsLink({ href: one.href, title: one.title, status: one.words }))}</div>`;
      // `show-advanced`: the old page's switch keeps its id, for links and bookmarks.
      return settingsSection({
        id: "advanced", title: "Show advanced features", state: summary.on ? " · on" : " · off", attrs,
        right: html`<span id="show-advanced">${change}</span>`,
        lead: "Flows, other computers, spend limits, operating modes and the rest, in your menus. They keep working either way.",
        body: pages,
      });
    },
  };
}

type LocalSummary = { owner: boolean; turnOff: boolean };
/** Local mode, said once: the local owner without a password is offered one; an operator's full session turns it off on
 * its change document (a step-up). */
function localModeSection(deps: GeneralDeps): SectionImpl<LocalSummary> {
  return {
    loadSummary: ctx => {
      if (!deps.localModeOn()) return null;
      const owner = ctx.person.authority !== "full";
      if (owner) return ctx.person.passwordSet ? null : { owner, turnOff: false };
      return ctx.can["turn-off"] === true ? { owner, turnOff: true } : null;
    },
    render: ({ declaration, summary, attrs }) => summary.owner
      ? settingsSection({ id: "local-mode", title: "Let agents work on their own", attrs,
        lead: "Agents can work on their own, merge and release only after you set a password.",
        body: html`<div class="k-acts">${btn("Set a password", { sm: true, href: "/password/set?next=%2Fsettings%2Fgeneral" })}</div>` })
      : settingsSection({ id: "local-mode", title: "Local mode", state: " · on", attrs,
        lead: "A browser on this computer can file tasks, approve plans and add projects without your password.",
        right: btn("Turn off local mode", { sm: true, href: changeHref(declaration.changes[0]!) }), body: html`` }),
    refusal: "An instance operator signed in with a password turns off local mode.",
    renderChange: ({ declaration, summary, problem }) => {
      const home = sectionHref(declaration);
      const title = "Turn off local mode";
      const words = summary === null || !summary.turnOff
        ? html`${infoLine("Local mode is off. This computer's browser signs in with a password.")}<div class="k-acts">${btn("Back to General", { href: home })}</div>`
        : joinHtml([
          html`<p>Local mode lets a browser on this computer file tasks, approve plans and add projects without a password. Turned off, every browser signs in with a password, and the local owner's sessions and links stop working. You can't turn it back on here.</p>`,
          problem === null ? "" : notice(problem),
          kitSectionForm({ proof: "local-mode-off", action: "/settings/local-mode/off", id: "local-mode-form", native: true, save: { label: "Turn off" }, confirm: title, body: html`` }),
          html`<div class="k-acts">${btn("Cancel", { variant: "ghost", href: home })}</div>`,
        ]);
      return { title, body: html`<div data-kit-page>${phoneHeader(title, { back: home })}${doc(docHeader({ title, back: [home, "General"], same: true }), words)}</div>` };
    },
  };
}

type InstallModeSummary = { mode: InstallModeRead["mode"]; facts: TeamFact[]; canSwitch: boolean; offered: boolean };
/** Solo or team, in one line. An instance operator's full session is offered "It's just me" while only history (an
 * install from before solo, a person since removed) says team; its change document asks for the password. */
function installModeSection(deps: GeneralDeps): SectionImpl<InstallModeSummary> {
  return {
    loadSummary: ctx => {
      const read = deps.installMode();
      const canSwitch = ctx.can["just-me"] === true;
      return { mode: read.mode, facts: read.facts, canSwitch, offered: canSwitch && justMeAllowed(read) };
    },
    render: ({ declaration, summary, attrs }) => {
      const line = installModeLine(summary.mode);
      return settingsSection({ id: "install-mode", title: line.label, attrs, lead: line.words,
        ...(summary.offered ? { right: btn("It's just me", { sm: true, href: changeHref(declaration.changes[0]!) }) } : {}), body: html`` });
    },
    refusal: "An instance operator signed in with a password says it's just them.",
    renderChange: ({ declaration, summary, problem }) => {
      const home = sectionHref(declaration);
      const title = "It's just me";
      const blocked = summary === null ? [] : summary.facts.filter(fact => fact !== "existing-install" && !fact.endsWith("-added"));
      const words = summary === null || summary.mode === "solo"
        ? html`${infoLine("This install is solo.")}<div class="k-acts">${btn("Back to General", { href: home })}</div>`
        : !summary.offered
          ? html`${blocked.map(fact => notice(TEAM_FACT_WORDS[fact]))}<div class="k-acts">${btn("Back to General", { href: home })}</div>`
          : joinHtml([
            html`<p>Approvals and Accept then need only you signed in. Signing in, tokens and connecting things still ask for your password. If anyone joins, this install switches back to Team.</p>`,
            problem === null ? "" : notice(problem),
            kitSectionForm({ proof: "install-solo", action: "/settings/install-mode/solo", id: "just-me-form", native: true, save: { label: title }, confirm: title, body: html`` }),
            html`<div class="k-acts">${btn("Cancel", { variant: "ghost", href: home })}</div>`,
          ]);
      return { title, body: html`<div data-kit-page>${phoneHeader(title, { back: home })}${doc(docHeader({ title, back: [home, "General"], same: true }), words)}</div>` };
    },
  };
}

/** Settings → General's task sizing, said in words: off is the default. */
export const TASK_SIZING_OFF_WORDS = "Off: no model call before you approve; uncertain tasks get a plan first.";
const SIZER_NAME = { claude: "Claude Haiku, on your plan", jev: "Jev via OpenRouter, your credit" } as const;
const SIZER_SHORT = { claude: "Claude Haiku", jev: "Jev via OpenRouter" } as const;
type TaskSizingSummary = { on: boolean; byEnv: boolean; canSwitch: boolean; sizer: "claude" | "jev" | null; available: "claude" | "jev"; moved: boolean };
/** Task sizing by a quick model call: its state in one line; an instance operator turns it on or off on its change
 * document (a step-up). */
function taskSizingSection(deps: GeneralDeps): SectionImpl<TaskSizingSummary> {
  return {
    loadSummary: ctx => {
      const read = deps.taskSizing();
      return { on: read.on && !read.byEnv, byEnv: read.byEnv, canSwitch: ctx.can["switch"] === true, sizer: read.sizer, available: read.available, moved: read.chosen && !read.on };
    },
    render: ({ summary, attrs }) => settingsSection({ id: "task-sizing", title: `Size tasks with a quick model call (${SIZER_NAME[summary.on && summary.sizer !== null ? summary.sizer : summary.available]})`, state: summary.on ? " · on" : " · off", attrs,
      lead: summary.byEnv ? "Off: TOOLROLL_NO_TASK_CLASSIFIER is set on this computer, so no model call happens before you approve; uncertain tasks get a plan first."
        : summary.on ? `On: before you approve, a quick call to ${SIZER_SHORT[summary.sizer!]} sizes each new task, and the plan names it.`
        : summary.moved && summary.sizer !== null ? `Off: you turned it on for ${SIZER_SHORT[summary.sizer]}, but ${SIZER_SHORT[summary.available]} is the one available now, so nothing is sent. Turn it on again to choose it. Uncertain tasks get a plan first.`
        : TASK_SIZING_OFF_WORDS,
      ...(summary.canSwitch && !summary.byEnv ? { right: btn(summary.on ? "Turn off" : "Turn on", { sm: true, href: "/settings/change/task-sizing" }) } : {}), body: html`` }),
    refusal: "An instance operator changes how tasks are sized.",
    renderChange: ({ declaration, summary, problem }) => {
      const home = sectionHref(declaration);
      const on = summary?.on === true;
      const choice = summary === null ? "claude" : on && summary.sizer !== null ? summary.sizer : summary.available;
      const title = `Size tasks with a quick model call (${SIZER_NAME[choice]})`;
      const words = summary === null || summary.byEnv
        ? html`${infoLine("TOOLROLL_NO_TASK_CLASSIFIER is set on this computer, so task sizing stays off.")}<div class="k-acts">${btn("Back to General", { href: home })}</div>`
        : joinHtml([
          html`<p>${on ? `Turn it off. ${TASK_SIZING_OFF_WORDS}` : choice === "jev"
            ? "Turn it on. Before you approve, each new task's words go to Jev through your OpenRouter key (your credit) to size it: small ones build at once on a fast model, risky ones plan first, and the plan names the model that sized it. Only Jev is asked; if the key goes, sizing turns itself off."
            : "Turn it on. Before you approve, a quick call to Claude Haiku on your own plan sizes each new task: small ones build at once on a fast model, risky ones plan first, and the plan names the model that sized it. Only Claude is asked; if an OpenRouter key is saved later, sizing turns itself off until you choose again."}</p>`,
          problem === null ? "" : notice(problem),
          kitSectionForm({ proof: "task-sizing", action: "/settings/task-sizing", id: "task-sizing-form", native: true, save: { label: on ? "Turn off" : "Turn on" }, confirm: on ? "Turn off task sizing" : "Turn on task sizing", hidden: { enabled: on ? "off" : "on", sizer: choice }, body: html`` }),
          html`<div class="k-acts">${btn("Cancel", { variant: "ghost", href: home })}</div>`,
        ]);
      return { title, body: html`<div data-kit-page>${phoneHeader(title, { back: home })}${doc(docHeader({ title, back: [home, "General"], same: true }), words)}</div>` };
    },
  };
}

/** Settings → General's interactive agent threads, what they are and their limits, in one line. */
export const FLEXIBLE_SETTING_WORDS = "Claude Code only for now. Runs inside Toolroll's sandbox with your Claude sign-in relayed; Toolroll never gives the agent your key.";
type FlexibleSummary = { on: boolean; canSwitch: boolean };
/** Interactive agent threads (beta): on or off in one line with what they are; an instance operator turns them on or
 * off on its change document (a step-up). */
function flexibleSection(deps: GeneralDeps): SectionImpl<FlexibleSummary> {
  return {
    loadSummary: ctx => ({ on: deps.flexible().on, canSwitch: ctx.can["switch"] === true }),
    render: ({ summary, attrs }) => settingsSection({ id: "flexible", title: "Interactive agent threads (beta)", state: summary.on ? " · on" : " · off", attrs,
      lead: `${summary.on ? "On" : "Off"}. ${FLEXIBLE_SETTING_WORDS}`,
      ...(summary.canSwitch ? { right: btn(summary.on ? "Turn off" : "Turn on", { sm: true, href: "/settings/change/flexible" }) } : {}), body: html`` }),
    refusal: "An instance operator turns interactive agent threads on or off.",
    renderChange: ({ declaration, summary, problem }) => {
      const home = sectionHref(declaration);
      const on = summary?.on === true;
      const title = "Interactive agent threads (beta)";
      const words = joinHtml([
        html`<p>${on ? "Turn them off. No new thread or turn starts, and any thread running now is stopped." : `Turn them on. Press T in the workbench to work with Claude Code in a thread. ${FLEXIBLE_SETTING_WORDS} Each project still needs its own Flexible terms, and each thread shows its terms before it starts.`}</p>`,
        problem === null ? "" : notice(problem),
        kitSectionForm({ proof: "flexible-switch", action: "/settings/flexible", id: "flexible-form", native: true, save: { label: on ? "Turn off" : "Turn on" }, confirm: on ? "Turn off interactive agent threads" : "Turn on interactive agent threads", hidden: { enabled: on ? "off" : "on" }, body: html`` }),
        html`<div class="k-acts">${btn("Cancel", { variant: "ghost", href: home })}</div>`,
      ]);
      return { title, body: html`<div data-kit-page>${phoneHeader(title, { back: home })}${doc(docHeader({ title, back: [home, "General"], same: true }), words)}</div>` };
    },
  };
}

/** General's sections, by id (settings-section-table.ts says who sees each). */
export function generalSections(deps: GeneralDeps): SectionImpls {
  return {
    appearance: appearanceSection(),
    "this-browser": thisBrowserSection(),
    "your-password": yourPasswordSection(deps),
    version: versionSection(deps),
    "install-mode": installModeSection(deps),
    "task-sizing": taskSizingSection(deps),
    flexible: flexibleSection(deps),
    advanced: advancedSection(),
    "local-mode": localModeSection(deps),
  } as unknown as SectionImpls;
}

/** The General area page's body (the frame is the caller's). */
export function generalBody(impls: SectionImpls, base: Base, asked: { section: string | null; open: boolean }, said: { said: string | null; problem: string | null }): { body: Html; shown: string[] } {
  return areaBody("general", impls, base, asked, said);
}
/** An area page's body: what the last act said (once), where the asked section is, then each admitted section. */
export function areaBody(name: SettingsArea, impls: SectionImpls, base: Base, asked: { section: string | null; open: boolean }, said: { said: string | null; problem: string | null }): { body: Html; shown: string[] } {
  const area = renderArea(name, impls, base, asked);
  const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  const answered = said.problem ? notice(sentence(said.problem)) : said.said ? infoLine(sentence(said.said)) : html``;
  return { body: joinHtml([answered, area.jump, ...area.sections]), shown: area.shown };
}
