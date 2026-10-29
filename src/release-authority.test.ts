/** A project's release-approval setting is one indexed seek wherever the approval predicate reads it (0.9.76 walked
 * the project's whole ledger once per task row, on every page's Needs you count). */
import { expect, test } from "vitest";
import { authorityStandsSql } from "./approval-authority.js";
import { RELEASE_APPROVAL_ACTION, releaseApprovalSetting, releaseAutoSql } from "./release-authority.js";
import { openStore } from "./store.js";

const plan = (store: ReturnType<typeof openStore>, sql: string, ...params: string[]) =>
  store.handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => String(row["detail"])).join("\n");

test("the approval predicate and the setting read seek the setting rows, never the project's ledger", () => {
  const store = openStore(":memory:");
  try {
    const predicate = plan(store, `SELECT ${authorityStandsSql("sc", "r.repo", "?")} FROM task_scope sc JOIN task_ref r ON r.external_id = sc.task_id`, "2026-10-29T00:00:00.000Z");
    expect(predicate).toMatch(/SEARCH ra_set USING (COVERING )?INDEX work_completion \(task_id=\? AND action=\?\)/);
    const setting = plan(store, `SELECT ${releaseAutoSql("?")}`, "/p");
    expect(setting).not.toMatch(/action_ledger_project/);
    expect(setting).toMatch(/USING (COVERING )?INDEX work_completion \(task_id=\? AND action=\?\)/);
  } finally { store.close(); }
});

test("the newest setting row still wins among the project's other ledger rows", () => {
  const store = openStore(":memory:");
  try {
    const row = (at: string, action: string, outcome: string, taskId: string | null = null, repo = "/p") =>
      store.recordAction({ at, actor: "alex", repo, taskId, runId: null, action, outcome, source: "work" });
    for (let n = 0; n < 50; n += 1) row(`2026-10-01T00:00:${String(n).padStart(2, "0")}.000Z`, "task placed", "ok", `t${n}`);
    row("2026-10-02T00:00:00.000Z", RELEASE_APPROVAL_ACTION, "auto");
    row("2026-10-02T00:00:01.000Z", RELEASE_APPROVAL_ACTION, "auto", "t1");
    row("2026-10-02T00:00:02.000Z", RELEASE_APPROVAL_ACTION, "auto", null, "/other");
    expect(releaseApprovalSetting(store, "/p")).toMatchObject({ auto: true, at: "2026-10-02T00:00:00.000Z" });
    row("2026-10-03T00:00:00.000Z", RELEASE_APPROVAL_ACTION, "ask");
    expect(releaseApprovalSetting(store, "/p").auto).toBe(false);
    expect(releaseApprovalSetting(store, "/other").auto).toBe(true);
  } finally { store.close(); }
});
