/** A project's release-approval setting is one indexed seek wherever the approval predicate reads it (0.9.76 walked
 * the project's whole ledger once per task row, on every page's Needs you count). */
import { expect, test } from "vitest";
import { authorityStandsSql } from "./approval-authority.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_APPROVAL_ACTION, releaseApprovalSetting, releaseAuthority, releaseAutoSql, releaseExpiredAt, releaseStateAt } from "./release-authority.js";
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

test("a live release authority past its time reads as expired; an ended one keeps its state", () => {
  const dir = mkdtempSync(join(tmpdir(), "so-authority-"));
  const store = openStore(join(dir, "state.db"));
  try {
    store.handle.exec("PRAGMA foreign_keys = OFF");
    const insert = store.handle.prepare(`INSERT INTO release_authority (repo, generation, version, pr, branch, base, anchor_task, anchor_digest, approved_sha, approved_tree,
        tip_sha, tip_task, policy_json, policy_digest, verify_command, verify_digest, access_digest, state, expires_at, created_at)
      VALUES ('/p', 1, '1.0.0', ?, 'b', 'main', 't', 'd', 's', 'tr', 's', 't', '{}', 'pd', 1, 'vd', 'sandboxed', ?, '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    const read = (pr: number, state: string) => releaseAuthority(store, Number(insert.run(pr, state).lastInsertRowid))!;
    const before = new Date("2026-01-01T12:00:00.000Z"), at = new Date("2026-01-02T00:00:00.000Z"), after = new Date("2026-01-03T00:00:00.000Z");
    for (const [pr, state] of [[1, "open"], [2, "deploying"], [3, "merge-reserved"]] as const) {
      const a = read(pr, state);
      expect(releaseStateAt(a, before)).toBe(state);
      expect(releaseExpiredAt(a, before)).toBe(false);
      // The expiry moment itself counts as past its time, as every reader read it before.
      expect(releaseStateAt(a, at)).toBe("expired");
      expect(releaseStateAt(a, after)).toBe("expired");
      expect(releaseExpiredAt(a, after)).toBe(true);
    }
    for (const [pr, state] of [[4, "merged"], [5, "revoked"], [6, "superseded"]] as const) expect(releaseStateAt(read(pr, state), after)).toBe(state);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
