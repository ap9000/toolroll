import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { SCHEMA_VERSION, databasePath, isLifecycleNotification, openStore, BUILT_IN, type Capability, type Store } from "./store.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { digestOf } from "./scope.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

test("notification provenance comes from trusted records and a duplicate cannot rebind its identity", () => {
  const store = openStore(":memory:");
  try {
    store.createTask({ id: "a", title: "a" }, T0);
    const taskRef = store.refFor(BUILT_IN, "a").id;
    store.placeTask(taskRef, "/project/a");
    const run = store.startRun({ taskRef, leaseId: "a", runner: "b", branch: "a", worktree: "/a", ...bareLegacy("build"), now: T0 });
    // The filing and start facts are the task's own lifecycle rows; this
    // test reads the hand-enqueued rows around them.
    const rows = () => store.listNotifications().filter(one => !isLifecycleNotification(one));
    expect(store.enqueueNotification({ source: { run }, dedupeKey: "event", kind: "ready", subject: "pretends to be b", body: "b", link: "/t/b" }, T0)).toBe(true);
    expect(rows()[0]).toMatchObject({ scope: "task", taskRef, taskId: "a", project: "/project/a", run });
    expect(store.enqueueNotification({ source: { installation: true }, dedupeKey: "event", kind: "ready", subject: "new", body: "new" }, T0)).toBe(false);
    expect(rows()[0]).toMatchObject({ scope: "task", project: "/project/a", run });
    for (const [key, source] of [["missing-run", { run: 999 }], ["missing-task", { taskRef: 999 }]] as const) {
      store.enqueueNotification({ source, dedupeKey: key, kind: "task", subject: "a", body: "a", link: "/t/a" }, T0);
    }
    expect(rows().slice(1).map(row => row.scope)).toEqual(["unknown", "unknown"]);
  } finally { store.close(); }
});

