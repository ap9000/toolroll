import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { isLifecycleNotification, openStore, type Store } from "./store.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannerSourceOf, encodePlannerSource } from "./planner-source.js";
import { storeEvidence } from "./evidence.js";
import { authorizePlanUnderMode } from "./plan-auto.js";
import { presetTerms, modeDigestOf, modeTermsJson } from "./modes.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import {
  acquire,
  acquireIfReady,
  type FailureClass,
  heartbeat,
  release,
  reap,
  currentClaim,
  DEFAULT_LEASE_MS,
  finalize,
} from "./claim.js";


/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  spend: { provider: string; model: string | null } = { provider: "claude", model: null },
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  // A task with no scope presents the bare word `legacy` for the pair it
  // spends as (atomic authority closure): the default claude pair, or the
  // exact pair a fixture names.
  const authority = s.routeAuthorityFor(taskRef, role) ?? s.routeAuthorityFor(taskRef, role, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-08-11T22:00:00.000Z");

/** acquireIfReady re-proves the approved scope for builder dispatches
 * (Codex planning review, finding 2), and since v48 a routed task opens
 * no run without a sealed route — so these tests approve through the
 * real ceremony: exact agents configured once, then propose and approve. */
function approveScopeFor(store: Store, taskId: string): void {
  for (const phase of ["plan", "build", "review"]) {
    if (store.phaseConfig("installation", phase) === null) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  }
  const token = (() => {
    const added = addApprover(store, "alex", T0);
    if (added.ok) return added.token;
    return approverTokens.get(store) as string;
  })();
  approverTokens.set(store, token);
  propose(store, { taskId, goal: "the work", now: T0 });
  const scope = store.getScope(taskId);
  if (scope === null) throw new Error("propose filed nothing");
  const approved = approve(store, taskId, "alex", T0, scope.digest, token);
  if (!approved.ok) throw new Error(`the fixture approval was refused: ${approved.reason}`);
}
const approverTokens = new WeakMap<Store, string>();
const later = (ms: number) => new Date(T0.getTime() + ms);

/** Lease ids are opaque; naming them makes a fencing failure readable. */
const ids = (...names: string[]) => {
  let index = 0;
  return () => names[index++] ?? `extra-${index}`;
};

/** The claim gate proves identity and repo binding in-transaction (MCP
 * spec v6): every test runner is registered, bound to REPO, with a
 * deterministic token so call sites can name it inline. */
const REPO = "/repo/claims";
const tok = (name: string) => `tok-${name}`;
function enrollRunners(store: Store): void {
  for (const name of ["runner-a", "runner-b"]) {
    register(store, { name, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => tok(name) });
  }
}
/** createTask leaves task_ref.repo null, and null no longer dispatches —
 * tests place every task they intend to claim. */
function placeAll(store: Store, ...ids: string[]): void {
  for (const id of ids) store.placeTask(store.refFor("built-in", id).id, REPO);
}

describe("claim", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => {
    store.close();
  });

  test("takes a free task, at generation 1", () => {
    const result = acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    expect(result).toMatchObject({ ok: true, reclaimed: false });
    if (result.ok) {
      expect(result.claim.generation).toBe(1);
      expect(result.claim.leaseId).toBe("lease-a");
      expect(result.claim.expiresAt).toBe(new Date(T0.getTime() + DEFAULT_LEASE_MS).toISOString());
    }
  });

  test("refuses a task somebody else holds, and says who", () => {
    // Losing is ordinary. What is not acceptable is a "no" that reads like a
    // bug, so the refusal carries the holder and the expiry.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    const second = acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(60_000) });

    expect(second).toMatchObject({ ok: false, reason: "held", by: "runner-a" });
  });

  test("lets the next runner in once the lease has run out", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    const second = acquire(store, task, "runner-b", {
      token: tok("runner-b"), now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    expect(second).toMatchObject({ ok: true, reclaimed: true });
    if (second.ok) {
      expect(second.claim.generation).toBe(2);
      expect(second.claim.leaseId).toBe("lease-b");
    }
  });

  test("fences out a completion from the runner that was superseded", () => {
    // The failure this module exists for. Runner A stops being reachable, its
    // lease expires, B picks the task up — and then A wakes up and finishes.
    // Nobody detected A's crash; the refusal comes from the world having moved.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      token: tok("runner-b"), now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    const late = release(store, "lease-a", later(DEFAULT_LEASE_MS + 30_000));

    expect(late).toEqual({ ok: false, reason: "fenced" });
  });

  test("still accepts the completion from the runner that actually holds it", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      token: tok("runner-b"), now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    const accepted = release(store, "lease-b", later(DEFAULT_LEASE_MS + 30_000));

    expect(accepted.ok).toBe(true);
  });

  test("tells a superseded runner at its next heartbeat, not at the end", () => {
    // The cheapest moment to learn you have been fenced is before you have
    // spent another twenty minutes on work nobody will accept.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      token: tok("runner-b"), now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    expect(heartbeat(store, "lease-a", later(DEFAULT_LEASE_MS + 2))).toEqual({
      ok: false,
      reason: "fenced",
    });
  });

  test("a heartbeat keeps the task from being taken away", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    // Well past the original expiry, but it has been checking in.
    heartbeat(store, "lease-a", later(DEFAULT_LEASE_MS - 1_000));
    const stolen = acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(DEFAULT_LEASE_MS + 1) });

    expect(stolen).toMatchObject({ ok: false, reason: "held", by: "runner-a" });
  });

  test("does not know a lease it never issued", () => {
    expect(heartbeat(store, "never-issued", T0)).toEqual({ ok: false, reason: "unknown" });
    expect(release(store, "never-issued", T0)).toEqual({ ok: false, reason: "unknown" });
  });

  test("tells a superseded lease apart from one that never existed", () => {
    // These are different situations and want different responses. Being
    // superseded is nobody's fault and means stop. Being unknown means you are
    // talking to the wrong database, or a lease id got mangled in transit —
    // and an earlier version of this could not distinguish them, because
    // reclaiming overwrote the row and erased the evidence.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      token: tok("runner-b"), now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    expect(release(store, "lease-a", later(DEFAULT_LEASE_MS + 2))).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(release(store, "lease-typo", later(DEFAULT_LEASE_MS + 2))).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("refuses a release that raced a reclaim and lost", () => {
    // The interleaving that matters cannot be produced in one process with a
    // synchronous driver, so the state it *leaves behind* is built directly:
    // runner A holds a live, unexpired, unreleased lease, and a newer
    // generation exists anyway — exactly what A would see on waking after a
    // reclaim committed between its fence check and its write.
    //
    // With the fence outside the UPDATE this passes; it is why the fence is
    // now a predicate on the write.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    store.handle
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at)
         VALUES ('lease-b', ?, 2, 'runner-b', ?, ?, ?, NULL)`,
      )
      .run(task, T0.toISOString(), later(9e6).toISOString(), T0.toISOString());

    expect(release(store, "lease-a", later(1_000))).toEqual({ ok: false, reason: "fenced" });
    expect(heartbeat(store, "lease-a", later(1_000))).toEqual({ ok: false, reason: "fenced" });
  });

  test("a superseded lease cannot extend its own expiry", () => {
    // If it could, a fenced runner would keep the task off the ready set for
    // as long as it kept heartbeating at a task it no longer holds.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(61_000), newLeaseId: ids("lease-b") });

    heartbeat(store, "lease-a", later(62_000));

    const row = store.handle.prepare("SELECT expires_at FROM claim WHERE lease_id = 'lease-a'").get();
    expect(String(row?.["expires_at"])).toBe(new Date(T0.getTime() + 60_000).toISOString());
  });

  test("does not turn a refusal into a permanent no", () => {
    // A refusal changes nothing, so it is not a mutation to be replayed. A
    // dispatcher told "busy" and retrying the same key an hour later must not
    // be handed the hour-old no about a task that has since been free.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });

    const refused = acquire(store, task, "runner-b", {
      token: tok("runner-b"), now: later(1_000),
      mutation: { idempotencyKey: "dispatch-9", at: T0 },
    });
    expect(refused.ok).toBe(false);

    const afterwards = acquire(store, task, "runner-b", {
      token: tok("runner-b"), now: later(120_000),
      mutation: { idempotencyKey: "dispatch-9", at: T0 },
    });

    expect(afterwards.ok).toBe(true);
  });

  test("keeps every lease on the record, not just the current one", () => {
    // The claim log is append-only. Superseded leases are the evidence that
    // makes a fencing decision explicable after the fact.
    for (let round = 0; round < 3; round++) {
      const name = `runner-${round}`;
      register(store, { name, host: "test", repos: [REPO], now: T0, newToken: () => tok(name) });
      acquire(store, task, name, {
        token: tok(name),
        now: later(round * (DEFAULT_LEASE_MS + 1)),
      });
    }

    const rows = store.handle
      .prepare("SELECT * FROM claim WHERE task_ref = ? ORDER BY lease_generation")
      .all(task);

    expect(rows).toHaveLength(3);
    expect(rows.map(row => Number(row["lease_generation"]))).toEqual([1, 2, 3]);
  });

  test("treats a second completion on the same lease as the same completion", () => {
    // Reported twice because the first acknowledgement was lost, not because
    // anything changed hands. M1 asks for duplicate completion to be
    // reconciled rather than refused — see the `duplicate completion` suite
    // below for the line between this and a genuine fence.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    release(store, "lease-a", later(1_000));

    const again = release(store, "lease-a", later(2_000));

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.duplicate).toBe(true);
  });

  test("frees the task as soon as it is released, without waiting for expiry", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    release(store, "lease-a", later(1_000));

    const second = acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(2_000) });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.claim.generation).toBe(2);
  });

  test("counts generations up and never back down", () => {
    // The fencing token is only a fence while it is monotonic. Reuse would let
    // a stale lease match a live one.
    const seen: number[] = [];
    for (let round = 0; round < 4; round++) {
      const at = later(round * (DEFAULT_LEASE_MS + 1));
      const name = `runner-${round}`;
      register(store, { name, host: "test", repos: [REPO], now: T0, newToken: () => tok(name) });
      const result = acquire(store, task, name, { token: tok(name), now: at });
      if (result.ok) seen.push(result.claim.generation);
    }

    expect(seen).toEqual([1, 2, 3, 4]);
  });

  test("hands a retried acquire the same lease instead of a second one", () => {
    // A dropped acknowledgement must not cost a generation, or a runner that
    // never heard "yes" fences out the copy of itself that did.
    const first = acquire(store, task, "runner-a", {
      token: tok("runner-a"), now: T0,
      newLeaseId: ids("lease-a", "lease-b"),
      mutation: { idempotencyKey: "dispatch-1", at: T0 },
    });
    const retry = acquire(store, task, "runner-a", {
      token: tok("runner-a"), now: later(1_000),
      newLeaseId: ids("lease-b"),
      mutation: { idempotencyKey: "dispatch-1", at: T0 },
    });

    // Same lease, same generation — plus the honest replay marker, so a
    // caller never re-runs first-time side effects on a stored answer
    // (external dispatch, finding 36).
    expect(retry).toEqual({ ...first, replayed: true });
    if (retry.ok) expect(retry.claim.generation).toBe(1);
  });

  test("reports the live claim, and stops reporting it once it lapses", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    expect(currentClaim(store, task, later(1_000))?.runner).toBe("runner-a");
    expect(currentClaim(store, task, later(DEFAULT_LEASE_MS + 1))).toBeNull();
  });
});

describe("reap", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
  });

  afterEach(() => {
    store.close();
  });

  test("releases what has run out and leaves what has not", () => {
    store.createTask({ id: "a", title: "a" }, T0);
    placeAll(store, "a");
    approveScopeFor(store, "a");
    store.createTask({ id: "b", title: "b" }, T0);
    placeAll(store, "b");
    approveScopeFor(store, "b");
    const a = store.refFor("built-in", "a").id;
    const b = store.refFor("built-in", "b").id;

    acquire(store, a, "runner-a", { token: tok("runner-a"), now: T0, ttlMs: 60_000 });
    acquire(store, b, "runner-b", { token: tok("runner-b"), now: T0, ttlMs: 600_000 });

    const reaped = reap(store, later(120_000));

    expect(reaped.map(claim => claim.runner)).toEqual(["runner-a"]);
    expect(currentClaim(store, b, later(120_000))?.runner).toBe("runner-b");
  });

  test("is quiet when there is nothing to reap", () => {
    expect(reap(store, T0)).toEqual([]);
  });

  test("does not reap the same lease twice", () => {
    store.createTask({ id: "a", title: "a" }, T0);
    placeAll(store, "a");
    approveScopeFor(store, "a");
    const a = store.refFor("built-in", "a").id;
    acquire(store, a, "runner-a", { token: tok("runner-a"), now: T0, ttlMs: 60_000 });

    reap(store, later(120_000));

    expect(reap(store, later(180_000))).toEqual([]);
  });
});

describe("duplicate completion", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("accepts the same lease reporting done twice", () => {
    // Nobody took the task away; the runner said so twice because its first
    // acknowledgement was lost. Telling it "superseded" would send an honest
    // runner off to stop when it should carry on.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    const first = release(store, "lease-a", later(1_000));
    const again = release(store, "lease-a", later(2_000));

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.duplicate).toBe(true);
  });

  test("still fences a lease that never finished", () => {
    // The distinction that makes the above safe. A repeat of a completion is
    // idempotent; a lease that was taken away before it ever completed is
    // refused. What separates them is whether it released, not whether the
    // world moved on afterwards — see the suite below.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(61_000), newLeaseId: ids("lease-b") });

    expect(release(store, "lease-a", later(62_000))).toEqual({ ok: false, reason: "fenced" });
  });
});

describe("a completion that happened, retried late", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("is still a duplicate after somebody else has taken the task", () => {
    // It completed; its work was accepted at the time. Answering "fenced"
    // would tell an honest runner its work never counted, which is a
    // different and false claim. Fencing is for a lease that never finished.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    release(store, "lease-a", later(1_000));
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(2_000), newLeaseId: ids("lease-b") });

    const retry = release(store, "lease-a", later(3_000));

    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.duplicate).toBe(true);
  });

  test("but a lease that never finished is still fenced", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(61_000), newLeaseId: ids("lease-b") });

    expect(release(store, "lease-a", later(62_000))).toEqual({ ok: false, reason: "fenced" });
  });
});

describe("acquireIfReady", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("takes a task that is genuinely ready", () => {
    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    expect(result).toMatchObject({ ok: true, reclaimed: false });
  });

  test("refuses a task that left the queued state, and says which", () => {
    // listReady saw it queued; by claim time it is cancelled. The CAS alone
    // would admit this — the whole point of re-proving readiness inside the
    // transaction is that it does not.
    store.setTaskState("t-1", "cancelled", later(1_000));

    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: later(2_000) });

    expect(result).toEqual({ ok: false, reason: "not-ready", message: "state is cancelled, not queued" });
  });

  test("refuses a task under an active hold, with the hold's reason", () => {
    store.hold(task, "waiting on legal", null, later(1_000));

    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: later(2_000) });

    expect(result).toEqual({ ok: false, reason: "not-ready", message: "held: waiting on legal" });
  });

  test("a hold that has expired is not a hold", () => {
    store.hold(task, "overnight only", later(5_000), later(1_000));

    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: later(6_000), newLeaseId: ids("lease-a") });

    expect(result).toMatchObject({ ok: true });
  });

  test("refuses a task whose blocker is not done, and names the blocker", () => {
    store.createTask({ id: "t-0", title: "first" }, T0);
    placeAll(store, "t-0");
    approveScopeFor(store, "t-0");
    store.addEdge("t-1", "t-0");

    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: later(1_000) });

    expect(result).toEqual({ ok: false, reason: "not-ready", message: "waiting on t-0" });
  });

  test("still loses an ordinary race, as a race", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    const result = acquireIfReady(store, task, "runner-b", { token: tok("runner-b"), now: later(1_000) });

    expect(result).toMatchObject({ ok: false, reason: "held", by: "runner-a" });
  });
});

test("an attempt ends through one door: claim.ts exports finalize and no per-ending finalizer", async () => {
  const claim = await import("./claim.js");
  expect(Object.keys(claim).filter(name => /finali[sz]e|Fenced$|^complete/i.test(name))).toEqual(["finalize"]);
});

describe("finalize: complete", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("releases the lease and writes the terminal state together", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });

    const result = finalize(store, "lease-a", { kind: "complete", state: "done", now: later(1_000) });

    expect(result).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("done");
    expect(currentClaim(store, task, later(2_000))).toBeNull();
  });

  test("a fenced lease writes nothing", () => {
    // Runner-a slept through its lease; runner-b holds the task now. Runner-a
    // waking up must not get to say how the task ended.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(61_000), newLeaseId: ids("lease-b") });

    const result = finalize(store, "lease-a", { kind: "complete", state: "failed", now: later(62_000) });

    expect(result).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("a duplicate completion reports duplicate and does not change the answer", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    finalize(store, "lease-a", { kind: "complete", state: "done", now: later(1_000) });

    const retry = finalize(store, "lease-a", { kind: "complete", state: "failed", now: later(2_000) });

    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(store.getTask("t-1")?.state).toBe("done");
  });

  test("closes the release-then-mark window: a freed task is never unfinished", () => {
    // The race this exists for: with release and setTaskState apart, another
    // pass claims the freed task before the terminal state lands. Here the
    // task is done the same instant the lease lets go, so a later claim finds
    // it not-ready rather than dispatching a second builder.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    finalize(store, "lease-a", { kind: "complete", state: "done", now: later(1_000) });

    const second = acquireIfReady(store, task, "runner-b", { token: tok("runner-b"), now: later(2_000) });

    expect(second).toEqual({ ok: false, reason: "not-ready", message: "state is done, not queued" });
  });
});

describe("release provenance", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("a completion arriving after the reaper took the lease is fenced", () => {
    // The stale-commit case: the machine slept, the lease expired, the reaper
    // released it. The build finishing afterwards was never accepted, and
    // answering "duplicate" here would let its commit pass as success.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    reap(store, later(61_000));

    const late = finalize(store, "lease-a", { kind: "complete", state: "done", now: later(120_000) });

    expect(late).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("a completion arriving after dead-runner recovery is fenced", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    store.releaseClaimsOf("runner-a", later(1_000));

    const late = finalize(store, "lease-a", { kind: "complete", state: "done", now: later(2_000) });

    expect(late).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("a release retried after the reaper took the lease is fenced, not duplicate", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    reap(store, later(61_000));

    expect(release(store, "lease-a", later(62_000))).toEqual({ ok: false, reason: "fenced" });
  });

  test("a completion retried after a genuine completion is still a duplicate", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    finalize(store, "lease-a", { kind: "complete", state: "done", now: later(1_000) });

    const retry = finalize(store, "lease-a", { kind: "complete", state: "done", now: later(2_000) });

    expect(retry).toMatchObject({ ok: true, duplicate: true });
  });

  test("a plain release does not let a later completion claim acceptance", () => {
    // Handing a task back and having a completion accepted are different
    // events. A runner that released and then tries to complete is reporting
    // work on a lease it already gave up.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a") });
    release(store, "lease-a", later(1_000));

    const late = finalize(store, "lease-a", { kind: "complete", state: "done", now: later(2_000) });

    expect(late).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });
});

describe("the capability gate in acquireIfReady", () => {
  let store: Store;
  let task: number;

  const cap = (over: Record<string, unknown> = {}) => ({
    repo: "/code/thing",
    kind: "env" as const,
    name: "SUPABASE_KEY",
    probe: 'test -n "$SUPABASE_KEY"',
    status: "unprobed" as const,
    addedBy: "alex",
    createdAt: T0.toISOString(),
    lastVerifiedAt: null,
    verifiedBy: null,
    lastResult: null,
    expiresAt: null,
    ...over,
  });

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    // These capabilities live at /code/thing — the task is PLACED there,
    // and the runner gate needs runner-a bound to it (same token).
    register(store, { name: "runner-a", host: "test", capacity: 9, repos: [REPO, "/code/thing"], now: T0, newToken: () => tok("runner-a") });
    store.createTask({ id: "t-1", title: "the work" }, T0);
    task = store.refFor("built-in", "t-1").id;
    store.placeTask(task, "/code/thing");
    approveScopeFor(store, "t-1");
    store.setRequirements(task, ["env:SUPABASE_KEY"]);
  });

  afterEach(() => store.close());

  test("an unrecorded requirement fails closed, and says so", () => {
    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: T0, repo: "/code/thing" });

    expect(result).toEqual({
      ok: false,
      reason: "capability",
      message: "needs env:SUPABASE_KEY — unrecorded for /code/thing",
    });
  });

  test("a recorded but unverified requirement does not dispatch", () => {
    store.saveCapability(cap({ status: "failed" }));

    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: T0, repo: "/code/thing" });

    expect(result).toMatchObject({ ok: false, reason: "capability" });
  });

  test("a verified requirement lets the claim through", () => {
    store.saveCapability(cap({ status: "verified" }));

    const result = acquireIfReady(store, task, "runner-a", {
      token: tok("runner-a"), now: T0,
      repo: "/code/thing",
      newLeaseId: ids("lease-a"),
    });

    expect(result).toMatchObject({ ok: true });
  });

  test("a verification that expired stopped counting", () => {
    store.saveCapability(
      cap({ status: "verified", expiresAt: new Date(T0.getTime() - 1_000).toISOString() }),
    );

    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: T0, repo: "/code/thing" });

    expect(result).toMatchObject({
      ok: false,
      reason: "capability",
      message: "needs env:SUPABASE_KEY — verification expired",
    });
  });

  test("the task's own placement outranks the dispatcher's repo", () => {
    // Verified where the dispatch is running, but the task lives elsewhere,
    // and elsewhere has nothing recorded — the task's placement is the truth.
    // Placement must precede the scope row: placeTask refuses to re-aim an
    // already-scoped task.
    store.createTask({ id: "t-placed", title: "placed" }, later(1))
    const placed = store.refFor("built-in", "t-placed").id;
    store.setRequirements(placed, ["env:SUPABASE_KEY"]);
    store.saveCapability(cap({ status: "verified" }));
    store.placeTask(placed, "/code/other");
    approveScopeFor(store, "t-placed");
    const task = placed;

    const result = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: T0, repo: "/code/thing" });

    expect(result).toEqual({
      ok: false,
      reason: "capability",
      message: "needs env:SUPABASE_KEY — unrecorded for /code/other",
    });
  });

  test("a task requiring nothing is untouched by all of this", () => {
    store.createTask({ id: "t-2", title: "free" }, T0);
    placeAll(store, "t-2");
    approveScopeFor(store, "t-2");
    const free = store.refFor("built-in", "t-2").id;

    const result = acquireIfReady(store, free, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-f") });

    expect(result).toMatchObject({ ok: true });
  });
});

describe("sealing a park", () => {
  let store: Store;
  let task: number;

  const decision = {
    urgency: "blocking" as const,
    recap: "The payout guard can fail open or fail closed on timeout.",
    question: "Fail open or fail closed?",
    options: [
      { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
      { id: "closed", label: "Fail closed", consequence: "Payouts pause.", reversible: true },
    ],
    recommendation: "closed",
    assignee: null,
    deadline: null,
  };

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  const openRun = (leaseId: string) =>
    store.startRun({
      taskRef: task,
      leaseId,
      runner: "runner-a",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, task, "builder"),
    });

  const openPlannerRepair = (leaseId: string) => {
    const root = store.startRun({
      taskRef: task,
      leaseId,
      runner: "runner-a",
      role: "planner",
      provider: "claude",
      sessionId: "planner-session",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, task, "planner"),
    });
    store.stampRun(root, { baseRevision: "a".repeat(40) });
    store.stampProviderStart(root, T0);
    const child = store.startRun({
      taskRef: task,
      leaseId,
      runner: "runner-a",
      role: "planner",
      provider: "claude",
      sessionId: "planner-session",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      parentRun: root,
      now: T0,
      ...presented(store, task, "planner"),
    });
    store.stampRun(child, { baseRevision: "a".repeat(40) });
    store.stampProviderStart(child, T0);
    return { root, child };
  };

  test("one transaction: decision, hold, run outcome, outbox — or none of it", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");

    const sealed = finalize(store, "lease-a", {
      kind: "park",
      runId,
      taskId: "t-1",
      decision,
      artifactIds: [],
      now: later(1_000),
    });

    expect(sealed).toMatchObject({ ok: true });
    if (!sealed.ok) return;

    // The decision exists, open, owned by exactly this run.
    expect(store.getDecision(sealed.decisionId)).toMatchObject({ run: runId, state: "open" });
    // Its hold keeps the task out of every ready set, indefinitely.
    const holds = store.activeHolds(task, later(9e8));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ ownerKind: "decision", ownerId: String(sealed.decisionId) });
    expect(store.listReady(later(9e8))).toHaveLength(0);
    // The run says parked, canonically.
    expect(store.getRun(runId)).toMatchObject({ outcome: "parked", reason: `decision:${sealed.decisionId}` });
    // The outbox knows, in the same transaction.
    expect(store.listNotifications("pending").map(n => n.dedupeKey)).toContain(`decision:${sealed.decisionId}`);
    // And the lease's provenance says a person owns the task now.
    expect(currentClaim(store, task, later(2_000))).toBeNull();
  });

  test.each(["omitted", "swapped", "tampered", "amendment", "preserved"])("recorded planner source: %s at the ingestion boundary", (mode) => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), "so-plan-boundary-"));
    try {
      propose(store, { taskId: "t-1", goal: "Keep every filed term", outOfScope: "billing", budgetMicrousd: 1_500_000, qualityMode: "strict", acceptance: [{ id: "c1", statement: "Tests pass", how: null, evidence: ["check"] }], now: T0 });
      acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
      const { root, child } = openPlannerRepair("lease-a");
      const sourced = plannerSourceOf(store, evidenceRoot, "t-1", []);
      if (!sourced.ok) throw new Error(sourced.message);
      const initial = store.getScope("t-1")!;
      store.stampRun(root, { scopeDigest: initial.digest });
      const sourceArtifact = storeEvidence(store, evidenceRoot, root, "plan-contract", "planner-source.json", encodePlannerSource(sourced.source), "recorded before spend", T0);
      let source = sourced.source;
      if (mode === "swapped") {
        propose(store, { taskId: "t-1", goal: "A newer contract", now: later(1) });
        const current = plannerSourceOf(store, evidenceRoot, "t-1", []);
        if (!current.ok) throw new Error(current.message);
        source = current.source;
      }
      if (mode === "tampered") writeFileSync(join(evidenceRoot, store.getArtifact(sourceArtifact)!.key), "{}");
      const expected = store.getScope("t-1")!.digest;
      const result = finalize(store, "lease-a", {
        kind: "plan", runId: root, taskId: "t-1", plan: { ...initial, goal: mode === "amendment" ? "Ignore the original contract" : initial.goal, plan: "Implement the specified change" }, artifact: null, repairRunId: child,
        ...(mode === "omitted" ? {} : { source, sourceArtifact, evidenceRoot }), now: later(1000)  });
      if (mode === "preserved") {
        expect(result).toMatchObject({ ok: true, changes: 0 });
        expect(store.getScope("t-1")).toMatchObject({ digest: initial.digest, budgetMicrousd: 1_500_000, qualityMode: "strict", approvedAt: null });
      } else {
        expect(result).toMatchObject({ ok: false, reason: "source-invalid" });
        expect(store.getScope("t-1")!.digest).toBe(expected);
        expect(store.refForId(task)?.plan).not.toBe("drafted");
        expect(store.latestPlanContractArtifact(task)).toBeNull();
      }
      expect(store.getRun(child)?.outcome).not.toBeNull();
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  test.each(["unchanged", "amended", "revoked", "expired", "renewed", "tampered-plan", "missing-plan", "wrong-source", "changed-terms", "legacy-mode", "different-actor", "no-paths", "mate", "fenced", "rollback"])("bounded plan auto-approval: %s", scenario => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), "so-plan-auto-"));
    try {
      const initial = propose(store, { taskId: "t-1", goal: "Keep every filed term", outOfScope: "No billing changes", touches: scenario === "no-paths" ? [] : ["src/example.ts"], budgetMicrousd: 1_500_000, qualityMode: "strict", acceptance: [{ id: "c1", statement: "Tests pass", how: null, evidence: ["check"] }], now: T0 });
      if (scenario === "mate") store.raw().prepare("UPDATE task_scope SET proposed_via='mate' WHERE task_id='t-1'").run();
      expect(store.requestPlan(task, T0).ok).toBe(true);
      const terms = { ...presetTerms("standard", later(60_000).toISOString()), autoApproveFiling: true, planAuto: scenario !== "legacy-mode" };
      const sign = () => store.signMode({ repo: REPO, name: terms.name, signedBy: "alex", digest: modeDigestOf(terms), termsJson: modeTermsJson(terms), publication: terms.publication, absoluteExpiry: terms.absoluteExpiry }, T0);
      sign();
      const armed = authorizePlanUnderMode(store, "t-1", scenario === "different-actor" ? "someone-else" : "alex", T0);
      expect(armed).toBe(!["legacy-mode", "different-actor", "no-paths", "mate"].includes(scenario));
      expect(store.scopeSealed("t-1")).toBe(false);
      acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
      const { root, child } = openPlannerRepair("lease-a");
      const sourced = plannerSourceOf(store, evidenceRoot, "t-1", []);
      if (!sourced.ok) throw new Error(sourced.message);
      store.stampRun(root, { scopeDigest: initial.digest });
      const sourceArtifact = storeEvidence(store, evidenceRoot, root, "plan-contract", "planner-source.json", encodePlannerSource(sourced.source), "recorded before spend", T0);
      const document = "## Approach\nImplement the filed change.\n## Milestones\n- Change the named file.\n## Dependencies\n- None.\n## Risks\n- Existing behavior must hold.\n## Proof\n- Run the existing checks.";
      const artifactId = storeEvidence(store, evidenceRoot, root, "plan", "plan.md", Buffer.from(document), "verified tree", T0);
      const artifact = store.getArtifact(artifactId)!;
      if (scenario === "tampered-plan") writeFileSync(join(evidenceRoot, artifact.key), "changed bytes");
      if (scenario === "revoked") store.revokeMode(REPO, "alex", "operator", later(500));
      if (scenario === "renewed") { terms.absoluteExpiry = later(120_000).toISOString(); sign(); }
      if (scenario === "wrong-source") store.raw().prepare("UPDATE plan_authorization SET source_digest='stale'").run();
      if (scenario === "changed-terms") propose(store, { taskId: "t-1", goal: "Changed while planning", now: later(1) });
      if (scenario === "fenced") {
        release(store, "lease-a", later(10));
        acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(20), newLeaseId: ids("lease-b") });
      }
      const seal = () => finalize(store, "lease-a", { kind: "plan", runId: root, taskId: "t-1", plan: { ...initial, goal: scenario === "amended" ? "Wider goal" : initial.goal, amendment: scenario === "amended" ? "Request a larger change" : null, plan: document }, artifact: scenario === "missing-plan" ? null : artifact, repairRunId: child, source: sourced.source, sourceArtifact, evidenceRoot, now: later(scenario === "expired" ? 61_000 : 1_000) });
      if (scenario === "rollback") {
        expect(() => store.transact(() => { expect(seal().ok).toBe(true); expect(store.scopeSealed("t-1")).toBe(true); throw new Error("rollback"); })).toThrow("rollback");
        expect(store.raw().prepare("SELECT 1 FROM plan_authorization").get()).toBeDefined();
      } else {
        const result = seal();
        expect(result.ok).toBe(!["fenced", "changed-terms"].includes(scenario));
      }
      expect(store.scopeSealed("t-1")).toBe(scenario === "unchanged");
      if (scenario === "unchanged") {
        expect(store.getScope("t-1")).toMatchObject({ digest: initial.digest, approvalBasis: "mode", approvedBy: "alex", budgetMicrousd: 1_500_000, qualityMode: "strict" });
        expect(store.modeApprovalLive(task, later(1000))).toBe(true);
        expect(store.actionLedger({ repos: [REPO] })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "plan auto-approval", outcome: "approved", actor: "alex", runId: root })]));
        store.revokeMode(REPO, "alex", "operator", later(2000));
        expect(store.scopeSealed("t-1")).toBe(false);
      }
    } finally { rmSync(evidenceRoot, { recursive: true, force: true }); }
  });

  test("an accepted planner correction settles only inside the successful park fence", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const { root, child } = openPlannerRepair("lease-a");
    expect(store.getRun(child)?.outcome).toBeNull();

    const sealed = finalize(store, "lease-a", {
      kind: "park",
      runId: root,
      taskId: "t-1",
      decision,
      artifactIds: [],
      repairRunId: child,
      now: later(1_000),
    });

    expect(sealed).toMatchObject({ ok: true });
    expect(store.getRun(root)?.outcome).toBe("parked");
    expect(store.getRun(child)).toMatchObject({ outcome: "no-change", reason: "structured planner output repaired" });
  });

  test("a superseded lease seals nothing — no decision, no hold, no page", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    const runId = openRun("lease-a");
    // The lease expires and the task is retaken: the world moved on.
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(120_000), newLeaseId: ids("lease-b") });

    const sealed = finalize(store, "lease-a", {
      kind: "park",
      runId,
      taskId: "t-1",
      decision,
      artifactIds: [],
      now: later(121_000),
    });

    expect(sealed).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.listDecisions("all")).toHaveLength(0);
    expect(store.activeHolds(task, later(9e8))).toHaveLength(0);
    // The attempt's own start fact stands; no page was created.
    expect(store.listNotifications("pending").filter(one => !isLifecycleNotification(one))).toHaveLength(0);
    // The run records the refusal it was.
    expect(store.getRun(runId)).toMatchObject({ outcome: "refused", reason: "fenced" });
    // And runner-b's live claim was never touched.
    expect(currentClaim(store, task, later(121_000))?.leaseId).toBe("lease-b");
  });

  test("a superseded park fence refuses the open planner correction atomically", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    const { root, child } = openPlannerRepair("lease-a");
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(120_000), newLeaseId: ids("lease-b") });

    const sealed = finalize(store, "lease-a", {
      kind: "park",
      runId: root,
      taskId: "t-1",
      decision,
      artifactIds: [],
      repairRunId: child,
      now: later(121_000),
    });

    expect(sealed).toEqual({ ok: false, reason: "fenced" });
    expect(store.getRun(root)).toMatchObject({ outcome: "refused", reason: "fenced" });
    expect(store.getRun(child)).toMatchObject({ outcome: "refused", reason: "fenced" });
    expect(store.listDecisions("all")).toHaveLength(0);
  });

  test("an accepted planner correction and its draft settle together inside the successful plan fence", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const { root, child } = openPlannerRepair("lease-a");
    const plan = {
      goal: "Ship the guarded payout flow",
      outOfScope: "No billing schema changes",
      touches: ["src/payouts.ts"],
      acceptance: [{ id: "c1", statement: "Rejected payouts fail closed.", how: null, evidence: ["check" as const] }],
      plan: "## Approach\nGuard the payout boundary.",
    };
    expect(store.getRun(child)?.outcome).toBeNull();

    const sealed = finalize(store, "lease-a", {
      kind: "plan",
      runId: root,
      taskId: "t-1",
      plan,
      artifact: {
        key: `${root}/plan.md`,
        bytesOriginal: 42,
        bytesStored: 42,
        truncated: false,
        sha256: "a".repeat(64),
        capture: "validated planner handoff",
      },
      repairRunId: child,
      now: later(1_000),
    });

    // No source was presented (the pre-source road): nothing to compare,
    // no amendment — the seal says so in the same shape every dispatch reads.
    expect(sealed).toEqual({ ok: true, changes: 0, amendment: null });
    expect(store.getRun(root)).toMatchObject({ outcome: "built", reason: "plan-drafted" });
    expect(store.getRun(child)).toMatchObject({ outcome: "no-change", reason: "structured planner output repaired" });
    expect(store.getScope("t-1")).toMatchObject({
      goal: plan.goal,
      outOfScope: plan.outOfScope,
      touches: plan.touches,
      acceptance: plan.acceptance,
      approvedAt: null,
    });
    expect(store.refForId(task)?.plan).toBe("drafted");
    expect(store.latestPlanArtifact(task)).toMatchObject({ run: root, sha256: "a".repeat(64) });
    expect(store.listNotifications("pending").map(one => one.dedupeKey)).toContain(`plan:${task}:${root}`);
    expect(currentClaim(store, task, later(2_000))).toBeNull();
  });

  test("a superseded plan fence refuses the root and accepted correction without landing a draft", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    const { root, child } = openPlannerRepair("lease-a");
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(120_000), newLeaseId: ids("lease-b") });

    const sealed = finalize(store, "lease-a", {
      kind: "plan",
      runId: root,
      taskId: "t-1",
      plan: {
        goal: "This must never land",
        outOfScope: null,
        touches: ["src/unsafe.ts"],
        acceptance: [{ id: "c1", statement: "The draft lands.", how: null, evidence: ["check"] }],
        plan: "## Approach\nThis must never land.",
      },
      artifact: {
        key: `${root}/plan.md`,
        bytesOriginal: 42,
        bytesStored: 42,
        truncated: false,
        sha256: "b".repeat(64),
        capture: "validated planner handoff",
      },
      repairRunId: child,
      now: later(121_000),
    });

    expect(sealed).toEqual({ ok: false, reason: "fenced" });
    expect(store.getRun(root)).toMatchObject({ outcome: "refused", reason: "fenced" });
    expect(store.getRun(child)).toMatchObject({ outcome: "refused", reason: "fenced" });
    expect(store.getScope("t-1")).toMatchObject({ goal: "the work", approvedBy: "alex" });
    expect(store.refForId(task)?.plan).toBeNull();
    expect(store.latestPlanArtifact(task)).toBeNull();
    expect(store.listNotifications("pending").filter(one => !isLifecycleNotification(one))).toHaveLength(0);
    expect(currentClaim(store, task, later(121_000))?.leaseId).toBe("lease-b");
  });

  test("a park's late release retry is fenced, never a duplicate", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");
    finalize(store, "lease-a", {
      kind: "park", runId, taskId: "t-1", decision, artifactIds: [], now: later(1_000),
    });

    // The runner retries its release after the park already sealed. The task
    // is a person's now; nothing the runner says afterwards is theirs to say.
    expect(release(store, "lease-a", later(2_000))).toMatchObject({ ok: false, reason: "fenced" });
  });

  test("a run that names another lease cannot be sealed", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("some-other-lease");

    expect(() =>
      finalize(store, "lease-a", {
        kind: "park", runId, taskId: "t-1", decision, artifactIds: [], now: later(1_000),
      }),
    ).toThrow(/open attempt/);
  });

  test("exhausted repair seals an incident the same fenced way", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");

    const sealed = finalize(store, "lease-a", {
      kind: "malformed",
      runId,
      taskId: "t-1",
      problems: [{ reason: "missing-recap", message: "recap is required" }],
      now: later(1_000),
    });

    expect(sealed).toMatchObject({ ok: true });
    if (!sealed.ok) return;
    expect(store.openIncidents()[0]).toMatchObject({ id: sealed.incidentId, taskId: "t-1" });
    expect(store.activeHolds(task, later(9e8))[0]).toMatchObject({
      ownerKind: "incident",
      ownerId: String(sealed.incidentId),
    });
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "malformed-decision" });
    expect(store.listNotifications("pending").map(n => n.dedupeKey)).toContain(`malformed:${runId}`);
    // Resolving the incident is what frees the task — nothing else does.
    expect(store.listReady(later(9e8))).toHaveLength(0);
    store.resolveIncident(sealed.incidentId, "alex", later(2_000));
    expect(store.listReady(later(9e8)).map(r => r.externalId)).toEqual(["t-1"]);
  });

  test("a superseded lease's malformed park also seals nothing", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    const runId = openRun("lease-a");
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(120_000), newLeaseId: ids("lease-b") });

    const sealed = finalize(store, "lease-a", {
      kind: "malformed",
      runId,
      taskId: "t-1",
      problems: [],
      now: later(121_000),
    });

    expect(sealed).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.openIncidents()).toHaveLength(0);
    expect(store.activeHolds(task, later(9e8))).toHaveLength(0);
  });
});

describe("the resume and the attention budget", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  const openRun = (leaseId: string, at: Date = T0) =>
    store.startRun({
      taskRef: task,
      leaseId,
      runner: "runner-a",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: at,
      ...presented(store, task, "builder"),
    });

  const parkAndAnswer = (choice = "closed") => {
    acquire(store, task, "runner-a", {
      token: tok("runner-a"), now: T0,
      ttlMs: 60 * 60_000,
      newLeaseId: ids("lease-park"),
    });
    const runId = openRun("lease-park");
    const sealed = finalize(store, currentClaim(store, task, T0)!.leaseId, {
      kind: "park",
      runId,
      taskId: "t-1",
      decision: {
        urgency: "blocking",
        recap: "r",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "slips", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "pauses", reversible: true },
        ],
        recommendation: "closed",
        assignee: null,
        deadline: null,
      },
      artifactIds: [],
      now: later(1_000),
    });
    if (!sealed.ok) throw new Error("seal failed");
    store.answerDecision({ id: sealed.decisionId, choice, by: "alex", via: "cli", note: "go" }, later(2_000));
    return sealed.decisionId;
  };

  test("answers attach to the resume causally, and a built run is the terminus", () => {
    const decisionId = parkAndAnswer();

    // First resume: the answer is attached, snapshot and all.
    const resume1 = openRun("lease-resume-1", later(3_000));
    const attached = store.attachAnswers(resume1, task);
    expect(attached.map(one => one.id)).toEqual([decisionId]);
    expect(store.answersFor(resume1)).toMatchObject([{ choice: "closed", note: "go" }]);

    // The resume fails; a second resume is handed the same answer again.
    store.finishRun(resume1, { outcome: "failed", reason: "agent", now: later(4_000) });
    const resume2 = openRun("lease-resume-2", later(5_000));
    expect(store.attachAnswers(resume2, task).map(one => one.id)).toEqual([decisionId]);

    // The second resume builds: delivered. A third run gets nothing.
    store.finishRun(resume2, { outcome: "built", committed: true, now: later(6_000) });
    const later3 = openRun("lease-later", later(7_000));
    expect(store.attachAnswers(later3, task)).toEqual([]);
  });

  test("attaching twice is once — the relation is idempotent", () => {
    parkAndAnswer();
    const resume = openRun("lease-resume", later(3_000));
    store.attachAnswers(resume, task);
    store.attachAnswers(resume, task);
    expect(store.answersFor(resume)).toHaveLength(1);
  });

  test("above the budget, a measured parker steps aside; a first-timer does not", () => {
    // Five open decisions on five other tasks fill the budget.
    for (let i = 0; i < 5; i++) {
      store.createTask({ id: `other-${i}`, title: "x" }, T0);
      const ref = store.refFor("built-in", `other-${i}`).id;
      const run = store.startRun({
        taskRef: ref, leaseId: `l-${i}`, runner: "r", branch: "b", worktree: "/w", now: T0,
        ...presented(store, ref, "builder"),
      });
      store.saveDecision(
        {
          run,
          urgency: "blocking",
          recap: "r",
          question: "q",
          options: [
            { id: "a", label: "a", consequence: "c", reversible: true },
            { id: "b", label: "b", consequence: "c", reversible: true },
          ],
          recommendation: "a",
        },
        T0,
      );
    }
    expect(store.countUnanswered()).toBe(5);

    // t-1 has a parking history: one parked, zero built → rate 1.
    const history = openRun("lease-history");
    store.finishRun(history, { outcome: "parked", reason: "decision:x", now: later(1_000) });
    expect(store.refForId(task)?.parkRate).toBe(1);

    const refused = acquireIfReady(store, task, "runner-a", { token: tok("runner-a"), now: later(2_000) });
    expect(refused).toMatchObject({ ok: false, reason: "attention-budget" });

    // A task that has never parked is not punished for the backlog.
    store.createTask({ id: "fresh", title: "x" }, T0);
    placeAll(store, "fresh");
    approveScopeFor(store, "fresh");
    const fresh = store.refFor("built-in", "fresh").id;
    const taken = acquireIfReady(store, fresh, "runner-a", { token: tok("runner-a"), now: later(2_000) });
    expect(taken).toMatchObject({ ok: true });

    // And under the budget, the parker dispatches again.
    const generous = acquireIfReady(store, task, "runner-a", {
      token: tok("runner-a"), now: later(3_000),
      maxOpenDecisions: 50,
    });
    expect(generous).toMatchObject({ ok: true });
  });

  test("the park rate is measured from concluded builder attempts", () => {
    const first = openRun("lease-1");
    store.finishRun(first, { outcome: "parked", reason: "decision:1", now: later(1_000) });
    expect(store.refForId(task)?.parkRate).toBe(1);

    const second = openRun("lease-2", later(2_000));
    store.finishRun(second, { outcome: "built", committed: true, now: later(3_000) });
    expect(store.refForId(task)?.parkRate).toBe(0.5);

    // Refusals and repair children do not move it: they are not concluded builds.
    const third = openRun("lease-3", later(4_000));
    store.finishRun(third, { outcome: "refused", reason: "fenced", now: later(5_000) });
    expect(store.refForId(task)?.parkRate).toBe(0.5);
  });
});

describe("the failure taxonomy, fenced", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  const attempt = (leaseId: string, at: Date) => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: at, ttlMs: 60 * 60_000, newLeaseId: () => leaseId });
    return store.startRun({
      taskRef: task, leaseId, runner: "runner-a", branch: "b", worktree: "/w", now: at,
      ...presented(store, task, "builder"),
    });
  };

  const failIt = (leaseId: string, runId: number, at: Date, failureClass: FailureClass = "unknown") =>
    finalize(store, leaseId, {
      kind: "failure", runId, taskId: "t-1", failureClass, message: "boom", worktree: "/w", now: at,
    });

  test("one failure: a strike, a doubling backoff, the task still queued", () => {
    const run = attempt("lease-1", T0);
    const sealed = failIt("lease-1", run, later(1_000));

    expect(sealed).toMatchObject({ ok: true, disposition: "backoff", strikes: 1 });
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.getRun(run)).toMatchObject({ outcome: "failed", reason: "unknown" });
    const hold = store.activeHolds(task, later(2_000))[0];
    expect(hold).toMatchObject({ ownerKind: "backoff" });
    // One minute, then eligible again.
    expect(store.listReady(later(30_000))).toHaveLength(0);
    expect(store.listReady(later(62_000)).map(r => r.externalId)).toEqual(["t-1"]);
  });

  test("the second backoff doubles", () => {
    const first = attempt("lease-1", T0);
    failIt("lease-1", first, later(1_000));
    const second = attempt("lease-2", later(70_000));
    const sealed = failIt("lease-2", second, later(71_000));

    expect(sealed).toMatchObject({ ok: true, disposition: "backoff", strikes: 2 });
    if (!sealed.ok || sealed.disposition !== "backoff") return;
    expect(Date.parse(sealed.until) - later(71_000).getTime()).toBe(120_000);
  });

  test("three strikes stall: incident, failed, held, paged once — and requeue undoes it all", () => {
    const first = attempt("lease-1", T0);
    failIt("lease-1", first, later(1_000));
    const second = attempt("lease-2", later(70_000));
    failIt("lease-2", second, later(71_000));
    const third = attempt("lease-3", later(200_000));
    const sealed = failIt("lease-3", third, later(201_000));

    expect(sealed).toMatchObject({ ok: true, disposition: "stalled", strikes: 3 });
    expect(store.getTask("t-1")?.state).toBe("failed");
    expect(store.openIncidents()).toMatchObject([{ kind: "attempts-exhausted", taskId: "t-1" }]);
    expect(store.listNotifications("pending").map(n => n.dedupeKey)).toContain(`stalled:${task}`);

    const back = store.requeueTask("t-1", "alex", later(300_000));
    expect(back).toMatchObject({ ok: true, resolvedIncidents: 1 });
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.openIncidents()).toHaveLength(0);
    expect(store.listReady(later(301_000)).map(r => r.externalId)).toEqual(["t-1"]);
  });

  test("a success resets the streak", () => {
    const first = attempt("lease-1", T0);
    failIt("lease-1", first, later(1_000));
    expect(store.refForId(task)?.strikes).toBe(1);

    store.resetStrikes(task);
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.activeHolds(task, later(2_000))).toHaveLength(0);
  });

  test("a commit failure takes neither road: an incident guards the worktree, no strike", () => {
    const run = attempt("lease-1", T0);
    const sealed = failIt("lease-1", run, later(1_000), "commit-failure");

    expect(sealed).toMatchObject({ ok: true, disposition: "commit-incident" });
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.openIncidents()).toMatchObject([{ kind: "commit-failure" }]);
    const note = store.listNotifications("pending").find(n => n.dedupeKey === `commit-failure:${run}`);
    expect(note?.body).toContain("/w");
  });

  test("a superseded lease's failure seals nothing but the fenced run", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, ttlMs: 60_000, newLeaseId: () => "lease-1" });
    const run = store.startRun({
      taskRef: task, leaseId: "lease-1", runner: "runner-a", branch: "b", worktree: "/w", now: T0,
      ...presented(store, task, "builder"),
    });
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(120_000) });

    const sealed = failIt("lease-1", run, later(121_000));
    expect(sealed).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.activeHolds(task, later(122_000))).toHaveLength(0);
    expect(store.getRun(run)).toMatchObject({ outcome: "refused", reason: "fenced" });
  });

  test("stranded work is derived, named, and freed by requeueing the blocker", () => {
    store.createTask({ id: "t-2", title: "dependent" }, T0);
    placeAll(store, "t-2");
    approveScopeFor(store, "t-2");
    store.addEdge("t-2", "t-1");
    store.setTaskState("t-1", "failed", later(1_000));

    expect(store.strandedTasks()).toEqual([{ id: "t-2", blockedBy: ["t-1"] }]);

    store.requeueTask("t-1", "alex", later(2_000));
    expect(store.strandedTasks()).toEqual([]);
  });
});

describe("capacity and quota, at the claim", () => {
  let store: Store;
  let a: number;
  let b: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-a", title: "a" }, T0);
    placeAll(store, "t-a");
    approveScopeFor(store, "t-a");
    store.createTask({ id: "t-b", title: "b" }, T0);
    placeAll(store, "t-b");
    approveScopeFor(store, "t-b");
    a = store.refFor("built-in", "t-a").id;
    b = store.refFor("built-in", "t-b").id;
  });

  afterEach(() => store.close());

  test("a full runner is refused its second claim, and freed by releasing", () => {
    register(store, { name: "small", host: "h", now: T0, capacity: 1, repos: [REPO], newToken: () => tok("small") });

    const first = acquireIfReady(store, a, "small", { token: tok("small"), now: T0, newLeaseId: ids("lease-a") });
    expect(first).toMatchObject({ ok: true });

    const second = acquireIfReady(store, b, "small", { token: tok("small"), now: later(1_000) });
    expect(second).toMatchObject({ ok: false, reason: "capacity" });

    release(store, "lease-a", later(2_000));
    expect(acquireIfReady(store, b, "small", { token: tok("small"), now: later(3_000) })).toMatchObject({ ok: true });
  });

  test("lowering capacity never interrupts running work; the new number applies at the next claim", () => {
    register(store, { name: "pair", host: "h", now: T0, capacity: 2, repos: [REPO], newToken: () => tok("pair") });
    expect(acquireIfReady(store, a, "pair", { token: tok("pair"), now: T0, newLeaseId: ids("lease-a") })).toMatchObject({ ok: true });
    expect(acquireIfReady(store, b, "pair", { token: tok("pair"), now: later(500), newLeaseId: ids("lease-b") })).toMatchObject({ ok: true });

    expect(store.setRunnerCapacity("pair", 1, "alex", later(1_000))).toEqual({ ok: true, before: 2, after: 1 });

    // Both running tasks keep their claims and can still check in.
    expect(store.liveClaimCount("pair", later(1_500))).toBe(2);
    expect(currentClaim(store, a, later(1_500))).toMatchObject({ leaseId: "lease-a", runner: "pair" });
    expect(currentClaim(store, b, later(1_500))).toMatchObject({ leaseId: "lease-b", runner: "pair" });
    expect(heartbeat(store, "lease-a", later(2_000))).toMatchObject({ ok: true });
    expect(heartbeat(store, "lease-b", later(2_000))).toMatchObject({ ok: true });

    // One finishes: with one still running, a capacity of 1 takes nothing new.
    release(store, "lease-b", later(3_000));
    expect(acquireIfReady(store, b, "pair", { token: tok("pair"), now: later(4_000) })).toMatchObject({ ok: false, reason: "capacity" });
    release(store, "lease-a", later(5_000));
    expect(acquireIfReady(store, b, "pair", { token: tok("pair"), now: later(6_000) })).toMatchObject({ ok: true });
  });

  test("an unregistered runner cannot claim at all — identity is proven in the claim transaction", () => {
    // The old law ("unregistered runners are not capacity-gated") is gone
    // with the runner gate (MCP spec v6): no row, no claim, whoever asks.
    expect(acquireIfReady(store, a, "ghost", { token: tok("ghost"), now: T0 })).toMatchObject({
      ok: false,
      reason: "unauthenticated",
      detail: "unknown",
    });
  });

  test("an exhausted quota refuses dispatch until its reset, then admits one probe", () => {
    register(store, { name: "r", host: "h", now: T0, capacity: 4, repos: [REPO], newToken: () => tok("r") });
    store.stampQuota(
      { runner: "r", provider: "claude", reason: "credit exhausted", resetAt: later(60_000) },
      T0,
    );

    const refused = acquireIfReady(store, a, "r", { token: tok("r"), now: later(1_000) });
    expect(refused).toMatchObject({ ok: false, reason: "quota" });
    if (refused.ok === false && refused.reason === "quota") {
      expect(refused.message).toContain("credit exhausted");
    }

    // Past the reset: half-open admits exactly one dispatch as the probe…
    const probe = acquireIfReady(store, a, "r", { token: tok("r"), now: later(61_000) });
    expect(probe).toMatchObject({ ok: true });
    // …and re-arms while the probe flies, so a racing pass stays out.
    const racing = acquireIfReady(store, b, "r", { token: tok("r"), now: later(61_500) });
    expect(racing).toMatchObject({ ok: false, reason: "quota" });

    // The probe's success clears the stamp; everything flows again.
    store.clearQuota("r", "claude", "");
    expect(acquireIfReady(store, b, "r", { token: tok("r"), now: later(62_000) })).toMatchObject({ ok: true });
  });

  test("quota is scoped: another model's credential is not this one's exhaustion", () => {
    register(store, { name: "r", host: "h", now: T0, capacity: 4, repos: [REPO], newToken: () => tok("r") });
    store.stampQuota({ runner: "r", provider: "claude", scope: "opus", reason: "quota" }, T0);

    expect(acquireIfReady(store, a, "r", { token: tok("r"), now: later(1_000), model: "opus" })).toMatchObject({
      ok: false,
      reason: "quota",
    });
    expect(acquireIfReady(store, a, "r", { token: tok("r"), now: later(2_000), model: "haiku" })).toMatchObject({
      ok: true,
    });
  });

  test("no reset time means exhausted until somebody says otherwise", () => {
    register(store, { name: "r", host: "h", now: T0, capacity: 4, repos: [REPO], newToken: () => tok("r") });
    store.stampQuota({ runner: "r", provider: "claude", reason: "auth revoked" }, T0);

    expect(acquireIfReady(store, a, "r", { token: tok("r"), now: later(9e9) })).toMatchObject({ ok: false, reason: "quota" });
    store.clearQuota("r", "claude", "");
    expect(acquireIfReady(store, a, "r", { token: tok("r"), now: later(9e9 + 1_000) })).toMatchObject({ ok: true });
  });
});

describe("sealing a plan revision", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    placeAll(store, "t-1");
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  const openRun = (leaseId: string) =>
    store.startRun({
      taskRef: task,
      leaseId,
      runner: "runner-a",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, task, "builder"),
    });

  /** The replacement plan document's row. The ledger's `artifact` column is
   * a real foreign key, so a revision cannot be filed against a document
   * nobody stored — every fixture writes one first. */
  const planArtifact = (runId: number, sha = "a".repeat(64)) =>
    store.saveArtifact(
      {
        run: runId,
        kind: "plan",
        key: `${runId}/plan-revision.md`,
        bytesOriginal: 120,
        bytesStored: 120,
        truncated: false,
        sha256: sha,
        capture: "builder-filed plan revision 2 (validated, re-serialized)",
      },
      T0,
    );

  const proposal = (runId: number, artifact: number, over: Record<string, unknown> = {}) => ({
    revision: 2,
    artifact,
    parentHash: null,
    reason: "src/legacy/pay.ts does not exist — the plan's first dependency names a file this repo deleted in 82c5eea",
    evidenceLink: "git log --diff-filter=D -- src/legacy/pay.ts",
    author: `builder:${runId}`,
    originRun: runId,
    authorityKind: "plan-only" as const,
    authorityDigest: "d".repeat(32),
    changedFields: [] as readonly ("signed-scope" | "publication-authority")[],
    ...over,
  });

  test("a plan-only revision applies, releases the task, and resumes without a hold", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");
    const artifact = planArtifact(runId);

    const sealed = finalize(store, "lease-a", {
      kind: "revision",
      runId,
      taskId: "t-1",
      taskRef: task,
      revision: proposal(runId, artifact),
      now: later(1_000),
    });

    expect(sealed).toMatchObject({ ok: true, authorityKind: "plan-only" });
    if (!sealed.ok) return;

    // The ledger row is in force: this IS the plan the next attempt reads.
    const row = store.getPlanRevision(sealed.revisionId);
    expect(row).toMatchObject({
      taskRef: task,
      revision: 2,
      artifact,
      kind: "builder-proposal",
      authorityKind: "plan-only",
      status: "applied",
      originRun: runId,
    });
    expect(store.currentPlanRevision(task)?.id).toBe(sealed.revisionId);
    // Nothing waits on a person: no hold, and the task is ready again —
    // which is exactly what "applied — resuming" promises.
    expect(store.activeHolds(task, later(9e8))).toHaveLength(0);
    // The attempt ended without committing, and said so in the vocabulary
    // that already exists — refused, never a new outcome word.
    expect(store.getRun(runId)).toMatchObject({ outcome: "refused", reason: "plan-revised" });
    // The claim was handed back inside the same transaction.
    expect(currentClaim(store, task, later(2_000))).toBeNull();
    expect(store.listNotifications("pending").map(one => one.subject)).toContain(
      "t-1: plan revision 2 applied — resuming",
    );
  });

  test("an authority-changing revision is blocked behind a named hold, never applied", () => {
    // The world moved underneath the build: whatever the revision proposes,
    // it is not the plane's to auto-apply once the signed scope has changed.
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");
    const artifact = planArtifact(runId);

    const sealed = finalize(store, "lease-a", {
      kind: "revision",
      runId,
      taskId: "t-1",
      taskRef: task,
      revision: proposal(runId, artifact, {
        authorityKind: "authority-change",
        changedFields: ["signed-scope", "publication-authority"],
      }),
      now: later(1_000),
    });

    expect(sealed).toMatchObject({ ok: true, authorityKind: "authority-change" });
    if (!sealed.ok) return;

    expect(store.getPlanRevision(sealed.revisionId)).toMatchObject({ status: "blocked", authorityKind: "authority-change" });
    // Blocked means blocked: it is NOT the current plan, and nothing runs.
    expect(store.currentPlanRevision(task)).toBeNull();
    expect(store.latestPlanRevision(task)?.id).toBe(sealed.revisionId);
    const holds = store.activeHolds(task, later(9e8));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ ownerKind: "revision", ownerId: String(sealed.revisionId) });
    // The hold NAMES what moved — a person should not have to diff to find out.
    expect(holds[0]?.reason).toContain("the signed scope and publication authority");
    expect(store.listReady(later(9e8))).toHaveLength(0);
    expect(store.getRun(runId)).toMatchObject({ outcome: "refused", reason: "plan-revision-blocked" });
    expect(store.listNotifications("pending").map(one => one.subject)).toContain(
      "t-1: plan revision 2 awaiting your approval",
    );
  });

  test("a superseded lease files nothing — no revision, no hold, no page", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    const runId = openRun("lease-a");
    const artifact = planArtifact(runId);
    // The lease expires and the task is retaken: the world moved on, and a
    // runner the world moved past does not get to rewrite the road.
    acquire(store, task, "runner-b", { token: tok("runner-b"), now: later(120_000), newLeaseId: ids("lease-b") });

    const sealed = finalize(store, "lease-a", {
      kind: "revision",
      runId,
      taskId: "t-1",
      taskRef: task,
      revision: proposal(runId, artifact),
      now: later(121_000),
    });

    expect(sealed).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.listPlanRevisions(task)).toHaveLength(0);
    expect(store.activeHolds(task, later(9e8))).toHaveLength(0);
    expect(store.listNotifications("pending").filter(one => !isLifecycleNotification(one))).toHaveLength(0);
    // The run records the refusal it was, and runner-b's claim is untouched.
    expect(store.getRun(runId)).toMatchObject({ outcome: "refused", reason: "fenced" });
    expect(currentClaim(store, task, later(121_000))?.leaseId).toBe("lease-b");
  });

  test("a run that names another lease cannot file a revision", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("some-other-lease");
    const artifact = planArtifact(runId);

    expect(() =>
      finalize(store, "lease-a", {
        kind: "revision",
        runId,
        taskId: "t-1",
        taskRef: task,
        revision: proposal(runId, artifact),
        now: later(1_000),
      }),
    ).toThrow(/open attempt/);
    expect(store.listPlanRevisions(task)).toHaveLength(0);
  });

  test("only a builder run files a plan revision — a planner's road is its own", () => {
    acquire(store, task, "runner-a", { token: tok("runner-a"), now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = store.startRun({
      taskRef: task,
      leaseId: "lease-a",
      runner: "runner-a",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      role: "planner",
      now: T0,
      ...presented(store, task, "planner"),
    });
    const artifact = planArtifact(runId);

    expect(() =>
      finalize(store, "lease-a", {
        kind: "revision",
        runId,
        taskId: "t-1",
        taskRef: task,
        revision: proposal(runId, artifact),
        now: later(1_000),
      }),
    ).toThrow(/only builder runs/);
    expect(store.listPlanRevisions(task)).toHaveLength(0);
  });
});

describe("provider readiness, at the claim (v47): an unavailable provider never claims, nothing substitutes", () => {
  let store: Store;
  let a: number;

  beforeEach(() => {
    store = openStore(":memory:");
    enrollRunners(store);
    store.createTask({ id: "t-a", title: "a" }, T0);
    placeAll(store, "t-a");
    approveScopeFor(store, "t-a");
    a = store.refFor("built-in", "t-a").id;
  });

  afterEach(() => store.close());

  test("a runner that reported the routed provider unavailable is refused before any claim exists, with the observation in words", () => {
    store.recordProviderReadiness("runner-a", [{ provider: "codex", state: "unavailable", reason: "`codex login status` says not logged in", probe: "identity" }], T0);
    const refused = acquireIfReady(store, a, "runner-a", { token: tok("runner-a"), now: later(1_000), provider: "codex", model: "gpt-5" });
    expect(refused).toMatchObject({ ok: false, reason: "provider-unavailable" });
    if (refused.ok === false && refused.reason === "provider-unavailable") {
      expect(refused.message).toContain("codex is reported unavailable on runner-a");
      expect(refused.message).toContain("not logged in");
      expect(refused.message).toContain("nothing substitutes");
    }
    expect(currentClaim(store, a, later(1_000))).toBeNull();
    // The SAME task claims on the other provider, and on a runner that never
    // reported codex (unknown is not unavailable).
    expect(acquireIfReady(store, a, "runner-a", { token: tok("runner-a"), now: later(2_000), provider: "claude", model: "sonnet" })).toMatchObject({ ok: true });
    release(store, currentClaim(store, a, later(2_000))!.leaseId, later(3_000));
    expect(acquireIfReady(store, a, "runner-b", { token: tok("runner-b"), now: later(4_000), provider: "codex", model: "gpt-5" })).toMatchObject({ ok: true });
  });

  test("a fresh READY observation lifts the refusal; unknown never counts as ready but never refuses either", () => {
    store.recordProviderReadiness("runner-a", [{ provider: "claude", state: "unavailable", reason: "`claude` is not installed on this runner's PATH", probe: "version" }], T0);
    expect(acquireIfReady(store, a, "runner-a", { token: tok("runner-a"), now: later(1_000), provider: "claude" })).toMatchObject({ ok: false, reason: "provider-unavailable" });
    store.recordProviderReadiness("runner-a", [{ provider: "claude", state: "unknown", reason: "installed; no non-spending login check exists", probe: "version" }], later(2_000));
    expect(store.runnerReadinessOf("runner-a", "claude")?.state).toBe("unknown");
    expect(acquireIfReady(store, a, "runner-a", { token: tok("runner-a"), now: later(3_000), provider: "claude" })).toMatchObject({ ok: true });
  });
});
