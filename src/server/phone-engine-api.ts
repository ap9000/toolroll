/**
 * Settings → Phone's one door into the companion engine: the B → C interfaces of the companion "perfect pass"
 * (contract §7) and the few calls the page makes. settings-phone.ts imports only from here, so the page has one seam
 * to fake in tests.
 */

import type { CompanionService, DirectAddress, DirectPathState, HostedPathState } from "../companion/service.js";
import { listPhones as listPhoneRows, renamePhone as renamePhoneRow, revokePairedDeviceRecord, getPairedDevice,
  type PhoneRow, type PhoneState, type RetiredReason } from "../companion/store.js";
import type { PairingQrPayload, PairingStatus, PairingView } from "../companion/daemon.js";
import type { Store } from "../store.js";

export type { DirectAddress, DirectPathState, HostedPathState, PairingStatus, PairingView, PhoneRow, PhoneState, RetiredReason };

/** The running companion service, as the page sees it. */
export type PhoneService = CompanionService;
export type StartedPairing = { ok: true; qr: PairingQrPayload; expiresAtMs: number } | { ok: false; error: string };

/** How long a retired phone stays on the list (contract §2.5: tombstones are kept 30 days). */
export const RETIRED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How a phone reaches this computer now: the direct listener (its addresses, labelled) and the hosted relay. */
export function pathStates(service: PhoneService): { direct: DirectPathState; hosted: HostedPathState } {
  const status = service.status();
  return { direct: status.direct, hosted: status.hosted };
}

/** A pairing's state, only for the session that started it (anyone else: null, as if it didn't exist). */
export function pairingView(service: PhoneService, pairSessionId: string, binding: string): PairingView | null {
  return service.engine.pairingView(pairSessionId, binding);
}

/** Start a pairing for this session (refused with a reason: no path, the 32-phone cap, a stale account). */
export function startPairing(service: PhoneService, accountName: string, binding: string, accountGeneration: number): StartedPairing {
  return service.startPairing(accountName, binding, accountGeneration);
}

/** The owner's "Codes match — pair". */
export function confirmPairing(service: PhoneService, pairSessionId: string, binding: string): Promise<{ ok: true; deviceId: string } | { ok: false; error: string }> {
  return service.engine.confirmPairing(pairSessionId, binding);
}

/** The owner's Cancel (the engine records it as `cancelled`, shown as a neutral notice). */
export function cancelPairing(service: PhoneService, pairSessionId: string, binding: string): boolean {
  return service.engine.cancelPairing(pairSessionId, binding);
}

/** This workspace's phones (read-only): live, finishing, and retired within the 30-day window with why. */
export function listPhones(store: Store, opts: { accountName?: string } = {}, now: Date = new Date()): PhoneRow[] {
  return listPhoneRows(store, { ...opts, now });
}

/** Rename one of this person's phones (not a retired one). False: no such phone of theirs. */
export function renamePhone(store: Store, deviceId: string, name: string, accountName: string): boolean {
  return renamePhoneRow(store, deviceId, name, accountName);
}

/** Remove one of this person's phones now: the record is revoked before this returns, its sessions end, and the relay
 * hears of it in the background (L11). With phone access off, the record alone. False: no such phone of theirs. */
export function removePhone(service: PhoneService | null, store: Store, deviceId: string, accountName: string, now: Date): boolean {
  if (service !== null) return service.removePhone(deviceId, accountName);
  const device = getPairedDevice(store.handle, deviceId);
  if (device === null || device.accountName !== accountName || device.revokedAt !== null) return false;
  return revokePairedDeviceRecord(store.handle, deviceId, now, "removed");
}