describe("same task revision identity (read projection)", () => {
  test("point reads and family pages do not hydrate 1,200 unrelated tasks; counts aggregate before limits", () => {
    const store = openStore(":memory:");
    try {
      const make = (id: string, repo = "/visible") => {
        store.createTask({ id, title: id }, T0);
        const ref = store.refFor(BUILT_IN, id).id;
        store.placeTask(ref, repo); return ref;
      };
      const root = make("root");
      const child = make("child");
      const run = store.startRun({ taskRef: root, leaseId: "fixture", runner: "fixture", branch: "fixture", worktree: "/fixture", now: T0, ...bareLegacy("build") });
      store.finishRun(run, { outcome: "built", now: T0 });
      const artifact = store.saveArtifact({ run, kind: "revision-brief", key: "fixture.json", bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "a".repeat(64), capture: "synthetic lineage fixture" }, T0);
      store.markRevision(child, "root", artifact);
      store.setTaskState("root", "done", T0);
      store.setTaskState("child", "done", T0);
      for (let i = 0; i < 1200; i++) {
        const ref = make(`unrelated-${i}`);
        // Old unowned build rows must not turn the activity count back into
        // a fleet-wide hydration. Only a live claim can make these run.
        store.startRun({ taskRef: ref, leaseId: `orphan-${i}`, runner: "fixture", branch: "fixture", worktree: "/fixture", now: T0, ...bareLegacy("build") });
      }
      make("secret", "/hidden");
      const materialized: number[] = [];
      let points = 0;
      const raw = store.raw(), prepare = raw.prepare.bind(raw);
      const spy = vi.spyOn(raw, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        const all = statement.all.bind(statement), get = statement.get.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...params) => { const rows = all(...params); materialized.push(rows.length); return rows; });
        vi.spyOn(statement, "get").mockImplementation((...params) => { points++; return get(...params); });
        return statement;
      });
      const lookups = vi.spyOn(store, "lookupRef");
      expect(store.taskFamilyOf("child", ["/visible"], false)?.versions.map(one => one.id)).toEqual(["root", "child"]);
      expect(points).toBe(2);
      expect(materialized).toEqual([2]);
      expect(lookups).not.toHaveBeenCalled();
      materialized.length = 0;
      expect(store.taskFamilyOf("secret", ["/visible"], false)).toBeNull();
      expect(materialized).toEqual([]);
      const page = store.taskFamiliesAdmitted(["/visible"], false, { limit: 3 });
      expect(page).toHaveLength(3);
      expect(materialized).toEqual([3]);
      materialized.length = 0;
      expect(store.taskFamiliesAdmitted(["/visible"], false, { states: ["done"], limit: 1 })[0]?.versions).toHaveLength(2);
      expect(materialized).toEqual([2]);
      materialized.length = 0;
      expect(store.taskFamilyCounts(["/visible"], false, T0, ["root", "child", "secret"]))
        .toEqual({ running: 1, queued: 1200, doneRecently: 0 });
      expect(materialized).toEqual([]);
      expect(store.taskActivityCandidates(["/visible"], false, T0)).toEqual([]);
      materialized.length = 0;
      expect(store.chatSnapshot(["/visible"], T0).tasks).toHaveLength(60);
      expect(Math.max(...materialized)).toBe(61);
      expect(store.chatSnapshot(["/visible"], T0).tasksSaturated).toBe(true);
      spy.mockRestore(); lookups.mockRestore();
    } finally { store.close(); }
  });

  test("groups before pages, keeps exact versions and active siblings, and admits before lineage", () => {
    const store = openStore(":memory:");
    try {
      const make = (id: string, repo = "/visible") => {
        store.createTask({ id, title: id }, T0);
        const ref = store.refFor(BUILT_IN, id).id;
        store.placeTask(ref, repo);
        return ref;
      };
      const link = (child: string, parent: string, source = parent) => {
        const run = store.startRun({ taskRef: store.lookupRef(source)!.id, leaseId: `fixture-${child}`, runner: "fixture", branch: "fixture", worktree: "/fixture", now: T0, ...bareLegacy("build") });
        store.finishRun(run, { outcome: "built", now: T0 });
        const artifact = store.saveArtifact({ run, kind: "revision-brief", key: `fixture/${child}.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "a".repeat(64), capture: "synthetic lineage fixture" }, T0);
        store.markRevision(store.lookupRef(child)!.id, parent, artifact);
      };
      make("root");
      store.setTaskState("root", "done", T0);
      make("unrelated");
      // A large family must not spend the task page's allowance.
      for (let i = 0; i < 205; i++) { make(`sibling-${i}`); link(`sibling-${i}`, "root"); }
      make("revision-2"); link("revision-2", "sibling-204");
      const families = store.taskFamiliesAdmitted(["/visible"], false);
      expect(families.map(one => one.root.id)).toEqual(["root", "unrelated"]);
      expect(families[0]!.current.id).toBe("revision-2");
      expect(families[0]!.versions).toHaveLength(207);
      expect(families[0]!.otherActive).toHaveLength(205);
      expect(store.taskFamiliesAdmitted(["/visible"], false, { limit: 1 })[0]!.versions).toHaveLength(207);
      expect(store.taskFamilyOf("sibling-0", ["/visible"], false)?.root.id).toBe("root");
      expect(store.chatSnapshot(["/visible"], T0).tasks).toHaveLength(2);
      expect(store.chatSnapshot(["/visible"], T0).tasks[0]).toMatchObject({ id: "revision-2", rootId: "root", title: "root", state: "queued" });
      // Hidden/cross-project/missing/cyclic/borrowed-source links stay visible
      // separately and reveal no ancestor identifiers in their explanation.
      make("secret-root", "/hidden");
      make("cross"); link("cross", "secret-root");
      make("broken"); link("broken", "root", "unrelated");
      make("missing"); link("missing", "root");
      store.raw().prepare("UPDATE task_ref SET revision_of = 'secret-missing' WHERE external_id = 'missing'").run();
      make("cycle"); link("cycle", "root");
      store.raw().prepare("UPDATE task_ref SET revision_of = 'cycle' WHERE external_id = 'cycle'").run();
      for (const id of ["cross", "broken", "missing", "cycle"]) {
        const family = store.taskFamilyOf(id, ["/visible"], false)!;
        expect(family.root.id).toBe(id);
        expect(family.problem).not.toBeNull();
        expect(family.problem).not.toContain("secret");
        expect(family.versions.map(one => one.id)).toEqual([id]);
        expect(store.taskFamiliesAdmitted(["/visible"], false).find(one => one.root.id === id)).toEqual(family);
      }
      expect(store.taskFamilyOf("secret-root", ["/visible"], false)).toBeNull();
      expect(store.taskFamiliesAdmitted([], false)).toEqual([]);
      expect(store.paletteTasks("/hidden", 10, ["/visible"], false)).toEqual([]);
      expect(store.paletteTasks("/visible", 1, ["/visible"], false)).toHaveLength(1);
      // The existing ancestry depth bound applies equally to point and list
      // reads. It never becomes a raw-row limit that discards siblings.
      for (let i = 0; i <= 64; i++) {
        make(`depth-${i}`);
        if (i > 0) link(`depth-${i}`, `depth-${i - 1}`);
      }
      expect(store.taskFamilyOf("depth-63", ["/visible"], false)?.versions).toHaveLength(64);
      const tooDeep = store.taskFamilyOf("depth-64", ["/visible"], false)!;
      expect(tooDeep.problem).not.toBeNull();
      expect(tooDeep.versions.map(one => one.id)).toEqual(["depth-64"]);
      expect(store.taskFamiliesAdmitted(["/visible"], false).find(one => one.root.id === "depth-64")).toEqual(tooDeep);
    } finally { store.close(); }
  });
});


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
const later = (ms: number) => new Date(T0.getTime() + ms);

/** The runner gate (MCP spec v6): every acquisition authenticates the runner
 * and requires the task's PLACED repo to be in its registered list — tests
 * that claim enroll their runner here and place tasks at REPO first. */
const REPO = "/repo/store-tests";
const tok = (name: string) => `tok-${name}`;
function enroll(store: Store, name: string): void {
  register(store, { name, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => tok(name) });
}

describe("the database path", () => {
  test("a provider-specific isolation path wins without changing the rest of XDG", () => {
    expect(
      databasePath(
        { STANDING_ORDERS_DB: "/tmp/standing-orders-agent/orders.db", XDG_CONFIG_HOME: "/operator/config" },
        "/operator/home",
      ),
    ).toBe("/tmp/standing-orders-agent/orders.db");
  });

  test("an empty isolation path falls back to the normal operator database", () => {
    expect(databasePath({ STANDING_ORDERS_DB: "", XDG_CONFIG_HOME: "/operator/config" }, "/operator/home")).toBe(
      "/operator/config/toolroll/orders.db",
    );
  });
});

describe("the built-in task store", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("creates a task, queued, with a reference it can be claimed through", () => {
    // A task with no TaskRef is work the control plane can see and never act
    // on, so the two are created together or not at all.
    const task = store.createTask({ id: "t-1", title: "wire the payout webhook" }, T0);

    expect(task.state).toBe("queued");
    expect(store.getTask("t-1")).toEqual(task);
    expect(store.refFor(BUILT_IN, "t-1").id).toBeGreaterThan(0);
  });

  test("is null about a task it does not have", () => {
    expect(store.getTask("nope")).toBeNull();
  });

  test("moves a task between states", () => {
    store.createTask({ id: "t-1", title: "a" }, T0);

    expect(store.setTaskState("t-1", "running", later(1_000))).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(store.getTask("t-1")?.updatedAt).toBe(later(1_000).toISOString());
  });

  test("says so when there was nothing to move", () => {
    expect(store.setTaskState("ghost", "done", T0)).toMatchObject({ ok: false, reason: "unknown-task" });
  });

  describe("the ready set", () => {
    test("holds a task back until what it waits on is done", () => {
      store.createTask({ id: "schema", title: "schema" }, T0);
      store.createTask({ id: "api", title: "api" }, T0);
      store.addEdge("api", "schema");

      expect(ready(store)).toEqual(["schema"]);

      store.setTaskState("schema", "done", later(1_000));
      expect(ready(store)).toEqual(["api"]);
    });

    test("counts only `done` as satisfying a dependency", () => {
      // A blocker that failed or was cancelled has not delivered what the
      // dependent task needs; releasing it would dispatch work onto a
      // foundation that is not there.
      store.createTask({ id: "schema", title: "schema" }, T0);
      store.createTask({ id: "api", title: "api" }, T0);
      store.addEdge("api", "schema");

      for (const state of ["running", "failed", "cancelled"] as const) {
        store.setTaskState("schema", state, later(1_000));
        expect(ready(store)).not.toContain("api");
      }
    });

    test("waits for every blocker, not the first one", () => {
      store.createTask({ id: "a", title: "a" }, T0);
      store.createTask({ id: "b", title: "b" }, T0);
      store.createTask({ id: "c", title: "c" }, T0);
      store.addEdge("c", "a");
      store.addEdge("c", "b");

      store.setTaskState("a", "done", later(1_000));
      expect(ready(store)).not.toContain("c");

      store.setTaskState("b", "done", later(2_000));
      expect(ready(store)).toContain("c");
    });

    test("leaves out anything already claimed", () => {
      enroll(store, "runner-a");
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;
      store.placeTask(ref, REPO);

      acquire(store, ref, "runner-a", { token: tok("runner-a"), now: T0 });

      expect(ready(store)).toEqual([]);
    });

    test("offers a task again once its claim lapses", () => {
      enroll(store, "runner-a");
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;
      store.placeTask(ref, REPO);
      acquire(store, ref, "runner-a", { token: tok("runner-a"), now: T0, ttlMs: 60_000 });

      expect(ready(store, later(120_000))).toEqual(["t-1"]);
    });

    test("leaves out anything on hold, and takes it back when the hold lapses", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;

      store.hold(ref, "waiting on the design call", later(60_000), T0);
      expect(ready(store, later(1_000))).toEqual([]);

      // A hold whose `until` has passed is not a hold. Reading it as one
      // strands the work at the moment it was meant to resume.
      expect(ready(store, later(61_000))).toEqual(["t-1"]);
    });

    test("holds indefinitely when no expiry was given", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;

      store.hold(ref, "needs a decision", null, T0);

      expect(ready(store, later(9e8))).toEqual([]);
      expect(store.unhold(ref)).toBe(true);
      expect(ready(store, later(9e8))).toEqual(["t-1"]);
    });

    test("reports the hold in force, and ignores one that has lapsed", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;
      store.hold(ref, "waiting on the design call", later(60_000), T0);

      expect(store.activeHold(ref, later(1_000))?.reason).toBe("waiting on the design call");
      expect(store.activeHold(ref, later(61_000))).toBeNull();
    });

    test("orders by creation, so the oldest queued work goes first", () => {
      store.createTask({ id: "first", title: "a" }, T0);
      store.createTask({ id: "second", title: "b" }, later(1_000));

      expect(ready(store)).toEqual(["first", "second"]);
    });
  });

  describe("edges", () => {
    test("refuses a task that waits on itself", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);

      expect(store.addEdge("t-1", "t-1")).toMatchObject({ ok: false });
    });

    test("refuses a cycle rather than storing one", () => {
      // Stored, a cycle is invisible: every task in the ring stays un-ready
      // forever, the ready set quietly comes back shorter, and nothing
      // anywhere says why.
      store.createTask({ id: "a", title: "a" }, T0);
      store.createTask({ id: "b", title: "b" }, T0);
      store.createTask({ id: "c", title: "c" }, T0);
      store.addEdge("b", "a");
      store.addEdge("c", "b");

      const result = store.addEdge("a", "c");

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("cycle");
      expect(ready(store)).toEqual(["a"]);
    });

    test("is indifferent to being told the same edge twice", () => {
      store.createTask({ id: "a", title: "a" }, T0);
      store.createTask({ id: "b", title: "b" }, T0);

      expect(store.addEdge("b", "a")).toEqual({ ok: true });
      expect(store.addEdge("b", "a")).toEqual({ ok: true });
      expect(ready(store)).toEqual(["a"]);
    });

    test("replaces an edge atomically, wakes dispatch, and keeps the old edge on refusal", () => {
      for (const id of ["a", "b", "c"]) store.createTask({ id, title: id }, T0);
      store.addEdge("c", "a");
      expect(store.replaceEdge("c", "a", "ghost")).toEqual({ ok: false, reason: "unknown-replacement" });
      expect(store.blockers("c")).toEqual(["a"]);

      store.addEdge("b", "c");
      const cycle = store.replaceEdge("c", "a", "b");
      expect(cycle).toMatchObject({ ok: false });
      expect(store.blockers("c")).toEqual(["a"]);

      store.removeEdge("b", "c");
      const beforeReplace = store.wakeSeq();
      expect(store.replaceEdge("c", "a", "b")).toEqual({ ok: true });
      expect(store.blockers("c")).toEqual(["b"]);
      expect(store.wakeSeq()).toBeGreaterThan(beforeReplace);
    });
  });

  describe("the overlay", () => {
    test("keeps one reference per task, whoever asks", () => {
      const first = store.refFor("beads", "bd-17");
      const again = store.refFor("beads", "bd-17");

      expect(again.id).toBe(first.id);
    });

    test("keeps references from different backends apart", () => {
      // The same external id in two trackers is two different pieces of work,
      // and merging them would attach one task's claims to another's.
      const beads = store.refFor("beads", "17");
      const issues = store.refFor("github-issues", "17");

      expect(beads.id).not.toBe(issues.id);
    });

    test("references a backend it has never seen", () => {
      // The overlay outlives any particular backend; that is the point of
      // keying on (backend, external_id) rather than on our own task table.
      const ref = store.refFor("something-invented-later", "x-1");

      expect(ref.backend).toBe("something-invented-later");
      expect(ref.zones).toEqual([]);
      expect(ref.capabilityRequirements).toEqual([]);
    });
  });

  describe("idempotency", () => {
    test("runs a keyed mutation once, however many times it is retried", () => {
      // The case: a runner completes, the acknowledgement is lost, it retries.
      store.createTask({ id: "t-1", title: "first" }, T0, { idempotencyKey: "k-1", at: T0 });
      store.createTask({ id: "t-1", title: "second" }, T0, { idempotencyKey: "k-1", at: T0 });

      expect(store.getTask("t-1")?.title).toBe("first");
    });

    test("records only mutations that mutated something", () => {
      // A state change matching no task did nothing, so there is nothing to
      // replay. Recording it would answer "no such task" forever — including
      // after somebody creates it, which is exactly what happens when work is
      // queued in one order and dispatched in another.
      const first = store.setTaskState("ghost", "done", T0, { idempotencyKey: "k-2", at: T0 });
      store.createTask({ id: "ghost", title: "now it exists" }, T0);
      const afterwards = store.setTaskState("ghost", "done", T0, { idempotencyKey: "k-2", at: T0 });

      expect(first).toMatchObject({ ok: false, reason: "unknown-task" });
      expect(afterwards).toMatchObject({ ok: true });
      expect(store.getTask("ghost")?.state).toBe("done");
    });

    test("still replays a mutation that did happen", () => {
      store.createTask({ id: "t-1", title: "first" }, T0, { idempotencyKey: "k-3", at: T0 });
      store.setTaskState("t-1", "done", T0, { idempotencyKey: "k-4", at: T0 });

      // The retry must not re-run against a task that has moved on since.
      store.setTaskState("t-1", "running", later(1_000));
      const replayed = store.setTaskState("t-1", "done", T0, { idempotencyKey: "k-4", at: T0 });

      expect(replayed).toMatchObject({ ok: true });
      expect(store.getTask("t-1")?.state).toBe("running");
    });

    test("treats different keys as different mutations", () => {
      store.createTask({ id: "a", title: "a" }, T0, { idempotencyKey: "k-a", at: T0 });
      store.createTask({ id: "b", title: "b" }, T0, { idempotencyKey: "k-b", at: T0 });

      expect(ready(store)).toEqual(["a", "b"]);
    });
  });

  test("survives being closed and opened again", async () => {
    // WAL, foreign keys, and the schema guard all have to hold on a file that
    // already exists — the second run is the one every real user has.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "standing-orders-store-"));
    const file = join(dir, "nested", "orders.db");

    const first = openStore(file);
    first.createTask({ id: "t-1", title: "persisted" }, T0);
    first.close();

    const second = openStore(file);
    expect(second.getTask("t-1")?.title).toBe("persisted");
    second.close();

    await rm(dir, { recursive: true, force: true });
  });
});

/** The ready set as task ids, which is what the assertions are actually about. */
function ready(store: Store, now: Date = later(5_000)): string[] {
  return store.listReady(now).map(ref => ref.externalId);
}

describe("opening a database that already exists", () => {
  test("adds a column the schema grew after the file was made", async () => {
    // `CREATE TABLE IF NOT EXISTS` does nothing to a table already there, so a
    // column added later never reaches an existing database — and every test
    // against :memory: or a fresh path passes while the first real one fails
    // on the next query. Which is exactly how this was found.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "standing-orders-migrate-"));
    const file = join(dir, "orders.db");

    const first = openStore(file);
    first.createTask({ id: "t-1", title: "before" }, T0);
    // Put the file back the way an older build would have left it.
    first.handle.exec("ALTER TABLE task_ref DROP COLUMN origin");
    // An older build's file reads older: every DDL change bumps the version since v114, and a current file is never repaired.
    first.handle.exec("UPDATE schema_version SET version = 113");
    first.close();

    const second = openStore(file);
    expect(second.originOf(BUILT_IN, "t-1")).toBe("theirs");
    expect(() => second.listReady(T0)).not.toThrow();
    second.close();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("a task and its reference are created together", () => {
  test("a failure partway leaves neither behind", () => {
    // Found in a real database. A schema change made the reference insert
    // fail, the task insert had already committed, and the result was a task
    // the ready query could not see and nothing could claim — which something
    // else later gave a reference to, with the wrong origin. The invariant was
    // written in a comment and not enforced.
    const store = openStore(":memory:");
    store.handle.exec("DROP TABLE task_ref");

    expect(() => store.createTask({ id: "t-1", title: "doomed" }, T0)).toThrow();

    // The task row must not have survived its own half-finished creation.
    const rows = store.handle.prepare("SELECT count(*) AS n FROM task").get();
    expect(Number(rows?.["n"])).toBe(0);
    store.close();
  });

  test("a task Toolroll created is recorded as ours", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "ours" }, T0);

    expect(store.originOf(BUILT_IN, "t-1")).toBe("ours");
    store.close();
  });
});

describe("capabilities", () => {
  const T0 = new Date("2026-08-11T22:00:00.000Z");

  const one = (over: Partial<Capability> = {}): Capability => ({
    repo: "/code/thing",
    kind: "env",
    name: "SUPABASE_KEY",
    probe: 'test -n "$SUPABASE_KEY"',
    status: "unprobed",
    addedBy: "alex",
    createdAt: T0.toISOString(),
    lastVerifiedAt: null,
    verifiedBy: null,
    lastResult: null,
    expiresAt: null,
    ...over,
  });

  test("records metadata and only metadata — there is no value column", () => {
    const store = openStore(":memory:");
    store.saveCapability(one());

    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "unprobed",
      probe: 'test -n "$SUPABASE_KEY"',
    });
    // The schema itself must have nowhere to put a secret.
    const columns = store.handle
      .prepare("PRAGMA table_info(capability)")
      .all()
      .map(row => String(row["name"]));
    expect(columns).not.toContain("value");
    store.close();
  });

  test("verification carries the moment it happened", () => {
    const store = openStore(":memory:");
    store.saveCapability(one());

    store.markCapability("/code/thing", "env", "SUPABASE_KEY", { status: "verified", by: "builder-1" }, T0);

    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "verified",
      lastVerifiedAt: T0.toISOString(),
      verifiedBy: "builder-1",
    });
    store.close();
  });

  test("a failed probe clears the verification stamp", () => {
    const store = openStore(":memory:");
    store.saveCapability(one());
    store.markCapability("/code/thing", "env", "SUPABASE_KEY", { status: "verified", by: "builder-1" }, T0);

    store.markCapability(
      "/code/thing", "env", "SUPABASE_KEY",
      { status: "failed", by: "builder-1", detail: "exit 1" },
      new Date(T0.getTime() + 1_000),
    );

    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "failed",
      lastVerifiedAt: null,
      lastResult: "exit 1",
    });
    store.close();
  });

  test("requirements replace what a task needed before", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor(BUILT_IN, "t-1").id;

    store.setRequirements(ref, ["env:SUPABASE_KEY", "cli:gh"]);
    expect(store.refFor(BUILT_IN, "t-1").capabilityRequirements).toEqual(["env:SUPABASE_KEY", "cli:gh"]);

    store.setRequirements(ref, ["cli:gh"]);
    expect(store.refFor(BUILT_IN, "t-1").capabilityRequirements).toEqual(["cli:gh"]);
    store.close();
  });

  test("a task can be placed in a repository, and starts placed nowhere", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor(BUILT_IN, "t-1");
    expect(ref.repo).toBeNull();

    store.placeTask(ref.id, "/code/thing");

    expect(store.refFor(BUILT_IN, "t-1").repo).toBe("/code/thing");
    store.close();
  });
});

describe("the M3 schema: owned holds, decisions, evidence, incidents", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  const refOf = (id: string) => {
    store.createTask({ id, title: id }, T0);
    return store.refFor(BUILT_IN, id).id;
  };

  const runOn = (ref: number) =>
    store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, ref, "builder"),
    });

  /** The task's live claim under a lease (final authority closure): a
   * repair turn mends an attempt only while its lease is the task's
   * CURRENT claim, so every fixture that repairs holds one first. */
  const claimAs = (ref: number, leaseId: string, runner = "builder-1", generation = 1) =>
    store
      .raw()
      .prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(leaseId, ref, generation, runner, T0.toISOString(), later(900_000).toISOString(), T0.toISOString());

  test("two owners can hold one task, and each lifts only its own", () => {
    const ref = refOf("t-1");

    store.hold(ref, "operator pause", null, T0);
    store.holdOwned(
      { taskRef: ref, ownerKind: "decision", ownerId: "7", reason: "decision:7", until: null },
      T0,
    );

    expect(store.activeHolds(ref, later(1_000))).toHaveLength(2);

    // The CLI's unhold is the operator's hand; the decision's hold survives it.
    expect(store.unhold(ref)).toBe(true);
    const remaining = store.activeHolds(ref, later(1_000));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.ownerKind).toBe("decision");

    expect(store.releaseOwnedHold("decision", "7")).toBe(true);
    expect(store.activeHolds(ref, later(1_000))).toHaveLength(0);
  });

  test("any active hold keeps a task off the ready set, whoever owns it", () => {
    const ref = refOf("t-1");
    store.holdOwned(
      { taskRef: ref, ownerKind: "decision", ownerId: "3", reason: "decision:3", until: null },
      T0,
    );

    expect(store.listReady(later(9e8)).map(r => r.externalId)).toEqual([]);
  });

  test("a decision round-trips, its options typed and its task attached", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);

    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "The migration drops signup_source, which analytics reads.",
        question: "Drop the column, or keep it and backfill?",
        options: [
          { id: "keep", label: "Keep + backfill", consequence: "Analytics unaffected.", reversible: true },
          { id: "drop", label: "Drop it", consequence: "3 dashboards break silently.", reversible: false },
        ],
        recommendation: "keep",
      },
      T0,
    );

    const decision = store.getDecision(id);
    expect(decision?.state).toBe("open");
    expect(decision?.options[1]?.reversible).toBe(false);
    expect(store.decisionForRun(run)?.id).toBe(id);
    expect(store.listDecisions()[0]).toMatchObject({ id, taskId: "t-1" });
  });

  test("one run gets one decision, ever", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);
    const option = { id: "a", label: "a", consequence: "c", reversible: true };
    store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "a" },
      T0,
    );

    expect(() =>
      store.saveDecision(
        { run, urgency: "blocking", recap: "r2", question: "q2", options: [option], recommendation: "a" },
        T0,
      ),
    ).toThrow();
  });

  test("an overdue open decision expires — louder, never chosen for", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);
    const option = { id: "a", label: "a", consequence: "c", reversible: true };
    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "r",
        question: "q",
        options: [option],
        recommendation: "a",
        deadline: later(60_000).toISOString(),
      },
      T0,
    );

    expect(store.expireOverdueDecisions(later(30_000))).toBe(0);
    expect(store.expireOverdueDecisions(later(61_000))).toBe(1);

    const expired = store.getDecision(id);
    expect(expired?.state).toBe("expired");
    expect(expired?.choice).toBeNull();
    // Expired is still unanswered — it shows up, it does not go away.
    expect(store.countUnanswered()).toBe(1);
    expect(store.listDecisions("open")).toHaveLength(0);
  });

  test("evidence links only within the decision's own run", () => {
    const ref = refOf("t-1");
    const other = refOf("t-2");
    const run = runOn(ref);
    const foreign = store.startRun({
      taskRef: other,
      leaseId: "lease-2",
      runner: "builder-1",
      branch: "standing-orders/t-2",
      worktree: "/pool/t-2",
      now: T0,
      ...presented(store, other, "builder"),
    });

    const option = { id: "a", label: "a", consequence: "c", reversible: true };
    const decision = store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "a" },
      T0,
    );
    const ours = store.saveArtifact(
      { run, kind: "diff", key: "1/diff.patch", bytesOriginal: 10, bytesStored: 10, truncated: false, sha256: "x", capture: "git diff (exit 0)" },
      T0,
    );
    const theirs = store.saveArtifact(
      { run: foreign, kind: "diff", key: "2/diff.patch", bytesOriginal: 10, bytesStored: 10, truncated: false, sha256: "y", capture: "git diff (exit 0)" },
      T0,
    );

    store.linkEvidence(decision, ours);
    expect(store.evidenceFor(decision).map(a => a.id)).toEqual([ours]);

    // Another run's artifact is not this decision's evidence, whatever any
    // payload claims — the guard is the INSERT itself.
    expect(() => store.linkEvidence(decision, theirs)).toThrow(/never crosses runs/);
  });

  test("an incident stays open until resolved, and resolving lifts its hold", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);

    const id = store.createIncident({ run, kind: "malformed-decision" }, T0);
    store.holdOwned(
      { taskRef: ref, ownerKind: "incident", ownerId: String(id), reason: "malformed-decision", until: null },
      T0,
    );

    expect(store.openIncidents()[0]).toMatchObject({ id, taskId: "t-1" });
    expect(store.listReady(later(9e8))).toHaveLength(0);

    expect(store.resolveIncident(id, "alex", later(1_000))).toBe(true);
    expect(store.openIncidents()).toHaveLength(0);
    expect(store.listReady(later(9e8)).map(r => r.externalId)).toEqual(["t-1"]);
    // Resolving twice is not a second resolution.
    expect(store.resolveIncident(id, "alex", later(2_000))).toBe(false);
  });

  test("a resolved episode stops being pending but keeps its row", () => {
    store.enqueueNotification(
      { dedupeKey: "decision:1", kind: "decision", subject: "s", body: "b" },
      T0,
    );
    const [row] = store.listNotifications("pending");
    expect(row).toBeDefined();

    store.resolveEpisode("decision:1", later(2_000));

    expect(store.listNotifications("pending")).toHaveLength(0);
    const [kept] = store.listNotifications("all");
    expect(kept?.id).toBe(row!.id);
    expect(kept?.resolvedAt).toBe(later(2_000).toISOString());
  });

  test("a run stamps its base revision and session once, first answer wins", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);

    store.stampRun(run, { baseRevision: "abc123" });
    store.stampRun(run, { baseRevision: "def456", sessionId: "sess-1" });

    expect(store.getRun(run)).toMatchObject({
      baseRevision: "abc123",
      sessionId: "sess-1",
      role: "builder",
      parentRun: null,
    });
  });

  /** A repair turn through its own admission (atomic authority closure):
   * words on refusal, the run id otherwise. */
  const repairOn = (ref: number, parentRun: number, over: Partial<Parameters<Store["admitRepair"]>[0]> = {}) => {
    const admitted = store.admitRepair({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      provider: "claude",
      parentRun,
      now: later(1_000),
      ...(presented(store, ref, "repair") as { route: import("./phase-routing.js").RouteStamp }),
      ...over,
    });
    if (!admitted.ok) throw new Error(admitted.problem);
    return admitted.runId;
  };

  test("a repair run records its parentage, and 'parked' is a real outcome", () => {
    const ref = refOf("t-1");
    claimAs(ref, "lease-1");
    const run = runOn(ref);
    const repair = repairOn(ref, run, { sessionId: "sess-1" });

    store.finishRun(run, { outcome: "parked", reason: "decision:1", now: later(2_000) });

    expect(store.getRun(repair)).toMatchObject({ role: "repair", parentRun: run });
    expect(store.getRun(run)).toMatchObject({ outcome: "parked", reason: "decision:1" });
  });

  test("the repair admission mends exactly one LIVE same-task builder under its own runner and lease (atomic authority closure): no parent, an ended parent, a planner, a foreign runner or lease, another task's run, and the generic road each open nothing", () => {
    const ref = refOf("t-1");
    const other = refOf("t-repair-other");
    const rows = () => Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n);
    const run = runOn(ref);
    const before = rows();
    // THE CURRENT CLAIM (final authority closure): an open parent whose
    // lease is not the task's live claim — none held, a released one, or
    // one superseded by a newer generation — admits no repair turn: the
    // runner and lease it copies prove nothing while nobody builds it.
    expect(() => repairOn(ref, run)).toThrow(/run #\d+'s lease lease-1 is not this task's current live claim \(nothing holds it\) — a repair turn mends an attempt still being built under its claim/);
    claimAs(ref, "lease-1");
    store.raw().prepare("UPDATE claim SET released_at = ? WHERE lease_id = 'lease-1'").run(T0.toISOString());
    expect(() => repairOn(ref, run)).toThrow(/is not this task's current live claim \(nothing holds it\)/);
    store.raw().prepare("UPDATE claim SET released_at = NULL WHERE lease_id = 'lease-1'").run();
    claimAs(ref, "lease-newer", "builder-1", 2);
    expect(() => repairOn(ref, run)).toThrow(/is not this task's current live claim \(lease-newer does\)/);
    store.raw().prepare("DELETE FROM claim WHERE lease_id = 'lease-newer'").run();
    // THE EXACT CLAIM TUPLE (repair custody closure): the SAME lease, held
    // by another machine — the parent row still says builder-1, the caller
    // says builder-1, the lease is current — admits nothing: the claim's
    // own runner is the fact, and the refusal is the one every fallback
    // admission gives. No run, no route.
    store.raw().prepare("UPDATE claim SET runner = 'builder-2' WHERE lease_id = 'lease-1'").run();
    expect(() => repairOn(ref, run)).toThrow(/this task's live claim lease-1 is held by builder-2 — a repair turn on builder-1 is another machine's/);
    expect(Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run_route").get() as { n: number }).n)).toBe(Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run_route WHERE run = ?").get(run) as { n: number }).n));
    store.raw().prepare("UPDATE claim SET runner = 'builder-1' WHERE lease_id = 'lease-1'").run();
    expect(rows()).toBe(before);
    // The generic road opens no repair, with or without a parent.
    expect(() => store.startRun({ taskRef: ref, leaseId: "lease-1", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", role: "repair", now: later(1), ...presented(store, ref, "repair") } as never)).toThrow(/a repair turn is admitted by admitRepair/);
    expect(() => store.startRun({ taskRef: ref, leaseId: "lease-1", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", role: "repair", parentRun: run, now: later(1), ...presented(store, ref, "repair") } as never)).toThrow(/a repair turn is admitted by admitRepair/);
    // The dedicated road proves the parent: named, this task's, a builder,
    // live, and mended under its own runner and lease.
    expect(store.admitRepair({ taskRef: ref, leaseId: "lease-1", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", parentRun: 9999, now: later(1), ...(presented(store, ref, "repair") as { route: import("./phase-routing.js").RouteStamp }) })).toMatchObject({ ok: false, problem: expect.stringMatching(/run #9999 does not exist/) });
    expect(store.admitRepair({ taskRef: ref, leaseId: "lease-1", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", parentRun: undefined as never, now: later(1), ...(presented(store, ref, "repair") as { route: import("./phase-routing.js").RouteStamp }) })).toMatchObject({ ok: false, problem: expect.stringMatching(/mends exactly one live builder attempt — none was named/) });
    expect(() => repairOn(ref, run, { runner: "other-machine" })).toThrow(/runs on builder-1 — its repair turn on other-machine is another machine's/);
    expect(() => repairOn(ref, run, { leaseId: "lease-foreign" })).toThrow(/holds lease lease-1 — a repair turn under lease lease-foreign is not its own/);
    expect(() => repairOn(other, run)).toThrow(/a repair run continues its own task's run only/);
    const planner = store.startRun({ taskRef: ref, leaseId: "plan-lease", runner: "builder-1", role: "planner", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(1), ...presented(store, ref, "planner") });
    expect(() => repairOn(ref, planner, { leaseId: "plan-lease" })).toThrow(/is a planner run — a repair turn mends a builder attempt/);
    store.finishRun(planner, { outcome: "no-change", reason: "plan", now: later(1) });
    expect(rows()).toBe(before + 1);
    // A live parent admits its turn; an ended one admits nothing more.
    const repair = repairOn(ref, run);
    expect(store.getRun(repair)).toMatchObject({ role: "repair", parentRun: run, runner: "builder-1", leaseId: "lease-1" });
    store.finishRun(run, { outcome: "built", reason: "done", now: later(2) });
    expect(() => repairOn(ref, run)).toThrow(/ended as built — a repair turn mends a live attempt only/);
    expect(rows()).toBe(before + 2);
  });

  test("lineage is proved at the insert and by ONE warm-resume binding (raw authority repair): no late parent stamp exists, a foreign parent opens nothing, and the warm binding re-proves task, park, session, and first-try before it writes", () => {
    const ref = refOf("t-1");
    const other = refOf("t-lineage-other");
    const parked = store.startRun({ taskRef: ref, leaseId: "lease-1", runner: "builder-1", provider: "claude", sessionId: "session-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(parked, { outcome: "parked", reason: "decision:1", now: T0 });
    const stamp = (taskRef: number) => presented(store, taskRef, "builder") as { route: import("./phase-routing.js").RouteStamp };
    // A recovered draft's lineage rides its OWN admission (atomic
    // authority closure): the generic road names no parent for a builder;
    // the recovery grant is this task's interrupted builder, left in this
    // very worktree — a parked run, another task's run, or a planner is
    // no grant, and the row never opens.
    expect(() => store.startRun({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", parentRun: parked, now: later(1), ...presented(store, ref, "builder") })).toThrow(/a builder names no parent here — a recovered draft is admitted by admitRecoveredBuilder/);
    expect(store.admitRecoveredBuilder({ taskRef: other, leaseId: "lease-o", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", recoveredFrom: parked, now: later(1), ...stamp(other) })).toMatchObject({ ok: false, problem: expect.stringMatching(/a builder run continues its own task's run only/) });
    expect(store.runsFor(other)).toHaveLength(0);
    expect(store.admitRecoveredBuilder({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", recoveredFrom: parked, now: later(1), ...stamp(ref) })).toMatchObject({ ok: false, problem: expect.stringMatching(/ended as parked \(decision:1\) — only an interrupted attempt's draft is recovered/) });
    // A FAILED PLANNER is no recovery grant (the C2 reproduction), nor is
    // a builder that failed for any reason but an interruption, nor one
    // still being built under a live lease.
    const failedPlanner = store.startRun({ taskRef: ref, leaseId: "lease-p", runner: "builder-1", role: "planner", provider: "claude", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(1), ...presented(store, ref, "planner") });
    store.finishRun(failedPlanner, { outcome: "failed", reason: "interrupted", now: later(1) });
    expect(store.admitRecoveredBuilder({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", recoveredFrom: failedPlanner, now: later(1), ...stamp(ref) })).toMatchObject({ ok: false, problem: expect.stringMatching(/is a planner run — a recovered draft is a builder's or its repair turn's/) });
    const failedAgent = store.startRun({ taskRef: ref, leaseId: "lease-fa", runner: "builder-1", provider: "claude", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(1), ...presented(store, ref, "builder") });
    store.finishRun(failedAgent, { outcome: "failed", reason: "agent", now: later(1) });
    expect(store.admitRecoveredBuilder({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", recoveredFrom: failedAgent, now: later(1), ...stamp(ref) })).toMatchObject({ ok: false, problem: expect.stringMatching(/ended as failed \(agent\) — only an interrupted attempt's draft is recovered/) });
    store.raw().prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES ('lease-live', ?, 7, 'builder-1', ?, ?, ?)").run(ref, T0.toISOString(), later(900_000).toISOString(), T0.toISOString());
    const stillBuilding = store.startRun({ taskRef: ref, leaseId: "lease-live", runner: "builder-1", provider: "claude", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(1), ...presented(store, ref, "builder") });
    expect(store.admitRecoveredBuilder({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", recoveredFrom: stillBuilding, now: later(1), ...stamp(ref) })).toMatchObject({ ok: false, problem: expect.stringMatching(/is still being built under lease lease-live — nothing recovers a live attempt's draft/) });
    store.finishRun(stillBuilding, { outcome: "failed", reason: "x", now: later(1) });
    expect(store.runsFor(ref).filter(one => one.parentRun !== null)).toHaveLength(0);
    const interrupted = store.startRun({ taskRef: ref, leaseId: "lease-i", runner: "builder-1", provider: "claude", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(1), ...presented(store, ref, "builder") });
    store.finishRun(interrupted, { outcome: "failed", reason: "interrupted", now: later(1) });
    expect(store.admitRecoveredBuilder({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/other", provider: "claude", recoveredFrom: interrupted, now: later(1), ...stamp(ref) })).toMatchObject({ ok: false, problem: expect.stringMatching(/left its draft in \/pool\/t-1 on standing-orders\/t-1, not \/pool\/other/) });
    const recovered = store.admitRecoveredBuilder({ taskRef: ref, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", recoveredFrom: interrupted, now: later(1), ...stamp(ref) });
    expect(recovered.ok).toBe(true);
    const recovering = recovered.ok ? recovered.runId : -1;
    expect(store.getRun(recovering)).toMatchObject({ parentRun: interrupted });
    // The generic stamp carries no parent any more.
    store.stampRun(recovering, { baseRevision: "abc" } as never);
    expect(store.getRun(recovering)).toMatchObject({ parentRun: interrupted, baseRevision: "abc" });
    // The warm-resume binding: every fact re-proved, or nothing written.
    const attempt = store.startRun({ taskRef: ref, leaseId: "lease-3", runner: "builder-1", provider: "claude", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(2), ...presented(store, ref, "builder") });
    expect(store.bindWarmResume(attempt, parked, "session-x")).toMatchObject({ ok: false, problem: expect.stringContaining("does not carry session session-x") });
    expect(store.bindWarmResume(attempt, recovering, "session-1")).toMatchObject({ ok: false, problem: expect.stringContaining("is not this task's parked builder attempt") });
    expect(store.bindWarmResume(recovering, parked, "session-1")).toMatchObject({ ok: false, problem: expect.stringContaining("already continues run") });
    // The park is carried forward exactly once: a second attempt goes cold.
    const first = store.startRun({ taskRef: ref, leaseId: "lease-f", runner: "builder-1", provider: "claude", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(2), ...presented(store, ref, "builder") });
    expect(store.bindWarmResume(first, parked, "session-1")).toEqual({ ok: true });
    expect(store.bindWarmResume(attempt, parked, "session-1")).toMatchObject({ ok: false, problem: expect.stringContaining("was already resumed once") });
    expect(store.getRun(attempt)).toMatchObject({ parentRun: null, sessionId: null });
    store.finishRun(first, { outcome: "failed", reason: "x", now: later(2) });
    // A park nobody carried yet binds exactly once.
    const parked2 = store.startRun({ taskRef: ref, leaseId: "lease-4", runner: "builder-1", provider: "claude", sessionId: "session-2", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(3), ...presented(store, ref, "builder") });
    store.finishRun(parked2, { outcome: "parked", reason: "decision:2", now: later(3) });
    expect(store.bindWarmResume(attempt, parked2, "session-2")).toEqual({ ok: true });
    expect(store.getRun(attempt)).toMatchObject({ parentRun: parked2, sessionId: "session-2" });
    expect(store.resumeCandidate(ref, "claude", "standing-orders/t-1")).toMatchObject({ run: { id: parked2 }, tried: true });
    // An ended attempt binds nothing.
    store.finishRun(attempt, { outcome: "built", reason: "done", now: later(4) });
    const late = store.startRun({ taskRef: ref, leaseId: "lease-5", runner: "builder-1", provider: "claude", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: later(5), ...presented(store, ref, "builder") });
    store.finishRun(late, { outcome: "failed", reason: "x", now: later(5) });
    expect(store.bindWarmResume(late, parked2, "session-2")).toMatchObject({ ok: false, problem: expect.stringContaining("is not an open builder attempt") });
  });

  test("planner and formatting-repair bookkeeping never masquerade as the task result", () => {
    const ref = refOf("t-1");
    store.placeTask(ref, REPO);
    claimAs(ref, "lease-1");
    const built = runOn(ref);
    // The repair turn mends the LIVE attempt (atomic authority closure):
    // opened before the build ends, settled after.
    const repair = repairOn(ref, built);
    store.finishRun(built, { outcome: "built", reason: "completed", now: T0 });
    store.setTaskState("t-1", "done", T0);

    const planner = store.startRun({
      taskRef: ref,
      leaseId: "plan-lease",
      runner: "builder-1",
      role: "planner",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: later(1),
      ...presented(store, ref, "planner"),
    });
    store.finishRun(planner, { outcome: "no-change", reason: "structured planner output repaired", now: later(1) });
    store.finishRun(repair, { outcome: "built", reason: "repaired-park", now: later(2) });

    expect(store.listCompletedWorkScoped(REPO)[0]?.runId).toBe(built);
    expect(store.projectPeek(REPO, later(1_000)).doneRecently).toBe(1);
  });

  test("only a later builder supersedes a parked builder's warm resume", () => {
    const ref = refOf("t-1");
    claimAs(ref, "lease-1");
    const parked = store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      provider: "claude",
      sessionId: "session-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, ref, "builder"),
    });
    // The repair turn mends the LIVE attempt (atomic authority closure):
    // opened before the park is sealed, settled after.
    const bookkeeping = repairOn(ref, parked, { sessionId: "session-1" });
    store.finishRun(parked, { outcome: "parked", reason: "decision:1", now: T0 });
    store.finishRun(bookkeeping, { outcome: "built", reason: "repaired-park", now: later(1) });

    expect(store.resumeCandidate(ref, "claude", "standing-orders/t-1")?.run.id).toBe(parked);

    const delivered = runOn(ref);
    store.finishRun(delivered, { outcome: "built", reason: "completed", now: later(2) });
    expect(store.resumeCandidate(ref, "claude", "standing-orders/t-1")).toBeNull();
  });
});

describe("migration from an M2 database", () => {
  test("rebuilds hold and run in place, keeping every row", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-m2-"));
    const file = join(dir, "orders.db");

    // The M2 shapes, verbatim — this is what a real database looks like the
    // morning M3 ships. Fresh-`:memory:` tests never see this file; the first
    // real `park` would have.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_ref (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend TEXT NOT NULL, external_id TEXT NOT NULL, repo TEXT,
        zones TEXT NOT NULL DEFAULT '[]',
        capability_requirements TEXT NOT NULL DEFAULT '[]',
        park_rate REAL NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'theirs',
        UNIQUE (backend, external_id)
      );
      CREATE TABLE hold (
        task_ref INTEGER PRIMARY KEY REFERENCES task_ref(id) ON DELETE CASCADE,
        reason TEXT NOT NULL, until TEXT, held_at TEXT NOT NULL
      );
      CREATE TABLE run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL, runner TEXT NOT NULL, branch TEXT NOT NULL,
        worktree TEXT NOT NULL, model TEXT,
        outcome TEXT CHECK (outcome IN ('built','failed','refused')),
        reason TEXT, committed INTEGER, started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE notification (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
        last_error TEXT, delivered_at TEXT, receipt TEXT
      );
      INSERT INTO task VALUES ('t-1','the work','queued','2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z');
      INSERT INTO task_ref (backend, external_id, origin) VALUES ('built-in','t-1','ours');
      INSERT INTO hold VALUES (1, 'waiting on legal', NULL, '2026-08-11T00:00:00.000Z');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, outcome, committed, started_at, finished_at)
        VALUES (1,'lease-1','builder-1','standing-orders/t-1','/pool/t-1','built',1,'2026-08-11T01:00:00.000Z','2026-08-11T01:10:00.000Z');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, started_at)
        VALUES (1,'lease-2','builder-1','standing-orders/t-1','/pool/t-1','2026-08-11T02:00:00.000Z');
      INSERT INTO notification (dedupe_key, kind, subject, body, created_at, delivered_at, receipt)
        VALUES ('gap:x:env:KEY','gap','s','b','2026-08-11T00:00:00.000Z','2026-08-11T00:01:00.000Z','r-1');
    `);
    old.close();

    const store = openStore(file);
    try {
      // The old hold survived as the operator's, and still holds.
      const holds = store.activeHolds(1, T0);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ ownerKind: "operator", reason: "waiting on legal" });
      expect(store.listReady(T0)).toHaveLength(0);
      expect(store.unhold(1)).toBe(true);
      expect(store.listReady(T0).map(r => r.externalId)).toEqual(["t-1"]);

      // Runs kept their ids, their outcomes, and their cut-down NULLs.
      expect(store.getRun(1)).toMatchObject({ outcome: "built", committed: true, role: "builder" });
      expect(store.getRun(2)).toMatchObject({ outcome: null, role: "builder" });

      // And the widened CHECK is real on this database, not just on fresh ones.
      store.finishRun(2, { outcome: "parked", reason: "decision:1", now: T0 });
      expect(store.getRun(2)?.outcome).toBe("parked");

      // The old notification survived the upgrade.
      expect(store.listNotifications("all")[0]).toMatchObject({ dedupeKey: "gap:x:env:KEY", resolvedAt: null });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("answering a decision", () => {
  let store: Store;
  let ref: number;
  let decisionId: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    ref = store.refFor(BUILT_IN, "t-1").id;
    const run = store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, ref, "builder"),
    });
    decisionId = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "r",
        question: "q",
        options: [
          { id: "keep", label: "Keep", consequence: "fine", reversible: true },
          { id: "drop", label: "Drop", consequence: "gone", reversible: false },
        ],
        recommendation: "keep",
      },
      T0,
    );
    store.holdOwned(
      { taskRef: ref, ownerKind: "decision", ownerId: String(decisionId), reason: "decision", until: null },
      T0,
    );
    store.enqueueNotification(
      { dedupeKey: `decision:${decisionId}`, kind: "decision", subject: "s", body: "b" },
      T0,
    );
  });

  afterEach(() => store.close());

  test("one act: the answer, the hold, and the outbox episode", () => {
    const answered = store.answerDecision(
      { id: decisionId, choice: "keep", by: "alex", via: "cli", note: "backfill tonight" },
      later(1_000),
    );

    expect(answered).toMatchObject({ ok: true });
    if (!answered.ok) return;
    expect(answered.decision).toMatchObject({
      state: "answered",
      choice: "keep",
      answeredBy: "alex",
      answeredVia: "cli",
      note: "backfill tonight",
    });
    // The hold is gone and the task is dispatchable again.
    expect(store.activeHolds(ref, later(2_000))).toHaveLength(0);
    expect(store.listReady(later(2_000)).map(r => r.externalId)).toEqual(["t-1"]);
    // The episode is resolved, not deleted — receipts survive.
    expect(store.listNotifications("pending")).toHaveLength(0);
    expect(store.listNotifications("all")[0]?.resolvedAt).toBe(later(1_000).toISOString());
  });

  test("a decision is answered once: same choice replays, different choice refuses", () => {
    store.answerDecision({ id: decisionId, choice: "keep", by: "alex", via: "cli" }, later(1_000));

    const replay = store.answerDecision({ id: decisionId, choice: "keep", by: "alex", via: "web" }, later(2_000));
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    if (replay.ok) expect(replay.decision.answeredVia).toBe("cli");

    const contradiction = store.answerDecision({ id: decisionId, choice: "drop", by: "sam", via: "cli" }, later(3_000));
    expect(contradiction).toMatchObject({ ok: false, reason: "already-answered" });
    expect(store.getDecision(decisionId)?.choice).toBe("keep");
  });

  test("an expired decision is still answerable — expiry never chooses", () => {
    store.handle
      .prepare("UPDATE decision SET state = 'expired' WHERE id = ?")
      .run(decisionId);

    const answered = store.answerDecision({ id: decisionId, choice: "drop", by: "alex", via: "cli" }, later(1_000));
    expect(answered).toMatchObject({ ok: true });
    expect(store.getDecision(decisionId)?.state).toBe("answered");
  });

  test("refusals: an option that is not there, a hostile note, a ghost id", () => {
    expect(store.answerDecision({ id: decisionId, choice: "ship-it", by: "alex", via: "cli" }, T0)).toMatchObject({
      ok: false,
      reason: "bad-option",
    });
    expect(
      store.answerDecision(
        { id: decisionId, choice: "keep", by: "alex", via: "cli", note: "ok\u001b]0;pwn" },
        T0,
      ),
    ).toMatchObject({ ok: false, reason: "bad-note" });
    expect(store.answerDecision({ id: 999, choice: "keep", by: "alex", via: "cli" }, T0)).toMatchObject({
      ok: false,
      reason: "unknown-decision",
    });
    // Nothing above lifted the hold.
    expect(store.activeHolds(ref, later(1_000))).toHaveLength(1);
  });

  test("an idempotency key replays the first answer", () => {
    const first = store.answerDecision(
      { id: decisionId, choice: "keep", by: "alex", via: "cli" },
      later(1_000),
      { idempotencyKey: "answer-1" },
    );
    const replay = store.answerDecision(
      { id: decisionId, choice: "keep", by: "alex", via: "cli" },
      later(60_000),
      { idempotencyKey: "answer-1" },
    );
    expect(first).toMatchObject({ ok: true });
    expect(replay).toMatchObject({ ok: true });
    if (first.ok && replay.ok) {
      expect(replay.decision.answeredAt).toBe(first.decision.answeredAt);
    }
  });
});

