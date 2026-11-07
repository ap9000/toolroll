/** Retired addresses (docs/plans/plain-toolroll.md P1.4): Home (`/`) and Tasks (`/tasks`) are the pages; every old page
 * answers with a permanent redirect to its place there, for good, so a bookmark, an old push or an installed phone's old
 * service worker still lands right. A redirect keeps only the query keys its target knows, and decides nothing: the
 * target admits the person and filters what they may see, exactly as if they had opened it. */
import type { ServerResponse } from "node:http";
import { SAFETY } from "./http.js";

/** The Tasks page's own address for a view, a project and the other keys it knows. */
export function tasksHref(over: { view?: string | null; project?: string | null; scope?: "all" | null; state?: string | null; cursor?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (over.scope === "all") q.set("scope", "all");
  else if (over.project != null) q.set("project", over.project);
  if (over.view != null && over.view !== "all") q.set("view", over.view);
  if (over.state != null) q.set("state", over.state);
  if (over.cursor != null) q.set("cursor", over.cursor);
  return `/tasks${q.size === 0 ? "" : `?${q}`}`;
}

/** The one project a link names (one `project` key, never two), or null. */
const projectOf = (url: URL): string | null => url.searchParams.getAll("project").length === 1 ? url.searchParams.get("project") : null;
/** The Tasks list views an old link may name, as /tasks names them. */
const LIST_VIEWS: Readonly<Record<string, string>> = { all: "all", "needs-you": "needs-you", running: "running", queued: "queued", completed: "completed", done: "completed", archived: "archived", ready: "ready" };

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
  // The old review list (a result keeps its own page: /review?result=…).
  review: url => tasksHref({ view: "ready", project: projectOf(url) }),
  // Archive old tasks' preview moved beside Tasks; its POST keeps /work/put-away exactly.
  "work.put-away": url => { const days = url.searchParams.get("days"); return days !== null && /^[0-9]{1,3}$/.test(days) ? `/tasks/archive?days=${days}` : "/tasks/archive"; },
};

/** A retired GET's answer: 301 to where it lives now. Permanent: the old address never comes back. */
export function retiredRedirect(id: string, url: URL, response: ServerResponse): void {
  const to = RETIRED_ROUTES[id];
  if (to === undefined) throw new Error(`no retired route ${id}`);
  response.setHeader("Location", to(url));
  response.writeHead(301, { ...SAFETY });
  response.end();
}
