/**
 * Closed tasks (docs/plans/closed-task-claims.md): a claim is refused on a done, failed or cancelled task, in the
 * grant's own transaction (and an expired claim is not renewed onto one); check cleanup has the one named exception;
 * strikes used up on a task a person already closed keep its state and write no incident, hold or page; and the CLI
 * `worker release` hands a task back and requeues it in one transaction.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { acquire, acquireForCheckCleanup, finalize, heartbeat, release, type FailureClass } from "./claim.js";
import { EXIT, runOperate } from "./operate.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { openStore, Store } from "./store.js";

const T0 = new Date("2026-11-01T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const REPO = "/repo/closed";
const tok = (name: string) => `tok-${name}`;
const CLOSED = ["done", "failed", "cancelled"] as const;

let dir: string;
let db: string;
let store: Store;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-closed-")));
  db = join(dir, "orders.db");
  store = openStore(db);
  for (const name of ["runner-a", "runner-b"]) register(store, { name, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => tok(name) });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A placed built-in task, its reference id back. */
function task(id: string): number {
  store.createTask({ id, title: id }, T0);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  return ref;
}

/** Close a task the way a person does (`task state <id> <state>`). */
function close(id: string, state: (typeof CLOSED)[number], at: Date = T0): void {
  expect(store.setTaskState(id, state, at)).toMatchObject({ ok: true });
}

const take = (ref: number, runner = "runner-a", at: Date = T0, ttlMs = 60 * 60_000, leaseId?: string) =>
  acquire(store, ref, runner, { token: tok(runner), now: at, ttlMs, ...(leaseId === undefined ? {} : { newLeaseId: () => leaseId }) });

const count = (sql: string, ...params: unknown[]) => Number(store.handle.prepare(sql).get(...params)!["n"]);
const rowOf = (id: string) => store.handle.prepare("SELECT state, updated_at FROM task WHERE id = ?").get(id);

describe("a claim on a closed task", () => {
  for (const state of CLOSED) {
    test(`${state}: refused with its state, and nothing is written`, () => {
      const ref = task("t-1");
      close("t-1", state);
      const before = { task: rowOf("t-1"), claims: count("SELECT COUNT(*) AS n FROM claim"), mutations: count("SELECT COUNT(*) AS n FROM mutation") };
      expect(acquire(store, ref, "runner-a", { token: tok("runner-a"), now: later(1_000), mutation: { key: "k-1" } })).toEqual({ ok: false, reason: "closed", state });
      expect({ task: rowOf("t-1"), claims: count("SELECT COUNT(*) AS n FROM claim"), mutations: count("SELECT COUNT(*) AS n FROM mutation") }).toEqual(before);
    });
  }

  test("queued and running claim as before; an expired claim on a running task is taken over", () => {
    const queued = task("t-q");
    expect(take(queued)).toMatchObject({ ok: true, reclaimed: false });
    const running = task("t-r");
    expect(take(running, "runner-a", T0, 60_000)).toMatchObject({ ok: true });
    store.setTaskState("t-r", "running", T0);
    expect(take(running, "runner-b", later(61_000))).toMatchObject({ ok: true, reclaimed: true });
  });

  test("every older refusal still answers first: held, unauthenticated", () => {
    const ref = task("t-1");
    expect(take(ref)).toMatchObject({ ok: true });
    close("t-1", "done");
    expect(take(ref, "runner-b", later(1_000))).toMatchObject({ ok: false, reason: "held", by: "runner-a" });
    expect(acquire(store, ref, "runner-b", { token: "wrong", now: later(1_000) })).toMatchObject({ ok: false, reason: "unauthenticated" });
  });

  test("a built-in reference with no task row is refused as no-task; another backend's task claims as before", () => {
    const ghost = store.refFor("built-in", "ghost").id;
    store.placeTask(ghost, REPO);
    expect(take(ghost)).toEqual({ ok: false, reason: "no-task" });
    expect(count("SELECT COUNT(*) AS n FROM claim WHERE task_ref = ?", ghost)).toBe(0);
    const outside = store.refFor("github-issues", "42").id;
    store.placeTask(outside, REPO);
    expect(take(outside)).toMatchObject({ ok: true });
  });

  test("the state is read under the grant's write lock: no other connection can close the task in between", () => {
    const ref = task("t-1");
    let busy: string | null = null;
    const other = new DatabaseSync(db);
    other.exec("PRAGMA busy_timeout = 0");
    try {
      const granted = acquire(store, ref, "runner-a", {
        token: tok("runner-a"), now: T0,
        // Called inside the claim transaction, after the state was read and before the insert.
        newLeaseId: () => {
          try { other.prepare("UPDATE task SET state = 'done' WHERE id = 't-1'").run(); } catch (error) { busy = String((error as Error).message); }
          return "lease-1";
        },
      });
      expect(granted).toMatchObject({ ok: true });
    } finally {
      other.close();
    }
    expect(busy).toMatch(/locked|busy/i);
    expect(store.getTask("t-1")?.state).toBe("queued");
  });
});

