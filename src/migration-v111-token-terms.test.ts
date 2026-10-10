/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, type Store } from "./store.js";
import { tokenLive } from "./api-tokens.js";
import { toV117 } from "../test/pre-v118.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const COLUMNS = ["projects_json", "replaces", "replaced_by", "overlap_until"];

test.each([110, -110])("v%s: every API token carries over unchanged, unlimited and unrotated, and limits and rotations have somewhere to live", version => {
  dir = mkdtempSync(join(tmpdir(), "so-v111-"));
  const file = join(dir, "state.db");
  const now = new Date("2026-10-06T17:00:00.000Z");
  const first = openStore(file);
  first.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES ('alex', 'x', ?, 'approver', 1)").run(now.toISOString());
  first.createApiToken({ id: "abcdef012345", account: "alex", name: "ci", secretHash: "0".repeat(64), access: "act", expiresAt: "2027-01-01T00:00:00.000Z", by: "alex" }, now);
  first.touchApiToken("abcdef012345", now);
  first.close();
  // The v110 shape: api_token (v118 merges it into credential) without the v111 columns.
  const db = new DatabaseSync(file);
  toV117(db);
  for (const column of COLUMNS) db.exec(`ALTER TABLE api_token DROP COLUMN ${column}`);
  const before = db.prepare("SELECT * FROM api_token").all();
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  db.close();

  expect(updateSafeSchema(110)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(111);
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(118);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(118);
  // The saved row is as it was, and reads as every-project, unrotated and live.
  const after = store.handle.prepare(`SELECT id, account, name, secret_hash, access, created_at, created_by, expires_at, last_used_at, revoked_at, revoked_by, purpose,
    projects_json, replaces, replaced_by, overlap_until FROM credential WHERE kind = 'person'`).all();
  expect(after.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !COLUMNS.includes(key))))).toEqual(before.map(row => ({ ...row })));
  for (const row of after) for (const column of COLUMNS) expect(row[column]).toBeNull();
  const kept = store.apiTokenSecret("abcdef012345")!.row;
  expect(kept).toMatchObject({ projects: null, replaces: null, replacedBy: null, overlapUntil: null, lastUsedAt: now.toISOString() });
  expect(tokenLive(kept, now.getTime())).toBe(true);
  // A limited token and a rotation now fit.
  store.createApiToken({ id: "0123456789ab", account: "alex", name: "shop", secretHash: "1".repeat(64), access: "read", expiresAt: "2027-01-01T00:00:00.000Z", by: "alex", projects: ["/srv/shop"] }, now);
  expect(store.apiTokenSecret("0123456789ab")!.row.projects).toEqual(["/srv/shop"]);
  expect(store.rotateApiToken("abcdef012345", { id: "fedcba987654", secretHash: "2".repeat(64) }, "alex", now, 600_000)).toMatchObject({ ok: true, row: { replaces: "abcdef012345", expiresAt: "2027-01-01T00:00:00.000Z" } });
  // An unreadable stored limit narrows to nothing, never to every project.
  store.handle.prepare("UPDATE credential SET projects_json = 'not json' WHERE id = '0123456789ab'").run();
  expect(store.apiTokenSecret("0123456789ab")!.row.projects).toEqual([]);
  // A second open changes nothing.
  store.close();
  const shape = () => new DatabaseSync(file).prepare("SELECT sql FROM sqlite_master WHERE name = 'credential'").get()?.["sql"];
  const sql = shape();
  store = openStore(file);
  store.close(); store = undefined;
  expect(shape()).toBe(sql);
});
