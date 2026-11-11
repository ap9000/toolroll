/**
 * Which pages may change in place, and which may be read ahead (docs/plans/live-pages-and-home.md A1.1, A1.4).
 *
 * Both are explicit allowlists of route-table ids (route-table.ts): nothing is eligible by default, so a new route
 * loads as its own document until it is added here on purpose. The welcome and first-run pages, the terminal, sign-in,
 * the release sheet and every page not named below are never eligible. A page on the in-place list is still a document
 * load when it is sensitive (a password field) or carries a page script (serve.ts sendScreen decides `inPlace`).
 */

/** The Settings pages (route-table.ts): the overview, its groups and each section page. Not the Slack manifest file. */
const SETTINGS_PAGES = [
  "settings.page",
  ...["general", "agents", "alerts", "projects", "access", "system"].map(one => `settings.group-${one}`),
  ...["models", "tools", "project", "approval", "policy", "sessions", "integrations", "monitoring", "updates", "retention", "storage",
    "pull-requests", "checks", "backups", "data", "sign-in", "lead", "teams", "discord", "slack",
    "skills", "flows", "knowledge", "learning", "spend", "passwordless"].map(one => `settings.${one}`),
];

/** Home, the Tasks list, a task page, Projects, Agents (the list), Search and the Settings pages. */
export const IN_PLACE_ROUTES: ReadonlySet<string> = new Set(["home", "tasks", "task.page", "projects.page", "agents", "search", ...SETTINGS_PAGES]);

/** What may be read ahead with `x-toolroll-read: prefetch`: Home, the Tasks list, Projects, Agents (the list, never an
 * opened agent), Search, a task page. Everything else answers 204. */
export const PREFETCH_ROUTES: ReadonlySet<string> = new Set(["home", "tasks", "projects.page", "agents", "search", "task.page"]);

/** The Agents view's Live grid shares the `agents` row (`/agents?view=live`); it only watches, and is never in place. */
const liveGrid = (id: string, url: URL): boolean => id === "agents" && url.searchParams.get("view") === "live";

export function inPlaceRoute(id: string | undefined, url: URL): boolean {
  return id !== undefined && IN_PLACE_ROUTES.has(id) && !liveGrid(id, url);
}

/** An opened agent shares the `agents` row too (`/agents?run=`): opening one marks it seen or watched, which is an
 * act, so its page is never read ahead (the browser never shows it before the person's own read). */
const openedAgent = (id: string, url: URL): boolean => id === "agents" && url.searchParams.has("run");

export function prefetchRoute(id: string | undefined, url: URL): boolean {
  return id !== undefined && PREFETCH_ROUTES.has(id) && !liveGrid(id, url) && !openedAgent(id, url);
}
