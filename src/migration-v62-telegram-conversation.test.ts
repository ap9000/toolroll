/** Isolated v61 fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addLegacyChatTables } from "../test/legacy-chat.js";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { requestTaskStop } from "./task-control.js";

const NOW = new Date("2026-09-16T09:00:00Z");
const REPO = "/test/project";
const tables = ["telegram_conversation_part", "telegram_conversation", "telegram_proposal_action"];
const V52_RUN_STOP = `CREATE TABLE run_stop (
  run INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE, task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL, requested_via TEXT NOT NULL CHECK (requested_via IN ('cli','web')), requested_at TEXT NOT NULL,
  settled_at TEXT, settlement TEXT CHECK (settlement IN ('interrupted','recovered','held','finished')), resumed_at TEXT, resumed_by TEXT,
  resumed_via TEXT CHECK (resumed_via IN ('cli','web')), CHECK ((settled_at IS NULL) = (settlement IS NULL)),
  CHECK (resumed_at IS NULL OR settled_at IS NOT NULL), CHECK ((resumed_at IS NULL) = (resumed_by IS NULL)))`;

describe("v62 Telegram conversation queue", () => {
  let dir: string | undefined;
  let store: Store | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  /** A v61-shaped file holding one real stop: the v52 audit CHECK, no v62 tables, version 61. */
  const windBack = (file: string, version: number): Record<string, unknown>[] => {
    const old = new DatabaseSync(file);
    addLegacyChatTables(old);
    for (const table of tables) old.exec(`DROP TABLE ${table}`);
    const stops = old.prepare("SELECT * FROM run_stop ORDER BY run").all() as Record<string, unknown>[];
    old.exec("DROP TABLE run_stop");
    old.exec(V52_RUN_STOP);
    for (const row of stops) {
      old.prepare("INSERT INTO run_stop (run, task_ref, requested_by, requested_via, requested_at, settled_at, settlement, resumed_at, resumed_by, resumed_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row["run"], row["task_ref"], row["requested_by"], row["requested_via"], row["requested_at"], row["settled_at"], row["settlement"], row["resumed_at"], row["resumed_by"], row["resumed_via"]);
    }
    old.exec("DROP TABLE service_cursor");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    old.close();
    return stops;
  };

  test.each([61, -61])("v%s upgrades to v62 keeping every stop row, id and settlement, admits a telegram stop afterwards, and reopens idempotently", version => {
    dir = mkdtempSync(join(tmpdir(), "so-v62-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", NOW);
    const alex = addApprover(store, "alex", NOW);
    if (!alex.ok) throw new Error("bootstrap");
    store.createTask({ id: "a", title: "work a" }, NOW);
    const ref = store.refFor("built-in", "a").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "a", goal: "do a", acceptance: [{ id: "c1", statement: "a is done", how: null, evidence: ["manual-review"] }], now: NOW });
    expect(approve(store, "a", "alex", NOW, store.getScope("a")!.digest, alex.token).ok).toBe(true);
    register(store, { name: "worker", host: "test", capacity: 1, repos: [REPO], now: NOW, newToken: () => "worker-token" });
    const claim = acquire(store, ref, "worker", { token: "worker-token", now: NOW });
    if (!claim.ok) throw new Error(claim.reason);
    const route = store.routeAuthorityFor(ref, "builder");
    if (!route?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "worker", branch: "b", worktree: "/pool/a", route: route.stamp, now: NOW });
    expect(requestTaskStop(store, { taskId: "a", runId: run, by: "alex", via: "web" }, NOW).ok).toBe(true);
    store.close(); store = undefined;
    const before = windBack(file, version);
    expect(before).toHaveLength(1);

    store = openStore(file);
    expect(SCHEMA_VERSION).toBe(117);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(store.handle.prepare("SELECT * FROM run_stop ORDER BY run").all()).toEqual(before);
    expect(String(store.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'run_stop'").get()?.["sql"])).toContain("'cli','web','telegram'");
    // The queue, its parts and its buttons now live in the shared chat tables (v114): still none.
    for (const table of ["chat_event", "chat_part", "chat_action"]) expect(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE provider = 'telegram'`).get()?.["n"]).toBe(0);
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The widened audit is real: a second stop on another run names the phone.
    expect(() => store!.handle.prepare("INSERT INTO run_stop (run, task_ref, requested_by, requested_via, requested_at) VALUES (?, ?, 'alex', 'telegram', ?)").run(run + 1, ref, NOW.toISOString())).toThrow(/FOREIGN KEY|constraint/);
    store.close(); store = openStore(file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(store.handle.prepare("SELECT * FROM run_stop ORDER BY run").all()).toEqual(before);
  });

  test("a v113 database missing the conversation queue fails closed instead of recreating it", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v62-missing-"));
    const file = join(dir, "orders.db");
    store = openStore(file); store.close(); store = undefined;
    const db = new DatabaseSync(file); addLegacyChatTables(db); db.exec("DROP TABLE telegram_conversation; UPDATE schema_version SET version = 113"); db.close();
    expect(() => openStore(file)).toThrow("Telegram conversation history is missing");
  });

  test("an unrecognized run_stop shape refuses the rebuild rather than guessing", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v62-shape-"));
    const file = join(dir, "orders.db");
    store = openStore(file); store.close(); store = undefined;
    const db = new DatabaseSync(file);
    addLegacyChatTables(db);
    for (const table of tables) db.exec(`DROP TABLE ${table}`);
    db.exec("DROP TABLE run_stop");
    // Every column of v52, but a CHECK list no build ever wrote: plausible, and unknown.
    db.exec(V52_RUN_STOP.replace("requested_via IN ('cli','web')", "requested_via IN ('cli')"));
    db.exec("DROP TABLE service_cursor");
    db.prepare("UPDATE schema_version SET version = 61").run();
    db.close();
    expect(() => openStore(file)).toThrow(/run_stop table's DDL is not a shape this migration knows/);
  });
});
