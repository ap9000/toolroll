/**
 * Settings → Phone's one door into the companion engine: the B → C interfaces of the companion "perfect pass"
 * (contract §7) and the few calls the page makes. settings-phone.ts imports only from here, so the page has one seam
 * to fake in tests.
 */

import type { CompanionService, DirectAddress, DirectPathState, HostedPathState } from "../companion/service.js";
import { listPhones as listPhoneRows, renamePhone as renamePhoneRow, revokePairedDeviceRecord, getPairedDevice,
  listAllAccountPasskeys, revokeAccountPasskey,
  type AccountPasskeyRow, type PhoneRow, type PhoneState, type RetiredReason } from "../companion/store.js";
import type { PairingQrPayload, PairingStatus, PairingView } from "../companion/daemon.js";
import {
  passkeyApprovalWindowMinutes,
  setPasskeyApprovalWindowMinutes,
  parsePasskeyWindowMinutes,
  PASSKEY_WINDOW_OPTIONS,
  type PasskeyWindowMinutes,
} from "../companion/passkey-gate.js";
import type { Store } from "../store.js";

export type { AccountPasskeyRow, DirectAddress, DirectPathState, HostedPathState, PairingStatus, PairingView, PasskeyWindowMinutes, PhoneRow, PhoneState, RetiredReason };
export { parsePasskeyWindowMinutes, PASSKEY_WINDOW_OPTIONS };

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

/** Active & revoked passkeys registered for this account in the current recovery generation (ADR 0005). */
export function listPasskeys(store: Store, accountName: string): AccountPasskeyRow[] {
  const identity = store.workspaceIdentity();
  return listAllAccountPasskeys(store.handle, identity.id, accountName, identity.recoveryGeneration);
}

/** Opens a 5-minute Mac consent window allowing this approver's iPhone to register a WebAuthn Passkey. */
export function openPasskeyEnrollment(service: PhoneService, accountName: string): { expiresAtMs: number } | null {
  return service.engine.actions?.openEnrollmentWindow(accountName) ?? null;
}

/** Whether a Mac passkey enrollment window is currently open for this account. */
export function isPasskeyEnrollmentOpen(service: PhoneService | null, accountName: string): boolean {
  return service?.engine.actions?.isEnrollmentOpen(accountName) ?? false;
}

/** Independently revokes one passkey credential without removing paired devices (ADR 0005), and clears active fresh leases. */
export function revokePasskey(store: Store, credentialId: string, accountName: string, now: Date, service: PhoneService | null = null): boolean {
  const revoked = revokeAccountPasskey(store.handle, credentialId, accountName, now);
  if (revoked) service?.engine.actions?.clearFreshLeases(accountName);
  return revoked;
}

/** Configured Passkey approval window in minutes (`0` = every time, `15` = 15 min, `60` = 1 hour). */
export function passkeyWindowMinutes(store: Store): PasskeyWindowMinutes {
  return passkeyApprovalWindowMinutes(store);
}

/** Updates the Passkey approval window and clears active fresh leases when tightened or turned off. */
export function updatePasskeyWindowMinutes(store: Store, minutes: PasskeyWindowMinutes, service: PhoneService | null = null): void {
  const prev = passkeyApprovalWindowMinutes(store);
  setPasskeyApprovalWindowMinutes(store, minutes);
  if (minutes === 0 || minutes < prev) {
    service?.engine.actions?.clearFreshLeases();
  }
}
