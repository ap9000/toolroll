/**
 * Operator steering (arc 1, schema v22): notes land at the next safe
 * boundary. Attachment is its own pre-invocation transaction; delivery
 * settles only on the stream's receipt; abandonment is LIVENESS, not
 * finalization — a crashed run keeps outcome NULL forever, and its note
 * must still find the next build.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire, release } from "./claim.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-23T05:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const BUILT_IN = "built-in";

/** The runner gate (MCP spec v6): every claim authenticates its runner and
 * proves the task's PLACED repo is in the runner's registered list. */
const REPO = "/repo/steer";
const TOKEN = "tok-builder-1";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
  register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => TOKEN });
  store.createTask({ id: "t-1", title: "steerable work" }, T0);
  store.placeTask(store.refFor(BUILT_IN, "t-1").id, REPO);
});

const refOf = (id: string) => store.refFor(BUILT_IN, id).id;

const openRun = (leaseId: string, at: Date = T0): number =>
  store.startRun({
    taskRef: refOf("t-1"),
    leaseId,
    runner: "builder-1",
    branch: "standing-orders/t-1",
    worktree: "/w",
    provider: "claude",
    ...bareLegacy("build", "claude", null), now: at,
  });

const claimIt = (at: Date, lease: string, ttlMs = 60 * 60_000) => {
  const got = acquire(store, refOf("t-1"), "builder-1", { token: TOKEN, now: at, ttlMs, newLeaseId: () => lease });
  if (!got.ok) throw new Error("claim failed in setup");
  return got.claim.leaseId;
};

describe("filing", () => {
  test("a note files against a queued task and is refused on finished ones", () => {
    const filed = store.fileSteerNote("t-1", "alex", "prefer the parser fix first", T0);
    expect(filed).toMatchObject({ ok: true });
    store.setTaskState("t-1", "done", later(1_000));
    expect(store.fileSteerNote("t-1", "alex", "too late", later(2_000))).toMatchObject({
      ok: false,
      reason: "task-finished",
    });
    expect(store.fileSteerNote("t-9", "alex", "nobody home", T0)).toMatchObject({
      ok: false,
      reason: "unknown-task",
    });
  });

  test("validateNote is the rule: controls and oversized notes refuse", () => {
    expect(store.fileSteerNote("t-1", "alex", "sneaky\u0007bell", T0)).toMatchObject({
      ok: false,
      reason: "invalid-note",
    });
    expect(store.fileSteerNote("t-1", "alex", "x".repeat(4_001), T0)).toMatchObject({
      ok: false,
      reason: "invalid-note",
      problem: "a note is at most 4000 characters",
    });
  });

  test("a steering note takes up to 4000 characters, whole", () => {
    const note = `${"prefer the parser fix first, then the totals. ".repeat(100)}`.slice(0, 4_000).trim();
    const filed = store.fileSteerNote("t-1", "alex", note, T0);
    expect(filed.ok).toBe(true);
    expect(store.listSteerNotes(store.refFor("built-in", "t-1").id).map(one => one.note)).toContain(note);
  });

  test("a finished task supersedes pending notes in the same transaction", () => {
    store.fileSteerNote("t-1", "alex", "still pending when it ends", T0);
    store.setTaskState("t-1", "cancelled", later(5_000));
    const notes = store.listSteerNotes(refOf("t-1"));
    expect(notes[0]?.supersededAt).not.toBeNull();
    expect(store.pendingSteerCount(refOf("t-1"))).toBe(0);
  });
});

describe("the attach transaction (finding 9)", () => {
  test("attaches pending notes to the open run, in filing order, and the same call is idempotent-safe", () => {
    store.fileSteerNote("t-1", "alex", "first note", T0);
    store.fileSteerNote("t-1", "alex", "second note", later(100));
    claimIt(T0, "lease-1");
    const runId = openRun("lease-1");
    const attached = store.attachSteerNotes(refOf("t-1"), runId, later(1_000));
    expect(attached.map(one => one.note)).toEqual(["first note", "second note"]);
    expect(attached[0]?.attachedRun).toBe(runId);
    // Re-attaching to the SAME run returns them again (own attachment).
    expect(store.attachSteerNotes(refOf("t-1"), runId, later(2_000)).length).toBe(2);
  });

  test("refuses a run that is not this task's open attempt", () => {
    claimIt(T0, "lease-1");
    const runId = openRun("lease-1");
    store.finishRun(runId, { outcome: "failed", reason: "agent", now: later(1_000) });
    expect(() => store.attachSteerNotes(refOf("t-1"), runId, later(2_000))).toThrow(/open attempt/);
  });

  test("a note attached to a CONCLUDED run re-attaches to the next build", () => {
    store.fileSteerNote("t-1", "alex", "survives the failure", T0);
    claimIt(T0, "lease-1");
    const first = openRun("lease-1");
    store.attachSteerNotes(refOf("t-1"), first, later(1_000));
    // The run fails WITHOUT a receipt; its lease releases.
    store.finishRun(first, { outcome: "failed", reason: "agent", now: later(2_000) });
    release(store, "lease-1", later(2_000));

    claimIt(later(3_000), "lease-2");
    const second = openRun("lease-2", later(3_000));
    const attached = store.attachSteerNotes(refOf("t-1"), second, later(4_000));
    expect(attached.map(one => one.note)).toEqual(["survives the failure"]);
    expect(attached[0]?.attachedRun).toBe(second);
  });

  test("a CRASHED run — outcome NULL forever, lease expired — still releases its note (finding 12)", () => {
    store.fileSteerNote("t-1", "alex", "survives the crash", T0);
    claimIt(T0, "lease-1", 60_000);
    const crashed = openRun("lease-1");
    store.attachSteerNotes(refOf("t-1"), crashed, later(1_000));
    // No finishRun, no release: the runner died. The lease simply expires.

    const afterExpiry = later(10 * 60_000);
    claimIt(afterExpiry, "lease-2");
    const next = openRun("lease-2", afterExpiry);
    const attached = store.attachSteerNotes(refOf("t-1"), next, later(11 * 60_000));
    expect(attached.map(one => one.note)).toEqual(["survives the crash"]);
  });

  test("a note riding the CURRENT live run is not stolen by a stranger run id", () => {
    store.fileSteerNote("t-1", "alex", "mid-flight", T0);
    claimIt(T0, "lease-1");
    const live = openRun("lease-1");
    store.attachSteerNotes(refOf("t-1"), live, later(1_000));
    // A second open run under the SAME live lease (hypothetical duplicate
    // caller) must not re-take a note already riding the live attempt.
    const sibling = openRun("lease-1", later(2_000));
    const taken = store.attachSteerNotes(refOf("t-1"), sibling, later(3_000));
    expect(taken).toEqual([]);
  });
});