describe("heartbeat on a closed task", () => {
  for (const state of CLOSED) {
    test(`an expired claim is not renewed once the task is ${state}, from another connection`, () => {
      const ref = task("t-1");
      expect(take(ref, "runner-a", T0, 60_000, "lease-a")).toMatchObject({ ok: true });
      // A person closes the task from a second connection after the claim ran out, before any reap or takeover.
      const person = openStore(db);
      try { expect(person.setTaskState("t-1", state, later(90_000))).toMatchObject({ ok: true }); } finally { person.close(); }
      const before = store.handle.prepare("SELECT expires_at, heartbeat_at, released_at FROM claim WHERE lease_id = 'lease-a'").get();
      expect(heartbeat(store, "lease-a", later(120_000))).toEqual({ ok: false, reason: "closed", state });
      expect(store.handle.prepare("SELECT expires_at, heartbeat_at, released_at FROM claim WHERE lease_id = 'lease-a'").get()).toEqual(before);
      expect(store.currentLiveLease(ref, later(120_000))).toBeNull();
    });
  }

  test("a live claim renews on a closed task, and an expired one on an open task renews, as before", () => {
    const ref = task("t-1");
    take(ref, "runner-a", T0, 60_000, "lease-a");
    close("t-1", "cancelled", later(1_000));
    expect(heartbeat(store, "lease-a", later(30_000))).toMatchObject({ ok: true });
    const open = task("t-2");
    take(open, "runner-a", T0, 60_000, "lease-b");
    expect(heartbeat(store, "lease-b", later(10 * 60_000))).toMatchObject({ ok: true });
    expect(store.currentLiveLease(open, later(10 * 60_000))).toBe("lease-b");
  });
});

