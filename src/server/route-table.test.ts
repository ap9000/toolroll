/**
 * The route table's own rules: well formed, each row wins its sample, and every policy class keeps its invariant.
 * What the server does with each row is checked over HTTP (route-policy-http, handler-registry, console-api and
 * serve.bearer-scope tests), generated from the same table.
 */
import { describe, expect, test } from "vitest";
import { assertRouteTable, declaredForAnotherMethod, matchRoute, ROUTES, type RouteDeclaration } from "./route-table.js";

const consoleRoutes = ROUTES.filter(route => route.stage === "console");
const edgeRoutes = ROUTES.filter(route => route.stage === "edge");
const ids = (routes: readonly RouteDeclaration[]): string[] => routes.map(route => route.id);
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

  test("every policy class keeps its invariant", () => {
    // Password step-up is a browser's POST, never a token's.
    for (const route of ROUTES.filter(one => one.scope === "step-up")) expect([route.method, route.callers], route.id).toEqual(["POST", ["cookie"]]);
    // The console admits cookies and bearers only, after Host validation and its own sign-in; reads need read, actions act or step-up.
    for (const route of consoleRoutes) {
      expect({ proof: route.proof, host: route.host }, route.id).toEqual({ proof: "console", host: "after" });
      expect(route.callers.every(caller => caller === "cookie" || caller === "bearer"), route.id).toBe(true);
      expect(route.scope, route.id).toEqual(route.method === "POST" ? expect.stringMatching(/^(act|step-up)$/) : "read");
    }
    // Only health and the signed hooks answer before Host validation.
    expect(ids(ROUTES.filter(one => one.host === "before"))).toEqual(["edge.healthz", ...ids(edgeRoutes.filter(one => one.sample.startsWith("/hooks/")))]);
    for (const route of ROUTES.filter(one => one.host === "before" && one.id !== "edge.healthz")) expect(route.proof, route.id).toBe("adapter");
    // An edge row either is public (anonymous, needs nothing, names no project) or keeps its protocol's own proof.
    for (const route of edgeRoutes.filter(one => one.proof === "public")) {
      expect({ scope: route.scope, project: route.project }, route.id).toEqual({ scope: "none", project: "none" });
      expect(route.callers.every(caller => caller === "anonymous" || caller === "cookie"), route.id).toBe(true);
    }
    for (const route of edgeRoutes.filter(one => one.callers.some(caller => !["anonymous", "cookie"].includes(caller)) || one.scope !== "none")) expect(route.proof, route.id).toBe("adapter");
    // A verified external sender is the row's only caller and proves itself in its adapter.
    for (const route of ROUTES.filter(one => one.callers.includes("service"))) expect({ callers: route.callers, proof: route.proof, scope: route.scope }, route.id).toEqual({ callers: ["service"], proof: "adapter", scope: "none" });
    // Project-limited access, the opener redirect and the viewer exception are console facts; the viewer may only POST.
    for (const route of ROUTES.filter(one => one.limited !== "deny")) expect(route.stage, route.id).toBe("console");
    for (const route of ROUTES.filter(one => one.needsProject)) expect([route.stage, route.method], route.id).toEqual(["console", "GET"]);
    for (const route of ROUTES.filter(one => one.viewer)) expect([route.method, route.callers.includes("cookie")], route.id).toEqual(["POST", true]);
    expect(ids(consoleRoutes.filter(one => one.viewer))).toEqual(["projects.select", "session.editor-links"]);
    // Each limited kind names how its object is found.
    for (const route of ROUTES.filter(one => one.limited === "self")) expect(["coding", "session"], route.id).toContain(route.project);
    expect(ids(ROUTES.filter(one => one.limited === "proposal"))).toEqual(ids(ROUTES.filter(one => one.project === "proposal")));
    expect(ids(ROUTES.filter(one => one.limited === "conversation"))).toEqual(["chat.page"]);
    for (const route of ROUTES.filter(one => ["task", "run", "decision", "routine", "flow"].includes(one.project))) expect(["resource", "deny"], route.id).toContain(route.limited);
    // Every project resolver but the adapter's is a console fact.
    for (const route of edgeRoutes) expect(["none", "flow", "adapter"], route.id).toContain(route.project);
    // Own refusal wording belongs to cookie-only console rows.
    for (const route of ROUTES.filter(one => one.scopeRefusal !== undefined || one.callerRefusal !== undefined)) expect([route.stage, route.callers], route.id).toEqual(["console", ["cookie"]]);
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
});
