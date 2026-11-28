/**
 * v187: the companion's tables (docs/plans/companion-app/noise-relay-protocol.md), made by the versioned migration only.
 * Nothing at run time creates or alters them: a read finds them (every opened store is at this version) or the store
 * refused to open.
 *
 * - companion_access: whether phone access is on, the hosted relay that was approved, and the direct listener's last
 *   bound port.
 * - companion_host_keys: this Mac's Noise static key and relay identity (one row).
 * - companion_paired_device: each paired phone. A row starts PENDING (activated_at NULL) when the owner confirms, and
 *   is activated by the phone's pair.done or first session hello within 10 minutes; a pending row nobody activated is
 *   deleted. A retired phone keeps its row (and keys) as a tombstone for 30 days, with why (revoked_reason), so its next
 *   connection gets an authenticated refusal; then the row is deleted.
 *
 * Legacy adoption: builds before v187 made these tables ad hoc on first use, in a few shapes. Each shape is recognised
 * by its exact columns and carried over (adoptLegacyCompanion); a table under one of these names in any other shape
 * stops the migration rather than being guessed at.
 */
import type { Database } from "../store.js";

export const COMPANION_RETIRED_REASONS = ["removed", "password_changed", "access_changed", "restored", "migration", "contested", "pairing_failed"] as const;

export const V187_SCHEMA = `
CREATE TABLE IF NOT EXISTS companion_access (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  hosted_relay TEXT,
  direct_port INTEGER
);
CREATE TABLE IF NOT EXISTS companion_host_keys (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  noise_static_priv TEXT NOT NULL,
  noise_static_pub TEXT NOT NULL,
  relay_priv TEXT NOT NULL,
  relay_pub TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companion_paired_device (
  device_id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  device_name TEXT NOT NULL,
  phone_static_pub TEXT NOT NULL,
  device_relay_pub TEXT NOT NULL,
  device_psk TEXT NOT NULL,
  recovery_generation TEXT NOT NULL,
  account_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('removed', 'password_changed', 'access_changed', 'restored', 'migration', 'contested', 'pairing_failed')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
`;

/** The v187 migration's steps, in order (a test seam may stop at each; it runs inside the step's transaction). */
export const V187_STEPS = Object.freeze(["companion"] as const);

/** v187's tables, as a current file holds them. */
export const V187_TABLES = Object.freeze(["companion_access", "companion_host_keys", "companion_paired_device"] as const);

/** Tables builds before v187 made and v187 removes (no code reads them). */
export const V187_DROPPED_TABLES = Object.freeze(["companion_push_token", "companion_idempotency"] as const);

/** A column as PRAGMA table_info reports it: name, declared type, NOT NULL, primary-key position. */
type Column = readonly [name: string, type: string, notNull: 0 | 1, pk: number];
const shapeOf = (columns: readonly Column[]): string => JSON.stringify(columns);

function columnsOf(db: Database, table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .map(row => [String(row["name"]), String(row["type"]).toUpperCase(), Number(row["notnull"]) === 1 ? 1 : 0, Number(row["pk"])] as const);
}

const tableExists = (db: Database, table: string): boolean =>
  db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

const ACCESS_BASE: Column[] = [["singleton", "INTEGER", 0, 1], ["enabled", "INTEGER", 1, 0], ["changed_by", "TEXT", 1, 0], ["changed_at", "TEXT", 1, 0]];
const ACCESS_V187: Column[] = [...ACCESS_BASE, ["hosted_relay", "TEXT", 0, 0], ["direct_port", "INTEGER", 0, 0]];
/** companion_access as builds before v187 made it: the switch alone, then with the approved relay. */
const ACCESS_LEGACY = [shapeOf(ACCESS_BASE), shapeOf([...ACCESS_BASE, ["hosted_relay", "TEXT", 0, 0]])];

