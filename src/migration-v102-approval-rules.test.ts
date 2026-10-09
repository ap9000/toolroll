/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

test.each([101, -101])("v%s: tasks filed before keep working with no filer; rules and approvals have somewhere to live", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v102-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-09-28T12:00:00.000Z");
  const first = openStore(file);
  first.createTask({ id: "old-task", title: "filed before v102" }, now);
  first.close();
  // The v101 shape: no filer columns, no rules, no approvals kept per person.
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE approval_policy; DROP TABLE scope_approval_vote; DROP TABLE scope_author; ALTER TABLE task_ref DROP COLUMN filed_by; ALTER TABLE task_ref DROP COLUMN filed_by_kind");
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(117);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(117);
  expect(store.taskFiler("old-task")).toBeNull();
  expect(store.approvalRules("/repo/main")).toMatchObject({ notRequester: false, protectProject: false, protectedPaths: [] });
  store.setApprovalRules("/repo/main", { notRequester: true, protectProject: false, protectedPaths: ["infra/**"] }, "alex", now);
  expect(store.approvalRules("/repo/main")).toMatchObject({ notRequester: true, protectedPaths: ["infra/**"] });
  store.createTask({ id: "new-task", title: "filed after", filedBy: { name: "alex", kind: "person" } }, now);
  expect(store.taskFiler("new-task")).toEqual({ name: "alex", kind: "person" });
  store.recordApprovalVote("new-task", "d1", "alex", now);
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM scope_approval_vote").get()?.n).toBe(1);
  store.recordScopeAuthor("new-task", "d1", "sam", now);
  expect(store.handle.prepare("SELECT author FROM scope_author").get()?.author).toBe("sam");
});
