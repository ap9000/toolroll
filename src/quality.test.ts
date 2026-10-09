import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, digestOf, propose } from "./scope.js";

/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-09-07T12:00:00.000Z");

/** v48: a routed task opens no run without a sealed route — approve first. */
function sealScope(store: Store, taskId: string): void {
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap should never be refused");
  const approved = approve(store, taskId, "alex", T0, store.getScope(taskId)!.digest, added.token);
  if (!approved.ok) throw new Error(`the fixture approval was refused: ${approved.reason}`);
}

describe("two quality modes", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
  });

  afterEach(() => store.close());

  test("Default preserves the historical digest while Strict / release is explicitly signed", () => {
    const terms = { goal: "ship the guard", outOfScope: null, touches: ["src/guard.ts"] };
    expect(digestOf(terms)).toBe(digestOf({ ...terms, qualityMode: "default" }));
    expect(digestOf({ ...terms, qualityMode: "strict" })).not.toBe(digestOf(terms));
  });

  test("the installation default resolves into a concrete scope and exact run stamp", () => {
    expect(store.qualityDefault()).toMatchObject({ mode: "default", updatedAt: null, updatedBy: null });
    store.setQualityDefault("strict", "alex", T0);
    store.createTask({ id: "release", title: "release it" }, T0);

    const scope = propose(store, { taskId: "release", goal: "release it with proof", now: T0 });
    expect(scope.qualityMode).toBe("strict");
    expect(store.refFor("built-in", "release").qualityMode).toBeNull();
    sealScope(store, "release");

    const run = store.startRun({
      taskRef: store.refFor("built-in", "release").id,
      leaseId: "lease-release",
      runner: "builder-1",
      branch: "standing-orders/release",
      worktree: "/pool/release",
      now: T0,
      ...presented(store, store.refFor("built-in", "release").id, "builder"),
    });
    expect(store.getRun(run)?.qualityMode).toBe("strict");
    expect(store.qualityDefault()).toMatchObject({ mode: "strict", updatedBy: "alex" });
  });

  test("a task override wins and later global edits do not rewrite an existing scope", () => {
    store.setQualityDefault("strict", "alex", T0);
    const made = store.createConsoleTask(
      { id: "fast", title: "fast task", goal: "take the fast evidence path", acceptance: [{ id: "c1", statement: "done", evidence: ["manual-review"] }], qualityMode: "default" },
      T0,
    );
    expect(made.ok).toBe(true);
    const before = store.getScope("fast");
    expect(before?.qualityMode).toBe("default");
    expect(store.refFor("built-in", "fast").qualityMode).toBe("default");

    store.setQualityDefault("default", "alex", new Date(T0.getTime() + 1_000));
    expect(store.getScope("fast")?.digest).toBe(before?.digest);
    expect(store.getScope("fast")?.qualityMode).toBe("default");
  });
});