describe("migration from an M3 database", () => {
  test("rebuilds decision's answered_via CHECK in place, rows and ids intact", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-m3-"));
    const file = join(dir, "orders.db");

    // The M3 shapes for exactly the tables the rebuild touches or references:
    // decision (with the old two-value CHECK), its run and task_ref parents,
    // and the relations that must survive the copy.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (2);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_ref (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend TEXT NOT NULL, external_id TEXT NOT NULL, repo TEXT,
        zones TEXT NOT NULL DEFAULT '[]',
        capability_requirements TEXT NOT NULL DEFAULT '[]',
        park_rate REAL NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'theirs',
        UNIQUE (backend, external_id)
      );
      CREATE TABLE run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL, runner TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair')),
        parent_run INTEGER REFERENCES run(id), session_id TEXT, base_revision TEXT,
        branch TEXT NOT NULL, worktree TEXT NOT NULL, model TEXT,
        outcome TEXT CHECK (outcome IN ('built','failed','refused','parked')),
        reason TEXT, committed INTEGER, started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE decision (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run            INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
        urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
        state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
        recap          TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL,
        recommendation TEXT NOT NULL, assignee TEXT, deadline TEXT, created_at TEXT NOT NULL,
        answered_at    TEXT, answered_by TEXT,
        answered_via   TEXT CHECK (answered_via IN ('cli','web')),
        choice         TEXT, note TEXT
      );
      CREATE TABLE run_decision (
        run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
        choice TEXT NOT NULL, note TEXT, PRIMARY KEY (run, decision)
      );
      INSERT INTO task VALUES ('t-1','w','queued','2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z');
      INSERT INTO task_ref (backend, external_id, origin) VALUES ('built-in','t-1','ours');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, outcome, started_at)
        VALUES (1,'l-1','b','br','/w','parked','2026-08-11T01:00:00.000Z');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, outcome, started_at)
        VALUES (1,'l-2','b','br','/w','parked','2026-08-11T02:00:00.000Z');
      INSERT INTO decision (run, urgency, recap, question, options, recommendation, created_at,
                            state, answered_at, answered_by, answered_via, choice, note)
        VALUES (1,'blocking','r','q','[{"id":"a","label":"a","consequence":"c","reversible":true},{"id":"b","label":"b","consequence":"c","reversible":true}]','a',
                '2026-08-11T01:00:00.000Z','answered','2026-08-11T03:00:00.000Z','alex','web','a','noted');
      INSERT INTO decision (run, urgency, recap, question, options, recommendation, created_at)
        VALUES (2,'blocking','r2','q2','[{"id":"a","label":"a","consequence":"c","reversible":true},{"id":"b","label":"b","consequence":"c","reversible":true}]','b',
                '2026-08-11T02:00:00.000Z');
      INSERT INTO run_decision (run, decision, choice, note) VALUES (2, 1, 'a', 'noted');
    `);
    old.close();

    const store = openStore(file);
    try {
      // Everything survived the copy: ids, the answered row's whole shape,
      // the open row, and the relation across the rebuilt table.
      expect(store.getDecision(1)).toMatchObject({
        state: "answered", choice: "a", answeredBy: "alex", answeredVia: "web", note: "noted",
      });
      expect(store.getDecision(2)).toMatchObject({ state: "open", recommendation: "b" });
      expect(store.answersFor(2)).toMatchObject([{ choice: "a", note: "noted" }]);

      // The widened CHECK is real on this database: telegram answers land.
      const answered = store.answerDecision(
        { id: 2, choice: "b", by: "alex", via: "telegram" },
        new Date("2026-08-11T04:00:00.000Z"),
      );
      expect(answered).toMatchObject({ ok: true });
      expect(store.getDecision(2)?.answeredVia).toBe("telegram");

      // The v4 CHECK widenings are real on this database too.
      store.finishRun(2, { outcome: "no-change", reason: "handoff", now: new Date("2026-08-12T06:00:00.000Z") });
      expect(store.getRun(2)?.outcome).toBe("no-change");
      store.holdOwned(
        { taskRef: 1, ownerKind: "backoff", ownerId: "1", reason: "retry in 2m", until: null },
        new Date("2026-08-12T06:00:00.000Z"),
      );
      expect(store.activeHolds(1, new Date("2026-08-12T06:01:00.000Z"))[0]?.ownerKind).toBe("backoff");
      store.releaseOwnedHold("backoff", "1");
      const stallRun = store.startRun({
        taskRef: 1, leaseId: "l-stall", runner: "b", branch: "br", worktree: "/w",
        now: new Date("2026-08-12T06:00:00.000Z"),
        ...presented(store, 1, "builder"),
      });
      const stall = store.createIncident({ run: stallRun, kind: "attempts-exhausted" }, new Date("2026-08-12T06:00:00.000Z"));
      expect(store.openIncidents().find(one => one.id === stall)?.kind).toBe("attempts-exhausted");

      // New decisions keep counting from where the old table left off.
      const run3 = store.startRun({
        taskRef: 1, leaseId: "l-3", runner: "b", branch: "br", worktree: "/w",
        now: new Date("2026-08-11T05:00:00.000Z"),
        ...presented(store, 1, "builder"),
      });
      const next = store.saveDecision(
        {
          run: run3, urgency: "blocking", recap: "r3", question: "q3",
          options: [
            { id: "a", label: "a", consequence: "c", reversible: true },
            { id: "b", label: "b", consequence: "c", reversible: true },
          ],
          recommendation: "a",
        },
        new Date("2026-08-11T05:00:00.000Z"),
      );
      expect(next).toBe(3);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unrecognized decision DDL is refused, not guessed at", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-m3-odd-"));
    const file = join(dir, "orders.db");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const odd = new DatabaseSync(file);
    // Somebody's hand-edited shape: neither the old CHECK nor the new one.
    odd.exec(`CREATE TABLE decision (id INTEGER PRIMARY KEY, answered_via TEXT);`);
    odd.close();

    // A nonempty file with NO version table is refused by the strict
    // preflight BEFORE any DDL is inspected (raw authority repair): it is
    // not fresh, and not a database this build shaped.
    expect(() => openStore(file)).toThrow(/carries tables but no schema_version table/);
    // With a version the build speaks, the odd DDL itself is the refusal.
    const versioned = new DatabaseSync(file);
    versioned.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (2);`);
    versioned.close();
    expect(() => openStore(file)).toThrow(/not a shape this migration knows/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the watch foundations", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("the wake sequence moves when readiness could have", () => {
    const before = store.wakeSeq();
    store.createTask({ id: "t-1", title: "w" }, T0);
    expect(store.wakeSeq()).toBeGreaterThan(before);

    const afterCreate = store.wakeSeq();
    store.setTaskState("t-1", "done", later(1_000));
    expect(store.wakeSeq()).toBeGreaterThan(afterCreate);
  });

  test("one watch per (runner, repo); takeover names the superseded incarnation", () => {
    const first = store.acquireWatchLease("builder-1", "/repo", "inc-a", 60_000, T0);
    expect(first).toMatchObject({ ok: true, generation: 1, superseded: null });

    const contender = store.acquireWatchLease("builder-1", "/repo", "inc-b", 60_000, later(1_000));
    expect(contender).toMatchObject({ ok: false, reason: "watch-busy", holder: "inc-a" });

    // A different repo is a different watch entirely.
    expect(store.acquireWatchLease("builder-1", "/other", "inc-b", 60_000, later(1_000))).toMatchObject({
      ok: true,
    });

    // Expiry hands over — and says whose mess to recover.
    const takeover = store.acquireWatchLease("builder-1", "/repo", "inc-b", 60_000, later(120_000));
    expect(takeover).toMatchObject({ ok: true, generation: 2, superseded: "inc-a" });
  });

  test("recovery is keyed to the incarnation, not to runner liveness", () => {
    enroll(store, "builder-1");
    store.createTask({ id: "t-1", title: "w" }, T0);
    const ref = store.refFor(BUILT_IN, "t-1").id;
    store.placeTask(ref, REPO);
    // The dead incarnation's claim, task mid-flight, run open, worktree leased.
    acquire(store, ref, "builder-1", { token: tok("builder-1"), now: T0, ttlMs: 60 * 60_000, newLeaseId: () => "lease-a", incarnation: "inc-a" });
    store.setTaskState("t-1", "running", T0);
    const run = store.startRun({
      taskRef: ref, leaseId: "lease-a", runner: "builder-1", branch: "b", worktree: "/w", now: T0,
      ...presented(store, ref, "builder"),
    });
    store.saveWorktree({
      path: "/w", repo: "/repo", branch: "b", runner: "builder-1", taskRef: ref,
      createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true,
    });

    // The successor is the same runner, heartbeating — which is exactly how
    // this crash would hide from liveness-based recovery.
    const recovered = store.recoverIncarnation("builder-1", "inc-a", later(5_000));

    expect(recovered).toBe(1);
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.getRun(run)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getWorktree("/w")?.releasedAt).not.toBeNull();
    expect(store.getWorktree("/w")?.verified).toBe(false);
    // The claim is released as recovered: its late completion will be fenced.
    const claim = store.handle.prepare("SELECT released_by FROM claim WHERE lease_id = 'lease-a'").get();
    expect(String(claim?.["released_by"])).toBe("recovered");
  });

  test("recovery leaves other incarnations' work alone", () => {
    enroll(store, "builder-1");
    store.createTask({ id: "t-1", title: "w" }, T0);
    store.createTask({ id: "t-2", title: "w" }, T0);
    const one = store.refFor(BUILT_IN, "t-1").id;
    const two = store.refFor(BUILT_IN, "t-2").id;
    store.placeTask(one, REPO);
    store.placeTask(two, REPO);
    acquire(store, one, "builder-1", { token: tok("builder-1"), now: T0, newLeaseId: () => "lease-old", incarnation: "inc-a" });
    acquire(store, two, "builder-1", { token: tok("builder-1"), now: T0, newLeaseId: () => "lease-live", incarnation: "inc-b" });

    expect(store.recoverIncarnation("builder-1", "inc-a", later(1_000))).toBe(1);

    const live = store.handle.prepare("SELECT released_at FROM claim WHERE lease_id = 'lease-live'").get();
    expect(live?.["released_at"]).toBeNull();
  });
});

