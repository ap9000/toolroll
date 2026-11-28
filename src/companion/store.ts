/**
 * SQLite persistence for the phone companion: this Mac's host keys and its paired phones
 * (`docs/plans/companion-app/threat-model-and-routes.md`, `noise-relay-protocol.md`). The tables are made by the v187
 * migration (schema.ts); nothing here creates or alters a table.
 *
 * A phone's row:
 * - PENDING from the owner's confirm until the phone's `pair.done` or first session hello (activatePendingDevice), at
 *   most 10 minutes; a pending row nobody activated is deleted by the sweep (sweepCompanionRecords).
 * - ACTIVE while its account stands at the credential generation it paired under.
 * - RETIRED (revoked_at + revoked_reason) when removed, when its account's credentials or access changed, or when its
 *   pairing failed after the keys reached a phone. A retired row keeps its keys for 30 days so the phone's next
 *   connection gets an authenticated refusal; then it is deleted.
 *
 * Plain storage note: `device_psk` is stored unencrypted in SQLite (and therefore exists in Workspace backups),
 * protected on disk by OS `0600` permissions and Toolroll's agent fence (`src/agent-fence.ts`). Per ADR 0001,
 * `retireCompanionOnRestore` unconditionally deletes this Mac's companion keys and every paired phone on restore.
 */

import type { Store } from "../store.js";
import { deriveMachineId, generateX25519KeyPair } from "./noise.js";
import { generateEd25519KeyPair } from "./relay-auth.js";
import { COMPANION_RETIRED_REASONS } from "./schema.js";

export type CompanionDb = Store["handle"];

export interface CompanionHostKeys {
  noiseStaticPriv: Buffer;
  noiseStaticPub: Buffer;
  relayPriv: Buffer;
  relayPub: Buffer;
  machineId: string;
}

export type RetiredReason = (typeof COMPANION_RETIRED_REASONS)[number];

export interface PairedDeviceRow {
  deviceId: string;
  accountName: string;
  deviceName: string;
  phoneStaticPub: Buffer;
  deviceRelayPub: Buffer;
  devicePsk: Buffer;
  recoveryGeneration: string;
  /** The account's credential generation when it was paired. A password change or any credential rotation moves the
   * account on, and the phone with it must pair again. */
  accountGeneration: number;
  createdAt: string;
  /** Null while pending (confirmed on the Mac, not yet acknowledged by the phone). */
  activatedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: RetiredReason | null;
}

/** How long a confirmed phone has to acknowledge (pair.done or its first hello) before its pending row is deleted. */
export const PENDING_ACTIVATION_MS = 10 * 60 * 1000;
/** How long a retired phone's row (and keys) stays, so its next connection is told it was removed. */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
/** Phones one Mac may have, active and pending together (the relays admit at most this many too). */
export const MAX_PHONES_PER_MAC = 32;

/** Strip C0/C1 controls, DEL, line/para separators, bidi overrides, and zero-width marks. */
// eslint-disable-next-line no-control-regex
const UNSAFE_DEVICE_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
export const MAX_DEVICE_NAME = 48;

export function sanitizeDeviceName(raw: unknown): string {
  if (typeof raw !== "string") return "iPhone";
  const cleaned = [...raw.replace(UNSAFE_DEVICE_NAME, "").trim()].slice(0, MAX_DEVICE_NAME).join("").trim();
  return cleaned.length > 0 ? cleaned : "iPhone";
}