describe("check cleanup's door", () => {
  const RUNNER = "runner-a";
  /** A finished check whose task is `agent-check-<id>`, held by cleanup attempt `attempt`. */
  function finishedCheck(attempt = "attempt-1"): { id: number; ref: number } {
    const id = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "opencode/big-pickle", by: "alex" }, T0);
    expect(store.acquireWatchLease(RUNNER, REPO, "watch-a", 60 * 60_000, T0)).toMatchObject({ ok: true });
    expect(store.claimAcpCheck(RUNNER, { repo: REPO, owner: "watch-a" }, T0)?.id).toBe(id);
    const ref = task(`agent-check-${id}`);
    expect(take(ref, RUNNER, T0, 60_000, `first-${id}`)).toMatchObject({ ok: true });
    expect(store.bindAcpCheck(id, { taskRef: ref, launchJson: "{}", leaseId: `first-${id}` }, T0)).toBe(true);
    expect(store.failAcpCheck(id, "the agent failed", T0)).toBe(true);
    expect(store.holdAcpSettle(id, attempt, later(2 * 60_000), 10 * 60_000)).toBe(true);
    return { id, ref };
  }
  const cleanup = (id: number, attempt: string, runner = RUNNER, at = later(3 * 60_000)) =>
    acquireForCheckCleanup(store, id, attempt, runner, { now: at, token: tok(runner), ttlMs: 10 * 60_000, newLeaseId: () => `settle-${id}-${Math.random()}` });

  for (const state of CLOSED) {
    test(`claims its own ${state} task; plain acquire on it answers closed`, () => {
      const { id, ref } = finishedCheck();
      close(`agent-check-${id}`, state);
      expect(take(ref, RUNNER, later(3 * 60_000))).toEqual({ ok: false, reason: "closed", state });
      expect(cleanup(id, "attempt-1")).toMatchObject({ ok: true });
    });
  }

  test("refuses, writing nothing, without the exact proof", () => {
    const { id, ref } = finishedCheck();
    close(`agent-check-${id}`, "failed");
    const claims = () => count("SELECT COUNT(*) AS n FROM claim WHERE task_ref = ?", ref);
    const before = claims();
    expect(cleanup(id, "another-attempt")).toEqual({ ok: false, reason: "closed", state: "failed" });
    expect(cleanup(id, "attempt-1", "runner-b")).toMatchObject({ ok: false });
    expect(cleanup(id, "attempt-1", RUNNER, later(13 * 60_000))).toEqual({ ok: false, reason: "closed", state: "failed" }); // the hold lapsed
    expect(claims()).toBe(before);
    // Settled: no longer cleanup's to take.
    store.handle.prepare("UPDATE acp_check_request SET settled_at = ? WHERE id = ?").run(T0.toISOString(), id);
    expect(cleanup(id, "attempt-1")).toEqual({ ok: false, reason: "closed", state: "failed" });
    expect(claims()).toBe(before);
  });

  test("refuses a check bound to a task not named from its own id", () => {
    const id = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "opencode/big-pickle", by: "alex" }, T0);
    expect(store.acquireWatchLease(RUNNER, REPO, "watch-a", 60 * 60_000, T0)).toMatchObject({ ok: true });
    store.claimAcpCheck(RUNNER, { repo: REPO, owner: "watch-a" }, T0);
    const ref = task("someone-elses-task");
    take(ref, RUNNER, T0, 60_000, "first");
    expect(store.bindAcpCheck(id, { taskRef: ref, launchJson: "{}", leaseId: "first" }, T0)).toBe(true);
    store.failAcpCheck(id, "x", T0);
    store.holdAcpSettle(id, "attempt-1", later(2 * 60_000), 10 * 60_000);
    close("someone-elses-task", "done");
    expect(cleanup(id, "attempt-1")).toEqual({ ok: false, reason: "closed", state: "done" });
  });

  test("only acp-check.ts imports it, and no options object can select it", () => {
    const sources = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter(path => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .map(path => ({ path: `src/${path}`, text: readFileSync(join("src", path), "utf8") }));
    expect(sources.filter(one => /import[^;]*\bacquireForCheckCleanup\b[^;]*from/.test(one.text)).map(one => one.path)).toEqual(["src/acp-check.ts"]);
    const claim = readFileSync("src/claim.ts", "utf8");
    // The literal appears only in acquireLocked's parameter and acquireForCheckCleanup's call.
    const functionsWith = claim.split(/\n(?=(?:export )?function )/).filter(chunk => chunk.includes(`"check-cleanup"`)).map(chunk => /function (\w+)/.exec(chunk)?.[1]);
    expect(functionsWith.sort()).toEqual(["acquireForCheckCleanup", "acquireLocked"]);
    const options = /export type AcquireOptions = \{([\s\S]*?)\n\};/.exec(claim)?.[1] ?? "";
    expect(options).not.toMatch(/closed|cleanup/i);
    // acquireLocked runs only inside the four wrappers, each through inTransaction.
    const callers = claim.split(/\n(?=(?:export )?function )/).filter(chunk => /\bacquireLocked\(store/.test(chunk)).map(chunk => /function (\w+)/.exec(chunk)?.[1]);
    expect(callers.sort()).toEqual(["acquire", "acquireForCheck", "acquireForCheckCleanup", "acquireIfReady"]);
  });
});