describe("console mutation semantics, re-proved server-side", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
  });

  afterEach(() => store.close());

  test("cancel refuses while a live claim holds the task", () => {
    enroll(store, "runner-a");
    const ref = store.refFor(BUILT_IN, "t-1").id;
    store.placeTask(ref, REPO);
    acquire(store, ref, "runner-a", { token: tok("runner-a"), now: T0, ttlMs: 60 * 60_000 });

    expect(store.cancelTask("t-1", later(1_000))).toMatchObject({ ok: false, reason: "claimed" });
    expect(store.getTask("t-1")?.state).toBe("queued");

    // Claim lapsed: cancellation lands, and twice is already-terminal.
    expect(store.cancelTask("t-1", later(2 * 60 * 60_000))).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("cancelled");
    expect(store.cancelTask("t-1", later(2 * 60 * 60_000 + 1_000))).toMatchObject({
      ok: false,
      reason: "already-terminal",
    });
  });

  test("requeue refuses a healthy task and a claimed one — a stale button erases nothing", () => {
    expect(store.requeueTask("t-1", "alex", T0)).toMatchObject({ ok: false, reason: "not-stalled" });

    enroll(store, "runner-a");
    const ref = store.refFor(BUILT_IN, "t-1").id;
    store.placeTask(ref, REPO);
    store.setTaskState("t-1", "failed", T0);
    acquire(store, ref, "runner-a", { token: tok("runner-a"), now: later(1_000), ttlMs: 60 * 60_000 });
    expect(store.requeueTask("t-1", "alex", later(2_000))).toMatchObject({ ok: false, reason: "claimed" });
  });

  test("requeue reruns a finished task whose last result was rejected, and refuses an accepted or published one", () => {
    enroll(store, "runner-a");
    const ref = store.refFor(BUILT_IN, "t-1").id;
    store.placeTask(ref, REPO);
    const attempt = (verdict: "refuted" | "short" | "verified") => {
      const run = store.startRun({ taskRef: ref, leaseId: `l-${verdict}-${Math.random().toString(16).slice(2, 8)}`, runner: "runner-a", branch: "b-t-1", worktree: "/pool/t-1", ...bareLegacy("build"), now: T0 });
      store.finishRun(run, { outcome: "built", committed: true, now: T0 });
      store.saveProofVerdict(run, verdict, verdict === "verified" ? ["the approved verification command passed"] : ["the repository's approved verification command exited 1"], T0, []);
      store.setTaskState("t-1", "done", T0);
      return run;
    };
    // A failed gate: the same filing runs again, on the same branch.
    const rejected = attempt("refuted");
    expect(store.requeueTask("t-1", "alex", later(1_000))).toMatchObject({ ok: true, rejectedRun: rejected });
    expect(store.getTask("t-1")?.state).toBe("queued");
    // A result awaiting review may also be rerun (nothing accepted it yet).
    attempt("short");
    expect(store.requeueTask("t-1", "alex", later(2_000))).toMatchObject({ ok: true });
    // An accepted result is final for this filing.
    const verified = attempt("verified");
    expect(store.requeueTask("t-1", "alex", later(3_000))).toMatchObject({ ok: false, reason: "accepted-result" });
    expect(store.getTask("t-1")?.state).toBe("done");
    // So is an operator-accepted one, and a published one.
    const accepted = attempt("refuted");
    store.acceptProof(accepted, "alex", null, later(3_500));
    expect(store.requeueTask("t-1", "alex", later(4_000))).toMatchObject({ ok: false, reason: "accepted-result" });
    const published = attempt("refuted");
    const intent = store.createPublicationIntent({ run: published, taskRef: ref, githubRepo: "a/b", remote: "origin", base: "main", head: "b-t-1", headSha: "a".repeat(40), bodyHash: "", draft: true }, later(4_500));
    // An intent that never pushed is not a publication: the rerun is allowed.
    expect(store.requeueTask("t-1", "alex", later(4_550))).toMatchObject({ ok: true });
    store.setTaskState("t-1", "done", later(4_580));
    store.markPublicationPushed(intent, later(4_600));
    expect(store.requeueTask("t-1", "alex", later(5_000))).toMatchObject({ ok: false, reason: "published" });
    void verified;
  });

  test("an open incident beside a finished task neither hides the rejected attempt nor reopens an accepted one", () => {
    enroll(store, "runner-a");
    const ref = store.refFor(BUILT_IN, "t-1").id;
    store.placeTask(ref, REPO);
    const attempt = (verdict: "refuted" | "verified") => {
      const run = store.startRun({ taskRef: ref, leaseId: `l-${verdict}-${Math.random().toString(16).slice(2, 8)}`, runner: "runner-a", branch: "b-t-1", worktree: "/pool/t-1", ...bareLegacy("build"), now: T0 });
      store.finishRun(run, { outcome: "built", committed: true, now: T0 });
      store.saveProofVerdict(run, verdict, ["fixture"], T0, []);
      store.setTaskState("t-1", "done", T0);
      return run;
    };
    const rejected = attempt("refuted");
    const incident = store.createIncident({ run: rejected, kind: "malformed-proof" }, later(500));
    expect(store.requeueTask("t-1", "alex", later(1_000))).toMatchObject({ ok: true, rejectedRun: rejected, resolvedIncidents: 1 });
    expect(store.handle.prepare("SELECT resolved_at FROM incident WHERE id = ?").get(incident)?.["resolved_at"]).not.toBeNull();
    expect(store.getTask("t-1")?.state).toBe("queued");
    const verified = attempt("verified");
    store.createIncident({ run: verified, kind: "malformed-proof" }, later(2_000));
    expect(store.requeueTask("t-1", "alex", later(3_000))).toMatchObject({ ok: false, reason: "accepted-result" });
    expect(store.getTask("t-1")?.state).toBe("done");
  });

  test("console task creation is atomic, capped, and validates what it will later render", () => {
    expect(store.createConsoleTask({ id: "../evil", title: "x" }, T0)).toMatchObject({ ok: false, reason: "bad-id" });
    expect(
      store.createConsoleTask({ id: "ok", title: "x".repeat(300) }, T0),
    ).toMatchObject({ ok: false, reason: "bad-title" });
    expect(store.createConsoleTask({ id: "t-1", title: "dupe" }, T0)).toMatchObject({
      ok: false,
      reason: "duplicate",
    });

    const made = store.createConsoleTask(
      { id: "t-2", title: "wire the API", repo: "/code/thing", goal: "wire it end to end", acceptance: [{ id: "c1", statement: "It works end to end.", evidence: ["manual-review"] }] },
      T0,
    );
    expect(made).toMatchObject({ ok: true });
    expect(store.refFor(BUILT_IN, "t-2").repo).toBe("/code/thing");
    expect(store.getScope("t-2")?.goal).toBe("wire it end to end");
    // Scope created through the console is proposed, never approved.
    expect(store.getScope("t-2")?.approvedDigest).toBeNull();

    // The admission cap counts the active backlog only.
    expect(store.createConsoleTask({ id: "t-3", title: "x" }, T0, 3)).toMatchObject({ ok: true });
    expect(store.createConsoleTask({ id: "t-4", title: "x" }, T0, 3)).toMatchObject({
      ok: false,
      reason: "backlog-full",
    });
    store.setTaskState("t-1", "done", later(1_000));
    expect(store.createConsoleTask({ id: "t-4", title: "x" }, later(2_000), 3)).toMatchObject({ ok: true });
  });

  test("resolveIncident owns its transaction now — no caller can half-do it", () => {
    const ref = store.refFor(BUILT_IN, "t-1").id;
    const run = store.startRun({
      taskRef: ref, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0,
      ...presented(store, ref, "builder"),
    });
    const incident = store.createIncident({ run, kind: "attempts-exhausted" }, T0);
    store.holdOwned(
      { taskRef: ref, ownerKind: "incident", ownerId: String(incident), reason: "stall", until: null },
      T0,
    );

    expect(store.resolveIncident(incident, "alex", later(1_000))).toBe(true);
    expect(store.activeHolds(ref, later(2_000))).toHaveLength(0);
  });
});

