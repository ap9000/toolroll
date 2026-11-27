/**
 * SQLite persistence for Toolroll Companion paired devices, host keys, push subscriptions,
 * and mutation idempotency (`docs/plans/companion-app/threat-model-and-routes.md` & `noise-relay-protocol.md`).
 *
 * Plain storage note: `device_psk` is stored unencrypted in SQLite (and therefore exists in
 * Workspace backups), protected on disk by OS `0600` permissions and Toolroll's agent fence
 * (`src/agent-fence.ts`). Per ADR 0001, `retireCompanionOnRestore` unconditionally deletes
 * all paired devices, push tokens, passkeys, challenges, and idempotency rows on restore.
 */

import type { Store } from "../store.js";
import { deriveMachineId, generateX25519KeyPair } from "./noise.js";
import { generateEd25519KeyPair } from "./relay-auth.js";

export type CompanionDb = Store["handle"];

export interface CompanionHostKeys {
  noiseStaticPriv: Buffer;
  noiseStaticPub: Buffer;
  relayPriv: Buffer;
  relayPub: Buffer;
  machineId: string;
  relayUrl: string;
}

export interface PairedDeviceRow {
  deviceId: string;
  accountName: string;
  deviceName: string;
  phoneStaticPub: Buffer;
  deviceRelayPub: Buffer;
  devicePsk: Buffer;
  nextDevicePsk: Buffer | null;
  pskVersion: number;
  recoveryGeneration: string;
  /** The account's credential generation when it was paired (null: paired before this was kept). A password change
   * or any credential rotation moves the account on, and the phone with it must pair again. */
  accountGeneration: number | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface CompanionPushSubscription {
  deviceId: string;
  apnsToken: string;
  p256dh: string; // base64url(65B uncompressed P-256)
  authSecret: string; // base64url(16B random auth secret)
  includeTitles: boolean; // default false (matches src/push.ts:8-11)
  updatedAt: string;
}

export type IdempotencyState = "in_flight" | "completed" | "unknown";

export interface IdempotencyRecord {
  deviceId: string;
  idempotencyKey: string;
  method: string;
  requestHash: string;
  state: IdempotencyState;
  outcomeJson: string | null;
  updatedAt: string;
}

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX_ROWS_PER_DEVICE = 1_000;

/** Strip C0/C1 controls, DEL, line/para separators, bidi overrides, and zero-width marks. */
// eslint-disable-next-line no-control-regex
const UNSAFE_DEVICE_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function sanitizeDeviceName(raw: unknown): string {
  if (typeof raw !== "string") return "iPhone";
  const cleaned = raw.replace(UNSAFE_DEVICE_NAME, "").trim().slice(0, 48);
  return cleaned.length > 0 ? cleaned : "iPhone";
}

export function ensureCompanionTables(db: CompanionDb): void {
  db.exec(`
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
  `);
  const columns = db.prepare("PRAGMA table_info(companion_paired_device)").all().map(c => String(c["name"]));
  if (!columns.includes("account_generation")) db.exec("ALTER TABLE companion_paired_device ADD COLUMN account_generation INTEGER");
}

export function loadOrCreateCompanionHostKeys(
  db: CompanionDb,
  defaultRelayUrl = "wss://relay.toolroll.dev/v1/connect",
  now = new Date(),
): CompanionHostKeys {
  ensureCompanionTables(db);
  const existing = db.prepare("SELECT * FROM companion_host_keys WHERE singleton = 1").get();
  if (existing !== undefined) {
    return {
      noiseStaticPriv: Buffer.from(String(existing["noise_static_priv"]), "base64url"),
      noiseStaticPub: Buffer.from(String(existing["noise_static_pub"]), "base64url"),
      relayPriv: Buffer.from(String(existing["relay_priv"]), "base64url"),
      relayPub: Buffer.from(String(existing["relay_pub"]), "base64url"),
      machineId: String(existing["machine_id"]),
      relayUrl: String(existing["relay_url"]),
    };
  }
  const noise = generateX25519KeyPair();
  const relay = generateEd25519KeyPair();
  const machineId = deriveMachineId(relay.publicKey);
  db.prepare(`
    INSERT OR IGNORE INTO companion_host_keys (singleton, noise_static_priv, noise_static_pub, relay_priv, relay_pub, machine_id, relay_url, created_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    noise.privateKey.toString("base64url"),
    noise.publicKey.toString("base64url"),
    relay.privateKey.toString("base64url"),
    relay.publicKey.toString("base64url"),
    machineId,
    defaultRelayUrl,
    now.toISOString(),
  );
  // Two processes starting at once: whichever row landed first is everyone's.
  return loadOrCreateCompanionHostKeys(db, defaultRelayUrl, now);
}


export function savePairedDevice(db: CompanionDb, row: Omit<PairedDeviceRow, "nextDevicePsk" | "lastSeenAt" | "revokedAt" | "accountGeneration"> & { accountGeneration?: number | null }): void {
  ensureCompanionTables(db);
  db.prepare(`
    INSERT INTO companion_paired_device
      (device_id, account_name, device_name, phone_static_pub, device_relay_pub, device_psk, psk_version, recovery_generation, created_at, account_generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.deviceId,
    row.accountName,
    sanitizeDeviceName(row.deviceName),
    row.phoneStaticPub.toString("base64url"),
    row.deviceRelayPub.toString("base64url"),
    row.devicePsk.toString("base64url"),
    row.pskVersion,
    row.recoveryGeneration,
    row.createdAt,
    row.accountGeneration ?? null,
  );
}

export function getPairedDevice(db: CompanionDb, deviceId: string): PairedDeviceRow | null {
  ensureCompanionTables(db);
  const row = db.prepare("SELECT * FROM companion_paired_device WHERE device_id = ?").get(deviceId);
  if (row === undefined) return null;
  return {
    deviceId: String(row["device_id"]),
    accountName: String(row["account_name"]),
    deviceName: String(row["device_name"]),
    phoneStaticPub: Buffer.from(String(row["phone_static_pub"]), "base64url"),
    deviceRelayPub: Buffer.from(String(row["device_relay_pub"]), "base64url"),
    devicePsk: Buffer.from(String(row["device_psk"]), "base64url"),
    nextDevicePsk: row["next_device_psk"] == null ? null : Buffer.from(String(row["next_device_psk"]), "base64url"),
    pskVersion: Number(row["psk_version"]),
    recoveryGeneration: String(row["recovery_generation"]),
    accountGeneration: row["account_generation"] == null ? null : Number(row["account_generation"]),
    createdAt: String(row["created_at"]),
    lastSeenAt: row["last_seen_at"] == null ? null : String(row["last_seen_at"]),
    revokedAt: row["revoked_at"] == null ? null : String(row["revoked_at"]),
  };
}

export function listPairedDevices(db: CompanionDb): PairedDeviceRow[] {
  ensureCompanionTables(db);
  const rows = db.prepare("SELECT device_id FROM companion_paired_device ORDER BY created_at DESC").all();
  return rows.map(r => getPairedDevice(db, String(r["device_id"]))).filter((d): d is PairedDeviceRow => d !== null);
}

export function touchPairedDeviceLastSeen(db: CompanionDb, deviceId: string, now: Date): void {
  ensureCompanionTables(db);
  db.prepare("UPDATE companion_paired_device SET last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL")
    .run(now.toISOString(), deviceId);
}

/** The paired device still answers to its account as paired: active, and at the credential generation it was paired
 * under (a device paired before generations were kept stands on the account alone). */
/** This workspace's phones that can still connect: not removed, paired under the current restore generation, and their
 * account still standing at the generation it paired under. What Settings lists and the relay admits. */
export function livePairedDevices(store: { handle: CompanionDb; workspaceIdentity(): { recoveryGeneration: string }; accountOf(name: string): { revokedAt: unknown; generation: number } | null }): PairedDeviceRow[] {
  // A read: on a workspace that never turned phone access on, the tables don't exist yet and aren't made here.
  if (store.handle.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'companion_paired_device'").get() === undefined) return [];
  const generation = store.workspaceIdentity().recoveryGeneration;
  return listPairedDevices(store.handle).filter(d => d.revokedAt === null && d.recoveryGeneration === generation && deviceAccountStands(d, store.accountOf(d.accountName)));
}

export function deviceAccountStands(device: PairedDeviceRow, account: { revokedAt: unknown; generation: number } | null): boolean {
  return account !== null && account.revokedAt === null && (device.accountGeneration === null || device.accountGeneration === account.generation);
}

export function revokePairedDeviceRecord(db: CompanionDb, deviceId: string, now: Date): boolean {
  ensureCompanionTables(db);
  const res = db.prepare("UPDATE companion_paired_device SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
    .run(now.toISOString(), deviceId);
  db.prepare("DELETE FROM companion_push_token WHERE device_id = ?").run(deviceId);
  return Number(res.changes) > 0;
}

export function savePushSubscription(db: CompanionDb, sub: CompanionPushSubscription): void {
  ensureCompanionTables(db);
  const uaPub = Buffer.from(sub.p256dh, "base64url");
  const auth = Buffer.from(sub.authSecret, "base64url");
  if (uaPub.length !== 65 || uaPub[0] !== 0x04) {
    throw new Error("p256dh must be a 65-byte uncompressed P-256 public key");
  }
  if (auth.length !== 16) {
    throw new Error("authSecret must be 16 bytes");
  }
  if (sub.apnsToken.trim().length < 16 || sub.apnsToken.length > 512) {
    throw new Error("invalid apnsToken");
  }
  db.prepare(`
    INSERT INTO companion_push_token (device_id, apns_token, p256dh, auth_secret, include_titles, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      apns_token = excluded.apns_token,
      p256dh = excluded.p256dh,
      auth_secret = excluded.auth_secret,
      updated_at = excluded.updated_at
  `).run(sub.deviceId, sub.apnsToken.trim(), sub.p256dh, sub.authSecret, sub.includeTitles ? 1 : 0, sub.updatedAt);
}

export function getPushSubscription(db: CompanionDb, deviceId: string): CompanionPushSubscription | null {
  ensureCompanionTables(db);
  const row = db.prepare("SELECT * FROM companion_push_token WHERE device_id = ?").get(deviceId);
  if (row === undefined) return null;
  return {
    deviceId: String(row["device_id"]),
    apnsToken: String(row["apns_token"]),
    p256dh: String(row["p256dh"]),
    authSecret: String(row["auth_secret"]),
    includeTitles: Number(row["include_titles"]) === 1,
    updatedAt: String(row["updated_at"]),
  };
}

/** Startup sweep: mark any lingering `in_flight` idempotency rows as `unknown` and prune old settled rows. */
export function sweepCompanionIdempotencyOnStartup(db: CompanionDb, now = new Date()): { markedUnknown: number; pruned: number } {
  ensureCompanionTables(db);
  const stamp = now.toISOString();
  const marked = db.prepare("UPDATE companion_idempotency SET state = 'unknown', updated_at = ? WHERE state = 'in_flight'")
    .run(stamp);
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS).toISOString();
  const prunedOld = db.prepare("DELETE FROM companion_idempotency WHERE state IN ('completed', 'unknown') AND updated_at < ?")
    .run(cutoff);
  return { markedUnknown: Number(marked.changes), pruned: Number(prunedOld.changes) };
}

/**
 * ADR 0001: Unconditionally wipe all companion paired devices (including `device_psk`),
 * push subscriptions, passkey registrations, pending challenges, and idempotency rows
 * during database restore before swap.
 */
const COMPANION_RESTORE_TABLES = [
  // This Mac's companion keys go too: a restored copy (another Mac, or this one later) gets its own machine id and
  // Noise key, so two copies never fight over one relay identity and a leaked backup carries no live key.
  "companion_host_keys",
  "companion_paired_device",
  "companion_push_token",
  "companion_idempotency",
  "companion_passkey",
  "companion_challenge",
] as const;

export function retireCompanionOnRestore(db: CompanionDb): number {
  let deleted = 0;
  for (const table of COMPANION_RESTORE_TABLES) {
    const exists = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (exists === undefined) continue;
    const res = db.prepare(`DELETE FROM ${table}`).run();
    deleted += Number(res.changes);
    const remaining = Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"] ?? 0);
    if (remaining !== 0) {
      throw new Error(`ADR 0001 postcondition failed: ${table} still has ${remaining} rows after restore`);
    }
  }
  return deleted;
}
