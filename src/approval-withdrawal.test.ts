// The one approval withdrawal (withdrawApproval) leaves task_scope exactly as each of the four statements it replaced did:
// the same rows matched and the same columns written, nothing more.
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, withdrawApproval, type Store } from "./store.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const one of stores.splice(0)) one.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A store on a temp file with four approved scopes under different bases, every approval column filled. */
function seeded(): Store {
  const dir = mkdtempSync(join(tmpdir(), "so-withdraw-"));
  dirs.push(dir);
  const store = openStore(join(dir, "state.db"));
  stores.push(store);
  const db = store.handle;
  db.exec("PRAGMA foreign_keys = OFF");
  const insert = db.prepare(`INSERT INTO task_scope (task_id, goal, proposed_at, digest, approved_at, approved_by, approved_digest,
      approved_profile_json, approved_route_json, approved_chain_json, approval_basis, mode_digest)
    VALUES (?, 'goal', '2026-01-01T00:00:00.000Z', 'd', '2026-01-01T00:00:00.000Z', 'alex', 'd', '{"p":1}', '{"r":1}', '{"c":1}', ?, 'm')`);
  for (const [id, basis] of [["t-auto", "auto-green"], ["t-check", "auto-check"], ["t-mode", "mode"], ["t-pass", "password"]] as const) insert.run(id, basis);
  return store;
}

const snapshot = (store: Store) => store.handle.prepare("SELECT * FROM task_scope ORDER BY task_id").all();

/** Run the old statement on one store and the one function on a twin; both tables must come out identical. */
function same(old: string, oldArgs: readonly (string | null)[], call: (store: Store) => number, changed: number): void {
  const before = seeded(), after = seeded();
  before.handle.prepare(old).run(...oldArgs);
  expect(call(after)).toBe(changed);
  expect(snapshot(after)).toEqual(snapshot(before));
}

describe("withdrawApproval matches each statement it replaced", () => {
  test("automatic release seal taken back (release-auto unseal)", () => {
    for (const task of ["t-auto", "t-mode"]) {
      same(`UPDATE task_scope SET approved_at = NULL, approved_by = NULL, approved_digest = NULL, approved_profile_json = NULL,
          approved_route_json = NULL, approval_basis = NULL, mode_digest = NULL WHERE task_id = ? AND approval_basis IN ('auto-check', 'auto-green')`, [task],
        store => withdrawApproval(store, { where: "WHERE task_id = ? AND approval_basis IN ('auto-check', 'auto-green')", args: [task] }, { basisAfter: null, clearRoute: true, clearModeDigest: true }),
        task === "t-auto" ? 1 : 0);
    }
  });

  test("fast start that did not start in time (fast-start), mode_digest kept", () => {
    same("UPDATE task_scope SET approved_at = NULL, approved_by = NULL, approved_digest = NULL, approved_profile_json = NULL, approved_route_json = NULL, approval_basis = NULL WHERE task_id = ?", ["t-pass"],
      store => withdrawApproval(store, { where: "WHERE task_id = ?", args: ["t-pass"] }, { basisAfter: null, clearRoute: true, clearModeDigest: false }), 1);
  });

  test("mode or flow grant ended (store demotions): back to a password, approved route kept", () => {
    same(`UPDATE task_scope SET approved_at = NULL, approved_by = NULL, approved_digest = NULL,
          approved_profile_json = NULL, approval_basis = 'password', mode_digest = NULL WHERE approval_basis = 'mode' AND mode_digest = ?`, ["m"],
      store => withdrawApproval(store, { where: "WHERE approval_basis = 'mode' AND mode_digest = ?", args: ["m"] }, { basisAfter: "password", clearRoute: false, clearModeDigest: true }), 1);
  });

  test("no withdrawal touches the chain snapshot or a row outside its WHERE", () => {
    const store = seeded();
    withdrawApproval(store, { where: "WHERE task_id = ?", args: ["t-check"] }, { basisAfter: null, clearRoute: true, clearModeDigest: true });
    const rows = snapshot(store) as Record<string, unknown>[];
    expect(rows.find(row => row["task_id"] === "t-check")?.["approved_chain_json"]).toBe('{"c":1}');
    expect(rows.filter(row => row["approved_at"] !== null).map(row => row["task_id"])).toEqual(["t-auto", "t-mode", "t-pass"]);
  });
});
