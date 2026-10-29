/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V125_ADDED_COLUMNS, type Store } from "./store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

const OLD_PROVIDERS = "CHECK (provider IN ('claude','codex','openrouter','gemini'))";
const NEW_PROVIDERS = "CHECK (provider IN ('claude','codex','openrouter','gemini','opencode','cursor','cline','qwen','goose'))";
const OLD_MODES = "CHECK (auth_mode IN ('subscription', 'api-key'))";
const NEW_MODES = "CHECK (auth_mode IN ('subscription', 'api-key', 'agent-login'))";
const WIDENED: readonly (readonly [string, string, string])[] = [
  ["phase_config", NEW_PROVIDERS, OLD_PROVIDERS],
  ["phase_tier_config", NEW_PROVIDERS, OLD_PROVIDERS],
  ["phase_tier_alternate", NEW_PROVIDERS, OLD_PROVIDERS],
  ["provider_readiness", NEW_PROVIDERS, OLD_PROVIDERS],
  ["provider_auth_pause", NEW_MODES, OLD_MODES],
  ["quota", "CHECK (auth_mode IN ('subscription','api-key','agent-login'))", "CHECK (auth_mode IN ('subscription','api-key'))"],
];

/** Put a table back to the shape it had before ACP agents: the same DDL with the narrower CHECK, every row kept. */
function narrow(db: DatabaseSync, table: string, wide: string, old: string): void {
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.["sql"]);
  expect(sql).toContain(wide);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(sql.replace(wide, old).replace(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?"?${table}"?`), `CREATE TABLE ${table}_old`));
  db.exec(`INSERT INTO ${table}_old SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_old RENAME TO ${table}`);
  db.exec("PRAGMA foreign_keys = ON");
}

test.each([124, -124])("v%s: ACP agents become providers — the CHECKs widen, every saved row and id carries over, and opening again changes nothing", version => {
  dir = mkdtempSync(join(tmpdir(), "so-acp-"));
  const file = join(dir, "state.db");
  const first = openStore(file);
  const db0 = first.handle;
  db0.prepare("INSERT INTO runner (name, host, credential_hash, capacity, registered_at, heartbeat_at) VALUES ('mac', 'mac', 'x', 1, 't', 't')").run();
  db0.prepare("INSERT INTO phase_config (scope, phase, provider, model, updated_at, updated_by) VALUES ('installation', 'build', 'claude', 'opus', 't', 'alex')").run();
  db0.prepare("INSERT INTO provider_readiness (runner, provider, state, reason, probe, observed_at) VALUES ('mac', 'codex', 'ready', 'ok', 'version', 't')").run();
  db0.prepare("INSERT INTO provider_auth_pause (provider, ordinal, auth_mode, opened_at) VALUES ('claude', 1, 'subscription', 't')").run();
  db0.prepare("INSERT INTO provider_auth_pause (provider, ordinal, auth_mode, opened_at, lifted_at) VALUES ('codex', 1, 'api-key', 't', 't')").run();
  first.close();

  // The v124 shape: the narrower CHECKs, and no agent-reported usage on a run.
  const db = new DatabaseSync(file);
  for (const [table, wide, old] of WIDENED) narrow(db, table, wide, old);
  for (const [table, columns] of Object.entries(V125_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  // v125's new tables (an ACP agent's checks and billing) don't exist yet either.
  for (const table of ["acp_attestation", "acp_billing"]) db.exec(`DROP TABLE ${table}`);
  // Rows keyed by text, with gaps in their hidden rowids (settings changed and cleared), as a long-lived install has
  // them: the update's history check reads count and highest rowid, so the rebuild must carry rowids whole.
  const keyedByText = ["phase_tier_config", "phase_tier_alternate"];
  for (const table of keyedByText) {
    const tier = table === "phase_tier_config" ? "strong" : "routine";
    const add = db.prepare(`INSERT INTO ${table} (scope, phase, tier, provider, model, updated_at, updated_by) VALUES (?, 'build', ?, 'codex', 'm', 't', 'alex')`);
    for (const scope of ["/a", "/b", "/c", "/d"]) add.run(scope, tier);
    db.prepare(`DELETE FROM ${table} WHERE scope IN ('/a', '/c')`).run();
  }
  const rowids = (handle: DatabaseSync) => keyedByText.map(table => handle.prepare(`SELECT rowid AS id, scope FROM ${table} ORDER BY scope`).all());
  const savedRowids = rowids(db);
  expect(savedRowids.map(rows => rows.map(row => row["id"]))).toEqual([[2, 4], [2, 4]]);
  db.prepare("UPDATE schema_version SET version = ?").run(version);
  expect(() => db.prepare("INSERT INTO phase_config (scope, phase, provider, model, updated_at, updated_by) VALUES ('p', 'build', 'opencode', 'm', 't', 'a')").run()).toThrow(/CHECK/);
  const before = historySnapshot(db);
  db.close();

  expect(updateSafeSchema(124)).toBe(true);
  expect(UPDATE_SAFE_MIGRATIONS).toContain(125);
  expect(SCHEMA_VERSION).toBe(137);
  openStore(file).close();
  const opened = new DatabaseSync(file);
  try {
    // Nothing saved changed: the widening carries every row whole.
    expect(changedHistory(opened, before)).toEqual([]);
    expect(rowids(opened)).toEqual(savedRowids);
  } finally { opened.close(); }

  store = openStore(file);
  const handle = store.handle;
  expect(handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(137);
  for (const table of ["acp_attestation", "acp_billing"]) expect(handle.prepare("SELECT count(*) AS n FROM " + table).get()?.["n"]).toBe(0);
  expect(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'acp_attestation_live'").get()).toBeDefined();
  for (const [table, wide] of WIDENED) {
    expect(String(handle.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.["sql"])).toContain(wide);
  }
  // Saved rows, ids and the counter, whole.
  expect(handle.prepare("SELECT provider, model FROM phase_config").all()).toEqual([{ provider: "claude", model: "opus" }]);
  expect(handle.prepare("SELECT provider, state FROM provider_readiness").all()).toEqual([{ provider: "codex", state: "ready" }]);
  expect(handle.prepare("SELECT id, provider, auth_mode FROM provider_auth_pause ORDER BY id").all()).toEqual([
    { id: 1, provider: "claude", auth_mode: "subscription" },
    { id: 2, provider: "codex", auth_mode: "api-key" },
  ]);
  // The open-pause index the rebuild dropped is back.
  expect(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'provider_auth_pause_open'").get()).toBeDefined();
  expect(() => handle.prepare("INSERT INTO provider_auth_pause (provider, ordinal, auth_mode, opened_at) VALUES ('claude', 2, 'subscription', 't')").run()).toThrow(/UNIQUE/);
  // An ACP agent can now be configured, observed and paused under its own sign-in; a stranger id still can't.
  handle.prepare("INSERT INTO phase_config (scope, phase, provider, model, updated_at, updated_by) VALUES ('/p', 'build', 'opencode', 'opencode/big-pickle', 't', 'alex')").run();
  handle.prepare("INSERT INTO provider_readiness (runner, provider, state, reason, probe, observed_at) VALUES ('mac', 'cursor', 'unavailable', 'not checked', 'version', 't')").run();
  handle.prepare("INSERT INTO provider_auth_pause (provider, ordinal, auth_mode, opened_at) VALUES ('opencode', 1, 'agent-login', 't')").run();
  expect(() => handle.prepare("INSERT INTO phase_config (scope, phase, provider, model, updated_at, updated_by) VALUES ('/q', 'build', 'aider', 'm', 't', 'a')").run()).toThrow(/CHECK/);
  expect(handle.prepare("PRAGMA table_info(run)").all().map(row => row["name"])).toContain("agent_reported_usage_json");
  expect(handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const sequence = handle.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'provider_auth_pause'").get()?.["seq"];
  store.close();
  store = undefined;
  // Opening again is a no-op: the shapes are current and nothing is rebuilt.
  store = openStore(file);
  expect(store.handle.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'provider_auth_pause'").get()?.["seq"]).toBe(sequence);
});

test("a table whose DDL isn't a shape the widening knows is refused, not rebuilt", () => {
  dir = mkdtempSync(join(tmpdir(), "so-acp-"));
  const file = join(dir, "state.db");
  openStore(file).close();
  const db = new DatabaseSync(file);
  narrow(db, "phase_config", NEW_PROVIDERS, `${OLD_PROVIDERS} CHECK (provider IN ('claude','codex','openrouter','gemini'))`);
  db.prepare("UPDATE schema_version SET version = 124").run();
  db.close();
  expect(() => openStore(file)).toThrow(/phase_config table's DDL is not a shape this migration knows/);
});
