/**
 * The route table against the behaviour it replaced. The legacy rules below are a frozen, test-only copy of the
 * hand-kept allowlists serve.ts used before the table (the limited account's read/write sets and resource
 * patterns, the viewer's POST set and the selected-project exceptions). They are deliberately written the old way,
 * independent of the table, so the comparison cannot pass by restating the same object.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertRouteTable, declaredForAnotherMethod, matchRoute, ROUTES, routePolicySnapshot, type LimitedAccess, type RouteDeclaration } from "./route-table.js";

// ---- the frozen legacy rules (serve.ts at 6f7cfcb) --------------------------------------------------------------
const legacyTask = (path: string, suffix: string): boolean => {
  const match = new RegExp(`^/t/([^/]+)${suffix === "" ? "$" : suffix}`).exec(path);
  if (match === null) return false;
  try { decodeURIComponent(match[1] as string); return true; } catch { return false; }
};
/** What projectRequestAllowed decided for a limited account, before any per-request lookup. */
function legacyLimited(method: string, path: string): LimitedAccess {
  if (path === "/chat" && method === "GET") return "conversation";
  if ((method === "GET" && path === "/settings/telegram") || (method === "POST" && ["/settings/telegram/pair", "/settings/telegram/unpair", "/settings/telegram/retry"].includes(path))) return "self";
  if (method === "POST" && ["/settings/chat-approval/confirm", "/settings/chat-approval/save", "/settings/chat-approval/off"].includes(path)) return "self";
  if (path === "/code" || path.startsWith("/code/")) return "self";
  if ((method === "GET" && /^\/chat\/action\/[0-9]{1,15}$/.test(path)) || (method === "POST" && /^\/chat\/proposal\/[0-9]{1,15}\/(confirm|dismiss)$/.test(path))) return "proposal";
  const read = new Set(["/settings/flows", "/settings/skills", "/settings/knowledge", "/settings", "/settings/learning", "/recipes", "/recipes/run", "/recipes/start", "/recipes/new", "/recipes/edit", "/recipes/from-task", "/recipes/preview", "/recipes/export", "/", "/inbox", "/work", "/projects", "/people", "/ledger", "/ledger/export", "/next", "/board", "/tasks", "/tasks/new", "/runs", "/review", "/done", "/routines", "/menu"]);
  const write = new Set(["/settings/flows/on", "/settings/skills/import", "/settings/skills/change", "/settings/skills/revise", "/settings/knowledge/change", "/settings/knowledge/refresh", "/settings/learning/change", "/recipes/prepare", "/recipes/preview", "/recipes/import", "/recipes/save", "/recipes/launch", "/projects/select", "/tasks/add", "/routines/add"]);
  const task = legacyTask(path, method === "GET" ? "(/evidence|/live)?$" : "/(hold|unhold|requeue|cancel|scope|approve|plan|plan-edit|next|reopen|steer|accept-proof|accept-revision|reject-revision|route|retry-review|complete|merge|confirm-stopped|stop|resume-arm|resume)$");
  const resource = method === "GET"
    ? /^\/(?:r|d)\/[0-9]{1,15}(?:\/evidence\/[0-9]{1,15})?$/.test(path) || /^\/routines\/[0-9]{1,15}$/.test(path) || path === "/flows" || /^\/flows\/[0-9]{1,15}(\/insights|\/export|\/live|\/runs\/[0-9]{1,15}\/[0-9]{1,15})?$/.test(path) || path === "/flows/new" || /^\/flows\/new\/[a-z-]{1,40}$/.test(path)
    : /^\/d\/[0-9]{1,15}\/answer$/.test(path) || /^\/routines\/[0-9]{1,15}\/(approve|refresh|pause|resume|run-now)$/.test(path) || path === "/flows/new" || /^\/flows\/new\/[a-z-]{1,40}$/.test(path) || path === "/flows/import" || /^\/flows\/[0-9]{1,15}\/(save|cards|archive|scripts)$/.test(path) || /^\/flows\/[0-9]{1,15}\/cards\/[0-9]{1,15}\/(move|decide|cancel|comment|assign|watch)$/.test(path) || /^\/flows\/[0-9]{1,15}\/triggers(\/[0-9]{1,15}\/(pause|resume|remove|check|press|renew|secret|share|unshare))?$/.test(path) || /^\/r\/[0-9]{1,15}\/(note|comment|revise|draft-repair|checks|add-tests)$/.test(path);
  if (!(method === "GET" ? read : write).has(path) && !task && !resource) return "deny";
  const unscoped = ["/settings/skills", "/settings/skills/import", "/settings/skills/change", "/settings/skills/revise", "/settings/knowledge", "/settings/knowledge/change", "/settings/knowledge/refresh", "/settings", "/settings/learning", "/settings/learning/change", "/projects", "/people", "/ledger", "/ledger/export", "/projects/select"].includes(path);
  if (task || resource) return "resource";
  return unscoped ? "unscoped" : "collection";
}
/** handleGet's opener redirect exceptions, without its two query-dependent ones. */
const legacyNeedsProject = (path: string): boolean =>
  path !== "/" && path !== "/inbox" && path !== "/work" && path !== "/menu" && path !== "/recipes" &&
  path !== "/flows" && path !== "/flows/import" && !/^\/flows\/[0-9]{1,15}(\/insights|\/export|\/live|\/runs\/[0-9]{1,15}\/[0-9]{1,15})?$/.test(path) &&
  path !== "/flows/new" && !/^\/flows\/new\/[a-z-]{1,40}$/.test(path) && !path.startsWith("/teammates") &&
  path !== "/tasks/new" && path !== "/tasks/add" && !/^\/t\/[^/]+(\/evidence|\/live)?$/.test(path) &&
  !/^\/r\/[0-9]{1,15}(?:\/evidence\/[0-9]{1,15})?$/.test(path) && !path.startsWith("/d/") && !path.startsWith("/contest/") &&
  path !== "/projects" && path !== "/projects/browse" && path !== "/projects/github" && path !== "/workbench" && path !== "/fleet" &&
  path !== "/chat" && path !== "/chat/mate/status" && path !== "/chat/task-status" && path !== "/chat/stream" &&
  path !== "/lead/status" && path !== "/onboarding/phone/dismiss" && !path.startsWith("/chat/demo/") && !/^\/chat\/action\/[0-9]{1,15}$/.test(path) &&
  !path.startsWith("/settings") && path !== "/logout" && path !== "/people" && path !== "/ledger" && path !== "/ledger/export" && path !== "/metrics" && path !== "/health" && path !== "/spend" && path !== "/spend/budget" &&
  // /code answered before the opener check.
  path !== "/code" && !path.startsWith("/code/");
