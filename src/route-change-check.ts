/** The approval's one question about a "what changed" line (route-change.ts), apart so scope.ts loads it without the rest. */
import { routeDigestOf, routeFromJson } from "./phase-routing.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";

/** Whether a line on record for this exact plan describes some other route. An Approve under it is a yes to the wrong words. */
export function routeChangeProblem(store: Store, taskId: string, scope: Scope): boolean {
  const ref = store.lookupRef(taskId);
  if (ref === null) return false;
  const row = store.handle.prepare("SELECT to_route_digest FROM route_change WHERE task_ref = ? AND scope_digest = ?").get(ref.id, scope.digest);
  if (row === undefined) return false;
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  return route === null || routeDigestOf(route) !== row["to_route_digest"];
}
