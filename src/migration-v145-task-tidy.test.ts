/** v145 (docs/plans/task-tidy.md) only adds tables: every saved task reads as not put away, and no saved row changes.
 * Isolated databases only. */
import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, taskArchived, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS } from "./store.js";
import { historySnapshot, changedHistory } from "./toolroll-update.js";

test.each([144, -144])("v%s tasks survive the put-away tables, none of them put away", version => {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v145-tidy-"));
  const file = join(dir, "state.db"), now = new Date("2026-11-01T00:00:00Z");
  try {
    const first = openStore(file);
    first.createTask({ id: "release-1.0.0-aaaaaaa", title: "Release 1.0.0" }, now);
    first.createTask({ id: "site-oct-30", title: "Is the site current? — Oct 30" }, now);
    first.close();
    const old = new DatabaseSync(file);
    old.exec("DROP TABLE task_archive; DROP TABLE branch_check_run; DROP TABLE merge_in_flight; DROP TABLE deploy_in_flight; DROP TABLE flow_step_task;");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    const before = historySnapshot(old);
    old.close();
    const migrated = openStore(file);
    expect(SCHEMA_VERSION).toBe(160);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(145);
    expect(migrated.getTask("site-oct-30")?.title).toBe("Is the site current? — Oct 30");
    expect(taskArchived(migrated, "site-oct-30")).toBe(false);
    expect(taskArchived(migrated, "release-1.0.0-aaaaaaa")).toBe(false);
    expect(migrated.handle.prepare("SELECT COUNT(*) n FROM branch_check_run").get()?.["n"]).toBe(0);
    migrated.close();
    const after = new DatabaseSync(file);
    try {
      expect(after.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(160);
      expect(changedHistory(after, before)).toEqual([]);
      expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
