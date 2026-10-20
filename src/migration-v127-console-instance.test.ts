/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readInstance, recordInstance } from "./console-instance.js";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";
import { fakePid } from "../test/fake-pid.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([126, -126])("v%s: the running console's instance record is added; every saved row stays as it was", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v127-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-20T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "t-1", title: "kept" }, now);
  first.close();
  // The v126 shape: no instance record.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE console_instance");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(126)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(127);
  expect(SCHEMA_VERSION).toBe(127);
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(127);
  // Nothing recorded until a console starts; then it can be.
  expect(readInstance(store)).toBeNull();
  recordInstance(store, { pid: fakePid(1), port: 4180, build: "test" }, now);
  expect(readInstance(store)?.port).toBe(4180);
  expect(store.getTask("t-1")?.title).toBe("kept");
  store.close();
  store = undefined;
  const after = new DatabaseSync(file);
  try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
});
