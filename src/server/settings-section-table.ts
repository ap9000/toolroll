/**
 * THE SETTINGS SECTION TABLE (docs: the eight settings plan v2 §2): every section a Settings area shows, as data.
 *
 * A section keeps three things apart (round 2, change 1):
 * - READ admission: who may see it at all. `policy` is the complete route policy of the page it came from, pinned
 *   (settings-sections.test.ts compares every field with the row at 271c93e1), and `read` names the checks the old
 *   handler made inline before drawing it. Both run before any of its loaders (settings-sections.ts admitSection).
 * - DATA SCOPE: which facts inside it a person may see (`scope`: a fact's name and the checks that include it).
 * - ACTION CAPABILITY: who may change it (`act`). It only decides which controls are drawn; every POST handler proves
 *   the act again, exactly as before.
 *
 * A section whose act needs a proof (a password, a credential, a secret) or a page script has a change document for
 * it: GET /settings/change/<document> (route-table.ts makes one row per document from this table, carrying the
 * section's policy). It is always its own sensitive document, never changed in place, and it shows its form only to a person
 * with the named act capability.
 *
 * Data only: no store, no request, no rendering (route-table.ts imports it). The loaders and renderers are in
 * settings-sections.ts.
 */
import type { Caller, LimitedAccess, ProjectResolver, RouteRefusal, RouteRole, RouteScope } from "./route-table.js";

/** The Settings areas, in left-nav order (plan v2 §1). */
export type SettingsArea = "general" | "projects" | "project" | "agents" | "computers" | "alerts" | "access" | "spend" | "system";

/** A section's route policy: the fields of the route row it replaces, unchanged. */
export type SectionPolicy = {
  readonly callers: readonly Caller[];
  readonly scope: RouteScope;
  readonly project: ProjectResolver;
  readonly limited: LimitedAccess;
  readonly needsProject: boolean;
  readonly role: RouteRole;
  readonly roleBrowser: boolean;
  readonly roleRefusal?: RouteRefusal;
  /** A viewer may POST here (never on a section: they are reads); kept so the policy is the row's, whole. */
  readonly viewer: boolean;
  readonly local: "allow" | "deny";
};

/**
 * The named checks a section's read, data scope or act may require, each exactly what an old handler checked inline:
 * - `installation`: installation-wide settings are this person's (settingsHome's `!minimal`: a configured
 *   installation, and not a project-limited account);
 * - `cookie-session`: a browser sign-in (an API token reads, never acts here);
 * - `full-session`: a browser sign-in with a password (never the local owner's own session);
 * - `operator`: an instance operator's browser session (the old handlers' `operator`); `approver`: an approver;
 * - `password-holder`: this person has a password (the local owner before setting one has none to remember or find);
 * - `whole-installation`: not a project-limited account (what /agents showed the computers to);
 * - `not-demo`: not the demo's sandbox (it registers and retires nothing).
 */
export type SectionGate = "installation" | "cookie-session" | "full-session" | "operator" | "approver" | "password-holder" | "whole-installation" | "not-demo";

/** One change document: its address (/settings/change/<id>), the act capability it needs, and the proof row its form
 * posts under. */
export type ChangeDocument = { readonly id: string; readonly act: string; readonly proof: string };

export type SectionDeclaration = {
  readonly id: string;
  readonly area: SettingsArea;
  readonly title: string;
  /** The route row (at 271c93e1) whose policy this section keeps. */
  readonly pinnedFrom: string;
  readonly policy: SectionPolicy;
  /** READ admission: every check must hold, or the section is never loaded, drawn or sent. */
  readonly read: readonly SectionGate[];
  /** DATA SCOPE: a fact inside the section, and the checks that include it. */
  readonly scope: Readonly<Record<string, readonly SectionGate[]>>;
  /** ACTION CAPABILITY: an act the section offers, and the checks that draw its control (the POST proves it again). */
  readonly act: Readonly<Record<string, readonly SectionGate[]>>;
  /** Its change documents (GET /settings/change/<document id>), one per guarded or scripted act. */
  readonly changes: readonly ChangeDocument[];
  /** Whether it has a detail view, loaded only on ?section=<id>&open=1. */
  readonly opens: boolean;
  /** Page scripts it needs (each only on its change document; settings-scripts.ts). */
  readonly scripts: readonly string[];
  /** Element ids an old link may still name (kept exactly once on the area page). */
  readonly oldIds: readonly string[];
};

