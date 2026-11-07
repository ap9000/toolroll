/**
 * P2.5 must-refuse rules, against the real store: a sealed route is exact, so a change of configuration seals nothing and
 * dispatches nothing; Toolroll proposes the new exact route itself with one line; an Approve whose line doesn't describe
 * the proposed route digest refuses.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, approvalOf, propose } from "./scope.js";
import { diagnoseTaskDispatch, scopeApprovedForDispatch, taskReadinessBlocker } from "./dispatch.js";
import { holdStaleApproval } from "./dispose.js";
import { legOf, routeFromJson } from "./phase-routing.js";
import { proposeNewRoute, routeChangeOf, routeChangeWords, routeLegacyPlans } from "./route-change.js";
import { register } from "./runner.js";
import { planCardText } from "./chat-decide.js";

const REPO = "/repos/shop";
const NOW = new Date("2026-11-06T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
let dir: string, store: Store, password: string, ref: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-route-"));
  store = openStore(join(dir, "orders.db"));
  const owner = addApprover(store, "owner", NOW);
  if (!owner.ok) throw new Error("owner");
  password = owner.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", NOW);
  register(store, { name: "worker", host: "fixture", capacity: 2, repos: [REPO], now: NOW, newToken: () => "tok" });
  store.createTask({ id: "t", title: "t" }, NOW);
  ref = store.refFor("built-in", "t").id;
  store.placeTask(ref, REPO, {}, NOW);
  const scope = propose(store, { taskId: "t", goal: "Fix it.", touches: ["a.ts"], acceptance: [{ id: "c1", statement: "ok", how: null, evidence: ["check"] }], now: NOW });
  const yes = approve(store, "t", "owner", NOW, scope.digest, password);
  if (!yes.ok) throw new Error(yes.reason);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const changeRoute = () => store.setPhaseConfig("installation", "build", "claude", "opus", "owner", later(1));
const stale = () => holdStaleApproval(store, { taskRef: ref, taskId: "t", message: "routing moved" }, later(2));

describe("the new route", () => {
  test("a configuration change alone rewrites nothing: the sealed bytes stand", () => {
    const before = store.getScope("t")!.approvedRouteJson;
    changeRoute();
    expect(store.getScope("t")!.approvedRouteJson).toBe(before);
    expect(scopeApprovedForDispatch(store, ref, later(2))).toBe(true);
  });

  test("Toolroll proposes the exact route itself: nothing is sealed, nothing dispatches, one line and one Approve", () => {
    const sealed = store.getScope("t")!.approvedRouteJson;
    changeRoute();
    stale();
    const scope = store.getScope("t")!;
    expect(scope.approvedRouteJson).toBe(sealed);
    expect(approvalOf(scope).approved).toBe(false);
    expect(scopeApprovedForDispatch(store, ref, later(3))).toBe(false);
    expect(legOf(routeFromJson(scope.proposedRouteJson!)!, "build").model).toBe("opus");
    expect(routeChangeOf(store, "t")).toBe("The builder changes from Claude sonnet to Claude opus. Approve to continue.");
    expect(taskReadinessBlocker(store, ref, later(3))).toMatchObject({ code: "hold" });
    expect(planCardText(store, "t", scope)).toContain("The builder changes from");
    const yes = approve(store, "t", "owner", later(4), scope.digest, password);
    expect(yes.ok).toBe(true);
    expect(legOf(routeFromJson(store.getScope("t")!.approvedRouteJson!)!, "build").model).toBe("opus");
    expect(taskReadinessBlocker(store, ref, later(5))).toBeNull();
    expect(scopeApprovedForDispatch(store, ref, later(5))).toBe(true);
    expect(routeChangeOf(store, "t")).toBeNull();
  });

  test("the need says what changed", () => {
    changeRoute();
    stale();
    store.releaseOwnedHold("backoff", `stale:${ref}`);
    expect(diagnoseTaskDispatch(store, "t", later(3))).toMatchObject({ code: "needs-approval", detail: expect.stringContaining("The builder changes from") });
  });

  test("the billing change rides the line", () => {
    const route = routeFromJson(store.getScope("t")!.approvedRouteJson!)!;
    expect(routeChangeWords({ route, profile: null, authMode: "api-key" }, { route: { ...route, legs: route.legs.map(one => one.phase === "build" ? { ...one, model: "opus" } : one) } as never, authMode: "subscription" })).toContain("(API key → subscription)");
  });
});

describe("must refuse", () => {
  test("an Approve whose line doesn't describe the proposed route digest", () => {
    changeRoute();
    stale();
    const scope = store.getScope("t")!;
    store.handle.prepare("UPDATE route_change SET to_route_digest = 'other'").run();
    expect(routeChangeOf(store, "t")).toBeNull();
    expect(approve(store, "t", "owner", later(3), scope.digest, password)).toMatchObject({ ok: false, reason: "changed" });
    expect(approvalOf(store.getScope("t")).approved).toBe(false);
  });

  test("a stale digest: the route moved again after the line was shown", () => {
    changeRoute();
    stale();
    const shown = store.getScope("t")!.digest;
    store.setPhaseConfig("installation", "build", "claude", "haiku", "owner", later(3));
    proposeNewRoute(store, ref, "t", later(4));
    expect(approve(store, "t", "owner", later(5), shown, password)).toMatchObject({ ok: false, reason: "changed" });
  });

  test("a line from before an edit says nothing about the edited plan", () => {
    changeRoute();
    stale();
    propose(store, { taskId: "t", goal: "Fix something else.", touches: ["a.ts"], acceptance: [{ id: "c1", statement: "ok", how: null, evidence: ["check"] }], now: later(3) });
    expect(routeChangeOf(store, "t")).toBeNull();
  });

  test("nothing changed: nothing is proposed", () => {
    expect(proposeNewRoute(store, ref, "t", later(1))).toBeNull();
    expect(approvalOf(store.getScope("t")).approved).toBe(true);
  });

  test("a release plan keeps its own road", () => {
    store.handle.prepare("UPDATE task_scope SET candidate = ? WHERE task_id = 't'").run("a".repeat(40));
    expect(proposeNewRoute(store, ref, "t", later(1))).toBeNull();
  });
});

describe("legacy rows", () => {
  test("an unapproved row with no route is routed and waits for the same Approve; a standing old approval is left alone", () => {
    store.createTask({ id: "old", title: "old" }, NOW);
    const oldRef = store.refFor("built-in", "old").id;
    store.placeTask(oldRef, REPO, {}, NOW);
    propose(store, { taskId: "old", goal: "Old.", touches: ["b.ts"], acceptance: [{ id: "c1", statement: "ok", how: null, evidence: ["check"] }], now: NOW });
    store.handle.prepare("UPDATE task_scope SET route_era = NULL, proposed_route_json = NULL WHERE task_id = 'old'").run();
    store.handle.prepare("UPDATE task_scope SET route_era = NULL WHERE task_id = 't'").run();
    expect(routeLegacyPlans(store, later(1))).toBe(1);
    expect(routeFromJson(store.getScope("old")!.proposedRouteJson ?? null)).not.toBeNull();
    expect(routeChangeOf(store, "old")).toContain("The builder is Claude sonnet");
    expect(approvalOf(store.getScope("t")).approved).toBe(true);
  });
});
