/**
 * The route table's own rules: well formed, each row wins its sample, and every policy class keeps its invariant.
 * What the server does with each row is checked over HTTP (route-policy-http, handler-registry, console-api and
 * serve.bearer-scope tests), generated from the same table.
 */
import { describe, expect, test } from "vitest";
import { assertRouteTable, matchRoute, ROUTES, type RouteDeclaration } from "./route-table.js";
import { RETIRED_ROUTES } from "./retired-routes.js";

const consoleRoutes = ROUTES.filter(route => route.stage === "console");
const edgeRoutes = ROUTES.filter(route => route.stage === "edge");
const ids = (routes: readonly RouteDeclaration[]): string[] => routes.map(route => route.id);
const methodOf = (route: RouteDeclaration): string => route.method === "POST" ? "POST" : "GET";

// Hand-kept access decisions, independent of ROUTES. Equality catches additions and policy changes as well as removals;
// a deny row must not disappear from the HTTP refusal matrix by silently becoming unscoped/collection/resource.
const LIMITED_ACCESS = {
  'code.page': 'self', 'projects.page': 'unscoped', 'projects.project': 'unscoped', 'projects.map': 'unscoped', 'projects.flaky': 'unscoped',
  'home': 'collection', 'search': 'collection', 'morning': 'collection', 'activity': 'collection', 'inbox': 'collection', 'work': 'collection', 'next': 'collection',
  'work.put-away': 'collection', 'work.put-away.apply': 'collection', 'task.act.archive': 'resource', 'task.act.restore': 'resource',
  'board': 'collection', 'review': 'collection', 'ledger': 'unscoped', 'done': 'collection',
  // Retired pages (P1.4) admit exactly as their target, Tasks, does; a push's /n/<n> resolves under the viewer's own access.
  'queue': 'collection', 'workbench': 'collection', 'tasks.archive': 'collection', 'n.task': 'unscoped',
  'people.page': 'unscoped', 'tasks': 'collection', 'tasks.new': 'collection', 'welcome': 'collection',
  'task.page': 'resource', 'task.evidence': 'resource',
  // One-tap release approval: the sheet and the push's locator are each one task's own page, admitted by its project.
  'task.release': 'resource', 'release.locate': 'resource',
  'ledger.export': 'unscoped', 'runs': 'collection', 'menu': 'collection',
  'run.page': 'resource', 'run.evidence': 'resource',
  'flows.new': 'resource', 'flows.gallery': 'resource', 'flows.page': 'resource',
  'flow.insights': 'resource', 'flow.scripts': 'resource', 'flow.export': 'resource', 'flow.page': 'resource',
  'recipes': 'collection', 'recipes.run': 'collection', 'recipes.start': 'collection',
  'recipes.new': 'collection', 'recipes.edit': 'collection', 'recipes.from-task': 'collection',
  'recipes.preview': 'collection', 'recipes.export': 'collection', 'routines': 'collection',
  'chat.page': 'conversation', 'routine.page': 'resource', 'chat.action': 'proposal',
  'settings.skills': 'unscoped', 'settings.flows': 'collection', 'settings.knowledge': 'unscoped',
  'settings.learning': 'unscoped', 'settings.telegram': 'self', 'settings.page': 'unscoped',
  'settings.group-general': 'unscoped', 'settings.group-agents': 'unscoped', 'settings.group-alerts': 'unscoped', 'settings.group-projects': 'unscoped', 'settings.group-access': 'unscoped', 'settings.group-system': 'unscoped',
  'decision.page': 'resource', 'decision.evidence': 'resource', 'code.act-other': 'self', 'code.answer-send': 'self', 'code.changes': 'self', 'code.continue-send': 'self',
  'code.other': 'self', 'code.changes-read': 'self', 'code.ship-preview': 'self', 'code.recover-send': 'self', 'code.resume-send': 'self', 'code.send-send': 'self',
  // Lead sweeps: the handler shows and acts only on a sweep in a project the reader can see.
  'sweep.page': 'unscoped', 'sweep.cancel-rest': 'unscoped',
  // Start a builder (S4): where Connect a builder leads; the handler shows only a visible project.
  'start-builder': 'unscoped',
  'code.session': 'self', 'code.ship': 'self', 'code.ship-send': 'self', 'code.start': 'self', 'code.state': 'self', 'code.stop-send': 'self',
  'settings.skills-revise': 'unscoped', 'settings.skills-import': 'unscoped', 'settings.skills-change': 'unscoped',
  'flows.gallery-create': 'resource', 'flows.create': 'resource', 'flows.import': 'resource',
  'flow.archive': 'resource', 'flow.cards': 'resource', 'flow.run': 'resource', 'flow.save': 'resource', 'flow.triggers': 'resource', 'flow.card.assign': 'resource', 'flow.card.cancel': 'resource', 'flow.card.comment': 'resource',
  'flow.card.decide': 'resource', 'flow.card.move': 'resource', 'flow.card.watch': 'resource',
  // Turning browser use off lowers authority: any approver on the flow's project; allowing it needs instance access.
  'flow.browser-off': 'resource',
  'flow.trigger.pause': 'resource', 'flow.trigger.resume': 'resource', 'flow.trigger.remove': 'resource',
  'flow.trigger.check': 'resource', 'flow.trigger.press': 'resource', 'flow.trigger.renew': 'resource',
  'flow.trigger.secret': 'resource', 'flow.trigger.setup': 'resource', 'flow.trigger.sender': 'resource', 'flow.trigger.dropped': 'resource', 'flow.trigger.scope': 'resource', 'flow.trigger.share': 'resource', 'flow.trigger.unshare': 'resource',
  'settings.flows-on': 'collection', 'settings.integrations-youiyoux': 'collection', 'settings.knowledge-refresh': 'unscoped',
  'settings.knowledge-change': 'unscoped', 'settings.learning-change': 'unscoped',
  'settings.telegram-retry': 'self', 'settings.chat-approval-confirm': 'self',
  'settings.chat-approval-save': 'self', 'settings.chat-approval-off': 'self',
  'settings.telegram-pair': 'self', 'settings.telegram-unpair': 'self',
  'projects.select': 'unscoped', 'agents': 'unscoped', 'agents.live': 'unscoped', 'agents.live.read': 'unscoped', 'agents.seen': 'unscoped', 'agents.watch': 'unscoped', 'tasks.add': 'collection', 'tasks.fast': 'collection', 'task.act.keep-grown': 'resource', 'task.release.go-on': 'resource', 'decision.answer': 'resource',
  'task.act.hold': 'resource', 'task.act.unhold': 'resource', 'task.act.requeue': 'resource',
  'task.act.cancel': 'resource', 'task.act.scope': 'resource', 'task.act.approve': 'resource',
  'task.act.plan': 'resource', 'task.act.plan-edit': 'resource', 'task.act.next': 'resource',
  'task.act.reopen': 'resource', 'task.act.steer': 'resource', 'task.act.reply': 'resource', 'task.act.accept-proof': 'resource',
  'task.act.accept-revision': 'resource', 'task.act.reject-revision': 'resource', 'task.act.route': 'resource',
  'task.act.retry-review': 'resource', 'task.act.complete': 'resource', 'task.act.merge': 'resource',
  'task.act.recheck-stopped': 'resource', 'task.act.stop': 'resource', 'task.act.stop-carrying': 'resource', 'task.act.pause': 'resource',
  'task.act.resume-arm': 'resource', 'task.act.resume': 'resource', 'chat.proposal.confirm': 'proposal', 'chat.proposal.dismiss': 'proposal',
  'recipes.prepare-send': 'collection', 'recipes.preview-send': 'collection', 'recipes.import-send': 'collection',
  'recipes.save-send': 'collection', 'recipes.launch-send': 'collection', 'run.act.add-tests': 'resource', 'run.act.checks': 'resource', 'run.act.comment': 'resource',
  'run.act.draft-repair': 'resource', 'run.act.note': 'resource', 'run.act.reveal': 'resource', 'run.act.revise': 'resource', 'session.forget-password': 'self',
} satisfies Record<string, Exclude<RouteDeclaration['limited'], 'deny'>>;