describe("strikes used up on a closed task", () => {
  /** Approve the task's scope so a builder run presents its route. */
  function approved(id: string): void {
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    propose(store, { taskId: id, goal: "the work", now: T0 });
    const scope = store.getScope(id)!;
    expect(approve(store, id, "alex", T0, scope.digest, added.token)).toMatchObject({ ok: true });
  }
  const route = (ref: number) => {
    const authority = store.routeAuthorityFor(ref, "builder");
    return authority === null || !authority.ok ? {} : { route: authority.stamp };
  };
  const attempt = (ref: number, leaseId: string, at: Date, role: "builder" | "scout" = "builder") => {
    expect(take(ref, "runner-a", at, 60 * 60_000, leaseId)).toMatchObject({ ok: true });
    return store.startRun({ taskRef: ref, leaseId, runner: "runner-a", branch: "b", worktree: "/w", now: at, ...(role === "scout" ? { role } : {}), ...route(ref) });
  };
  const failBuild = (leaseId: string, runId: number, at: Date, taskId = "t-1", failureClass: FailureClass = "agent-reported") =>
    finalize(store, leaseId, { kind: "failure", runId, taskId, failureClass, message: "boom", worktree: "/w", now: at });
  const failScout = (leaseId: string, runId: number, at: Date) =>
    finalize(store, leaseId, { kind: "scout-failure", runId, taskId: "t-1", failure: "failure", message: "boom", now: at });
  /** Two strikes in, a third attempt claimed and running. */
  function third(role: "builder" | "scout" = "builder"): { ref: number; run: number } {
    const ref = task("t-1");
    approved("t-1");
    const fail = role === "scout" ? failScout : failBuild;
    for (const [n, at] of [[1, 0], [2, 10 * 60_000]] as const) {
      const run = attempt(ref, `lease-${n}`, later(at), role);
      expect(fail(`lease-${n}`, run, later(at + 1_000))).toMatchObject({ ok: true, disposition: "backoff" });
    }
    store.handle.prepare("DELETE FROM hold WHERE task_ref = ?").run(ref);
    return { ref, run: attempt(ref, "lease-3", later(30 * 60_000), role) };
  }
  const effects = (ref: number) => ({
    incidents: count("SELECT COUNT(*) AS n FROM incident"),
    holds: count("SELECT COUNT(*) AS n FROM hold WHERE task_ref = ?", ref),
    notifications: count("SELECT COUNT(*) AS n FROM notification"),
  });

  for (const role of ["builder", "scout"] as const) {
    for (const state of CLOSED) {
      test(`${role}, task ${state} while the claim was live: its state stays, no incident, hold or page`, () => {
        const { ref, run } = third(role);
        close("t-1", state, later(30 * 60_000 + 500));
        const before = { task: rowOf("t-1"), ...effects(ref) };
        const sealed = role === "scout" ? failScout("lease-3", run, later(31 * 60_000)) : failBuild("lease-3", run, later(31 * 60_000));
        expect(sealed).toEqual({ ok: true, disposition: "closed", strikes: 3, state });
        expect({ task: rowOf("t-1"), ...effects(ref) }).toEqual(before);
        expect(store.getRun(run)).toMatchObject({ outcome: "failed" });
        expect(store.handle.prepare("SELECT released_by FROM claim WHERE lease_id = 'lease-3'").get()).toEqual({ released_by: "released" });
        expect(store.refForId(ref)?.strikes).toBe(3);
      });
    }
  }

  test("an open task still stalls: failed, one incident, one hold, one page", () => {
    const { ref, run } = third();
    store.setTaskState("t-1", "running", later(30 * 60_000));
    const before = effects(ref);
    expect(failBuild("lease-3", run, later(31 * 60_000))).toMatchObject({ ok: true, disposition: "stalled", strikes: 3 });
    expect(store.getTask("t-1")?.state).toBe("failed");
    expect(effects(ref)).toEqual({ incidents: before.incidents + 1, holds: before.holds + 1, notifications: before.notifications + 1 });
  });

  test("a supplied task id that is not the run's own is refused, and the whole seal rolls back", () => {
    const { ref, run } = third();
    task("other");
    const before = { task: rowOf("t-1"), other: rowOf("other"), ...effects(ref), strikes: store.refForId(ref)?.strikes };
    expect(() => failBuild("lease-3", run, later(31 * 60_000), "other")).toThrow(/not other/);
    expect({ task: rowOf("t-1"), other: rowOf("other"), ...effects(ref), strikes: store.refForId(ref)?.strikes }).toEqual(before);
    expect(store.getRun(run)?.outcome).toBeNull();
    expect(store.currentLiveLease(ref, later(31 * 60_000))).toBe("lease-3");
  });
});

