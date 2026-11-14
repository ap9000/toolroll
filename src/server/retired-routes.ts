/** Retired addresses (docs/plans/plain-toolroll.md P1.4, the one-workspace plan S2a): Work (`/`) is the page; every old
 * page, Tasks (`/tasks`) included, answers with a permanent redirect to its place there, for good, so a bookmark, an old
 * push or an installed phone's old service worker still lands right. A redirect keeps only the query keys its target
 * knows, and decides nothing: the target admits the person and filters what they may see, exactly as if they had opened it. */
import type { ServerResponse } from "node:http";
import { SAFETY } from "./http.js";
import { taskLinkFromLegacy, taskLinkOf, type TaskLinkSection } from "../task-link.js";
import type { HandlerContext } from "./handler-context.js";

/** Work's own address for a view, a project and the other keys its list knows. With no project named it is every
 * project (`scope=all` is never needed there). */
export function tasksHref(over: { view?: string | null; project?: string | null; scope?: "all" | null; state?: string | null; cursor?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (over.scope !== "all" && over.project != null) q.set("project", over.project);
  if (over.view != null && over.view !== "all") q.set("view", over.view);
  if (over.state != null) q.set("state", over.state);
  if (over.cursor != null) q.set("cursor", over.cursor);
  return `/${q.size === 0 ? "" : `?${q}`}`;
}

/** The one project a link names (one `project` key, never two), or null. */
const projectOf = (url: URL): string | null => url.searchParams.getAll("project").length === 1 ? url.searchParams.get("project") : null;
/** The Tasks list views an old link may name, as /tasks names them. */
const LIST_VIEWS: Readonly<Record<string, string>> = { all: "all", "needs-you": "needs-you", running: "running", queued: "queued", completed: "completed", done: "completed", archived: "archived", ready: "ready" };

/**
 * A retired Settings page (the eight settings plan v2 §2.5): the area page it became part of, its section there, and
 * the query keys it keeps — each kept only when the old link names it once (its views, pages and recovery words).
 * The answer carries `section=<id>` and never a fragment: by RFC 9110 §10.2.2 the browser keeps the old link's own
 * fragment, so a bookmark to an id inside the old page still lands on that id (kept on the area page).
 */
export type SettingsRetirement = { readonly to: string; readonly section: string; readonly keep: readonly string[]; readonly open?: true };
export const SETTINGS_RETIRED: Readonly<Record<string, SettingsRetirement>> = {
  // Settings → Advanced (the switch and every advanced page) is General's Advanced section, opened.
  "settings.group-advanced": { to: "/settings/general", section: "advanced", keep: ["said", "problem"], open: true },
};
/** Where a retired Settings page's link lands now. */
export function settingsRetiredHref(retirement: SettingsRetirement, url: URL): string {
  const query = new URLSearchParams();
  for (const key of retirement.keep) {
    const values = url.searchParams.getAll(key);
    if (values.length === 1) query.set(key, values[0]!);
  }
  query.set("section", retirement.section);
  if (retirement.open === true) query.set("open", "1");
  return `${retirement.to}?${query}`;
}

/** Each retired GET row (route-table.ts `retired`), and where it now lives. */
export const RETIRED_ROUTES: Readonly<Record<string, (url: URL) => string>> = {
  // The old Tasks list: its view, project, stored-state filter and page; layout=board is the Board view; all=1 every project.
  work: url => {
    const board = url.searchParams.get("layout") === "board";
    const view = board ? "board" : LIST_VIEWS[url.searchParams.get("view") ?? ""] ?? null;
    const all = url.searchParams.get("all") === "1";
    return tasksHref({ view, scope: all ? "all" : null, project: all ? null : projectOf(url), state: board ? null : url.searchParams.get("state"), cursor: board ? null : url.searchParams.get("cursor") });
  },
  // The old inbox and its triage flow: Home holds what needs you.
  inbox: url => { const project = projectOf(url); return project === null ? "/" : `/?project=${encodeURIComponent(project)}`; },
  next: url => { const project = projectOf(url); return project === null ? "/" : `/?project=${encodeURIComponent(project)}`; },
  // The portfolio: Tasks across every project.
  workbench: () => tasksHref({ scope: "all" }),
  // The old board: the Board view, or its order view.
  board: url => url.searchParams.get("view") === "order" ? tasksHref({ view: "order", project: projectOf(url) })
    : url.searchParams.get("scope") === "all" ? tasksHref({ view: "board", scope: "all" }) : tasksHref({ view: "board", project: projectOf(url) }),
  queue: url => tasksHref({ view: "order", project: projectOf(url) }),
  done: url => tasksHref({ view: "done", project: projectOf(url) }),
  // The old review list (a result leads to its task page: TASK_VIEW_REDIRECTS below).
  review: url => tasksHref({ view: "ready", project: projectOf(url) }),
  // Tasks (S2a): Work at `/` with the same query (its view, project, state, page and layout keys); a template link
  // still opens the new-task page with it.
  tasks: url => {
    const template = url.searchParams.get("template");
    if (template !== null) return `/tasks/new?template=${encodeURIComponent(template)}`;
    return `/${url.search}`;
  },
  // Archive old tasks' preview moved beside Tasks; its POST keeps /work/put-away exactly.
  "work.put-away": url => { const days = url.searchParams.get("days"); return days !== null && /^[0-9]{1,3}$/.test(days) ? `/tasks/archive?days=${days}` : "/tasks/archive"; },
  ...Object.fromEntries(Object.entries(SETTINGS_RETIRED).map(([id, retirement]) => [id, (url: URL) => settingsRetiredHref(retirement, url)])),
};

/** One task view (one-workspace plan S1): the old result addresses and the task's full-record page lead to the task page.
 * These rows are not retired: each handler keeps its own refusals (a stale run is "Result changed", an unseen one not
 * found, a running build keeps its record page) and redirects only what it would have shown, to exactly the place the
 * address named (task-link.ts). The task page then admits the person itself. */
export const TASK_VIEW_REDIRECTS = {
  /** `/review?result=T&run=N&tab=S` (with its `noted`/`refused` feedback) → `/t/T?tab=result&run=N&section=S`. */
  review: (url: URL): string | null => url.searchParams.has("result") ? taskLinkFromLegacy(`${url.pathname}${url.search}`) : null,
  /** A finished build's `/r/N` (its result) → its task's Result section at N; `record=`, fragments and running builds stay. */
  "run.page": (url: URL, taskId: string, runId: number): string | null =>
    url.searchParams.has("record") || url.searchParams.has("fragment") ? null : taskLinkOf({ task: taskId, run: runId, section: sectionOf(url.searchParams.get("tab")) }),
  /** `/t/T/evidence` → the task page's Record section; its JSON download and printable page keep this address. */
  "task.evidence": (url: URL, rootId: string): string | null =>
    url.searchParams.get("format") === "json" || url.searchParams.has("print") ? null : taskLinkOf({ task: rootId, record: true }),
} as const;

const sectionOf = (raw: string | null): TaskLinkSection | null => raw === "changes" || raw === "checks" || raw === "summary" ? raw : null;

/** A retired GET's answer: 301 to where it lives now. Permanent: the old address never comes back. */
export function retiredRedirect(id: string, url: URL, response: ServerResponse): void {
  const to = RETIRED_ROUTES[id];
  if (to === undefined) throw new Error(`no retired route ${id}`);
  response.setHeader("Location", to(url));
  response.writeHead(301, { ...SAFETY });
  response.end();
}

/** A retired row's handler (route-table.ts `retired`): its redirect, and nothing else. */
export function retiredHandler(id: string): (ctx: HandlerContext) => Promise<void> {
  if (RETIRED_ROUTES[id] === undefined) throw new Error(`no retired route ${id}`);
  return async ctx => retiredRedirect(id, ctx.url, ctx.response);
}
