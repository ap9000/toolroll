/** v187: the phone companion's tables join the versioned schema; the ad hoc shapes earlier builds made are adopted. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V187_STEPS } from "./store.js";
import { V187_DROPPED_TABLES, V187_TABLES } from "./companion/schema.js";
import { getPairedDevice, loadOrCreateCompanionHostKeys } from "./companion/store.js";
import { changedHistory, historySnapshot } from "./toolroll-update.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-27T00:00:00.000Z");

/** The ad hoc DDL builds before v187 ran on first use (companion/store.ts ensureCompanionTables, access.ts). */
const LEGACY_DDL = `
CREATE TABLE IF NOT EXISTS companion_host_keys (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  noise_static_priv TEXT NOT NULL,
  noise_static_pub TEXT NOT NULL,
  relay_priv TEXT NOT NULL,
  relay_pub TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  relay_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companion_paired_device (
  device_id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  device_name TEXT NOT NULL,
  phone_static_pub TEXT NOT NULL,
  device_relay_pub TEXT NOT NULL,
  device_psk TEXT NOT NULL,
  next_device_psk TEXT,
  psk_version INTEGER NOT NULL DEFAULT 1,
  recovery_generation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS companion_push_token (
  device_id TEXT PRIMARY KEY,
  apns_token TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  include_titles INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companion_idempotency (
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_flight', 'completed', 'unknown')),
  outcome_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS companion_access (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    changed_by TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
`;

/** A v186 file holding the ad hoc companion tables: `withGenerations` = the later shape (account_generation and
 * hosted_relay added by ALTER), else the first one. */
function legacyFile(withGenerations: boolean): { file: string; generation: string } {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v187-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.saveApprover("alex", "hash-a", T0);
  made.createTask({ id: "kept", title: "kept" }, T0);
  const generation = made.workspaceIdentity().recoveryGeneration;
  made.close();
  const raw = new DatabaseSync(file);
  for (const table of V187_TABLES) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  raw.exec(LEGACY_DDL);
  if (withGenerations) {
    raw.exec("ALTER TABLE companion_paired_device ADD COLUMN account_generation INTEGER");
    raw.exec("ALTER TABLE companion_access ADD COLUMN hosted_relay TEXT");
  }
  raw.prepare("INSERT INTO companion_host_keys VALUES (1, 'npriv', 'npub', 'rpriv', 'rpub', 'abcdefghijklmnopqrstuvwxyz', 'wss://relay.toolroll.dev/v1/connect', ?)").run(T0.toISOString());
  const insert = withGenerations
    ? raw.prepare("INSERT INTO companion_paired_device (device_id, account_name, device_name, phone_static_pub, device_relay_pub, device_psk, recovery_generation, created_at, revoked_at, account_generation) VALUES (?, 'alex', 'Phone', 'p', 'r', 'k', ?, ?, ?, ?)")
    : raw.prepare("INSERT INTO companion_paired_device (device_id, account_name, device_name, phone_static_pub, device_relay_pub, device_psk, recovery_generation, created_at, revoked_at) VALUES (?, 'alex', 'Phone', 'p', 'r', 'k', ?, ?, ?)");
  const at = T0.toISOString(), gone = new Date(T0.getTime() + 1000).toISOString();
  if (withGenerations) {
    insert.run("dev_live", generation, at, null, 1);
    insert.run("dev_gone", generation, at, gone, 1);
    insert.run("dev_nogen", generation, at, null, null);
  } else {
    insert.run("dev_nogen", generation, at, null);
    insert.run("dev_gone", generation, at, gone);
  }
  raw.prepare("INSERT INTO companion_push_token VALUES ('dev_live', 'apns', 'p256', 'auth', 0, ?)").run(at);
  raw.prepare("INSERT INTO companion_idempotency VALUES ('dev_live', 'k', 'm', 'h', 'completed', NULL, ?)").run(at);
  raw.prepare(withGenerations ? "INSERT INTO companion_access VALUES (1, 1, 'alex', ?, 'wss://relay.toolroll.dev/v1/connect')" : "INSERT INTO companion_access VALUES (1, 1, 'alex', ?)").run(at);
  raw.exec("UPDATE schema_version SET version = 186");
  raw.close();
  return { file, generation };
}

const tableNames = (file: string): string[] => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try { return raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companion_%' ORDER BY name").all().map(row => String(row["name"])); } finally { raw.close(); }
};

