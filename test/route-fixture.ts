/** Shared by the split server and tick suites (src/serve.*.test.ts, src/tick.*.test.ts). */

/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
export const presented = (
  s: Pick<import("../src/store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  spend: { provider: string; model: string | null } = { provider: "claude", model: null },
): { route: import("../src/phase-routing.js").RouteStamp } | Record<string, never> => {
  // A task with no scope presents the bare word `legacy` for the pair it
  // spends as (atomic authority closure): the default claude pair, or the
  // exact pair a fixture names.
  const authority = s.routeAuthorityFor(taskRef, role) ?? s.routeAuthorityFor(taskRef, role, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};
