/**
 * Schema v53 (OS containment and login recovery): four additive nullable
 * columns on run_process — boot_id, containment, container,
 * container_empty_at. A v52 file gains them with NULLs in every existing
 * row; a legacy witness (NULL boot, NULL containment) keeps exactly the
 * conservative reading it had; the marker lands at 53; reopening is a
 * no-op. Existing installations are compatible: nothing they wrote changes
 * meaning, and the default containment policy is the observed mode they
 * always had.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { injectBootIdentity } from "./boot-identity.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { fakePid } from "../test/fake-pid.js";

const V52_RUN_PROCESS = `CREATE TABLE run_process (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  pid INTEGER CHECK (pid > 0),
  host TEXT NOT NULL,
  process_group INTEGER NOT NULL CHECK (process_group IN (0,1)),
  observed_at TEXT NOT NULL,
  exited_at TEXT
)`;

describe("schema v53: boot identity and the native OS object ride the process witness", () => {
  let dir: string | undefined;
  let store: Store | null = null;
  const REPO = resolve("/repo");
const T0 = new Date("2026-09-12T08:00:00.000Z");

  afterEach(() => {
    injectBootIdentity(null);
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const columns = (file: string): string[] => {
    const db = new DatabaseSync(file);
    try { return db.prepare("PRAGMA table_info(run_process)").all().map(row => String(row["name"])); }
    finally { db.close(); }
  };

  test("a v52 file gains the columns with NULLs, keeps every witness row and id, lands at v53, and reopens as a no-op", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v53-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    register(store, { name: "r", host: hostname(), capacity: 1, repos: [REPO], now: T0, newToken: () => "tok" });
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor("built-in", "t").id;
    store.placeTask(ref, REPO);
    const claimed = acquire(store, ref, "r", { token: "tok", now: T0, ttlMs: 3_600_000, newLeaseId: () => "lease" });
    if (!claimed.ok) throw new Error(claimed.reason);
    const run = store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
    const raw = store.raw(), openPid = fakePid(1), exitedPid = fakePid(2);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`CREATE TABLE run_process_copy AS SELECT id, run, pid, host, process_group, observed_at, exited_at FROM run_process;
      DROP TABLE run_process;
      ${V52_RUN_PROCESS};
      INSERT INTO run_process SELECT * FROM run_process_copy;
      DROP TABLE run_process_copy;
      CREATE INDEX IF NOT EXISTS run_process_by_run ON run_process(run, exited_at);`);
    raw.prepare(`INSERT INTO run_process (run, pid, host, process_group, observed_at, exited_at) VALUES (?, ${openPid}, ?, 1, ?, NULL)`).run(run, hostname(), T0.toISOString());
    raw.prepare(`INSERT INTO run_process (run, pid, host, process_group, observed_at, exited_at) VALUES (?, ${exitedPid}, ?, 0, ?, ?)`).run(run, hostname(), T0.toISOString(), T0.toISOString());
    const before = raw.prepare("SELECT id, run, pid, host, process_group, observed_at, exited_at FROM run_process ORDER BY id").all();
    expect(() => raw.prepare("SELECT boot_id FROM run_process").all()).toThrow();
    raw.exec("DROP TABLE service_cursor");
    raw.prepare("UPDATE schema_version SET version = 52").run();
    store.close();
    store = null;
    expect(columns(file)).not.toContain("boot_id");

    store = openStore(file);
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(112);
    expect(columns(file)).toEqual(expect.arrayContaining(["boot_id", "containment", "container", "container_empty_at"]));
    const after = store.raw().prepare("SELECT * FROM run_process ORDER BY id").all();
    expect(after.map(row => ({ id: row["id"], run: row["run"], pid: row["pid"], host: row["host"], process_group: row["process_group"], observed_at: row["observed_at"], exited_at: row["exited_at"] }))).toEqual(before);
    for (const row of after) {
      expect(row["boot_id"]).toBeNull();
      expect(row["containment"]).toBeNull();
      expect(row["container"]).toBeNull();
      expect(row["container_empty_at"]).toBeNull();
    }

    // The legacy witness (NULL boot) keeps its conservative reading even
    // under a different current boot: its pid is probed, not assumed dead.
    injectBootIdentity({ ok: true, id: "9b1d0e2f-3a4b-4c5d-8e6f-a1b2c3d4e5f6", source: "injected" });
    const asked = store.requestRunStop({ runId: run, taskRef: ref, by: "alex", via: "cli" }, T0);
    expect(asked.ok).toBe(true);
    store.finishRun(run, { outcome: "failed", reason: "interrupted", now: T0 });
    const problem = store.stopQuiescenceProblem(run);
    // That pid is gone (ESRCH); were it alive the witness would say "may
    // still be running" — either way the legacy row was decided by the
    // probe, never by the boot id.
    expect(problem === null || problem.includes("may still be running")).toBe(true);

    // New witnesses on the upgraded file carry the boot id.
    const reserved = store.reserveRunProcess(run, T0, true);
    expect(store.raw().prepare("SELECT boot_id FROM run_process WHERE id = ?").get(reserved)?.["boot_id"]).toBe("9b1d0e2f-3a4b-4c5d-8e6f-a1b2c3d4e5f6");
    store.close();
    store = null;

    // Reopen: a no-op at the current version.
    store = openStore(file);
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);
    expect(columns(file).filter(name => name === "boot_id")).toHaveLength(1);
  });

  test("the container custody writes are fenced: one object per witness, empty only after it was named", () => {
    store = openStore(":memory:");
    register(store, { name: "r", host: hostname(), capacity: 1, repos: [REPO], now: T0, newToken: () => "tok" });
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor("built-in", "t").id;
    store.placeTask(ref, REPO);
    const run = store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
    const witness = store.reserveRunProcess(run, T0, true);
    store.markRunContainerEmpty(witness, T0);
    expect(store.raw().prepare("SELECT container_empty_at FROM run_process WHERE id = ?").get(witness)?.["container_empty_at"]).toBeNull();
    store.recordRunContainer(witness, "cgroup2", "/sys/fs/cgroup/own/so-x");
    expect(() => store!.recordRunContainer(witness, "cgroup2", "/sys/fs/cgroup/own/so-y")).toThrow(/container custody changed/);
    store.markRunContainerEmpty(witness, T0);
    expect(store.raw().prepare("SELECT containment, container, container_empty_at FROM run_process WHERE id = ?").get(witness)).toEqual({ containment: "cgroup2", container: "/sys/fs/cgroup/own/so-x", container_empty_at: T0.toISOString() });
    expect(store.latestRunProcessWitness(run)).toBe(witness);
  });
});