describe("v187: the companion's tables", () => {
  test("fresh: the three tables in their v187 shape, nothing retired, classed update-safe", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(187);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(187);
    expect(updateSafeSchema(186)).toBe(true);
    expect(V187_STEPS).toEqual(["companion"]);
    const dir = mkdtempSync(join(tmpdir(), "toolroll-v187-"));
    dirs.push(dir);
    const file = join(dir, "fresh.db");
    openStore(file).close();
    expect(tableNames(file)).toEqual([...V187_TABLES].sort());
    // Reading creates nothing and finds no keys until the engine makes them.
    const store = openStore(file);
    try {
      expect(store.handle.prepare("SELECT count(*) AS n FROM companion_host_keys").get()?.["n"]).toBe(0);
      expect(loadOrCreateCompanionHostKeys(store.handle, T0).machineId).toMatch(/^[a-z2-7]{26}$/);
    } finally { store.close(); }
  });

  for (const withGenerations of [false, true]) {
    test(`adopts the ad hoc shape ${withGenerations ? "with" : "without"} credential generations: rows carried, history unchanged for the update`, () => {
      const { file, generation } = legacyFile(withGenerations);
      const before = (() => { const raw = new DatabaseSync(file, { readOnly: true }); try { return historySnapshot(raw); } finally { raw.close(); } })();
      const store = openStore(file);
      try {
        expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
        expect(store.lookupRef("kept")).not.toBeNull();
        // Host keys copied verbatim (the never-read relay URL dropped).
        expect(store.handle.prepare("SELECT * FROM companion_host_keys").get()).toEqual({
          singleton: 1, noise_static_priv: "npriv", noise_static_pub: "npub", relay_priv: "rpriv", relay_pub: "rpub", machine_id: "abcdefghijklmnopqrstuvwxyz", created_at: T0.toISOString(),
        });
        // A phone without a credential generation is kept but retired (fail closed); a removed one keeps its time.
        expect(getPairedDevice(store.handle, "dev_nogen")).toMatchObject({ accountGeneration: -1, activatedAt: T0.toISOString(), revokedReason: "migration", recoveryGeneration: generation });
        expect(getPairedDevice(store.handle, "dev_nogen")?.revokedAt).not.toBeNull();
        expect(getPairedDevice(store.handle, "dev_gone")).toMatchObject({ revokedAt: new Date(T0.getTime() + 1000).toISOString(), revokedReason: "removed", activatedAt: T0.toISOString() });
        if (withGenerations) expect(getPairedDevice(store.handle, "dev_live")).toMatchObject({ accountGeneration: 1, activatedAt: T0.toISOString(), revokedAt: null, revokedReason: null });
        expect(store.handle.prepare("SELECT enabled, direct_port FROM companion_access").get()).toEqual({ enabled: 1, direct_port: null });
      } finally { store.close(); }
      for (const table of V187_DROPPED_TABLES) expect(tableNames(file)).not.toContain(table);
      const after = new DatabaseSync(file, { readOnly: true });
      try { expect(changedHistory(after, before)).toEqual([]); } finally { after.close(); }
    });
  }

  test("an interrupted run rolls back whole and the next open completes it", () => {
    const { file } = legacyFile(true);
    expect(() => openStore(file, { migrationStep: one => { if (one === "companion") throw new Error("crash"); } })).toThrow(/crash/);
    // Rolled back: the ad hoc shapes are as they were.
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      expect(raw.prepare("PRAGMA table_info(companion_host_keys)").all().map(row => String(row["name"]))).toContain("relay_url");
      expect(raw.prepare("SELECT count(*) AS n FROM companion_push_token").get()?.["n"]).toBe(1);
    } finally { raw.close(); }
    const store = openStore(file);
    try {
      expect(getPairedDevice(store.handle, "dev_live")).toMatchObject({ revokedAt: null, activatedAt: T0.toISOString() });
    } finally { store.close(); }
    expect(tableNames(file)).toEqual([...V187_TABLES].sort());
  });

  test("a companion table in a shape no build made stops the migration; a damaged current file refuses to open", () => {
    const { file } = legacyFile(true);
    const raw = new DatabaseSync(file);
    raw.exec("ALTER TABLE companion_paired_device ADD COLUMN surprise TEXT");
    raw.close();
    expect(() => openStore(file)).toThrow(/companion_paired_device has an unknown shape/);
    expect(() => openStore(file)).toThrow(/unknown shape/);

    const dir = mkdtempSync(join(tmpdir(), "toolroll-v187-"));
    dirs.push(dir);
    const current = join(dir, "current.db");
    openStore(current).close();
    const damage = new DatabaseSync(current);
    damage.exec("ALTER TABLE companion_access ADD COLUMN surprise TEXT");
    damage.close();
    expect(() => openStore(current)).toThrow(/refusing to open — the phone access table companion_access has an unknown shape/);
  });
});