describe("the route table", () => {
  test('project-limited access matches the independent per-route decisions exactly', () => {
    expect(Object.fromEntries(ROUTES.filter(row => row.limited !== 'deny').map(row => [row.id, row.limited])))
      .toEqual(LIMITED_ACCESS);
  });

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
    expect(ids(consoleRoutes.filter(one => one.viewer))).toEqual(["session.forget-password", "projects.select", "session.editor-links", "agents.seen", "agents.watch"]);
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

  test("one live stream: GET /live, readable by a browser or a token, each room proving its own access", () => {
    const live = matchRoute("GET", "/live", "edge");
    expect(live).toMatchObject({ id: "live", callers: ["cookie", "bearer"], scope: "read", project: "adapter", proof: "adapter", needsProject: false });
    for (const old of ["/t/one/live", "/flows/7/live", "/chat/stream"]) expect(matchRoute("GET", old, "console"), old).toBeNull();
    expect(matchRoute("GET", "/api/team/events")).toBeNull();
    expect(matchRoute("POST", "/live", "console")).toBeNull();
  });

  test("undeclared paths and wrong methods match nothing", () => {
    for (const path of ["/nope", "/settings/nope", "/t", "/t/a/b/c", "/r/x", "/flows/0/export", "/flows/1/export/x", "/chat/action/x", "/admin", "/.env", "/login/../board"]) {
      expect(matchRoute("GET", path, "console"), path).toBeNull();
      expect(matchRoute("POST", path, "console"), path).toBeNull();
    }
    expect(matchRoute("POST", "/board", "console")).toBeNull();
    expect(matchRoute("GET", "/tasks/add", "console")).toBeNull();
    expect(matchRoute("DELETE", "/board", "console")).toBeNull();
    expect(matchRoute("HEAD", "/board", "console")).toBeNull();
  });
});