const HOST_KEYS_V187: Column[] = [["singleton", "INTEGER", 0, 1], ["noise_static_priv", "TEXT", 1, 0], ["noise_static_pub", "TEXT", 1, 0],
  ["relay_priv", "TEXT", 1, 0], ["relay_pub", "TEXT", 1, 0], ["machine_id", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0]];
const HOST_KEYS_LEGACY = shapeOf([...HOST_KEYS_V187.slice(0, 6), ["relay_url", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0]]);

const DEVICE_V187: Column[] = [["device_id", "TEXT", 0, 1], ["account_name", "TEXT", 1, 0], ["device_name", "TEXT", 1, 0], ["phone_static_pub", "TEXT", 1, 0],
  ["device_relay_pub", "TEXT", 1, 0], ["device_psk", "TEXT", 1, 0], ["recovery_generation", "TEXT", 1, 0], ["account_generation", "INTEGER", 1, 0],
  ["created_at", "TEXT", 1, 0], ["activated_at", "TEXT", 0, 0], ["last_seen_at", "TEXT", 0, 0], ["revoked_at", "TEXT", 0, 0], ["revoked_reason", "TEXT", 0, 0]];
const DEVICE_LEGACY_BASE: Column[] = [["device_id", "TEXT", 0, 1], ["account_name", "TEXT", 1, 0], ["device_name", "TEXT", 1, 0], ["phone_static_pub", "TEXT", 1, 0],
  ["device_relay_pub", "TEXT", 1, 0], ["device_psk", "TEXT", 1, 0], ["next_device_psk", "TEXT", 0, 0], ["psk_version", "INTEGER", 1, 0],
  ["recovery_generation", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0], ["last_seen_at", "TEXT", 0, 0], ["revoked_at", "TEXT", 0, 0]];
/** companion_paired_device as builds before v187 made it: without, then with, the account's credential generation. */
const DEVICE_LEGACY = { base: shapeOf(DEVICE_LEGACY_BASE), generation: shapeOf([...DEVICE_LEGACY_BASE, ["account_generation", "INTEGER", 0, 0]]) };

const DROPPED_SHAPES: Record<(typeof V187_DROPPED_TABLES)[number], string> = {
  companion_push_token: shapeOf([["device_id", "TEXT", 0, 1], ["apns_token", "TEXT", 1, 0], ["p256dh", "TEXT", 1, 0], ["auth_secret", "TEXT", 1, 0],
    ["include_titles", "INTEGER", 1, 0], ["updated_at", "TEXT", 1, 0]]),
  companion_idempotency: shapeOf([["device_id", "TEXT", 1, 1], ["idempotency_key", "TEXT", 1, 2], ["method", "TEXT", 1, 0], ["request_hash", "TEXT", 1, 0],
    ["state", "TEXT", 1, 0], ["outcome_json", "TEXT", 0, 0], ["updated_at", "TEXT", 1, 0]]),
};

const TARGET: Record<(typeof V187_TABLES)[number], string> = {
  companion_access: shapeOf(ACCESS_V187),
  companion_host_keys: shapeOf(HOST_KEYS_V187),
  companion_paired_device: shapeOf(DEVICE_V187),
};

/** The v187 tables as a current (or resumed) file must hold them: each there in exactly this build's shape, and the
 * removed ones gone. Null when they are; else what is wrong, in words. */
export function companionShapeProblem(db: Database): string | null {
  for (const table of V187_TABLES) {
    if (!tableExists(db, table)) return `the phone access table ${table} is missing`;
    if (shapeOf(columnsOf(db, table)) !== TARGET[table]) return `the phone access table ${table} has an unknown shape`;
  }
  for (const table of V187_DROPPED_TABLES) if (tableExists(db, table)) return `the retired phone access table ${table} is still here`;
  return null;
}

/** One rebuild: the table under a temporary name in its v187 shape, every row copied (its rowid carried, so the
 * update's history check finds the same rows), the old one dropped and the new one renamed into place. */
