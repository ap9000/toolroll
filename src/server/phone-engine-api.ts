/**
 * Settings → Phone's one door into the companion engine: the frozen B → C interfaces of the companion "perfect pass"
 * (contract §7), declared here exactly, and the few calls the page makes. settings-phone.ts imports only from here.
 *
 * Stream B implements these in src/companion/** in parallel. Until that lands, each function below is a thin
 * temporary adapter over what the engine offers today, marked `INTEGRATION`; at integration each is replaced by the
 * stream-B import (and the matching type by B's own), with no change to the page.
 */

import { networkInterfaces } from "node:os";
import type { CompanionService } from "../companion/service.js";
import { deviceAccountStands, listPairedDevices, revokePairedDeviceRecord, sanitizeDeviceName } from "../companion/store.js";
import { isTailnetIpv4 } from "../companion/paths.js";
import type { PairingQrPayload } from "../companion/daemon.js";
import type { Store } from "../store.js";

// ---- §7 types (frozen) ------------------------------------------------------------------------------------------

// INTEGRATION: replace with the stream-B import (src/companion/daemon.ts PairingStatus, PairingView).
export type PairingStatus = "awaiting_scan" | "awaiting_ready" | "awaiting_confirm" | "confirming" | "finishing" | "paired" | "cancelled" | "expired" | "contested" | "failed";
export interface PairingView {
  pairSessionId: string; status: PairingStatus; expiresAtMs: number; confirmCode: string | null;
  deviceName: string | null; deviceId: string | null; error: string | null;
}

// INTEGRATION: replace with the stream-B import (src/companion/store.ts PhoneState, RetiredReason, PhoneRow).
export type PhoneState = "active" | "finishing" | "retired";
export type RetiredReason = "removed" | "password_changed" | "access_changed" | "restored" | "migration" | "contested" | "pairing_failed";
export interface PhoneRow {
  deviceId: string; name: string; accountName: string; pairedAt: string; lastSeenAt: string | null;
  state: PhoneState; retiredReason: RetiredReason | null;
}

// INTEGRATION: replace with the stream-B import (src/companion/service.ts DirectAddress, DirectPathState, HostedPathState).
export interface DirectAddress { address: string; kind: "lan" | "tailnet"; interface: string }
export interface DirectPathState {
  state: "listening" | "failed" | "off"; port: number | null; error: string | null;
  addresses: DirectAddress[]; tailscale: "found" | "not_found";
}
export type HostedPathState =
  | { state: "off"; superseded?: boolean }
  | { state: "starting"; relay: string; superseded: boolean }
  | { state: "connected"; relay: string; since: string; superseded: boolean }
  | { state: "unreachable"; relay: string; error: string; retryAt: string; superseded: boolean };

/** The running companion service, as the page sees it. */
export type PhoneService = CompanionService;
export type StartedPairing = { ok: true; qr: PairingQrPayload; expiresAtMs: number } | { ok: false; error: string };

/** How long a retired phone stays on the list (contract §2.5: tombstones are kept 30 days). */
export const RETIRED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ---- paths ------------------------------------------------------------------------------------------------------

/** How a phone reaches this computer now: the direct listener (its addresses, labelled) and the hosted relay. */
export function pathStates(service: PhoneService): { direct: DirectPathState; hosted: HostedPathState } {
  // INTEGRATION: replace with the stream-B import — `service.status()` returns these shapes itself.
  const status = service.status();
  const hosted: HostedPathState = status.hosted.state === "off" ? { state: "off" } : { ...status.hosted, superseded: false };
  const listening = status.direct.state === "listening" ? status.direct.port : null;
  const addresses: DirectAddress[] = listening === null ? [] : service.paths()
    .filter(path => path.kind === "direct")
    .map(path => new URL(path.url).hostname)
    .map(address => ({ address, kind: isTailnetIpv4(address) ? "tailnet" as const : "lan" as const, interface: interfaceOf(address) }));
  const tailscale = addresses.some(one => one.kind === "tailnet") ? "found" as const : "not_found" as const;
  if (status.direct.state === "listening") return { direct: { state: "listening", port: status.direct.port, error: null, addresses, tailscale }, hosted };
  if (status.direct.state === "failed") {
    // Today's engine words a busy port as advice; B reports the listener's own error. Keep only the fact here.
    const port = /Port (\d+) on this computer is in use/.exec(status.direct.error)?.[1];
    const error = port === undefined ? status.direct.error : "another app is using it (EADDRINUSE)";
    return { direct: { state: "failed", port: port === undefined ? null : Number(port), error, addresses: [], tailscale }, hosted };
  }
  return { direct: { state: "off", port: null, error: null, addresses: [], tailscale }, hosted };
}

/** The network interface an address of this computer is on (INTEGRATION adapter helper; B reports it itself). */
function interfaceOf(address: string): string {
  for (const [name, infos] of Object.entries(networkInterfaces())) if ((infos ?? []).some(info => info.address === address)) return name;
  return "";
}

// ---- pairing ----------------------------------------------------------------------------------------------------

/** Pairings this page cancelled (INTEGRATION adapter state: today's engine says `aborted_rejected` for a cancel and a
 * dropped phone alike; B's engine says `cancelled` itself). */
