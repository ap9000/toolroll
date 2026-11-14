/**
 * Fixtures shared by the console server suites (src/serve.*.test.ts): the
 * route a fixture presents, the sealed-scope ceremony, and readers for the
 * rendered workspace, stylesheet and revision forms.
 */
import { expect } from "vitest";
import type { Store } from "../src/store.js";
import { approve, propose } from "../src/scope.js";

export { presented } from "./route-fixture.js";

export const T0 = new Date("2026-08-11T22:00:00.000Z");

export async function stylesOf(html: string, base: string): Promise<string> {
  const path = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];
  if (!path) throw new Error("missing workspace stylesheet");
  const response = await fetch(new URL(path, base));
  expect(response.status).toBe(200);
  return response.text();
}

/** The JSON snapshot is inert transport, not a second rendered copy. Keep
 * visible-copy assertions on the fallback and inspect snapshot admission
 * separately; never strip it from whole-response secret/XSS assertions. */
export function renderedHtmlOf(html: string): string {
  return html.replace(/<script type="application\/json" id="standing-orders-workspace-data"[^>]*>[\s\S]*?<\/script>/, '');
}

export function workspaceOf(html: string): import('../src/browser-workspace.js').BrowserWorkspace {
  const json = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(json, 'authenticated browser workspace snapshot').toBeDefined();
  return JSON.parse(json!);
}

/** The revision form's own binding (repair 2026-09-14): the exact note
 * batch and source terms a rendered page displays. A seal posts these —
 * a bare `{ csrf }` is an out-of-date form and is refused. */
export function revisionIdOf(location: string | null): string {
  const url = new URL(location ?? "", "http://fixture");
  return url.searchParams.get("revision") ?? url.searchParams.get("version") ?? decodeURIComponent(url.pathname.slice(3));
}

/** A sent-back revision is planned first. Fixtures that go on to its approval
 * stand in for the planner's turn with the copied terms kept as they are
 * (the planner's real turn is covered end to end, scripts/app-e2e.mjs). */
export function plannerKeptTerms(store: Store, taskId: string): void {
  const ref = store.lookupRef(taskId);
  expect(ref?.plan).toBe("requested");
  store.setPlanState(ref!.id, "drafted");
}

export function revisionFormOf(html: string): { batch: string; source: string } {
  const form = /<form method="post" action="\/r\/[0-9]+\/revise"[\s\S]*?<\/form>/.exec(html)?.[0] ?? /<form method="post" action="\/r\/[0-9]+\/comment"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
  return {
    batch: /name="batch" value="([^"]*)"/.exec(form)?.[1] ?? "",
    source: /name="source" value="([^"]*)"/.exec(form)?.[1] ?? "",
  };
}

/**
 * v48: a routed task opens no run without a sealed route. Fixtures that
 * need a run on a task seal its scope through the real ceremony first:
 * exact agents configured once, the scope proposed (or re-filed under
 * today's configuration), and approved by a bootstrap approver whose token
 * is remembered per store. The task's own goal is kept when one is filed.
 */
export function sealScopeFixture(store: Store, taskId: string, token: string, goal = "the work"): void {
  for (const phase of ["plan", "build", "review"]) {
    if (store.phaseConfig("installation", phase) === null) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  }
  const existing = store.getScope(taskId);
  if (existing === null) propose(store, { taskId, goal, now: T0 });
  else if (existing.profileState !== "resolved" || existing.proposedRouteJson == null) store.refileScope(taskId, T0);
  const scope = store.getScope(taskId);
  if (scope === null) throw new Error("the fixture filed no scope");
  if (scope.approvedAt !== null && scope.approvedDigest === scope.digest) return;
  const approved = approve(store, taskId, "alex", T0, scope.digest, token);
  if (!approved.ok) throw new Error(`the fixture approval of ${taskId} was refused: ${approved.reason}`);
}

/** Work's list ("/", the one-workspace plan S2a): the Tasks list view it carries, from a workspace snapshot (or a Tasks
 * view itself, for a page that still sends one). */
export function workListOf(workspace: import('../src/browser-workspace.js').BrowserWorkspace): import('../src/browser-workspace.js').BrowserTasksView {
  const view = workspace.view;
  if (view?.kind === 'work') return view.list;
  if (view?.kind === 'tasks') return view;
  throw new Error(`not Work's list: ${view?.kind ?? 'no view'}`);
}

/** Work's Needs-you rows (every ask Home admitted), in their Decide / Review / Unblock groups' order. */
export function workNeedsRowsOf(workspace: import('../src/browser-workspace.js').BrowserWorkspace): import('../src/browser-workspace.js').BrowserHomeRow[] {
  const view = workspace.view;
  if (view?.kind !== 'work') throw new Error(`not Work: ${view?.kind ?? 'no view'}`);
  return view.needs.flatMap(group => group.rows);
}