describe("the CLI", () => {
  let lines: string[] = [];
  const run = async (argv: string[], now: Date = T0) => {
    lines = [];
    return runOperate(argv[0]!, argv.slice(1), line => lines.push(line), { databaseFile: db, now });
  };
  const payload = () => JSON.parse(lines.join("\n")) as Record<string, unknown>;
  const claim = (id: string, runner = "runner-a", now: Date = T0, ttl?: number) =>
    run(["claim", id, "--runner", runner, "--token", tok(runner), "--json", ...(ttl === undefined ? [] : ["--ttl", String(ttl)])], now);

  test("claim refuses a closed task with its state and a next step that works for it", async () => {
    task("t-done");
    close("t-done", "done");
    expect(await claim("t-done")).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, command: "claim", reason: "closed", state: "done" });
    // Done with no rejected result: a requeue would be refused, so it is not offered.
    expect(String(payload()["message"])).toContain("toolroll task show t-done");
    expect(String(payload()["message"])).not.toContain("requeue");

    task("t-failed");
    close("t-failed", "failed");
    expect(await claim("t-failed")).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "closed", state: "failed" });
    expect(String(payload()["message"])).toContain("toolroll task requeue t-failed");

    task("t-cancelled");
    close("t-cancelled", "cancelled");
    expect(await claim("t-cancelled")).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "closed", state: "cancelled" });
    expect(String(payload()["message"])).toContain("toolroll task state t-cancelled queued");
    expect(count("SELECT COUNT(*) AS n FROM claim")).toBe(0);
  });

  test("claim makes the task running with its grant; if the running write misses, the grant rolls back too", async () => {
    const ref = task("t-1");
    expect(await claim("t-1")).toBe(EXIT.ok);
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(count("SELECT COUNT(*) AS n FROM claim WHERE task_ref = ?", ref)).toBe(1);

    const other = task("t-2");
    // A test seam: the running write changes no row, so the claim must not stand alone.
    store.handle.exec("CREATE TRIGGER no_running BEFORE UPDATE OF state ON task WHEN NEW.state = 'running' AND OLD.id = 't-2' BEGIN SELECT RAISE(IGNORE); END");
    let code: number | string;
    try { code = await claim("t-2"); } catch (error) { code = String((error as Error).message); }
    expect(code).not.toBe(EXIT.ok);
    expect(count("SELECT COUNT(*) AS n FROM claim WHERE task_ref = ?", other)).toBe(0);
    expect(store.getTask("t-2")?.state).toBe("queued");
  });

  test("heartbeat on an expired claim of a closed task says closed", async () => {
    task("t-1");
    await claim("t-1", "runner-a", T0, 60);
    const lease = (payload()["lease"] as { leaseId: string }).leaseId;
    close("t-1", "done", later(90_000));
    expect(await run(["heartbeat", lease, "--json"], later(120_000))).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, command: "heartbeat", reason: "closed", state: "done" });
  });

  test("worker release and its requeue are one commit: no one can claim in between", async () => {
    task("t-1");
    await claim("t-1");
    const lease = (payload()["lease"] as { leaseId: string }).leaseId;
    let busy: string | null = null;
    let seenReleased: unknown = "unread";
    const original = Store.prototype.refForId;
    // refForId runs inside releaseToQueue's transaction, after the release and before the requeue.
    const spy = vi.spyOn(Store.prototype, "refForId").mockImplementation(function (this: Store, taskRef: number) {
      if (busy === null) {
        const other = new DatabaseSync(db);
        other.exec("PRAGMA busy_timeout = 0");
        try {
          // The release is written but not committed: another connection still reads the claim as held...
          seenReleased = other.prepare("SELECT released_at FROM claim WHERE lease_id = ?").get(lease)?.["released_at"];
          // ...and cannot start a write (a claim) until the requeue commits with it.
          other.exec("BEGIN IMMEDIATE"); other.exec("ROLLBACK"); busy = "no";
        } catch (error) { busy = String((error as Error).message); } finally { other.close(); }
      }
      return original.call(this, taskRef);
    });
    try {
      expect(await run(["worker", "release", lease, "--json"], later(1_000))).toBe(EXIT.ok);
    } finally {
      spy.mockRestore();
    }
    expect(seenReleased).toBeNull();
    expect(busy).toMatch(/locked|busy/i);
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.currentLiveLease(store.refFor("built-in", "t-1").id, later(1_000))).toBeNull();
    // After the commit, runner B claims and keeps running: no later write of A's lands over it.
    expect(await claim("t-1", "runner-b", later(2_000))).toBe(EXIT.ok);
    expect(store.getTask("t-1")?.state).toBe("running");
  });

  test("a duplicate release changes nothing, even after another runner claimed the task", async () => {
    const ref = task("t-1");
    await claim("t-1");
    const lease = (payload()["lease"] as { leaseId: string }).leaseId;
    expect(await run(["worker", "release", lease, "--json"], later(1_000))).toBe(EXIT.ok);
    expect(await claim("t-1", "runner-b", later(2_000))).toBe(EXIT.ok);
    const before = rowOf("t-1");
    expect(await run(["worker", "release", lease, "--json"], later(3_000))).toBe(EXIT.ok);
    expect(rowOf("t-1")).toEqual(before);
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(store.currentLiveLease(ref, later(3_000))).not.toBeNull();
  });

  test("the old two-step partial release (released, requeue never ran) is left alone by a retry, and the state verb recovers it", async () => {
    task("t-1");
    await claim("t-1");
    const lease = (payload()["lease"] as { leaseId: string }).leaseId;
    expect(release(store, lease, later(1_000))).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(await run(["worker", "release", lease, "--json"], later(2_000))).toBe(EXIT.ok);
    expect(store.getTask("t-1")?.state).toBe("running");
    // Recovery today is a person's `task state <id> queued` (no reaper requeues a released claim's task).
    expect(store.setTaskState("t-1", "queued", later(3_000))).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("releasing a lease on a task the pass keeps queued changes no state", async () => {
    const ref = task("t-1");
    expect(take(ref, "runner-a", T0, 60 * 60_000, "lease-q")).toMatchObject({ ok: true });
    const before = rowOf("t-1");
    expect(await run(["worker", "release", "lease-q", "--json"], later(1_000))).toBe(EXIT.ok);
    expect(rowOf("t-1")).toEqual(before);
  });
});
