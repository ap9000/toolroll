/**
 * A lead sweep's limit at claim time (docs/plans/lead-fan-out.md): at most max_parallel of its families hold a live
 * claim — checked in acquire's own write transaction, counting claimed-but-not-started, a revision as its child.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { acquire, release } from "./claim.js";

const T0 = new Date("2026-10-20T10:00:00.000Z");
const REPO = "/repo/sweep";
const tok = (name: string) => `tok-${name}`;

function approveScope(store: Store, password: string, taskId: string): void {
  for (const phase of ["plan", "build", "review"]) {
    if (store.phaseConfig("installation", phase) === null) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  }
  propose(store, { taskId, goal: "Reproduce and fix one report.", now: T0 });
  const scope = store.getScope(taskId);
  if (scope === null) throw new Error("no scope");
  const approved = approve(store, taskId, "alex", T0, scope.digest, password);
  if (!approved.ok) throw new Error(`approval refused: ${approved.reason}`);
}

describe("a sweep's limit", () => {
  let store: Store;
  const refs: number[] = [];
  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    for (const name of ["runner-a", "runner-b"]) register(store, { name, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => tok(name) });
    const sweep = store.createSweep({ owner: "alex", thread: null, repo: REPO, title: "Bug sweep", brief: "Reproduce first.", maxParallel: 2, proposal: null }, T0);
    refs.length = 0;
    for (const [index, id] of ["s-1", "s-2", "s-3"].entries()) {
      store.createTask({ id, title: `report ${index + 1}` }, T0);
      store.placeTask(store.refFor("built-in", id).id, REPO);
      approveScope(store, added.token, id);
      store.addSweepTask(sweep, id, index, `report ${index + 1}`);
      refs.push(store.refFor("built-in", id).id);
    }
  });
  afterEach(() => store.close());

  test("at most max_parallel families claim at once, across runners; a released slot opens", () => {
    expect(acquire(store, refs[0]!, "runner-a", { token: tok("runner-a"), now: T0 }).ok).toBe(true);
    expect(acquire(store, refs[1]!, "runner-b", { token: tok("runner-b"), now: T0 }).ok).toBe(true);
    const third = acquire(store, refs[2]!, "runner-a", { token: tok("runner-a"), now: T0 });
    expect(third).toMatchObject({ ok: false, reason: "sweep-limit", limit: 2 });
    const first = store.handle.prepare("SELECT lease_id FROM claim WHERE task_ref = ?").get(refs[0]!)!;
    release(store, String(first["lease_id"]), T0);
    expect(acquire(store, refs[2]!, "runner-a", { token: tok("runner-a"), now: T0 }).ok).toBe(true);
  });

  test("an expired lease no longer holds a slot", () => {
    acquire(store, refs[0]!, "runner-a", { token: tok("runner-a"), now: T0, ttlMs: 1_000 });
    acquire(store, refs[1]!, "runner-b", { token: tok("runner-b"), now: T0, ttlMs: 1_000 });
    expect(acquire(store, refs[2]!, "runner-a", { token: tok("runner-a"), now: new Date(T0.getTime() + 5_000) }).ok).toBe(true);
  });

  test("a task outside any sweep is never limited by one", () => {
    store.createTask({ id: "solo", title: "solo" }, T0);
    store.placeTask(store.refFor("built-in", "solo").id, REPO);
    expect(store.sweepOfTask("solo")).toBeNull();
    expect(store.sweepOfTask("s-2")).toMatchObject({ maxParallel: 2 });
  });
});