describe("retired pages (docs/plans/plain-toolroll.md P1.4)", () => {
  const retired = ROUTES.filter(route => route.retired === true);
  test("every retired GET is a redirect row with a target and no page of its own; Home, Tasks and results keep theirs", () => {
    expect(ids(retired).sort()).toEqual(["board", "done", "inbox", "next", "queue", "work", "work.put-away", "workbench"]);
    for (const route of retired) {
      expect(route.method, route.id).toBe("GET");
      expect(RETIRED_ROUTES[route.id], route.id).toBeDefined();
      // Admitted exactly as the page it leads to: never sent to the project opener first, a listing for a limited person.
      expect(route.needsProject, route.id).toBe(false);
      expect(route.limited, route.id).toBe("collection");
    }
    for (const id of ["home", "tasks", "review", "tasks.archive", "task.page"]) expect(ROUTES.find(route => route.id === id)?.retired, id).toBeUndefined();
  });

  test("the archive POST row is unchanged: its path, step-up and approver rule", () => {
    const apply = ROUTES.find(route => route.id === "work.put-away.apply")!;
    expect(apply).toMatchObject({ method: "POST", pattern: "^\\/work\\/put-away$", scope: "step-up", callers: ["cookie"], limited: "collection", role: "approver", roleBrowser: true });
    expect(matchRoute("POST", "/work/put-away")?.id).toBe("work.put-away.apply");
    expect(matchRoute("GET", "/tasks/archive")?.id).toBe("tasks.archive");
  });

  test("each redirect keeps only the keys its target knows", () => {
    const at = (id: string, path: string) => RETIRED_ROUTES[id]!(new URL(path, "http://x"));
    expect(at("work", "/work")).toBe("/tasks");
    expect(at("work", "/work?view=needs-you&project=%2Fr%2Fshop&evil=1")).toBe("/tasks?project=%2Fr%2Fshop&view=needs-you");
    expect(at("work", "/work?layout=board&state=failed")).toBe("/tasks?view=board");
    expect(at("work", "/work?all=1&view=running")).toBe("/tasks?scope=all&view=running");
    expect(at("work", "/work?project=a&project=b")).toBe("/tasks");
    expect(at("inbox", "/inbox?tab=ready")).toBe("/");
    expect(at("next", "/next?skip=d:1")).toBe("/");
    expect(at("workbench", "/workbench?t=one")).toBe("/tasks?scope=all");
    expect(at("board", "/board")).toBe("/tasks?view=board");
    expect(at("board", "/board?view=order")).toBe("/tasks?view=order");
    expect(at("board", "/board?scope=all")).toBe("/tasks?scope=all&view=board");
    expect(at("queue", "/queue")).toBe("/tasks?view=order");
    expect(at("done", "/done")).toBe("/tasks?view=done");
    expect(at("review", "/review")).toBe("/tasks?view=ready");
    expect(at("work.put-away", "/work/put-away?days=30")).toBe("/tasks/archive?days=30");
    expect(at("work.put-away", "/work/put-away?days=../x")).toBe("/tasks/archive");
  });

  test("/n/<number> is its own row outside /t/, numbers only", () => {
    expect(matchRoute("GET", "/n/41")?.id).toBe("n.task");
    for (const path of ["/n/0", "/n/1x", "/n/../x", "/n/fix-the-footer", "/n/41/x"]) expect(matchRoute("GET", path)?.id, path).not.toBe("n.task");
  });
});