const cancelledHere = new Set<string>();

/** A pairing's state, only for the session that started it (anyone else: null, as if it didn't exist). */
export function pairingView(service: PhoneService, pairSessionId: string, binding: string): PairingView | null {
  // INTEGRATION: replace with the stream-B import — `service.engine.pairingView(pairSessionId, binding)`.
  const p = service.engine.getPairingStatus(pairSessionId, binding);
  if (p === null) return null;
  const status: PairingStatus = p.status === "confirmed" ? "paired" : p.status === "aborted_race" ? "contested"
    : p.status === "aborted_rejected" ? (cancelledHere.has(pairSessionId) ? "cancelled" : "failed") : p.status;
  return { pairSessionId: p.pairSessionId, status, expiresAtMs: p.expiresAtMs, confirmCode: p.confirmCode, deviceName: p.deviceName, deviceId: null, error: null };
}

/** Start a pairing for this session (refused with a reason: no path, the 32-phone cap, a stale account). */
export function startPairing(service: PhoneService, accountName: string, binding: string, accountGeneration: number): StartedPairing {
  // INTEGRATION: replace with the stream-B import — `service.startPairing(...)`, unchanged, now also refusing the cap.
  return service.startPairing(accountName, binding, accountGeneration);
}

/** The owner's "Codes match — pair". */
export function confirmPairing(service: PhoneService, pairSessionId: string, binding: string): Promise<{ ok: true; deviceId: string } | { ok: false; error: string }> {
  return service.engine.confirmPairing(pairSessionId, binding);
}

/** The owner's Cancel (shown as a neutral "Pairing cancelled.", never as a failure). */
export function cancelPairing(service: PhoneService, pairSessionId: string, binding: string): boolean {
  // INTEGRATION: replace with the stream-B import — `service.engine.cancelPairing(...)` (its status is `cancelled`).
  const cancelled = service.engine.cancelPairing(pairSessionId, binding);
  if (cancelled) {
    cancelledHere.add(pairSessionId);
    if (cancelledHere.size > 256) cancelledHere.delete(cancelledHere.values().next().value!);
  }
  return cancelled;
}

// ---- phones -----------------------------------------------------------------------------------------------------

const tableExists = (store: Store): boolean =>
  store.handle.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'companion_paired_device'").get() !== undefined;

/** This workspace's phones (read-only; empty before phone access was ever on): live ones, and retired ones within
 * the 30-day window with why. */
export function listPhones(store: Store, opts: { accountName?: string } = {}, now: Date = new Date()): PhoneRow[] {
  // INTEGRATION: replace with the stream-B import — `listPhones(store, opts)` from src/companion/store.ts.
  if (!tableExists(store)) return [];
  const generation = store.workspaceIdentity().recoveryGeneration;
  const rows: PhoneRow[] = [];
  for (const device of listPairedDevices(store.handle)) {
    if (opts.accountName !== undefined && device.accountName !== opts.accountName) continue;
    const base = { deviceId: device.deviceId, name: device.deviceName, accountName: device.accountName, pairedAt: device.createdAt, lastSeenAt: device.lastSeenAt };
    if (device.revokedAt !== null) {
      if (now.getTime() - Date.parse(device.revokedAt) <= RETIRED_WINDOW_MS) rows.push({ ...base, state: "retired", retiredReason: "removed" });
      continue;
    }
    const account = store.accountOf(device.accountName);
    if (device.recoveryGeneration !== generation) rows.push({ ...base, state: "retired", retiredReason: "restored" });
    else if (!deviceAccountStands(device, account)) rows.push({ ...base, state: "retired", retiredReason: account === null || account.revokedAt !== null ? "access_changed" : "password_changed" });
    else rows.push({ ...base, state: "active", retiredReason: null });
  }
  return rows;
}

/** Rename one of this person's phones (not a retired one). False: no such phone of theirs. */
export function renamePhone(store: Store, deviceId: string, name: string, accountName: string): boolean {
  // INTEGRATION: replace with the stream-B import — `renamePhone(store, deviceId, name, accountName)`.
  if (!tableExists(store)) return false;
  const changed = store.handle.prepare("UPDATE companion_paired_device SET device_name = ? WHERE device_id = ? AND account_name = ? AND revoked_at IS NULL")
    .run(sanitizeDeviceName(name), deviceId, accountName);
  return Number(changed.changes) > 0;
}

/** Remove one of this person's phones now: the record is revoked before this returns, its sessions end, and the relay
 * hears of it in the background (L11). With phone access off, the record alone. False: no such phone of theirs. */
export function removePhone(service: PhoneService | null, store: Store, deviceId: string, accountName: string, now: Date): boolean {
  // INTEGRATION: replace with the stream-B import — `service.removePhone(deviceId, accountName)` while running, and B's
  // store revoke (reason `removed`) while phone access is off.
  const mine = listPhones(store, { accountName }, now).some(one => one.deviceId === deviceId && one.state !== "retired");
  if (!mine) return false;
  if (service === null) return revokePairedDeviceRecord(store.handle, deviceId, now);
  // revokeDevice revokes the record and drops the sessions synchronously; only the relay call is awaited inside it.
  void service.engine.revokeDevice(deviceId).catch(() => {});
  return true;
}
