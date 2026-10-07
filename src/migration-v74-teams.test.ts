/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, DECISION_V68_DDL_FOR_TESTS, RUN_STOP_V68_DDL_FOR_TESTS, type Store } from "./store.js";
import { chatTables } from "./chat-delivery-state.js";

describe("v74 Teams joins the recorded surfaces", () => {
  let dir: string, store: Store | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

  function fixture(version: number) {
    dir = mkdtempSync(join(tmpdir(), "so-v74-"));
    const file = join(dir, "state.db");
    store = openStore(file);
    store.createTask({ id: "sample", title: "Preserve history" }, new Date());
    const ref = store.refFor("built-in", "sample").id;
    const run = store.startRun({ taskRef: ref, leaseId: "history", runner: "fixture", branch: "fixture", worktree: "/fixture",
      route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
    store.close(); store = undefined;
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF");
    // The v68..v73 shape: Discord named, Teams not yet.
    db.exec("DROP TABLE decision; DROP TABLE run_stop;");
    db.exec(DECISION_V68_DDL_FOR_TESTS("decision"));
    db.exec(RUN_STOP_V68_DDL_FOR_TESTS("run_stop"));
    for (const name of [...chatTables("teams")].reverse()) db.exec(`DROP TABLE IF EXISTS ${name}`);
    db.exec("DROP TABLE IF EXISTS teams_room; DROP TABLE IF EXISTS teams_meta");
    db.prepare("INSERT INTO run_stop(run,task_ref,requested_by,requested_via,requested_at) VALUES(?,?,'operator','discord','2026-09-21')").run(run, ref);
    db.prepare("INSERT INTO decision(run,urgency,state,recap,question,options,recommendation,created_at,answered_via) VALUES(?,'blocking','answered','recap','question','[]','one','2026-09-21','discord')").run(run);
    db.prepare("UPDATE schema_version SET version=?").run(version);
    const stops = db.prepare("SELECT * FROM run_stop").all(), decisions = db.prepare("SELECT * FROM decision").all();
    db.close();
    return { file, run, ref, stops, decisions };
  }

  test.each([73, -73])("upgrades v%s without changing existing rows and records Teams separately", version => {
    const f = fixture(version);
    store = openStore(f.file);
    expect(SCHEMA_VERSION).toBe(111);
    expect(store.handle.prepare("SELECT * FROM run_stop").all()).toEqual(f.stops);
    expect(store.handle.prepare("SELECT * FROM decision").all()).toEqual(f.decisions);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(SCHEMA_VERSION);
    store.handle.prepare("UPDATE run_stop SET requested_via='teams' WHERE run=?").run(f.run);
    store.handle.prepare("UPDATE decision SET answered_via='teams' WHERE run=?").run(f.run);
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name='run_stop_by_task'").get()).toBeDefined();
    for (const name of chatTables("teams")) expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name)).toBeDefined();
    expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name='teams_room'").get()).toBeDefined();
    store.close(); store = openStore(f.file);
    expect(store.handle.prepare("SELECT requested_via FROM run_stop").get()?.requested_via).toBe("teams");
  });

  test.each(["decision", "run_stop"])("refuses an unrecognized %s table instead of stripping columns", table => {
    const f = fixture(73);
    const db = new DatabaseSync(f.file);
    db.exec(`ALTER TABLE ${table} ADD COLUMN unexpected TEXT`);
    db.close();
    expect(() => openStore(f.file)).toThrow(/DDL is not a shape/);
  });
});