/** The policy every Settings group page had at 271c93e1 (route-table.ts `settings.group-*`): anyone signed in, any project. */
const GROUP_PAGE: SectionPolicy = Object.freeze({
  callers: Object.freeze(["cookie", "bearer"] as const), scope: "read", project: "session", limited: "unscoped", needsProject: false,
  role: "any", roleBrowser: false, viewer: false, local: "allow",
});

/** /start-builder at 271c93e1: anyone signed in, a project-limited person included (it shows only a visible project). */
const START_BUILDER: SectionPolicy = Object.freeze({ ...GROUP_PAGE });
/** /fleet at 271c93e1: anyone signed in with instance access (a project-limited person is refused). */
const FLEET: SectionPolicy = Object.freeze({ ...GROUP_PAGE, limited: "deny" });
/** Managing computers (register, retire, move reserved work, a note), as the Agents page drew it: an approver's browser
 * session with instance access, never the demo — and a full session, since every one of those posts refuses the local
 * owner's (route-table.ts LOCAL_POSTS names none of them). */
const MANAGE_COMPUTERS: readonly SectionGate[] = ["full-session", "approver", "whole-installation", "not-demo"];

/** Every section, by area, in page order. */
export const SETTINGS_SECTIONS: readonly SectionDeclaration[] = Object.freeze([
  // ---- General ----
  { id: "appearance", area: "general", title: "Appearance", pinnedFrom: "settings.group-general", policy: GROUP_PAGE,
    read: [], scope: {}, act: {}, changes: [], opens: false, scripts: [], oldIds: ["accent", "accent-own"] },
  { id: "this-browser", area: "general", title: "This browser", pinnedFrom: "settings.group-general", policy: GROUP_PAGE,
    read: ["password-holder"], scope: {}, act: { forget: ["cookie-session"] }, changes: [], opens: false, scripts: [], oldIds: [] },
  { id: "your-password", area: "general", title: "Your password", pinnedFrom: "settings.group-general", policy: GROUP_PAGE,
    read: ["password-holder"], scope: { passwordless: ["installation"] }, act: {}, changes: [], opens: false, scripts: [], oldIds: [] },
  { id: "version", area: "general", title: "Version", pinnedFrom: "settings.group-general", policy: GROUP_PAGE,
    read: [], scope: { "updates-version": ["installation"], "package-version": ["operator"] }, act: { updates: ["operator"] }, changes: [], opens: false, scripts: [], oldIds: [] },
  // Solo or team (install-mode.ts): the one line, for everyone signed in; "It's just me" is an instance operator's
  // credential act from a full session, on its own change document.
  { id: "install-mode", area: "general", title: "Solo or team", pinnedFrom: "settings.group-general", policy: GROUP_PAGE,
    read: [], scope: {}, act: { "just-me": ["full-session", "operator"] }, changes: [{ id: "just-me", act: "just-me", proof: "install-solo" }],
    opens: false, scripts: [], oldIds: [] },
  // Task sizing by a quick model call (task-sizing.ts): off by default; an instance operator's step-up turns it on or off
  // on its own change document (a local owner's own act on a laptop install).
  { id: "task-sizing", area: "general", title: "Size tasks with a quick model call (Claude Haiku, on your plan)", pinnedFrom: "settings.group-general", policy: GROUP_PAGE,
    read: ["installation"], scope: {}, act: { switch: ["cookie-session", "operator"] }, changes: [{ id: "task-sizing", act: "switch", proof: "task-sizing" }],
    opens: false, scripts: [], oldIds: [] },
  // Interactive agent threads (beta; flexible-available.ts): off by default; an instance operator's step-up turns them on
  // or off on its own change document (a local owner's own act on a laptop install).
  { id: "flexible", area: "general", title: "Interactive agent threads (beta)", pinnedFrom: "settings.group-general", policy: GROUP_PAGE,
    read: ["installation"], scope: {}, act: { switch: ["cookie-session", "operator"] }, changes: [{ id: "flexible", act: "switch", proof: "flexible-switch" }],
    opens: false, scripts: [], oldIds: [] },
  // Settings → Advanced retired to here (F0): the person's own switch, and every advanced page on request.
  { id: "advanced", area: "general", title: "Show advanced features", pinnedFrom: "settings.group-advanced", policy: GROUP_PAGE,
    read: [], scope: { "operator-pages": ["operator"] }, act: { switch: ["cookie-session"] }, changes: [], opens: true, scripts: [], oldIds: ["show-advanced"] },
  // Local mode (from People and sign-in): turning it off is an instance operator's step-up from a full session, on its
  // own change document.
  { id: "local-mode", area: "general", title: "Local mode", pinnedFrom: "settings.group-access", policy: GROUP_PAGE,
    read: ["cookie-session"], scope: {}, act: { "turn-off": ["full-session", "operator"] }, changes: [{ id: "local-mode", act: "turn-off", proof: "local-mode-off" }],
    opens: false, scripts: [], oldIds: [] },
  // ---- Computers (F2): /fleet, /start-builder and the computers on Agents, in one area ----
  // Connect a builder: the one command, and whether a builder serves the shown project (a task's own, or the open one).
  { id: "start", area: "computers", title: "Connect a builder", pinnedFrom: "start-builder", policy: START_BUILDER,
    read: [], scope: {}, act: { register: MANAGE_COMPUTERS }, changes: [{ id: "register-computer", act: "register", proof: "runner-register" }],
    opens: false, scripts: [], oldIds: ["builder"] },
  // Every computer that builds, and on request one computer's details (its reserved work, its note).
  { id: "builders", area: "computers", title: "Computers that build", pinnedFrom: "fleet", policy: FLEET,
    read: [], scope: {}, act: { manage: MANAGE_COMPUTERS }, changes: [{ id: "retire-computer", act: "manage", proof: "runner-retire" }],
    opens: true, scripts: [], oldIds: ["workers"] },
] satisfies SectionDeclaration[]);