const legacyViewer = (path: string): boolean => new Set(["/projects/select", "/session/editor-links"]).has(path);

const consoleRoutes = ROUTES.filter(route => route.stage === "console");
const methodOf = (route: RouteDeclaration): string => route.method === "POST" ? "POST" : "GET";

describe("the route table", () => {
  test("is well formed: unique ids and rows, each row wins its own sample", () => {
    expect(() => assertRouteTable()).not.toThrow();
    expect(() => assertRouteTable([...ROUTES, { ...ROUTES[0]!, id: "copy" }])).toThrow(/duplicate route/);
    expect(() => assertRouteTable([...ROUTES, { ...ROUTES[1]!, pattern: "^\\/never$", sample: "/never" }])).toThrow(/duplicate id/);
    const shadow = ROUTES.findIndex(route => route.id === "recipes.run");
    const reordered = [...ROUTES];
    reordered.splice(shadow, 0, { ...ROUTES.find(route => route.id === "recipes.other")!, id: "early-catch-all" });
    expect(() => assertRouteTable(reordered)).toThrow(/shadowed/);
  });

  test("every row's sample resolves to that row (intentional precedence)", () => {
    for (const route of ROUTES) expect(matchRoute(methodOf(route), route.sample, route.stage)?.id, route.sample).toBe(route.id);
  });

  test("a project-limited account's access matches the legacy allowlists, route by route", () => {
    const differences = consoleRoutes
      .map(route => ({ id: route.id, sample: route.sample, table: route.limited, legacy: legacyLimited(methodOf(route), route.sample) }))
      .filter(one => one.table !== one.legacy);
    expect(differences).toEqual([]);
  });

  test("the selected-project exceptions and the viewer POST set match the legacy lists", () => {
    for (const route of consoleRoutes.filter(one => one.method === "GET")) expect(route.needsProject, route.sample).toBe(legacyNeedsProject(route.sample));
    for (const route of consoleRoutes.filter(one => one.method === "POST")) expect(route.viewer, route.sample).toBe(legacyViewer(route.sample));
  });

  test("/flows/:id/live is a browser-only read resolved through its flow's project", () => {
    const live = matchRoute("GET", "/flows/7/live", "console");
    expect(live).toMatchObject({ id: "flow.live", callers: ["cookie"], scope: "read", project: "flow", limited: "resource", needsProject: false });
    expect(matchRoute("POST", "/flows/7/live", "console")).toBeNull();
  });

  test("undeclared paths and wrong methods match nothing", () => {
    for (const path of ["/nope", "/settings/nope", "/t", "/t/a/b/c", "/r/x", "/flows/0/live", "/flows/1/live/x", "/chat/action/x", "/admin", "/.env", "/login/../board"]) {
      expect(matchRoute("GET", path, "console"), path).toBeNull();
      expect(matchRoute("POST", path, "console"), path).toBeNull();
    }
    expect(matchRoute("POST", "/board", "console")).toBeNull();
    expect(declaredForAnotherMethod("POST", "/board", "console")).toBe(true);
    expect(matchRoute("GET", "/tasks/add", "console")).toBeNull();
    expect(matchRoute("DELETE", "/board", "console")).toBeNull();
    expect(matchRoute("HEAD", "/board", "console")).toBeNull();
  });

  test("every literal address the console's routers compare against is declared", () => {
    const sources = ["tasks", "flows", "chat", "settings", "people-tokens", "pages"].map(name => readFileSync(join(import.meta.dirname, `${name}.ts`), "utf8"));
    let source = "";
    const body = (header: string): string => {
      const start = source.indexOf(header);
      const end = source.indexOf("\n  }\n", start);
      expect(start).toBeGreaterThan(0);
      return source.slice(start, end);
    };
    const literals = (text: string): string[] => [...new Set([...text.matchAll(/url\.pathname\s*===\s*["'`](\/[^"'`$]*)["'`]/g)].map(match => match[1]!))];
    const reads: string[] = [], writes: string[] = [];
    for (source of sources) {
      reads.push(...literals(body("  async function get(")));
      writes.push(...literals(body("  async function post(")));
    }
    expect(reads.length).toBeGreaterThan(60);
    expect(writes.length).toBeGreaterThan(80);
    expect(reads.filter(path => matchRoute("GET", path, "console") === null)).toEqual([]);
    expect(writes.filter(path => matchRoute("POST", path, "console") === null)).toEqual([]);
  });

  test("the effective policy of every route is frozen", () => {
    expect(routePolicySnapshot()).toMatchSnapshot();
  });
});