describe("delivery and receipts (finding 8)", () => {
  test("the receipt settles every attached note once — first receipt wins, replays change nothing", () => {
    store.fileSteerNote("t-1", "alex", "note a", T0);
    store.fileSteerNote("t-1", "alex", "note b", later(100));
    claimIt(T0, "lease-1");
    const runId = openRun("lease-1");
    store.attachSteerNotes(refOf("t-1"), runId, later(1_000));
    expect(store.settleSteerDelivered(runId, later(2_000))).toBe(2);
    expect(store.settleSteerDelivered(runId, later(3_000))).toBe(0);
    for (const note of store.listSteerNotes(refOf("t-1"))) {
      expect(note.deliveredAt).toBe(later(2_000).toISOString());
    }
  });

  test("delivery survives the run failing AFTER the receipt", () => {
    store.fileSteerNote("t-1", "alex", "reached the agent", T0);
    claimIt(T0, "lease-1");
    const runId = openRun("lease-1");
    store.attachSteerNotes(refOf("t-1"), runId, later(1_000));
    store.settleSteerDelivered(runId, later(2_000));
    store.finishRun(runId, { outcome: "failed", reason: "timeout", now: later(3_000) });
    const note = store.listSteerNotes(refOf("t-1"))[0];
    expect(note?.deliveredAt).not.toBeNull();
    // Delivered: the next build does NOT get it again.
    release(store, "lease-1", later(3_000));
    claimIt(later(4_000), "lease-2");
    const next = openRun("lease-2", later(4_000));
    expect(store.attachSteerNotes(refOf("t-1"), next, later(5_000))).toEqual([]);
  });
});

describe("tournaments stay closed in both directions", () => {
  test("filing refuses while a contest is open", () => {
    // A contest row in a racing state, fabricated minimally (FKs are ON,
    // so the terms row comes first).
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): { lastInsertRowid: number | bigint } } } }).db;
    const terms = db.prepare(
      `INSERT INTO tournament_terms (task_ref, generation, race_digest, agents, n,
         per_agent_budget_microusd, overrun_reserve_microusd, total_budget_microusd,
         price_version, retries, publication_policy, created_at)
       VALUES (?, 1, 'digest', '[]', 2, 1, 1, 1, 1, 0, 'none', ?)`,
    ).run(refOf("t-1"), T0.toISOString());
    db.prepare(
      `INSERT INTO contest (task_ref, terms, state, scope_digest, race_digest, created_at)
       VALUES (?, ?, 'racing', 'scope-d', 'digest', ?)`,
    ).run(refOf("t-1"), Number(terms.lastInsertRowid), T0.toISOString());
    expect(store.fileSteerNote("t-1", "alex", "no racing notes", later(1_000))).toMatchObject({
      ok: false,
      reason: "contest-open",
    });
  });

  test("pendingSteerCount is the admitContest predicate", () => {
    store.fileSteerNote("t-1", "alex", "pending", T0);
    expect(store.pendingSteerCount(refOf("t-1"))).toBe(1);
  });
});

describe("the v21 → v22 migration", () => {
  test("an existing database gains task_steer and a note round-trips, reopened twice", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v22-"));
    const file = join(dir, "orders.db");
    try {
      // A pre-v22 database is any database this suite's openStore has not
      // touched: build one at the CURRENT schema minus the new table, the
      // additive way every older fixture works — open, then drop the table
      // to simulate its absence, then stamp the old version.
      const first = openStore(file);
      first.close();
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite");
      const raw = new DatabaseSync(file);
      raw.exec("DROP TABLE service_cursor; DROP INDEX IF EXISTS task_steer_pending; DROP TABLE IF EXISTS task_steer; UPDATE schema_version SET version = 21;");
      raw.close();

      openStore(file).close(); // reopened once — migrates
      const migrated = openStore(file); // reopened twice — stays stable
      try {
        migrated.createTask({ id: "t-m", title: "migrated" }, T0);
        expect(migrated.fileSteerNote("t-m", "alex", "hello new table", T0)).toMatchObject({ ok: true });
        expect(migrated.listSteerNotes(migrated.refFor(BUILT_IN, "t-m").id).length).toBe(1);
        const version = (migrated as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> } } }).db
          .prepare("SELECT version FROM schema_version")
          .get();
        expect(Number(version["version"])).toBe(SCHEMA_VERSION);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