function rebuild(db: Database, table: string, ddl: string, columns: readonly string[], select: readonly string[]): void {
  const next = `${table}_v187`;
  db.exec(`DROP TABLE IF EXISTS ${next}`);
  db.exec(ddl.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${next} (`));
  db.exec(`INSERT INTO ${next} (rowid, ${columns.join(", ")}) SELECT rowid, ${select.join(", ")} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${next} RENAME TO ${table}`);
}

const ddlOf = (table: string): string => {
  const statement = V187_SCHEMA.split(/;\s*\n/).map(one => one.trim()).find(one => one.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
  if (statement === undefined) throw new Error(`no v187 DDL for ${table}`);
  return statement;
};

/**
 * Carries the ad hoc companion tables of builds before v187 into the v187 shape, then makes whatever is missing.
 * Idempotent: a table already in its v187 shape is left alone. Throws (the caller rolls the step back) on a shape it
 * can't name.
 *
 * - companion_access: the approved relay and the direct port are added (saved rows read none).
 * - companion_host_keys: copied verbatim, without the never-read relay_url.
 * - companion_paired_device: every row copied, activated as of when it was paired; PSK-rotation columns that were never
 *   used are dropped. A row with no credential generation (paired before generations were kept) is kept but retired
 *   ('migration'): it can't be proved to belong to the account as it stands now — fail closed. An already-retired row
 *   keeps its time, as 'removed'.
 * - companion_push_token, companion_idempotency: dropped (nothing reads them).
 */
export function adoptLegacyCompanion(db: Database, now: Date): void {
  if (tableExists(db, "companion_access")) {
    const shape = shapeOf(columnsOf(db, "companion_access"));
    if (shape !== TARGET.companion_access) {
      if (!ACCESS_LEGACY.includes(shape)) throw new Error("the phone access table companion_access has an unknown shape; refusing to adopt it");
      if (!columnsOf(db, "companion_access").some(([name]) => name === "hosted_relay")) db.exec("ALTER TABLE companion_access ADD COLUMN hosted_relay TEXT");
      db.exec("ALTER TABLE companion_access ADD COLUMN direct_port INTEGER");
    }
  }
  if (tableExists(db, "companion_host_keys")) {
    const shape = shapeOf(columnsOf(db, "companion_host_keys"));
    if (shape !== TARGET.companion_host_keys) {
      if (shape !== HOST_KEYS_LEGACY) throw new Error("the phone access table companion_host_keys has an unknown shape; refusing to adopt it");
      const columns = HOST_KEYS_V187.map(([name]) => name);
      rebuild(db, "companion_host_keys", ddlOf("companion_host_keys"), columns, columns);
    }
  }
  if (tableExists(db, "companion_paired_device")) {
    const shape = shapeOf(columnsOf(db, "companion_paired_device"));
    if (shape !== TARGET.companion_paired_device) {
      if (shape !== DEVICE_LEGACY.base && shape !== DEVICE_LEGACY.generation) {
        throw new Error("the phone access table companion_paired_device has an unknown shape; refusing to adopt it");
      }
      const generation = shape === DEVICE_LEGACY.generation ? "account_generation" : "NULL";
      const stamp = `'${now.toISOString()}'`;
      const columns = DEVICE_V187.map(([name]) => name);
      const select = columns.map(name => {
        switch (name) {
          // -1 is no account's generation: a row without one stands for nobody (it is retired below anyway).
          case "account_generation": return `COALESCE(${generation}, -1)`;
          case "activated_at": return "created_at";
          case "revoked_at": return `CASE WHEN revoked_at IS NOT NULL THEN revoked_at WHEN ${generation} IS NULL THEN ${stamp} ELSE NULL END`;
          case "revoked_reason": return `CASE WHEN revoked_at IS NOT NULL THEN 'removed' WHEN ${generation} IS NULL THEN 'migration' ELSE NULL END`;
          default: return name;
        }
      });
      rebuild(db, "companion_paired_device", ddlOf("companion_paired_device"), columns, select);
    }
  }
  for (const table of V187_DROPPED_TABLES) {
    if (!tableExists(db, table)) continue;
    if (shapeOf(columnsOf(db, table)) !== DROPPED_SHAPES[table]) throw new Error(`the retired phone access table ${table} has an unknown shape; refusing to drop it`);
    db.exec(`DROP TABLE ${table}`);
  }
  db.exec(V187_SCHEMA);
}

/**
 * v188 (ADR 0005 / Gate 2): WebAuthn Passkeys for phone approvals, single-use verb-specific challenges, and
 * mutation idempotency tracking. All three tables are wiped unconditionally on backup restore (ADR 0001).
 */
export const V188_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_passkeys (
  credential_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  public_key_spki TEXT NOT NULL,
  sign_count INTEGER NOT NULL CHECK (sign_count >= 0),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  recovery_generation TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_passkeys_owner ON account_passkeys (workspace_id, account_name, recovery_generation);
CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'approve', 'accept', 'land', 'ship')),
  workspace_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  recovery_generation TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expires ON passkey_challenges (expires_at);
CREATE TABLE IF NOT EXISTS device_idempotency (
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_flight', 'completed', 'unknown')),
  outcome_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_device_idempotency_updated ON device_idempotency (device_id, state, updated_at);
CREATE TABLE IF NOT EXISTS passkey_approval_policy (
  scope TEXT PRIMARY KEY,
  required INTEGER NOT NULL CHECK (required IN (0, 1))
);
`;

export const V188_STEPS = Object.freeze(["companion-passkey"] as const);
export const V188_TABLES = Object.freeze(["account_passkeys", "passkey_challenges", "device_idempotency", "passkey_approval_policy"] as const);

const PASSKEYS_V188: Column[] = [
  ["credential_id", "TEXT", 0, 1], ["workspace_id", "TEXT", 1, 0], ["account_name", "TEXT", 1, 0],
  ["user_handle", "TEXT", 1, 0], ["public_key_spki", "TEXT", 1, 0], ["sign_count", "INTEGER", 1, 0],
  ["label", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0], ["last_used_at", "TEXT", 0, 0],
  ["recovery_generation", "TEXT", 1, 0], ["revoked_at", "TEXT", 0, 0],
];
const CHALLENGES_V188: Column[] = [
  ["challenge", "TEXT", 0, 1], ["kind", "TEXT", 1, 0], ["workspace_id", "TEXT", 1, 0],
  ["account_name", "TEXT", 1, 0], ["device_id", "TEXT", 1, 0], ["recovery_generation", "TEXT", 1, 0],
  ["binding_json", "TEXT", 1, 0], ["expires_at", "TEXT", 1, 0], ["consumed_at", "TEXT", 0, 0],
];
const IDEMPOTENCY_V188: Column[] = [
  ["device_id", "TEXT", 1, 1], ["idempotency_key", "TEXT", 1, 2], ["method", "TEXT", 1, 0],
  ["request_hash", "TEXT", 1, 0], ["state", "TEXT", 1, 0], ["outcome_json", "TEXT", 0, 0],
  ["updated_at", "TEXT", 1, 0],
];
const POLICY_V188: Column[] = [
  ["scope", "TEXT", 0, 1], ["required", "INTEGER", 1, 0],
];

const TARGET_V188: Record<(typeof V188_TABLES)[number], string> = {
  account_passkeys: shapeOf(PASSKEYS_V188),
  passkey_challenges: shapeOf(CHALLENGES_V188),
  device_idempotency: shapeOf(IDEMPOTENCY_V188),
  passkey_approval_policy: shapeOf(POLICY_V188),
};

export function companionPasskeyShapeProblem(db: Database): string | null {
  for (const table of V188_TABLES) {
    if (!tableExists(db, table)) return `the passkey approval table ${table} is missing`;
    if (shapeOf(columnsOf(db, table)) !== TARGET_V188[table]) return `the passkey approval table ${table} has an unknown shape`;
  }
  return null;
}