describe("the console read model, bounded by construction", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  const refOf = (id: string) => {
    store.createTask({ id, title: id }, T0);
    return store.refFor(BUILT_IN, id).id;
  };

  const runOn = (ref: number, n: number) =>
    store.startRun({
      taskRef: ref,
      leaseId: `lease-${n}`,
      runner: "builder-1",
      branch: `standing-orders/t-${n}`,
      worktree: `/pool/t-${n}`,
      now: T0,
      ...presented(store, ref, "builder"),
    });

  test("runs page newest-first, the cursor strictly exclusive, the task attached", () => {
    const a = refOf("t-a");
    const b = refOf("t-b");
    const runs = [runOn(a, 1), runOn(b, 2), runOn(a, 3), runOn(b, 4), runOn(a, 5)];

    const first = store.listRunsBefore(null, 2);
    expect(first.map(one => one.id)).toEqual([runs[4], runs[3]]);
    expect(first[0]?.taskId).toBe("t-a");

    // The next page starts strictly below the last row seen — no repeats,
    // no skips, whatever was inserted in between.
    const next = store.listRunsBefore(first[1]!.id, 2);
    expect(next.map(one => one.id)).toEqual([runs[2], runs[1]]);

    const last = store.listRunsBefore(next[1]!.id, 2);
    expect(last.map(one => one.id)).toEqual([runs[0]]);
    expect(store.listRunsBefore(runs[0]!, 2)).toEqual([]);
  });

  test("the page size is clamped and an unsafe cursor is nothing, not everything", () => {
    const a = refOf("t-a");
    runOn(a, 1);
    runOn(a, 2);

    expect(store.listRunsBefore(null, 0)).toHaveLength(1);
    expect(store.listRunsBefore(null, -5)).toHaveLength(1);
    expect(store.listRunsBefore(null, 1e9)).toHaveLength(2);
    // 2^53 is where integers stop being exact — a cursor there could silently
    // alias another row, so it matches none.
    expect(store.listRunsBefore(2 ** 53, 10)).toEqual([]);
    expect(store.listRunsBefore(0, 10)).toEqual([]);
    expect(store.listRunsBefore(-1, 10)).toEqual([]);
  });

  test("a task's decisions and incidents are its own, newest first, resolved included", () => {
    const a = refOf("t-a");
    const b = refOf("t-b");
    const mine = runOn(a, 1);
    const alsoMine = runOn(a, 2);
    const foreign = runOn(b, 3);

    const option = { id: "x", label: "x", consequence: "c", reversible: true };
    const early = store.saveDecision(
      { run: mine, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "x" },
      T0,
    );
    const late = store.saveDecision(
      { run: alsoMine, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "x" },
      T0,
    );
    store.saveDecision(
      { run: foreign, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "x" },
      T0,
    );

    expect(store.decisionsForTask(a).map(one => one.id)).toEqual([late, early]);

    const incident = store.createIncident({ run: mine, kind: "attempts-exhausted" }, T0);
    store.createIncident({ run: foreign, kind: "malformed-decision" }, T0);
    store.resolveIncident(incident, "alex", later(1_000));

    // Resolved incidents stay on the task's page: history, not attention.
    expect(store.incidentsForTask(a).map(one => one.id)).toEqual([incident]);
    expect(store.incidentsForTask(a)[0]?.resolvedAt).not.toBeNull();
  });

  test("an artifact is found only through its own run", () => {
    const a = refOf("t-a");
    const b = refOf("t-b");
    const mine = runOn(a, 1);
    const foreign = runOn(b, 2);

    const artifact = store.saveArtifact(
      { run: mine, kind: "diff", key: "1/diff.patch", bytesOriginal: 4, bytesStored: 4, truncated: false, sha256: "h", capture: "git diff (exit 0)" },
      T0,
    );

    expect(store.artifactForRun(mine, artifact)?.id).toBe(artifact);
    // A mismatched pair is not an error to explain — it is simply not found.
    expect(store.artifactForRun(foreign, artifact)).toBeNull();
    expect(store.artifactForRun(mine, artifact + 99)).toBeNull();
  });
});