export function loadOrCreateCompanionHostKeys(db: CompanionDb, now = new Date()): CompanionHostKeys {
  const existing = db.prepare("SELECT * FROM companion_host_keys WHERE singleton = 1").get();
  if (existing !== undefined) {
    return {
      noiseStaticPriv: Buffer.from(String(existing["noise_static_priv"]), "base64url"),
      noiseStaticPub: Buffer.from(String(existing["noise_static_pub"]), "base64url"),
      relayPriv: Buffer.from(String(existing["relay_priv"]), "base64url"),
      relayPub: Buffer.from(String(existing["relay_pub"]), "base64url"),
      machineId: String(existing["machine_id"]),
    };
  }
  const noise = generateX25519KeyPair();
  const relay = generateEd25519KeyPair();
  db.prepare(`
    INSERT OR IGNORE INTO companion_host_keys (singleton, noise_static_priv, noise_static_pub, relay_priv, relay_pub, machine_id, created_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    noise.privateKey.toString("base64url"),
    noise.publicKey.toString("base64url"),
    relay.privateKey.toString("base64url"),
    relay.publicKey.toString("base64url"),
    deriveMachineId(relay.publicKey),
    now.toISOString(),
  );
  // Two processes starting at once: whichever row landed first is everyone's.
  return loadOrCreateCompanionHostKeys(db, now);
}

/** This Mac's host keys if it has made them (a read: nothing is created). */
export function readCompanionHostKeys(db: CompanionDb): CompanionHostKeys | null {
  const existing = db.prepare("SELECT 1 AS hit FROM companion_host_keys WHERE singleton = 1").get();
  return existing === undefined ? null : loadOrCreateCompanionHostKeys(db);
}

function rowOf(row: Record<string, unknown>): PairedDeviceRow {
  const reason = row["revoked_reason"];
  return {
    deviceId: String(row["device_id"]),
    accountName: String(row["account_name"]),
    deviceName: String(row["device_name"]),
    phoneStaticPub: Buffer.from(String(row["phone_static_pub"]), "base64url"),
    deviceRelayPub: Buffer.from(String(row["device_relay_pub"]), "base64url"),
    devicePsk: Buffer.from(String(row["device_psk"]), "base64url"),
    recoveryGeneration: String(row["recovery_generation"]),
    accountGeneration: Number(row["account_generation"]),
    createdAt: String(row["created_at"]),
    activatedAt: row["activated_at"] == null ? null : String(row["activated_at"]),
    lastSeenAt: row["last_seen_at"] == null ? null : String(row["last_seen_at"]),
    revokedAt: row["revoked_at"] == null ? null : String(row["revoked_at"]),
    revokedReason: typeof reason === "string" && (COMPANION_RETIRED_REASONS as readonly string[]).includes(reason) ? reason as RetiredReason : null,
  };
}

/** A confirmed phone's row, PENDING until the phone acknowledges (activatePendingDevice). */
export function savePendingDevice(db: CompanionDb, row: Omit<PairedDeviceRow, "activatedAt" | "lastSeenAt" | "revokedAt" | "revokedReason">): void {
  db.prepare(`
    INSERT INTO companion_paired_device
      (device_id, account_name, device_name, phone_static_pub, device_relay_pub, device_psk, recovery_generation, account_generation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.deviceId,
    row.accountName,
    sanitizeDeviceName(row.deviceName),
    row.phoneStaticPub.toString("base64url"),
    row.deviceRelayPub.toString("base64url"),
    row.devicePsk.toString("base64url"),
    row.recoveryGeneration,
    row.accountGeneration,
    row.createdAt,
  );
}

/** A pending row that was never acknowledged, removed outright (its keys may never have reached any phone). */
export function deletePendingDevice(db: CompanionDb, deviceId: string): boolean {
  return Number(db.prepare("DELETE FROM companion_paired_device WHERE device_id = ? AND activated_at IS NULL AND revoked_at IS NULL").run(deviceId).changes) > 0;
}

export function getPairedDevice(db: CompanionDb, deviceId: string): PairedDeviceRow | null {
  const row = db.prepare("SELECT * FROM companion_paired_device WHERE device_id = ?").get(deviceId);
  return row === undefined ? null : rowOf(row);
}

export function listPairedDevices(db: CompanionDb): PairedDeviceRow[] {
  return db.prepare("SELECT * FROM companion_paired_device ORDER BY created_at DESC, device_id").all().map(rowOf);
}

export function touchPairedDeviceLastSeen(db: CompanionDb, deviceId: string, now: Date): void {
  db.prepare("UPDATE companion_paired_device SET last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now.toISOString(), deviceId);
}

type StoreView = { handle: CompanionDb; workspaceIdentity(): { recoveryGeneration: string }; accountOf(name: string): { revokedAt: unknown; generation: number; role?: string } | null };

/** The paired device still answers to its account: the account is active, at the credential generation it paired under. */
export function deviceAccountStands(device: Pick<PairedDeviceRow, "accountGeneration">, account: { revokedAt: unknown; generation: number } | null): boolean {
  return account !== null && account.revokedAt === null && device.accountGeneration === account.generation;
}

const pendingLive = (device: PairedDeviceRow, nowMs: number): boolean =>
  device.activatedAt === null && device.revokedAt === null && Date.parse(device.createdAt) > nowMs - PENDING_ACTIVATION_MS;

/**
 * This workspace's phones that can connect: not retired, paired under the current restore generation, their account
 * still standing at the generation they paired under, and active — or, with `includePending`, confirmed within the
 * last 10 minutes and not yet acknowledged (the relay must admit those too, or the phone's first hosted dial fails).
 */
export function livePairedDevices(store: StoreView, opts: { includePending?: boolean; now?: Date } = {}): PairedDeviceRow[] {
  const generation = store.workspaceIdentity().recoveryGeneration;
  const nowMs = (opts.now ?? new Date()).getTime();
  return listPairedDevices(store.handle).filter(d => d.revokedAt === null && d.recoveryGeneration === generation
    && deviceAccountStands(d, store.accountOf(d.accountName))
    && (d.activatedAt !== null || (opts.includePending === true && pendingLive(d, nowMs))));
}

/** Active and pending phones on this Mac (the 32-phone cap counts both). */
export function phoneCount(db: CompanionDb, now: Date): number {
  const cutoff = new Date(now.getTime() - PENDING_ACTIVATION_MS).toISOString();
  return Number(db.prepare("SELECT count(*) AS n FROM companion_paired_device WHERE revoked_at IS NULL AND (activated_at IS NOT NULL OR created_at > ?)")
    .get(cutoff)?.["n"] ?? 0);
}

/**
 * Activates a pending phone — atomically: one transaction re-reads the account (active, at the generation the row was
 * paired under) and the workspace's recovery generation, and the update itself requires the row to be pending, not
 * retired and younger than 10 minutes. `already_active`: the row was activated before (by the other of pair.done and
 * hello) and still stands.
 */
export function activatePendingDevice(store: StoreView & { transact<T>(work: () => T): T }, deviceId: string, now: Date): "activated" | "already_active" | "refused" {
  return store.transact(() => {
    const device = getPairedDevice(store.handle, deviceId);
    if (device === null || device.revokedAt !== null || device.recoveryGeneration !== store.workspaceIdentity().recoveryGeneration) return "refused";
    if (!deviceAccountStands(device, store.accountOf(device.accountName))) return "refused";
    if (device.activatedAt !== null) return "already_active";
    const cutoff = new Date(now.getTime() - PENDING_ACTIVATION_MS).toISOString();
    const done = store.handle.prepare(`UPDATE companion_paired_device SET activated_at = ?
      WHERE device_id = ? AND activated_at IS NULL AND revoked_at IS NULL AND created_at > ? AND account_generation = ? AND recovery_generation = ?`)
      .run(now.toISOString(), deviceId, cutoff, device.accountGeneration, device.recoveryGeneration);
    return Number(done.changes) === 1 ? "activated" : "refused";
  });
}

/** Retires a phone, keeping its row as a 30-day tombstone that says why. False when it was already retired or unknown. */
export function revokePairedDeviceRecord(db: CompanionDb, deviceId: string, now: Date, reason: RetiredReason = "removed"): boolean {
  const res = db.prepare("UPDATE companion_paired_device SET revoked_at = ?, revoked_reason = ? WHERE device_id = ? AND revoked_at IS NULL")
    .run(now.toISOString(), reason, deviceId);
  return Number(res.changes) > 0;
}

/**
 * The periodic sweep (at service start and hourly, whether or not a phone is connected): deletes tombstones past 30
 * days and pending rows nobody acknowledged within 10 minutes. Returns the deleted pending phones' ids (the relay is
 * told to forget them).
 */
export function sweepCompanionRecords(db: CompanionDb, now: Date): { tombstones: number; pending: string[] } {
  const tombstoneCutoff = new Date(now.getTime() - TOMBSTONE_MS).toISOString();
  const pendingCutoff = new Date(now.getTime() - PENDING_ACTIVATION_MS).toISOString();
  const tombstones = Number(db.prepare("DELETE FROM companion_paired_device WHERE revoked_at IS NOT NULL AND revoked_at < ?").run(tombstoneCutoff).changes);
  const pending = db.prepare("SELECT device_id FROM companion_paired_device WHERE activated_at IS NULL AND revoked_at IS NULL AND created_at <= ?")
    .all(pendingCutoff).map(row => String(row["device_id"]));
  for (const deviceId of pending) deletePendingDevice(db, deviceId);
  return { tombstones, pending };
}

// ---- What Settings shows (§7 interface) --------------------------------------------------------------------------

export type PhoneState = "active" | "finishing" | "retired";

export interface PhoneRow {
  deviceId: string;
  name: string;
  accountName: string;
  /** When the owner confirmed it. */
  pairedAt: string;
  lastSeenAt: string | null;
  state: PhoneState;
  retiredReason: RetiredReason | null;
}

/**
 * The phones Settings lists (read-only): active ones, ones still finishing on the phone (pending, within 10 minutes),
 * and retired ones within their 30-day window with why. A phone whose account moved on without the record saying so
 * yet reads as retired by an access change.
 */
export function listPhones(store: StoreView, opts: { accountName?: string; now?: Date } = {}): PhoneRow[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const generation = store.workspaceIdentity().recoveryGeneration;
  const out: PhoneRow[] = [];
  for (const d of listPairedDevices(store.handle)) {
    if (opts.accountName !== undefined && d.accountName !== opts.accountName) continue;
    if (d.recoveryGeneration !== generation) continue;
    let state: PhoneState;
    let reason: RetiredReason | null = null;
    if (d.revokedAt !== null) {
      if (Date.parse(d.revokedAt) <= nowMs - TOMBSTONE_MS) continue;
      // A pending row retired before the phone acknowledged (contested, failed) never was a phone the person had.
      if (d.activatedAt === null) continue;
      state = "retired";
      reason = d.revokedReason ?? "removed";
    } else if (!deviceAccountStands(d, store.accountOf(d.accountName))) {
      state = "retired";
      reason = "access_changed";
    } else if (d.activatedAt === null) {
      if (!pendingLive(d, nowMs)) continue;
      state = "finishing";
    } else {
      state = "active";
    }
    out.push({ deviceId: d.deviceId, name: d.deviceName, accountName: d.accountName, pairedAt: d.createdAt, lastSeenAt: d.lastSeenAt, state, retiredReason: reason });
  }
  return out;
}

/** Renames one of the account's phones (active or finishing). False when it isn't that account's, or is retired. */
export function renamePhone(store: StoreView, deviceId: string, name: string, accountName: string): boolean {
  const res = store.handle.prepare("UPDATE companion_paired_device SET device_name = ? WHERE device_id = ? AND account_name = ? AND revoked_at IS NULL")
    .run(sanitizeDeviceName(name), deviceId, accountName);
  return Number(res.changes) > 0;
}

/**
 * ADR 0001: a restore unconditionally deletes this Mac's companion keys, every paired phone (including `device_psk`),
 * every registered passkey, pending passkey challenges, and mutation idempotency records. A restored copy gets its own
 * machine id and Noise key, and old passkeys/challenges never survive a restore.
 */
const COMPANION_RESTORE_TABLES = [
  "companion_host_keys",
  "companion_paired_device",
  "account_passkeys",
  "passkey_challenges",
  "device_idempotency",
] as const;

export function retireCompanionOnRestore(db: CompanionDb): number {
  let deleted = 0;
  for (const table of COMPANION_RESTORE_TABLES) {
    deleted += Number(db.prepare(`DELETE FROM ${table}`).run().changes);
    const remaining = Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"] ?? 0);
    if (remaining !== 0) throw new Error(`ADR 0001 postcondition failed: ${table} still has ${remaining} rows after restore`);
  }
  return deleted;
}

// ---- Gate 2: Passkeys, Single-Use Challenges, and Mutation Idempotency (ADR 0005) ----------------------------------

export type PasskeyChallengeKind = "register" | "approve" | "accept" | "land" | "ship";

export interface AccountPasskeyRow {
  credentialId: string;
  workspaceId: string;
  accountName: string;
  userHandle: string;
  publicKeySpki: string;
  signCount: number;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  recoveryGeneration: string;
  revokedAt: string | null;
}

export interface PasskeyChallengeRow {
  challenge: string;
  kind: PasskeyChallengeKind;
  workspaceId: string;
  accountName: string;
  deviceId: string;
  recoveryGeneration: string;
  bindingJson: string;
  expiresAt: string;
  consumedAt: string | null;
}

export type DeviceIdempotencyState = "in_flight" | "completed" | "unknown";

export interface DeviceIdempotencyRow {
  deviceId: string;
  idempotencyKey: string;
  method: string;
  requestHash: string;
  state: DeviceIdempotencyState;
  outcomeJson: string | null;
  updatedAt: string;
}

export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX_PER_DEVICE = 1_000;

function passkeyRowOf(row: Record<string, unknown>): AccountPasskeyRow {
  return {
    credentialId: String(row["credential_id"]),
    workspaceId: String(row["workspace_id"]),
    accountName: String(row["account_name"]),
    userHandle: String(row["user_handle"]),
    publicKeySpki: String(row["public_key_spki"]),
    signCount: Number(row["sign_count"]),
    label: String(row["label"]),
    createdAt: String(row["created_at"]),
    lastUsedAt: row["last_used_at"] == null ? null : String(row["last_used_at"]),
    recoveryGeneration: String(row["recovery_generation"]),
    revokedAt: row["revoked_at"] == null ? null : String(row["revoked_at"]),
  };
}

export function getAccountPasskey(db: CompanionDb, credentialId: string): AccountPasskeyRow | null {
  const row = db.prepare("SELECT * FROM account_passkeys WHERE credential_id = ?").get(credentialId);
  return row === undefined ? null : passkeyRowOf(row);
}

export function insertAccountPasskey(
  db: CompanionDb,
  row: Omit<AccountPasskeyRow, "lastUsedAt" | "revokedAt">,
): boolean {
  const res = db.prepare(`
    INSERT OR IGNORE INTO account_passkeys
      (credential_id, workspace_id, account_name, user_handle, public_key_spki, sign_count, label, created_at, recovery_generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.credentialId,
    row.workspaceId,
    row.accountName,
    row.userHandle,
    row.publicKeySpki,
    row.signCount,
    sanitizeDeviceName(row.label),
    row.createdAt,
    row.recoveryGeneration,
  );
  return Number(res.changes) === 1;
}

export function listActiveAccountPasskeys(
  db: CompanionDb,
  workspaceId: string,
  accountName: string,
  recoveryGeneration: string,
): AccountPasskeyRow[] {
  return db.prepare(`
    SELECT * FROM account_passkeys
    WHERE workspace_id = ? AND account_name = ? AND recovery_generation = ? AND revoked_at IS NULL
    ORDER BY created_at DESC, credential_id
  `).all(workspaceId, accountName, recoveryGeneration).map(passkeyRowOf);
}

export function listAllAccountPasskeys(
  db: CompanionDb,
  workspaceId: string,
  accountName: string,
  recoveryGeneration: string,
): AccountPasskeyRow[] {
  return db.prepare(`
    SELECT * FROM account_passkeys
    WHERE workspace_id = ? AND account_name = ? AND recovery_generation = ?
    ORDER BY created_at DESC, credential_id
  `).all(workspaceId, accountName, recoveryGeneration).map(passkeyRowOf);
}

export function updateAccountPasskeyUsage(db: CompanionDb, credentialId: string, signCount: number, now: Date): void {
  db.prepare("UPDATE account_passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL")
    .run(signCount, now.toISOString(), credentialId);
}

export function revokeAccountPasskey(db: CompanionDb, credentialId: string, accountName: string, now: Date): boolean {
  const res = db.prepare("UPDATE account_passkeys SET revoked_at = ? WHERE credential_id = ? AND account_name = ? AND revoked_at IS NULL")
    .run(now.toISOString(), credentialId, accountName);
  return Number(res.changes) > 0;
}

export function savePasskeyChallenge(db: CompanionDb, row: Omit<PasskeyChallengeRow, "consumedAt">): void {
  db.prepare(`
    INSERT INTO passkey_challenges
      (challenge, kind, workspace_id, account_name, device_id, recovery_generation, binding_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.challenge,
    row.kind,
    row.workspaceId,
    row.accountName,
    row.deviceId,
    row.recoveryGeneration,
    row.bindingJson,
    row.expiresAt,
  );
}

export function getPasskeyChallenge(db: CompanionDb, challenge: string): PasskeyChallengeRow | null {
  const row = db.prepare("SELECT * FROM passkey_challenges WHERE challenge = ?").get(challenge);
  if (row === undefined) return null;
  return {
    challenge: String(row["challenge"]),
    kind: String(row["kind"]) as PasskeyChallengeKind,
    workspaceId: String(row["workspace_id"]),
    accountName: String(row["account_name"]),
    deviceId: String(row["device_id"]),
    recoveryGeneration: String(row["recovery_generation"]),
    bindingJson: String(row["binding_json"]),
    expiresAt: String(row["expires_at"]),
    consumedAt: row["consumed_at"] == null ? null : String(row["consumed_at"]),
  };
}

export function consumePasskeyChallenge(db: CompanionDb, challenge: string, now: Date): boolean {
  const res = db.prepare("UPDATE passkey_challenges SET consumed_at = ? WHERE challenge = ? AND consumed_at IS NULL AND expires_at > ?")
    .run(now.toISOString(), challenge, now.toISOString());
  return Number(res.changes) === 1;
}

export function prunePasskeyChallenges(db: CompanionDb, now: Date): number {
  return Number(db.prepare("DELETE FROM passkey_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now.toISOString()).changes);
}

function idempotencyRowOf(row: Record<string, unknown>): DeviceIdempotencyRow {
  return {
    deviceId: String(row["device_id"]),
    idempotencyKey: String(row["idempotency_key"]),
    method: String(row["method"]),
    requestHash: String(row["request_hash"]),
    state: String(row["state"]) as DeviceIdempotencyState,
    outcomeJson: row["outcome_json"] == null ? null : String(row["outcome_json"]),
    updatedAt: String(row["updated_at"]),
  };
}

export function getDeviceIdempotency(db: CompanionDb, deviceId: string, idempotencyKey: string): DeviceIdempotencyRow | null {
  const row = db.prepare("SELECT * FROM device_idempotency WHERE device_id = ? AND idempotency_key = ?").get(deviceId, idempotencyKey);
  return row === undefined ? null : idempotencyRowOf(row);
}

export type IdempotencyClaim =
  | { status: "claimed" }
  | { status: "conflict" }
  | { status: "in_flight" }
  | { status: "unknown" }
  | { status: "completed"; outcomeJson: string };

/**
 * Atomically claims `(deviceId, idempotencyKey)` as `in_flight` (or classifies an existing row).
 * Reusing a key with a different `method` or `requestHash` is unconditionally rejected (`conflict`).
 */
export function claimDeviceIdempotency(
  db: CompanionDb,
  input: { deviceId: string; idempotencyKey: string; method: string; requestHash: string; now: Date },
): IdempotencyClaim {
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO device_idempotency (device_id, idempotency_key, method, request_hash, state, outcome_json, updated_at)
    VALUES (?, ?, ?, ?, 'in_flight', NULL, ?)
  `).run(input.deviceId, input.idempotencyKey, input.method, input.requestHash, input.now.toISOString());
  if (Number(inserted.changes) === 1) return { status: "claimed" };
  const existing = getDeviceIdempotency(db, input.deviceId, input.idempotencyKey);
  if (existing === null) return { status: "conflict" };
  if (existing.method !== input.method || existing.requestHash !== input.requestHash) return { status: "conflict" };
  if (existing.state === "in_flight") return { status: "in_flight" };
  if (existing.state === "unknown") return { status: "unknown" };
  return { status: "completed", outcomeJson: existing.outcomeJson ?? "{}" };
}

export function settleDeviceIdempotency(
  db: CompanionDb,
  deviceId: string,
  idempotencyKey: string,
  state: "completed" | "unknown",
  outcomeJson: string | null,
  now: Date,
): void {
  db.prepare("UPDATE device_idempotency SET state = ?, outcome_json = ?, updated_at = ? WHERE device_id = ? AND idempotency_key = ?")
    .run(state, outcomeJson, now.toISOString(), deviceId, idempotencyKey);
}

/**
 * Startup reconciliation (threat-model-and-routes.md §3): unconditionally moves every lingering `in_flight` row to
 * `unknown` because a restarted daemon can no longer settle an interrupted external side effect.
 */
export function reconcileIdempotencyOnStartup(db: CompanionDb, now: Date): number {
  return Number(db.prepare("UPDATE device_idempotency SET state = 'unknown', updated_at = ? WHERE state = 'in_flight'").run(now.toISOString()).changes);
}

/**
 * Bounded retention: drops settled (`completed`, `unknown`) rows older than 24h and enforces a hard cap of 1,000 rows
 * per paired device, evicting oldest settled rows first.
 */
export function pruneDeviceIdempotency(db: CompanionDb, now: Date): number {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS).toISOString();
  let deleted = Number(db.prepare("DELETE FROM device_idempotency WHERE state IN ('completed', 'unknown') AND updated_at < ?").run(cutoff).changes);
  const devices = db.prepare("SELECT device_id FROM device_idempotency GROUP BY device_id HAVING count(*) > ?").all(IDEMPOTENCY_MAX_PER_DEVICE);
  for (const row of devices) {
    const deviceId = String(row["device_id"]);
    const total = Number(db.prepare("SELECT count(*) AS n FROM device_idempotency WHERE device_id = ?").get(deviceId)?.["n"] ?? 0);
    const excess = total - IDEMPOTENCY_MAX_PER_DEVICE;
    if (excess <= 0) continue;
    deleted += Number(db.prepare(`
      DELETE FROM device_idempotency
      WHERE rowid IN (
        SELECT rowid FROM device_idempotency
        WHERE device_id = ? AND state IN ('completed', 'unknown')
        ORDER BY updated_at ASC, rowid ASC
        LIMIT ?
      )
    `).run(deviceId, excess).changes);
  }
  return deleted;
}
