import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addLegacyChatTables } from "../test/legacy-chat.js";
import { legacyAppTables } from "./chat-migration.js";
const SLACK_TABLES = legacyAppTables("slack");
describe("v67 Slack audit and durable delivery", () => {
  let dir: string, store: Store | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  function fixture(version = 66) {
    dir = mkdtempSync(join(tmpdir(), "so-v67-"));
    const file = join(dir, "state.db");
    store = openStore(file);
    store.createTask({ id: "sample", title: "Preserve history" }, new Date());
    const ref = store.refFor("built-in", "sample").id;
    const run = store.startRun({
      taskRef: ref,
      leaseId: "history",
      runner: "fixture",
      branch: "fixture",
      worktree: "/fixture",
      route: {
        routeDigest: "legacy",
        phase: "build",
        provider: "claude",
        model: null,
        chosen: "legacy",
      },
      now: new Date(),
    });
    store.close();
    store = undefined;
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF");
    addLegacyChatTables(db);
    db.exec("DROP TABLE decision; DROP TABLE run_stop;");
    db.exec(
      readFileSync(
        join(import.meta.dirname, "fixtures/v66-chat-audit.sql"),
        "utf8",
      ),
    );
    for (const name of [...SLACK_TABLES].reverse())
      db.exec(`DROP TABLE ${name}`);
    db.prepare(
      "INSERT INTO run_stop(run,task_ref,requested_by,requested_via,requested_at) VALUES(?,?,'operator','telegram','2026-09-17')",
    ).run(run, ref);
    db.prepare(
      "INSERT INTO decision(run,urgency,state,recap,question,options,recommendation,created_at,answered_via) VALUES(?,'blocking','answered','recap','question','[]','one','2026-09-17','telegram')",
    ).run(run);
    db.exec("DROP TABLE service_cursor");
    db.prepare("UPDATE schema_version SET version=?").run(version);
    const stops = db.prepare("SELECT * FROM run_stop").all(),
      decisions = db.prepare("SELECT * FROM decision").all();
    db.close();
    return { file, run, ref, stops, decisions };
  }
  test.each([66, -66])(
    "upgrades v%s without changing existing rows and records Slack separately",
    (version) => {
      const f = fixture(version);
      store = openStore(f.file);
      expect(store.handle.prepare("SELECT * FROM run_stop").all()).toEqual(
        f.stops,
      );
      expect(store.handle.prepare("SELECT * FROM decision").all()).toEqual(
        f.decisions,
      );
      expect(
        store.handle.prepare("SELECT version FROM schema_version").get()
          ?.version,
      ).toBe(SCHEMA_VERSION);
      store.handle
        .prepare("UPDATE run_stop SET requested_via='slack' WHERE run=?")
        .run(f.run);
      store.handle
        .prepare("UPDATE decision SET answered_via='slack' WHERE run=?")
        .run(f.run);
      expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual(
        [],
      );
      expect(
        store.handle
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='decision_attention'",
          )
          .get(),
      ).toBeDefined();
      expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name='run_stop_by_task'").get()).toBeDefined();
      store.close();
      store = openStore(f.file);
      expect(
        store.handle.prepare("SELECT requested_via FROM run_stop").get()
          ?.requested_via,
      ).toBe("slack");
    },
  );
  test.each(["decision", "run_stop"])(
    "refuses an unrecognized %s table instead of stripping columns",
    (table) => {
      const f = fixture();
      const db = new DatabaseSync(f.file);
      db.exec(`ALTER TABLE ${table} ADD COLUMN unexpected TEXT`);
      db.close();
      expect(() => openStore(f.file)).toThrow(/DDL is not a shape/);
      const inspect = new DatabaseSync(f.file);
      expect(
        inspect
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === "unexpected"),
      ).toBe(true);
      inspect.close();
    },
  );
  test("a v113 file missing a Slack receipt table refuses before the epoch changes", () => {
    const f = fixture();
    store = openStore(f.file);
    store.close();
    store = undefined;
    const db = new DatabaseSync(f.file);
    addLegacyChatTables(db);
    db.exec("DROP TABLE slack_part; UPDATE schema_version SET version = 113");
    db.close();
    expect(() => openStore(f.file)).toThrow(/Slack history is missing/);
    const inspect = new DatabaseSync(f.file);
    expect(
      inspect.prepare("SELECT version FROM schema_version").get()?.version,
    ).toBe(113);
    inspect.close();
  });
});