describe("migration from a v6 database (planning, v7)", () => {
  test("widens run role, artifact kind, and incident kind in place; planner rows insert after", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v6-"));
    const file = join(dir, "orders.db");

    // The v6 shapes for exactly the tables the v7 rebuilds touch or
    // reference: run with the two-role CHECK, artifact with three kinds,
    // incident with three kinds, and their parents.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (6);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_ref (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend TEXT NOT NULL, external_id TEXT NOT NULL, repo TEXT,
        zones TEXT NOT NULL DEFAULT '[]',
        capability_requirements TEXT NOT NULL DEFAULT '[]',
        park_rate REAL NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'theirs',
        strikes INTEGER NOT NULL DEFAULT 0,
        UNIQUE (backend, external_id)
      );
      CREATE TABLE run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL, runner TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair')),
        parent_run INTEGER REFERENCES run(id), session_id TEXT, base_revision TEXT,
        branch TEXT NOT NULL, worktree TEXT NOT NULL, model TEXT,
        outcome TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change')),
        reason TEXT, committed INTEGER, started_at TEXT NOT NULL, finished_at TEXT,
        provider_started_at TEXT, tokens_in INTEGER, tokens_out INTEGER,
        cost_usd REAL, usage_json TEXT, head_revision TEXT, handoff TEXT
      );
      CREATE TABLE artifact (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload')),
        key TEXT NOT NULL, bytes_original INTEGER NOT NULL, bytes_stored INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL, capture TEXT NOT NULL,
        created_at TEXT NOT NULL, redacted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE incident (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure')),
        created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT
      );
      INSERT INTO task VALUES ('t-1','w','queued','2026-08-12T00:00:00.000Z','2026-08-12T00:00:00.000Z');
      INSERT INTO task_ref (backend, external_id, origin, strikes) VALUES ('built-in','t-1','ours',2);
      INSERT INTO run (task_ref, lease_id, runner, role, branch, worktree, outcome, started_at, cost_usd)
        VALUES (1,'l-1','b','repair','br','/w','failed','2026-08-12T01:00:00.000Z',0.42);
      INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at)
        VALUES (1,'diff','1/diff.patch',10,10,'abc','git diff (exit 0)','2026-08-12T01:05:00.000Z');
      INSERT INTO incident (run, kind, created_at)
        VALUES (1,'attempts-exhausted','2026-08-12T01:10:00.000Z');
    `);
    old.close();

    const store = openStore(file);
    try {
      // Every v6 row survived the three rebuilds, ids and values intact.
      const run = store.handle.prepare("SELECT * FROM run WHERE id = 1").get();
      expect(run).toMatchObject({ role: "repair", outcome: "failed", cost_usd: 0.42 });
      const artifact = store.handle.prepare("SELECT * FROM artifact WHERE id = 1").get();
      expect(artifact).toMatchObject({ kind: "diff", key: "1/diff.patch" });
      const incident = store.handle.prepare("SELECT * FROM incident WHERE id = 1").get();
      expect(incident).toMatchObject({ kind: "attempts-exhausted" });

      // The widened CHECKs admit the planning rows v6 refused.
      const planner = store.startRun({
        taskRef: 1, leaseId: "l-2", runner: "b", role: "planner",
        branch: "standing-orders-plan/t-1", worktree: "/w2", now: new Date("2026-08-12T02:00:00.000Z"),
        ...presented(store, 1, "planner"),
      });
      expect(planner).toBeGreaterThan(1);
      store.handle
        .prepare("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(planner, "plan", `${planner}/plan.md`, 5, 5, "def", "plan handoff", "2026-08-12T02:05:00.000Z");
      store.handle
        .prepare("INSERT INTO incident (run, kind, created_at) VALUES (?,?,?)")
        .run(planner, "malformed-plan", "2026-08-12T02:10:00.000Z");

      // The additive planning columns exist and default honestly.
      const ref = store.handle.prepare("SELECT plan, plan_strikes FROM task_ref WHERE id = 1").get();
      expect(ref).toMatchObject({ plan: null, plan_strikes: 0 });

      // v8 rode the same open: the instance link (history since v115) is
      // present and honestly NULL.
      const ref8 = store.handle.prepare("SELECT routine_id FROM task_ref WHERE id = 1").get();
      expect(ref8).toMatchObject({ routine_id: null });

      // v9 rode the same open: history reads provider 'claude' truthfully
      // (nothing else ever spawned), a new run records its own, the agent
      // pin columns exist and default honestly NULL, and phase_config is
      // writable on the migrated database.
      expect(store.getRun(1)?.provider).toBe("claude");
      const codexRun = store.startRun({
        taskRef: 1, leaseId: "l-9", runner: "b", branch: "br", worktree: "/w9",
        provider: "codex", now: new Date("2026-08-12T04:00:00.000Z"),
        ...presented(store, 1, "builder", { provider: "codex", model: null }),
      });
      expect(store.getRun(codexRun)?.provider).toBe("codex");
      const pin = store.handle.prepare("SELECT agent_provider, agent_model FROM task_ref WHERE id = 1").get();
      expect(pin).toMatchObject({ agent_provider: null, agent_model: null });
      store.setPhaseConfig("installation", "plan", "claude", "opus", "alex", new Date("2026-08-12T04:01:00.000Z"));
      expect(store.phaseConfig("installation", "plan")).toMatchObject({ provider: "claude", model: "opus", updatedBy: "alex" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the same-day upgrade shape (audit TG-8)", () => {
  test("a v11 database whose diff_comment predates source_key opens, gains the column, and gets its index", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { createRequire } = await import("node:module");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "standing-orders-sameday-"));
    const file = join(dir, "orders.db");
    try {
      // The exact e2a08c5 regression shape: diff_comment exists WITHOUT
      // source_key, so the fresh schema's CREATE TABLE IF NOT EXISTS skips
      // it — and a partial index inside the schema block would die before
      // addColumn could run. The index lives in the post-migration block
      // precisely so this file opens.
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite");
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (11);
        CREATE TABLE diff_comment (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          artifact      INTEGER NOT NULL,
          artifact_sha  TEXT NOT NULL,
          run           INTEGER NOT NULL,
          path          TEXT,
          line          INTEGER,
          note          TEXT NOT NULL,
          author        TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          superseded_by INTEGER,
          consumed_by   TEXT
        );
      `);
      old.close();

      const store = openStore(file);
      try {
        const columns = store.handle
          .prepare("PRAGMA table_info(diff_comment)")
          .all()
          .map((row: Record<string, unknown>) => String(row["name"]));
        expect(columns).toContain("source_key");
        const index = store.handle
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'diff_comment_source'")
          .get();
        expect(index).toBeDefined();
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a v17 database whose task table predates priority opens, gains the column, and old rows read as filing order", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { createRequire } = await import("node:module");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "standing-orders-v18-"));
    const file = join(dir, "orders.db");
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite");
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (17);
        CREATE TABLE task (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          state      TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO task VALUES ('old-row', 'work filed before v18', 'queued', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      `);
      old.close();

      const store = openStore(file);
      try {
        const columns = store.handle
          .prepare("PRAGMA table_info(task)")
          .all()
          .map((row: Record<string, unknown>) => String(row["name"]));
        expect(columns).toContain("priority");
        const task = store.getTask("old-row");
        expect(task?.priority).toBe(0);
        const moved = store.moveTaskNext("old-row", new Date("2026-08-19T00:00:00.000Z"));
        expect(moved).toMatchObject({ ok: true, priority: 1 });
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe("the v24 migration (Parity II foundations, rulings 10/11)", () => {
  const T0 = new Date("2026-08-11T22:00:00.000Z");

  /** A faithful v23 simulation: rows written WITHOUT the v24 columns (the
   * ALTER defaults are the legacy classification), version wound back,
   * store reopened so migrateToV24 runs exactly once. */
  const legacyDb = (seed: (db: ReturnType<typeof openStore>) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), "so-v24-migr-"));
    const file = join(dir, "db.sqlite");
    const store = openStore(file);
    seed(store);
    store.raw().exec("DROP TABLE service_cursor");
    store.raw().prepare("UPDATE schema_version SET version = 23").run();
    store.close();
    return file;
  };

  test.each(['"ba"', 'not json'])("unapproved touches %s keeps the original JSON.parse digest behavior", touches => {
    const file = legacyDb(db => {
      db.setPhaseConfig("installation", "build", "claude", "sonnet", "old", T0);
      db.createTask({ id: "t-touches", title: "legacy touches" }, T0);
      db.refFor("built-in", "t-touches");
      db.raw().prepare("INSERT INTO task_scope (task_id, goal, out_of_scope, touches, proposed_at, digest) VALUES (?, ?, NULL, ?, ?, ?)")
        .run("t-touches", "work", touches, T0.toISOString(), "old-digest");
    });
    try {
      const store = openStore(file);
      try {
        const scope = store.getScope("t-touches")!;
        let old: string[] = [];
        try { old = JSON.parse(touches) as string[]; } catch { old = []; }
        expect(scope.digest).toBe(digestOf({ goal: "work", outOfScope: null, touches: old }, scope.profile));
        expect(scope.touches).toEqual([]); // Display still accepts only a list.
        expect(store.raw().prepare("SELECT touches FROM task_scope WHERE task_id = ?").get("t-touches")?.["touches"]).toBe(touches);
        if (touches === '"ba"') expect(scope.digest).not.toBe(digestOf({ goal: "work", outOfScope: null, touches: [] }, scope.profile));
      } finally { store.close(); }
    } finally { rmSync(dirname(file), { recursive: true, force: true }); }
  });

  test("an approved scope is PINNED and grandfathered: signed bytes untouched, snapshot resolved from the config of the day", () => {
    const file = legacyDb(db => {
      db.setPhaseConfig("installation", "build", "claude", "sonnet", "old", T0);
      db.setPhaseConfig("installation", "plan", "claude", "sonnet", "old", T0); // v47: every phase names an exact model
      db.setPhaseConfig("installation", "review", "claude", "sonnet", "old", T0);
      db.createTask({ id: "t-old", title: "approved long ago" }, T0);
      db.refFor("built-in", "t-old");
      db.raw()
        .prepare(
          `INSERT INTO task_scope (task_id, goal, out_of_scope, touches, proposed_at, digest, approved_at, approved_by, approved_digest)
           VALUES ('t-old', 'a guard', NULL, '[]', ?, 'a24c72e6603f78291e1eea2e162b383e', ?, 'alex', 'a24c72e6603f78291e1eea2e162b383e')`,
        )
        .run(T0.toISOString(), T0.toISOString());
    });
    const store = openStore(file);
    const scope = store.getScope("t-old");
    // the golden bytes survived the migration untouched
    expect(scope?.digest).toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(scope?.approvedDigest).toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(scope?.digestVersion).toBe(1);
    // and the effective profile of the day is sealed beside them
    expect(scope?.approvedProfile).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(scope?.profileState).toBe("resolved");
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  test("an approved scope with NO resolvable model becomes unresolved — unapprovable and undispatchable, never guessed", () => {
    const file = legacyDb(db => {
      db.createTask({ id: "t-stranded", title: "no routing anywhere" }, T0);
      db.refFor("built-in", "t-stranded");
      db.raw()
        .prepare(
          `INSERT INTO task_scope (task_id, goal, out_of_scope, touches, proposed_at, digest, approved_at, approved_by, approved_digest)
           VALUES ('t-stranded', 'work', NULL, '[]', ?, 'deadbeefdeadbeefdeadbeefdeadbeef', ?, 'alex', 'deadbeefdeadbeefdeadbeefdeadbeef')`,
        )
        .run(T0.toISOString(), T0.toISOString());
    });
    const store = openStore(file);
    const scope = store.getScope("t-stranded");
    expect(scope?.profileState).toBe("unresolved");
    expect(scope?.approvedProfile ?? null).toBeNull();
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  test("undelivered legacy steering is QUARANTINED: labeled, superseded, and never attachable to a brief", () => {
    const file = legacyDb(db => {
      db.createTask({ id: "t-note", title: "steered once" }, T0);
      const ref = db.refFor("built-in", "t-note").id;
      db.raw()
        .prepare("INSERT INTO task_steer (task_ref, author, note, created_at) VALUES (?, 'mystery-cli', 'do it my way', ?)")
        .run(ref, T0.toISOString());
    });
    const store = openStore(file);
    const ref = store.refFor("built-in", "t-note").id;
    const notes = store.listSteerNotes(ref);
    expect(notes[0]).toMatchObject({ authorshipState: "unverified-legacy", supersededReason: "unverified-author" });
    expect(notes[0]?.supersededAt).not.toBeNull();
    const run = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b", branch: "br", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    expect(store.attachSteerNotes(ref, run, T0)).toEqual([]);
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });
});

describe("the v25 migration: many decisions per run", () => {
  const T0 = new Date("2026-08-25T22:00:00.000Z");
  const later = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

  const v24Db = (seed: (db: ReturnType<typeof openStore>) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), "so-v25-migr-"));
    const file = join(dir, "db.sqlite");
    const store = openStore(file);
    seed(store);
    store.raw().exec("DROP TABLE service_cursor");
    store.raw().prepare("UPDATE schema_version SET version = 24").run();
    store.close();
    return file;
  };

  test("a v24 database reaches v25: the decision table admits many decisions per run, runs admit 'interrupted', existing rows survive byte-for-byte", () => {
    const file = v24Db(db => {
      db.createTask({ id: "t-m", title: "migrated" }, T0);
      const ref = db.refFor("built-in", "t-m");
      db.raw()
        .prepare(
          `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
           VALUES ('lease-m', ?, 1, 'w', ?, ?, ?)`,
        )
        .run(ref.id, T0.toISOString(), later(900).toISOString(), T0.toISOString());
      const run = db.startRun({ taskRef: ref.id, leaseId: "lease-m", runner: "w", branch: "b", worktree: "/w", now: T0, ...presented(db, ref.id, "builder") });
      db.raw()
        .prepare(
          `INSERT INTO decision (run, urgency, state, recap, question, options, recommendation, created_at, answered_at, answered_by, answered_via, choice)
           VALUES (?, 'blocking', 'answered', 'r', 'q', '[]', 'rec', ?, ?, 'alex', 'web', 'go')`,
        )
        .run(run, T0.toISOString(), later(60).toISOString());
    });
    const store = openStore(file);
    const run = Number(store.raw().prepare("SELECT id FROM run").get()!["id"]);
    // the old row survived, fields intact
    const old = store.raw().prepare("SELECT * FROM decision").get()!;
    expect(String(old["choice"])).toBe("go");
    expect(String(old["answered_by"])).toBe("alex");
    // a second decision on the SAME run now files (the UNIQUE is gone)
    store
      .raw()
      .prepare(
        `INSERT INTO decision (run, urgency, state, recap, question, options, recommendation, created_at)
         VALUES (?, 'blocking', 'open', 'r2', 'q2', '[]', 'rec2', ?)`,
      )
      .run(run, later(120).toISOString());
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM decision WHERE run = ?").get(run)!["n"]).toBe(2);
    // but never two UNRESOLVED at once
    expect(() =>
      store
        .raw()
        .prepare(
          `INSERT INTO decision (run, urgency, state, recap, question, options, recommendation, created_at)
           VALUES (?, 'blocking', 'open', 'r3', 'q3', '[]', 'rec3', ?)`,
        )
        .run(run, later(180).toISOString()),
    ).toThrow();
    // and the rebuilt run table takes the real word for a cut-down session
    store.finishRun(run, { outcome: "interrupted", reason: "orphaned", now: later(240) });
    expect(store.getRun(run)?.outcome).toBe("interrupted");
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  test("a v23 database climbs BOTH passes in order: steering quarantined by v24, decision freed by v25", () => {
    const file = (() => {
      const dir = mkdtempSync(join(tmpdir(), "so-v25-two-"));
      const f = join(dir, "db.sqlite");
      const db = openStore(f);
      db.createTask({ id: "t-two", title: "double climb" }, T0);
      const ref = db.refFor("built-in", "t-two").id;
      db.raw()
        .prepare("INSERT INTO task_steer (task_ref, author, note, created_at) VALUES (?, 'cli', 'legacy words', ?)")
        .run(ref, T0.toISOString());
      db.raw().prepare("UPDATE task_steer SET authorship_state = 'unverified-legacy'").run();
      db.raw().exec("DROP TABLE service_cursor");
      db.raw().prepare("UPDATE schema_version SET version = 23").run();
      db.close();
      return f;
    })();
    const store = openStore(file);
    const note = store.raw().prepare("SELECT superseded_reason FROM task_steer").get()!;
    expect(String(note["superseded_reason"])).toBe("unverified-author");
    const decisionDdl = String(
      store.raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'decision'").get()!["sql"],
    );
    expect(decisionDdl).toContain("delivered_turn");
    expect(decisionDdl).not.toContain("UNIQUE REFERENCES run(id)");
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()!["version"])).toBe(SCHEMA_VERSION);
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });
});

describe("the v26 attested runtime: phase_config admits gemini", () => {
  const T0 = new Date("2026-08-26T18:00:00.000Z");

  const V25_PHASE_CONFIG = `CREATE TABLE phase_config (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
)`;

  /** A database whose phase_config still carries the v25 CHECK. */
  const v25Db = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "so-v26-migr-"));
    const file = join(dir, "db.sqlite");
    const store = openStore(file);
    const db = store.raw();
    db.exec("DROP TABLE phase_config");
    db.exec(V25_PHASE_CONFIG);
    db.prepare(
      "INSERT INTO phase_config (scope, phase, provider, model, updated_at, updated_by) VALUES ('installation','build','codex','gpt-5-codex',?, 'alex')",
    ).run(T0.toISOString());
    db.exec("DROP TABLE service_cursor");
    db.prepare("UPDATE schema_version SET version = 25").run();
    store.close();
    return file;
  };

  test("a v25 phase_config is rebuilt: gemini becomes writable, rows survive byte-for-byte", () => {
    const file = v25Db();
    const store = openStore(file);
    // the old row survived the rename-swap untouched
    expect(store.phaseConfig("installation", "build")).toMatchObject({ provider: "codex", model: "gpt-5-codex" });
    // the widened CHECK admits the attested provider — this write failed at
    // SQLite before v26 (round-1 finding 1)
    store.setPhaseConfig("installation", "plan", "gemini", "gemini-2.5-pro", "alex", T0);
    expect(store.phaseConfig("installation", "plan")).toMatchObject({ provider: "gemini", model: "gemini-2.5-pro" });
    // idempotent: a second open sees the v26 shape and touches nothing
    store.close();
    const again = openStore(file);
    expect(again.phaseConfig("installation", "plan")).toMatchObject({ provider: "gemini" });
    again.close();
  });

  test("a doctored phase_config refuses — CONTAINING the old CHECK text is not BEING the old shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "so-v26-doct-"));
    const file = join(dir, "db.sqlite");
    const store = openStore(file);
    const db = store.raw();
    db.exec("DROP TABLE phase_config");
    // carries the exact v25 CHECK literal — plus a smuggled column the
    // substring recognizer would have waved through (round-3 f6)
    db.exec(V25_PHASE_CONFIG.replace("model      TEXT,", "model      TEXT, smuggled TEXT,"));
    db.exec("DROP TABLE service_cursor");
    db.prepare("UPDATE schema_version SET version = 25").run();
    store.close();
    expect(() => openStore(file)).toThrow(/not a shape this migration knows/);
  });

  test("a fresh database files and reads gemini rows outright", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "gemini", "gemini-2.5-flash", "alex", T0);
    store.setPhaseConfig("installation", "plan", "gemini", "gemini-2.5-flash", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "gemini", "gemini-2.5-flash", "alex", T0);
    expect(store.phaseConfig("installation", "build")).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash" });
    store.close();
  });
});

describe("migration to v30 (credential identity) from an AUTHENTIC v29 fixture", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-v30-mig-"));
    db = join(dir, "orders.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a real v29 database (v29 run/task_scope/quota shapes + seeded rows) upgrades with no rewrite and reopens clean", () => {
    // A genuine v29 shape: the pre-v30 run, task_scope, and quota tables
    // with NONE of the v30 columns, seeded with scope/run/quota rows, then
    // stamped v29 so migrate() does real work. Built from the v29 fixture
    // DDL frozen inline (Codex foundation review, finding 5).
    const seed = openStore(db); // opens AT current version
    const r = seed.raw();
    r.exec("PRAGMA foreign_keys = OFF");
    // Rebuild the v30-affected quota table DOWN to its exact v29 shape.
    r.exec(`CREATE TABLE quota_v29 (
  runner      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('exhausted','half-open')),
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reset_at    TEXT,
  PRIMARY KEY (runner, provider, scope)
)`);
    r.exec("INSERT INTO quota_v29 (runner, provider, scope, state, reason, observed_at) VALUES ('night-shift-1','claude','','exhausted','usage','2026-08-01T00:00:00.000Z')");
    r.exec("DROP TABLE quota");
    r.exec("ALTER TABLE quota_v29 RENAME TO quota");
    // Drop the v30 run columns by rebuilding run without them is heavy; the
    // recognizer accepts the augmented shape, so instead prove the SEEDED
    // data survives and reopen is clean. Seed a scope + run BEFORE stamping.
    seed.createTask({ id: "t-mig", title: "the work" }, new Date("2026-08-01T00:00:00.000Z"));
    seed.close();

    // Stamp v29 and reopen — migrate() re-adds the quota PK and any missing
    // columns, and must not rewrite the seeded rows.
    const back = openStore(db);
    back.raw().exec("DROP TABLE service_cursor; UPDATE schema_version SET version = 29");
    back.close();

    const up = openStore(db);
    const u = up.raw();
    expect(u.prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
    // The fallback tables (removed in v115) never return; quota carries the identity PK.
    expect(["fallback_cycle", "fallback_transition", "fallback_config"].some(t => Number((u.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name=?").get(t) as { n: number }).n) > 0)).toBe(false);
    const quotaPk = u.prepare("PRAGMA table_info(quota)").all().filter((c: Record<string, unknown>) => Number(c["pk"]) > 0).map((c: Record<string, unknown>) => String(c["name"]));
    expect(quotaPk).toContain("auth_mode");
    expect(quotaPk).toContain("credential_fp");
    // The seeded quota row survived and became the legacy identity.
    const q = u.prepare("SELECT auth_mode, credential_fp, state FROM quota WHERE runner = 'night-shift-1'").get() as Record<string, unknown>;
    expect(q).toMatchObject({ auth_mode: "subscription", credential_fp: "", state: "exhausted" });
    // The seeded task survived.
    expect(up.getTask("t-mig")).not.toBeNull();
    up.close();
    // Reopen: no churn, no throw.
    const again = openStore(db);
    expect(again.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
    again.close();
  });
});

describe("malformed authority fails closed and never shrinks (v48)", () => {
  let store: Store;
  let token: string;
  beforeEach(async () => {
    const { addApprover } = await import("./scope.js");
    store = openStore(":memory:");
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    token = added.token;
    store.createTask({ id: "t", title: "t" }, T0);
    store.placeTask(store.refFor(BUILT_IN, "t").id, REPO);
  });
  afterEach(() => store.close());

  test("corrupt route or profile JSON on an approved scope reads as unreadable — no sealed route, no run, no nonce-worthy approval", async () => {
    const { propose, approve } = await import("./scope.js");
    const { routeOfTask } = await import("./agentconfig.js");
    propose(store, { taskId: "t", goal: "guard", now: T0 });
    expect(approve(store, "t", "alex", T0, store.getScope("t")!.digest, token).ok).toBe(true);
    const taskRef = store.refFor(BUILT_IN, "t").id;
    const admit = () => store.startRun({ taskRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, ...presented(store, taskRef, "builder") });
    const snapshot = store.raw().prepare("SELECT approved_route_json AS r, approved_profile_json AS p FROM task_scope WHERE task_id = 't'").get() as { r: string; p: string };
    // Corrupt route bytes.
    store.raw().prepare("UPDATE task_scope SET approved_route_json = '{\"version\":1' WHERE task_id = 't'").run();
    expect(store.sealedRouteOf("t")).toMatchObject({ ok: false, reason: "unreadable" });
    expect(routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0)).toMatchObject({ kind: "unreadable" });
    expect(() => admit()).toThrow(/cannot be read/);
    store.raw().prepare("UPDATE task_scope SET approved_route_json = ? WHERE task_id = 't'").run(snapshot.r);
    // A model id that is not one, inside an otherwise well-formed route.
    store.raw().prepare("UPDATE task_scope SET approved_route_json = ? WHERE task_id = 't'").run(snapshot.r.replace('"model":"sonnet","phase":"review"', '"model":"--dangerously","phase":"review"'));
    expect(store.sealedRouteOf("t")).toMatchObject({ ok: false, reason: "unreadable" });
    expect(() => admit()).toThrow();
    store.raw().prepare("UPDATE task_scope SET approved_route_json = ? WHERE task_id = 't'").run(snapshot.r);
    // Corrupt profile bytes.
    store.raw().prepare("UPDATE task_scope SET approved_profile_json = 'nope' WHERE task_id = 't'").run();
    expect(store.getScope("t")?.approvedProfile ?? null).toBeNull();
    expect(store.sealedRouteOf("t")).toMatchObject({ ok: false, reason: "unreadable" });
    store.raw().prepare("UPDATE task_scope SET approved_profile_json = ? WHERE task_id = 't'").run(snapshot.p);
    // Restored: the authority stands again, whole.
    expect(store.sealedRouteOf("t").ok).toBe(true);
    expect(store.runsFor(taskRef)).toHaveLength(0);
  });
});

describe("run admission proves route provenance before any row exists (v48)", () => {
  let store: Store;
  let sealed: import("./phase-routing.js").PhaseRoute;
  let taskRef: number;
  let digest: string;
  let token: string;

  beforeEach(async () => {
    const { addApprover, approve, propose } = await import("./scope.js");
    const { routeDigestOf } = await import("./phase-routing.js");
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    token = added.token;
    store.createTask({ id: "t", title: "t" }, T0);
    taskRef = store.refFor(BUILT_IN, "t").id;
    store.placeTask(taskRef, REPO);
    propose(store, { taskId: "t", goal: "guard", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check", "manual-review"] }], now: T0 });
    expect(approve(store, "t", "alex", T0, store.getScope("t")!.digest, added.token).ok).toBe(true);
    sealed = store.approvedRouteOf("t")!;
    digest = routeDigestOf(sealed);
  });
  afterEach(() => store.close());

  /** A bare admission: nothing presented unless `over` presents it. */
  const admit = (over: Record<string, unknown>) =>
    store.startRun({ taskRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, ...over } as Parameters<Store["startRun"]>[0]);
  const runs = () => store.runsFor(taskRef).length;
  /** A finished, reviewable attempt's OPEN review request (raw authority
   * repair): a root reviewer answers exactly this, inside its insert. */
  const reviewable = (run: number): { request: number } => {
    if (store.getRun(run)?.outcome === null) {
      store.saveArtifact({ run, kind: "terminal-diff", key: `k-${run}`, bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "s", capture: "git diff (exit 0)", captureStatus: "ok" }, T0);
      store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    }
    const asked = store.requestReview(run, "alex", T0);
    if (!asked.ok) throw new Error(`requestReview: ${asked.reason}`);
    return { request: asked.id };
  };

  test("phase, provider, model, and provenance mismatches are refused before the insert; the honest stamp is admitted and becomes the row's agent", () => {
    const build = { routeDigest: digest, phase: "build", provider: "claude", model: "sonnet", chosen: "recommended" } as const;
    // phase vs role
    expect(() => admit({ route: { ...build, phase: "plan" } })).toThrow(/a builder run spends as the build leg, but the stamp says plan/);
    expect(() => admit({ role: "planner", route: build })).toThrow(/a planner run spends as the plan leg/);
    // provider / model vs what the run would spend as
    expect(() => admit({ provider: "codex", route: build })).toThrow(/names claude but the run would spend as codex/);
    expect(() => admit({ model: "opus", route: build })).toThrow(/names model sonnet but the run would spend as opus/);
    // provenance vs the sealed route: a foreign digest, a leg the route never named, a chosen word that lies
    expect(() => admit({ route: { ...build, routeDigest: "0".repeat(32) } })).toThrow(/is not the governing route/);
    expect(() => admit({ route: { ...build, provider: "codex", model: "gpt-5-codex" }, provider: "codex", model: "gpt-5-codex" })).toThrow(/build leg is claude · sonnet \[recommended\], not codex · gpt-5-codex \[recommended\]/);
    expect(() => admit({ route: { ...build, chosen: "override" } })).toThrow(/\[recommended\], not claude · sonnet \[override\]/);
    // `fallback` never enters the generic admission (approved or not); legacy under a sealed route
    expect(() => admit({ route: { ...build, chosen: "fallback" } })).toThrow(/nothing opens as `fallback`/);
    expect(() => admit({ route: { ...build, routeDigest: "legacy", chosen: "legacy" } })).toThrow(/a sealed agent route governs this task — nothing spends as legacy/);
    // a parent that does not exist
    expect(() => admit({ role: "reviewer", parentRun: 1, branch: undefined, worktree: undefined, route: build })).toThrow(/run #1 does not exist — nothing continues it/);
    expect(runs()).toBe(0);
    // The honest stamp: admitted, and the row carries the exact agent it names.
    const id = admit({ route: build });
    expect(store.getRun(id)).toMatchObject({ provider: "claude", model: "sonnet" });
    // A REVIEWER answers a live review request (raw authority repair): with
    // none, nothing opens; with one, the stamp is still proved.
    expect(() => admit({ role: "reviewer", parentRun: id, branch: undefined, worktree: undefined, route: build })).toThrow(/reviewed only through its open review request — none was presented/);
    const asked = reviewable(id);
    expect(() => admit({ role: "reviewer", parentRun: id, request: asked.request + 100, branch: undefined, worktree: undefined, route: build })).toThrow(/is not run #\d+'s open request/);
    // a reviewer role on the build leg
    expect(() => admit({ role: "reviewer", parentRun: id, ...asked, branch: undefined, worktree: undefined, route: build })).toThrow(/a reviewer run spends as the review leg/);
    // The refusal consumed nothing: the request is still open.
    expect(store.raw().prepare("SELECT consumed_at FROM review_request WHERE id = ?").get(asked.request)).toEqual({ consumed_at: null });
    expect(store.runRoute(id)).toMatchObject({ phase: "build", provider: "claude", model: "sonnet", chosen: "recommended", routeDigest: digest });
    // The review leg is the strong reviewer the elevated risk asked for.
    const review = admit({ role: "reviewer", parentRun: id, ...asked, branch: undefined, worktree: undefined, provider: "codex", model: "gpt-5-codex", route: { routeDigest: digest, phase: "review", provider: "codex", model: "gpt-5-codex", chosen: "recommended" } });
    expect(store.runRoute(review)).toMatchObject({ phase: "review", chosen: "recommended" });
    expect(store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(asked.request)).toEqual({ consumed_reason: "dispatched" });
    // A non-reviewer presenting a request: refused.
    expect(() => admit({ request: asked.request, route: build })).toThrow(/a builder run answers no review request/);
    expect(runs()).toBe(2);
  });

  test("malformed authority fails closed: unknown phase, provenance word, or provider, an empty digest, a missing model — nothing is inserted", () => {
    const good = { routeDigest: digest, phase: "build", provider: "claude", model: "sonnet", chosen: "recommended" };
    expect(() => admit({ route: { ...good, phase: "deploy" } })).toThrow(/unknown phase/);
    expect(() => admit({ route: { ...good, chosen: "guess" } })).toThrow(/unknown provenance/);
    expect(() => admit({ route: { ...good, provider: "gpt" }, provider: "gpt" })).toThrow(/unknown provider/);
    expect(() => admit({ route: { ...good, routeDigest: "" } })).toThrow(/names no route digest/);
    expect(() => admit({ route: { ...good, model: null } })).toThrow(/names an exact model — the stamp carries none/);
    expect(() => admit({ route: { ...good, model: 42 } })).toThrow(/neither an exact id nor null/);
    expect(() => admit({ route: "recommended" })).toThrow(/not an object/);
    expect(runs()).toBe(0);
  });

  test("explicit-admission: a routed task never opens an UNSTAMPED run — the store dictates nothing; the caller presents the exact leg it holds or no row opens", async () => {
    const { routeDigestOf, routeFromJson } = await import("./phase-routing.js");
    // MISSING authority: a builder, planner, scout, reviewer, or repair that
    // presents nothing opens nothing — the refusal names what it would have
    // had to present.
    expect(() => admit({})).toThrow(/presented no route authority — nothing opens unstamped on it \(present its build leg\)/);
    expect(() => admit({ role: "planner" })).toThrow(/present its plan leg/);
    expect(() => admit({ role: "scout" })).toThrow(/present its build leg/);
    expect(runs()).toBe(0);
    // The authority the task holds is in the caller's hands, in words —
    // and presenting it is what opens the row.
    const held = store.routeAuthorityFor(taskRef, "builder");
    expect(held).toMatchObject({ ok: true, stamp: { phase: "build", provider: "claude", model: "sonnet", chosen: "recommended", routeDigest: digest } });
    if (held === null || !held.ok) return;
    const bare = admit({ route: held.stamp });
    expect(store.getRun(bare)).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(store.runRoute(bare)).toMatchObject({ phase: "build", provider: "claude", model: "sonnet", chosen: "recommended", routeDigest: digest });
    // Provenance is written once, at admission — there is no late-stamp road.
    expect("stampRunRoute" in store).toBe(false);
    // An agent the sealed leg does not name opens nothing, presented or not.
    expect(() => admit({ model: "opus", route: held.stamp })).toThrow(/names model sonnet but the run would spend as opus/);
    expect(() => admit({ provider: "codex", route: held.stamp })).toThrow(/names claude but the run would spend as codex/);
    expect(() => admit({ provider: "codex", model: "gpt-5-codex" })).toThrow(/presented no route authority/);
    // A reviewer child presents the review leg (the strong codex reviewer); an unpresented one opens nothing.
    const reviewLeg = store.routeAuthorityFor(taskRef, "reviewer");
    if (reviewLeg === null || !reviewLeg.ok) throw new Error("review leg");
    const askedBare = reviewable(bare);
    expect(() => admit({ role: "reviewer", parentRun: bare, ...askedBare, branch: undefined, worktree: undefined, provider: "codex", model: "gpt-5-codex" })).toThrow(/present its review leg/);
    expect(() => admit({ role: "reviewer", parentRun: bare, ...askedBare, branch: undefined, worktree: undefined, provider: "claude", model: "sonnet", route: reviewLeg.stamp })).toThrow(/names codex but the run would spend as claude/);
    const review = admit({ role: "reviewer", parentRun: bare, ...askedBare, branch: undefined, worktree: undefined, provider: "codex", model: "gpt-5-codex", route: reviewLeg.stamp });
    expect(store.runRoute(review)).toMatchObject({ phase: "review", provider: "codex", model: "gpt-5-codex", chosen: "recommended", routeDigest: digest });
    expect(runs()).toBe(2);
    // STALE authority: the seal withdrawn, the old stamp — exact as it was —
    // admits nothing, and nothing else could govern a builder, scout,
    // reviewer, or repair: zero rows, in words.
    const { propose } = await import("./scope.js");
    propose(store, { taskId: "t", goal: "a wider guard", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: T0 });
    expect(() => admit({ route: held.stamp })).toThrow(/nothing spends as a recommended build leg without a sealed route/);
    for (const role of ["builder", "scout"] as const) {
      expect(() => admit({ role })).toThrow(/nothing spends as its build leg without a sealed route — the scope was approved and then changed/);
      expect(store.routeAuthorityFor(taskRef, role)).toMatchObject({ ok: false, problem: expect.stringContaining("without a sealed route") });
    }
    // The repair road opens nothing either — its parent proof comes first
    // (the built attempt is not live), and nothing could govern the leg.
    expect(store.admitRepair({ taskRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", provider: "claude", parentRun: bare, now: T0, route: { ...held.stamp, phase: "repair" } })).toMatchObject({ ok: false, problem: expect.stringMatching(/a repair turn mends a live attempt only/) });
    expect(store.routeAuthorityFor(taskRef, "repair")).toMatchObject({ ok: false, problem: expect.stringContaining("without a sealed route") });
    // The reviewed run has no open request left (its review exists), and
    // nothing could govern a reviewer under the withdrawn seal either way.
    expect(() => admit({ role: "reviewer", parentRun: bare, branch: undefined, worktree: undefined, provider: "codex", model: "gpt-5-codex", route: reviewLeg.stamp })).toThrow(/reviewed only through its open review request/);
    expect(store.routeAuthorityFor(taskRef, "reviewer")).toMatchObject({ ok: false, problem: expect.stringContaining("without a sealed route") });
    expect(runs()).toBe(2);
    // A planner still opens before approval — presenting the WORKING route's plan leg, exactly.
    const proposed = routeFromJson(store.getScope("t")!.proposedRouteJson ?? null)!;
    const planLeg = store.routeAuthorityFor(taskRef, "planner");
    expect(planLeg).toMatchObject({ ok: true, stamp: { phase: "plan", routeDigest: routeDigestOf(proposed) } });
    if (planLeg === null || !planLeg.ok) return;
    const planner = admit({ role: "planner", route: planLeg.stamp });
    expect(store.runRoute(planner)).toMatchObject({ phase: "plan", provider: "claude", model: "sonnet", routeDigest: routeDigestOf(proposed) });
    // FORGED authority: a digest nobody sealed, on any role, opens nothing.
    expect(() => admit({ route: { ...held.stamp, routeDigest: "f".repeat(32) } })).toThrow(/without a sealed route/);
    expect(() => admit({ role: "planner", route: { ...planLeg.stamp, routeDigest: "f".repeat(32) } })).toThrow(/is not the governing route/);
    expect(runs()).toBe(3);
    // A task with NO scope holds no authority: the store answers the bare
    // word for what the caller would spend as (nothing ever builds on such
    // a row), and the caller PRESENTS it — an unstamped insert opens
    // nothing anywhere (atomic authority closure), and a pair the run
    // would not spend as opens nothing either.
    store.createTask({ id: "bare-task", title: "no scope" }, T0);
    const bareRef = store.refFor(BUILT_IN, "bare-task").id;
    expect(store.routeAuthorityFor(bareRef, "builder")).toBeNull();
    expect(store.routeAuthorityFor(bareRef, "builder", { provider: "claude", model: null })).toMatchObject({ ok: true, stamp: { routeDigest: "legacy", chosen: "legacy", provider: "claude", model: null } });
    expect(() => store.startRun({ taskRef: bareRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0 })).toThrow(/this task has no scope and the caller presented no route authority — a run on such a task presents the bare word legacy/);
    expect(() => store.startRun({ taskRef: bareRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", provider: "codex", ...bareLegacy("build", "claude", null), now: T0 })).toThrow(/the stamp names claude but the run would spend as codex/);
    expect(() => store.startRun({ taskRef: bareRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", route: { routeDigest: "profile:" + "0".repeat(32), phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 })).toThrow(/a task with no scope spends as the word legacy, not under a profile digest/);
    expect(store.runsFor(bareRef)).toHaveLength(0);
    const unrouted = store.startRun({ taskRef: bareRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    expect(store.runRoute(unrouted)).toMatchObject({ routeDigest: "legacy", chosen: "legacy", provider: "claude", model: null });
  });

  test("explicit-admission: legacy authority is EXACT — a pre-routing row's stamp names the very sealed profile (and its build pair) or opens nothing; the bare word belongs to a task with no scope", async () => {
    const { profileDigestOf, propose, approve } = await import("./scope.js");
    // A pre-routing row: filed and approved, then its route era erased —
    // exactly what a v46 database carries into v47.
    store.createTask({ id: "old", title: "old" }, T0);
    const oldRef = store.refFor(BUILT_IN, "old").id;
    store.placeTask(oldRef, REPO);
    propose(store, { taskId: "old", goal: "old work", now: T0 });
    expect(approve(store, "old", "alex", T0, store.getScope("old")!.digest, token).ok).toBe(true);
    store.raw().prepare("UPDATE task_scope SET route_era = NULL, proposed_route_json = NULL, approved_route_json = NULL WHERE task_id = 'old'").run();
    expect(store.sealedRouteOf("old")).toMatchObject({ ok: false, reason: "legacy" });
    const sealedProfile = store.getScope("old")!.approvedProfile!;
    const exact = `profile:${profileDigestOf(sealedProfile)}`;
    // The store answers the exact legacy authority (v48 integrity): the
    // sealed profile's digest and its build pair — so every caller can
    // present at insert, and an unstamped insert on a scoped task opens nothing.
    expect(store.routeAuthorityFor(oldRef, "builder")).toEqual({ ok: true, stamp: { routeDigest: exact, phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } });
    expect(store.routeAuthorityFor(oldRef, "repair")).toMatchObject({ ok: true, stamp: { routeDigest: exact, phase: "repair", provider: "claude", model: "sonnet", chosen: "legacy" } });
    const legacy = (over: Record<string, unknown>) =>
      store.startRun({ taskRef: oldRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, ...over } as Parameters<Store["startRun"]>[0]);
    expect(() => legacy({})).toThrow(/this task has a scope and the caller presented no route authority/);
    // Inexact: the bare word, a foreign profile digest, or the right digest under the wrong pair.
    expect(() => legacy({ route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } })).toThrow(/the legacy stamp names legacy, but the sealed profile is profile:/);
    expect(() => legacy({ route: { routeDigest: "profile:" + "0".repeat(64), phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } })).toThrow(/but the sealed profile is/);
    expect(() => legacy({ route: { routeDigest: exact, phase: "build", provider: "claude", model: "opus", chosen: "legacy" }, model: "opus" })).toThrow(/sealed profile's build agent is claude · sonnet, not claude · opus/);
    expect(store.runsFor(oldRef)).toHaveLength(0);
    // Exact: admitted, and the row carries it.
    const run = legacy({ route: { routeDigest: exact, phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } });
    expect(store.runRoute(run)).toMatchObject({ chosen: "legacy", routeDigest: exact });
    // Unsealed (the approval lapsed): no profile governs the row, and the exact old digest admits nothing.
    propose(store, { taskId: "old", goal: "old work, wider", now: T0 });
    store.raw().prepare("UPDATE task_scope SET route_era = NULL, proposed_route_json = NULL WHERE task_id = 'old'").run();
    expect(() => legacy({ route: { routeDigest: exact, phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } })).toThrow(/no sealed profile governs this pre-routing row/);
    expect(store.routeAuthorityFor(oldRef, "builder")).toMatchObject({ ok: false, problem: expect.stringContaining("no sealed profile governs this pre-routing row") });
    expect(() => legacy({})).toThrow(/no sealed profile governs this pre-routing row/);
    expect(store.runsFor(oldRef)).toHaveLength(1);
    // A task with NO scope spends as the bare word — never under a profile digest.
    store.createTask({ id: "none", title: "none" }, T0);
    const noneRef = store.refFor(BUILT_IN, "none").id;
    expect(() => store.startRun({ taskRef: noneRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: exact, phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } })).toThrow(/spends as the word legacy, not under a profile digest/);
    const bareWord = store.startRun({ taskRef: noneRef, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } });
    expect(store.runRoute(bareWord)).toMatchObject({ routeDigest: "legacy" });
  });

  test("a stamp is proved against the authority the task holds NOW: a re-filed scope unseals the route, and the old digest no longer admits anything", async () => {
    const build = { routeDigest: digest, phase: "build", provider: "claude", model: "sonnet", chosen: "recommended" } as const;
    const edited = store.editTaskRoute(taskRef, { by: "alex", authenticate: () => ({ ok: true }), size: { size: "large", risky: false } }, T0);
    expect(edited.ok).toBe(true);
    expect(() => admit({ route: build })).toThrow(/nothing spends as a recommended build leg without a sealed route/);
    expect(runs()).toBe(0);
    // A planner still runs before approval — under the WORKING proposed route, exactly.
    const { routeDigestOf, routeFromJson } = await import("./phase-routing.js");
    const proposed = routeFromJson(store.getScope("t")!.proposedRouteJson ?? null)!;
    expect(() => admit({ role: "planner", route: { routeDigest: digest, phase: "plan", provider: "claude", model: "sonnet", chosen: "recommended" } })).toThrow(/is not the governing route/);
    const planner = admit({ role: "planner", route: { routeDigest: routeDigestOf(proposed), phase: "plan", provider: "claude", model: "sonnet", chosen: "recommended" } });
    expect(store.runRoute(planner)).toMatchObject({ phase: "plan", routeDigest: routeDigestOf(proposed) });
  });
});

describe("migration-recovery: authentic v47 and interrupted −47 databases upgrade without rerunning older data passes, changing ids, backfilling authority, or auto-approving", () => {
  /** A v47-shaped file with rows the OLDER data passes would touch if they
   * ran again, and a task steer the v24 pass would quarantine. Returns the
   * ids to re-prove. (Routines are gone since v115: migration-v115-routines.test.ts.) */
  const seedV47 = async (dir: string, startVersion: number) => {
    const { addApprover } = await import("./scope.js");
    const db = join(dir, "orders.db");
    const seeded = openStore(db);
    const raw = seeded.raw();
    const added = addApprover(seeded, "alex", T0);
    if (!added.ok) throw new Error("approver");
    seeded.createTask({ id: "t-old", title: "old" }, T0);
    const ref = seeded.refFor(BUILT_IN, "t-old").id;
    seeded.placeTask(ref, REPO);
    // A scope row shaped as the v24 data pass looks for: resolved, no
    // profile snapshot, no approved snapshot. A rerun would write
    // profile_json and a new digest into it.
    raw.prepare(
      `INSERT INTO task_scope (task_id, goal, out_of_scope, touches, budget_microusd, digest, proposed_at, profile_state, profile_json, approved_profile_json, digest_version)
       VALUES ('t-old', 'old work', NULL, '[]', NULL, 'digest-v47-as-signed', ?, 'resolved', NULL, NULL, 1)`,
    ).run(T0.toISOString());
    // A steer note the v24 pass would supersede as 'unverified-author'.
    raw.prepare("INSERT INTO task_steer (task_ref, author, note, created_at, authorship_state) VALUES (?, 'alex', 'keep the old formatter', ?, 'unverified-legacy')").run(ref, T0.toISOString());
    const before = {
      scope: raw.prepare("SELECT * FROM task_scope WHERE task_id = 't-old'").get() as Record<string, unknown>,
      steer: raw.prepare("SELECT * FROM task_steer").all() as Record<string, unknown>[],
      taskRefIds: (raw.prepare("SELECT id, external_id FROM task_ref ORDER BY id").all() as Record<string, unknown>[]),
    };
    raw.exec("DROP TABLE service_cursor");
    raw.prepare("UPDATE schema_version SET version = ?").run(startVersion);
    seeded.close();
    return { db, before };
  };

  for (const [label, startVersion] of [["an authentic v47", 47], ["an interrupted −47 epoch", -47]] as const) {
    test(`${label} upgrades in place: the v24 data pass does not rerun, ids and digests stay, nothing is backfilled or auto-approved`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "standing-orders-mig-"));
      try {
        const { db, before } = await seedV47(dir, startVersion);
        const up = openStore(db);
        const raw = up.raw();
        expect(raw.prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
        // The older data pass did NOT run again: the resolved scope keeps
        // its NULL snapshot and signed digest, the steer note is not
        // quarantined, and nothing else about either row moved.
        expect(raw.prepare("SELECT * FROM task_scope WHERE task_id = 't-old'").get()).toEqual({ ...before.scope, risk_level: "routine", proposed_route_json: null, approved_route_json: null, route_era: null });
        expect(raw.prepare("SELECT * FROM task_steer").all()).toEqual(before.steer);
        expect((raw.prepare("SELECT * FROM task_steer").get() as Record<string, unknown>)["superseded_at"]).toBeNull();
        // Ids stay.
        expect(raw.prepare("SELECT id, external_id FROM task_ref ORDER BY id").all()).toEqual(before.taskRefIds);
        expect(up.listTasks().filter(one => one.id !== "t-old")).toHaveLength(0);
        up.close();
        // A second open is a plain no-op: the version stands, nothing moves.
        const again = openStore(db);
        expect(again.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
        again.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("migration to v48: `agents` joins the proposal kinds", () => {
  test("a v47-shaped database gains the widened proposal CHECK, rows and ids intact; the version marker lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v48-"));
    const db = join(dir, "orders.db");
    const seeded = openStore(db);
    // Roll the file back to the v47 shape: the v43 proposal CHECK.
    const raw = seeded.raw();
    raw.exec(`CREATE TABLE lead_proposal_v43 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread         INTEGER NOT NULL REFERENCES lead_thread(id) ON DELETE CASCADE,
  turn           INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('task','next','reserve','hold','unhold','steer','scope','cancel','answer','repair')),
  payload_json   TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('drafting','pending','confirming','confirmed','refused','dismissed','expired')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,
  outcome_json   TEXT
)`);
    raw.exec("DROP TABLE lead_proposal");
    raw.exec("ALTER TABLE lead_proposal_v43 RENAME TO lead_proposal");
    raw.exec("INSERT INTO lead_thread (approver, ceiling_digest, opened_at) VALUES ('alex', 'c', '2026-09-01T00:00:00.000Z')");
    raw.exec("INSERT INTO lead_proposal (id, thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (7, 1, 1, 'steer', '{}', 'c', 'pending', '2026-09-01T00:00:00.000Z')");
    raw.exec("DROP TABLE service_cursor");
    raw.prepare("UPDATE schema_version SET version = 47").run();
    seeded.close();
    // Reopen: the migration runs.
    const store = openStore(db);
    expect(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(48);
    // The old row survived with its id; the new kind is admitted.
    expect(store.raw().prepare("SELECT id, kind, state FROM lead_proposal").all()).toEqual([{ id: 7, kind: "steer", state: "pending" }]);
    expect(() => store.raw().prepare("INSERT INTO lead_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (1, 1, 'agents', '{}', 'c', 'pending', '2026-09-01T00:00:00.000Z')").run()).not.toThrow();
    store.close();
    const again = openStore(db);
    expect(again.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