/** Every change document with the section it belongs to (one route row each). */
export const CHANGE_DOCUMENTS: readonly (ChangeDocument & { readonly section: SectionDeclaration })[] =
  SETTINGS_SECTIONS.flatMap(section => section.changes.map(change => ({ ...change, section })));
/** One change document by id, or undefined. */
export function changeDocumentOf(id: string): (ChangeDocument & { readonly section: SectionDeclaration }) | undefined {
  return CHANGE_DOCUMENTS.find(one => one.id === id);
}

/** One section by id, or undefined. */
export function sectionDeclaration(id: string): SectionDeclaration | undefined {
  return SETTINGS_SECTIONS.find(one => one.id === id);
}

/** The area pages this table draws, and their addresses. */
export const AREA_PATHS: Readonly<Partial<Record<SettingsArea, string>>> = Object.freeze({ general: "/settings/general", computers: "/settings/computers" });

/** A section's place on its area page: `?section=<id>` (no fragment; an old link's fragment is inherited). */
export function sectionHref(declaration: Pick<SectionDeclaration, "id" | "area">, options: { open?: boolean; project?: string | null; extra?: Readonly<Record<string, string>> } = {}): string {
  const path = AREA_PATHS[declaration.area] ?? "/settings";
  const query = new URLSearchParams();
  if (options.project != null) query.set("repo", options.project);
  query.set("section", declaration.id);
  if (options.open === true) query.set("open", "1");
  for (const [key, value] of Object.entries(options.extra ?? {})) query.set(key, value);
  return `${path}?${query}`;
}

/** A change document's address, with the project it acts on and the keys that name its object, when it has them. */
export function changeHref(document: Pick<ChangeDocument, "id">, project: string | null = null, extra: Readonly<Record<string, string>> = {}): string {
  const query = new URLSearchParams();
  if (project !== null) query.set("repo", project);
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return `/settings/change/${document.id}${query.size === 0 ? "" : `?${query}`}`;
}
