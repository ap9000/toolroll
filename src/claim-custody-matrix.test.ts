/**
 * THE CURRENT-CLAIM TUPLE INVARIANT, as one isolated mutation matrix (repair
 * custody closure): a repair turn proves inside its own transaction that the
 * run it opens is this task's, under the lease that holds the task RIGHT NOW,
 * on the runner that claim names. Every way the claim can disagree — the SAME
 * lease held by another machine, a lease the caller names that is not the
 * claim, an expired claim, a released one, one superseded by a newer
 * generation, and no claim at all — is applied to a snapshot of the database,
 * the admission is asked, and the database is proved byte-for-byte unchanged:
 * no run, no route, no claim moved. Then the exact statement admits, so the
 * fixture is shown to be otherwise sound.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover } from "./scope.js";
import type { RouteStamp } from "./phase-routing.js";

const T0 = new Date("2026-08-29T12:00:00.000Z");
const REPO = "/repos/custody";
const RUNNER = "b-1";

type Mutation = "wrong-runner" | "lease-mismatch" | "expired" | "released" | "superseded" | "nothing-holds";
const MUTATIONS: readonly Mutation[] = ["wrong-runner", "lease-mismatch", "expired", "released", "superseded", "nothing-holds"];

/** The words a claim disagreement is refused in. `lease-mismatch` may be
 * refused earlier in the repair road's own words — the parent's lease is not
 * the caller's before the claim is even read — so it accepts either. */
const words = (mutation: Mutation, lease: string): RegExp => {
  switch (mutation) {
    case "wrong-runner":
      return new RegExp(`this task's live claim ${lease} is held by other-machine — a repair turn on ${RUNNER} is another machine's`);
    case "lease-mismatch":
      return new RegExp(`lease l-stranger is not this task's current live claim \\(${lease} does\\)|a repair turn under lease l-stranger is not its own`);
    case "expired":
    case "released":
    case "nothing-holds":
      return new RegExp(`lease ${lease} is not this task's current live claim \\(nothing holds it\\)`);
    case "superseded":
      return new RegExp(`lease ${lease} is not this task's current live claim \\(l-super does\\)`);
  }
};

describe("the current-claim tuple invariant: one mutation matrix over the repair admission", () => {
  let store: Store;
  let ref: number;

  const hold = (lease: string, runner = RUNNER): void => {
    const generation = Number((store.raw().prepare("SELECT COALESCE(MAX(lease_generation), 0) + 1 AS g FROM claim WHERE task_ref = ?").get(ref) as { g: number }).g);
    store
      .raw()
      .prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(lease, ref, generation, runner, T0.toISOString(), new Date(T0.getTime() + 900_000).toISOString(), T0.toISOString());
  };
  const presented = (role: "builder" | "repair"): { route: RouteStamp } => {
    const authority = store.routeAuthorityFor(ref, role);
    if (authority === null || !authority.ok) throw new Error(`no ${role} authority`);
    return { route: authority.stamp };
  };

  /** Every table an admission could write, read whole and in a fixed order. */
  const snapshot = () => {
    const db = store.raw();
    return {
      run: db.prepare("SELECT * FROM run ORDER BY id").all(),
      route: db.prepare("SELECT * FROM run_route ORDER BY run").all(),
      claim: db.prepare("SELECT * FROM claim ORDER BY lease_id").all(),
      sqlite: db.prepare("SELECT total_changes() AS n").get(),
    };
  };

  /** Apply one claim disagreement to the live claim `lease`; returns the
   * lease the caller should present, and the undo. */
  const mutate = (mutation: Mutation, lease: string): { present: string; undo: () => void } => {
    const db = store.raw();
    switch (mutation) {
      case "wrong-runner":
        db.prepare("UPDATE claim SET runner = 'other-machine' WHERE lease_id = ?").run(lease);
        return { present: lease, undo: () => db.prepare("UPDATE claim SET runner = ? WHERE lease_id = ?").run(RUNNER, lease) };
      case "lease-mismatch":
        return { present: "l-stranger", undo: () => undefined };
      case "expired":
        db.prepare("UPDATE claim SET expires_at = ? WHERE lease_id = ?").run(new Date(T0.getTime() - 1).toISOString(), lease);
        return { present: lease, undo: () => db.prepare("UPDATE claim SET expires_at = ? WHERE lease_id = ?").run(new Date(T0.getTime() + 900_000).toISOString(), lease) };
      case "released":
        db.prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = ?").run(T0.toISOString(), lease);
        return { present: lease, undo: () => db.prepare("UPDATE claim SET released_at = NULL, released_by = NULL WHERE lease_id = ?").run(lease) };
      case "superseded":
        hold("l-super");
        return { present: lease, undo: () => db.prepare("DELETE FROM claim WHERE lease_id = 'l-super'").run() };
      case "nothing-holds": {
        const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(lease) as Record<string, unknown>;
        db.prepare("DELETE FROM claim WHERE lease_id = ?").run(lease);
        return {
          present: lease,
          undo: () =>
            db
              .prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, released_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(row["lease_id"], row["task_ref"], row["lease_generation"], row["runner"], row["acquired_at"], row["expires_at"], row["heartbeat_at"], row["released_at"], row["released_by"]),
        };
      }
    }
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    ref = store.refFor("built-in", "t-1").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
    expect(approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, added.token).ok).toBe(true);
  });
  afterEach(() => store.close());

  test("every claim disagreement refuses a repair turn in words and writes nothing; the exact statement then admits", () => {
    hold("l-base");
    const parentRun = store.startRun({ taskRef: ref, leaseId: "l-base", runner: RUNNER, branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented("builder") });
    const admit = (lease: string) =>
      store.admitRepair({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "b", worktree: "/w", provider: "claude", parentRun, now: T0, ...presented("repair") });
    for (const mutation of MUTATIONS) {
      const { present, undo } = mutate(mutation, "l-base");
      const before = snapshot();
      const result = admit(present);
      expect(result.ok, `repair under ${mutation} admitted run #${result.ok ? result.runId : "?"}`).toBe(false);
      if (!result.ok) expect(result.problem).toMatch(words(mutation, "l-base"));
      expect(snapshot()).toEqual(before);
      undo();
    }
    const admitted = admit("l-base");
    expect(admitted.ok, admitted.ok ? "" : admitted.problem).toBe(true);
    if (!admitted.ok) return;
    expect(store.getRun(admitted.runId)).toMatchObject({ taskRef: ref, leaseId: "l-base", runner: RUNNER, parentRun });
    expect(store.runRoute(admitted.runId)).not.toBeNull();
  });
});
