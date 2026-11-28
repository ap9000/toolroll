/**
 * Transactional Passkey Verification Gate (ADR 0005).
 *
 * Called directly inside each verb's real domain transaction (`scope.ts:approve`,
 * `assignment.ts:acceptAndCompleteAsOperator`, `local-landing.ts:land`, `pull-request-flow.ts:mergeAsPerson`).
 * Never writes a parallel ledger entry outside the real domain gate. Also the one owner of approvals windows
 * (leases): only a committed consumption of a routine approve/accept or an unlock opens one.
 */

import type { Store } from "../store.js";
import {
  consumePasskeyChallenge,
  deviceAccountStands,
  getAccountPasskey,
  getPairedDevice,
  getPasskeyChallenge,
  updateAccountPasskeyUsage,
} from "./store.js";
import {
  canonicalJson,
  derivePasskeyUserHandle,
  PASSKEY_CHALLENGE_TTL_MS,
  PASSKEY_ORIGIN,
  PASSKEY_RP_ID,
  verifyAssertionResponse,
  type PasskeyVerb,
  type VerbChallengeBinding,
  type WebAuthnAssertionPayload,
} from "./webauthn.js";

export interface PasskeyAssertionProof {
  readonly kind?: "assertion";
  readonly deviceId: string;
  readonly challenge: string;
  readonly assertion: WebAuthnAssertionPayload;
  readonly rpId?: string;
  readonly expectedOrigin?: string;
}

/**
 * "Use this device's approvals window" (ADR 0005 tiered freshness). It carries no timestamps or credential: the gate
 * looks the window up in its own registry and re-checks every standing. Domain gates accept it ONLY for a routine
 * `approve` (one approver, standard permissions, not protected, no release terms) and a clean `accept` (not an
 * exception, not publishing, not protected, no release terms); never for land, ship or a second approver's vote.
 */
export interface PasskeyLeaseUse {
  readonly kind: "lease";
  readonly deviceId: string;
}

export type PasskeyActionProof = PasskeyAssertionProof | PasskeyLeaseUse;

export const PASSKEY_WINDOW_OPTIONS = [0, 15, 60] as const;
export type PasskeyWindowMinutes = (typeof PASSKEY_WINDOW_OPTIONS)[number];
export const DEFAULT_PASSKEY_WINDOW_MINUTES: PasskeyWindowMinutes = 15;

export function parsePasskeyWindowMinutes(raw: unknown): PasskeyWindowMinutes | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return n === 0 || n === 15 || n === 60 ? n : null;
}

export function usesPasskeyLease(proof: PasskeyActionProof): proof is PasskeyLeaseUse {
  return proof.kind === "lease";
}

export type PasskeyGateResult =
  | {
    ok: true;
    accountName: string;
    accountGeneration: number;
    deviceId: string;
    credentialId: string;
    be: boolean;
    bs: boolean;
    /** When the live assertion behind this act was verified (for a window, the assertion that opened it). */
    provedAtMs: number;
  }
  | { ok: false; code: string; message: string };

/** A verified, not yet consumed assertion. Only `checkPasskeyAction` makes one; `consumePasskeyAction` takes it once. */
export type PasskeyChecked = Extract<PasskeyGateResult, { ok: true }> & {
  readonly verb: PasskeyVerb;
  readonly challenge: string;
  readonly storedSignCount: number;
  readonly newSignCount: number;
};

/** The checked results this module made and nobody has consumed: a lookalike object built elsewhere is not one. */
const CHECKED = new WeakSet<object>();

type GateInput = {
  accountName: string;
  /** The project acted on; `null` refuses. Unlocking approvals names no project: pass `anyProject: true`. */
  repo: string | null;
  anyProject?: true;
  deviceId: string;
  credentialId: string;
};

/** Account, project, paired-device and credential standing, read now. */
function standingProblem(store: Store, input: GateInput): { code: string; message: string } | { account: NonNullable<ReturnType<Store["accountOf"]>> } {
  const identity = store.workspaceIdentity();
  const account = store.accountOf(input.accountName);
  if (account === null || account.revokedAt !== null || account.role !== "approver") {
    return { code: "not_an_approver", message: "Only an active approver account can authorize this act." };
  }
  if (input.anyProject !== true && (input.repo === null || !store.accountCanAccess(input.accountName, input.repo))) {
    return { code: "not_an_approver", message: "You don't have access to this project." };
  }
  const device = getPairedDevice(store.handle, input.deviceId);
  if (
    device === null ||
    device.revokedAt !== null ||
    device.activatedAt === null ||
    device.accountName !== input.accountName ||
    device.recoveryGeneration !== identity.recoveryGeneration ||
    !deviceAccountStands(device, account)
  ) {
    return { code: "device_revoked", message: "This iPhone is no longer paired or your account changed." };
  }
  const cred = getAccountPasskey(store.handle, input.credentialId);
  if (
    cred === null ||
    cred.revokedAt !== null ||
    cred.workspaceId !== identity.id ||
    cred.accountName !== input.accountName ||
    cred.recoveryGeneration !== identity.recoveryGeneration
  ) {
    return { code: "credential_not_allowed", message: "That passkey is not active for your account on this Mac." };
  }
  return { account };
}

/**
 * Verifies a single-use verb-specific passkey assertion without consuming it: standing, the challenge row (kind,
 * workspace, account, device, generation, exact binding, expiry, unused) and the WebAuthn assertion itself.
 * Cheap to re-check later: `consumePasskeyAction` re-reads standing and swaps the signCount from what was read here.
 */
export function checkPasskeyAction(
  store: Store,
  input: {
    accountName: string;
    repo: string | null;
    anyProject?: true;
    verb: PasskeyVerb;
    expectedBinding: VerbChallengeBinding;
    proof: PasskeyAssertionProof;
    now: Date;
  },
): PasskeyChecked | { ok: false; code: string; message: string } {
  const identity = store.workspaceIdentity();
  // Typed callers can't do otherwise; a lookalike object (a window proof, a missing assertion) is refused, not trusted.
  const proof = input.proof as Partial<PasskeyAssertionProof> | null;
  if (proof === null || typeof proof !== "object" || (proof.kind !== undefined && proof.kind !== "assertion") || typeof proof.deviceId !== "string"
    || typeof proof.challenge !== "string" || proof.assertion === null || typeof proof.assertion !== "object" || typeof proof.assertion.credentialId !== "string") {
    return { ok: false, code: "invalid_proof", message: "That passkey confirmation isn't valid." };
  }
  const standing = standingProblem(store, { ...input, deviceId: input.proof.deviceId, credentialId: input.proof.assertion.credentialId });
  if (!("account" in standing)) return { ok: false, ...standing };

  const challengeRow = getPasskeyChallenge(store.handle, input.proof.challenge);
  if (challengeRow === null) {
    return { ok: false, code: "challenge_unknown", message: "Approval challenge not found. Request a fresh approval." };
  }
  if (challengeRow.consumedAt !== null) {
    return { ok: false, code: "challenge_used", message: "That approval challenge was already used." };
  }
  if (Date.parse(challengeRow.expiresAt) <= input.now.getTime()) {
    return { ok: false, code: "challenge_expired", message: "That approval challenge expired. Try again." };
  }
  if (challengeRow.kind !== input.verb) {
    return { ok: false, code: "verb_mismatch", message: "That passkey challenge belongs to a different action." };
  }
  if (
    challengeRow.workspaceId !== identity.id ||
    challengeRow.accountName !== input.accountName ||
    challengeRow.deviceId !== input.proof.deviceId ||
    challengeRow.recoveryGeneration !== identity.recoveryGeneration
  ) {
    return { ok: false, code: "challenge_binding_mismatch", message: "Approval challenge does not match this device or account." };
  }
  if (challengeRow.bindingJson !== canonicalJson(input.expectedBinding)) {
    return { ok: false, code: "binding_mismatch", message: "The target changed since the approval challenge was issued." };
  }

  const cred = getAccountPasskey(store.handle, input.proof.assertion.credentialId)!;
  const verified = verifyAssertionResponse({
    payload: input.proof.assertion,
    expectedChallenge: challengeRow.challenge,
    expectedUserHandle: derivePasskeyUserHandle(identity.id, input.accountName),
    storedPublicKeySpki: cred.publicKeySpki,
    storedSignCount: cred.signCount,
    rpId: input.proof.rpId ?? PASSKEY_RP_ID,
    expectedOrigin: input.proof.expectedOrigin ?? PASSKEY_ORIGIN,
  });
  if (!verified.ok) return verified;

  const checked: PasskeyChecked = {
    ok: true,
    accountName: input.accountName,
    accountGeneration: standing.account.generation,
    deviceId: input.proof.deviceId,
    credentialId: cred.credentialId,
    be: verified.be,
    bs: verified.bs,
    provedAtMs: input.now.getTime(),
    verb: input.verb,
    challenge: challengeRow.challenge,
    storedSignCount: cred.signCount,
    newSignCount: verified.newSignCount,
  };
  CHECKED.add(checked);
  return checked;
}

/**
 * Consumes a checked assertion. MUST run inside the verb's `store.transact()` so challenge consumption, signCount,
 * proof row and domain change commit or roll back together. Standing is re-read now and the signCount moves only from
 * what the check read. `startsLease` (routine approve/accept, or an unlock) parks a window grant that
 * `startPasskeyLease` opens only once this consumption has committed.
 */
export function consumePasskeyAction(
  store: Store,
  checked: PasskeyChecked,
  input: { repo: string | null; anyProject?: true; now: Date; startsLease?: { minutes: number } },
): PasskeyGateResult {
  if (!CHECKED.has(checked)) return { ok: false, code: "not_verified", message: "That passkey confirmation wasn't verified." };
  CHECKED.delete(checked);
  const standing = standingProblem(store, { ...checked, repo: input.repo, ...(input.anyProject === true ? { anyProject: true as const } : {}) });
  if (!("account" in standing)) return { ok: false, ...standing };
  if (standing.account.generation !== checked.accountGeneration) {
    return { ok: false, code: "device_revoked", message: "This iPhone is no longer paired or your account changed." };
  }
  // Both writes or neither (a caller that returns this refusal normally still commits nothing of it).
  const refusedWith = (code: string, message: string) => Object.assign(new Error(message), { refusal: { ok: false as const, code, message } });
  try {
    store.savepoint(() => {
      if (!consumePasskeyChallenge(store.handle, checked.challenge, input.now)) throw refusedWith("challenge_used", "That approval challenge was already used or expired.");
      if (!updateAccountPasskeyUsage(store.handle, checked.credentialId, checked.storedSignCount, checked.newSignCount, input.now)) throw refusedWith("sign_count_regression", "Passkey signCount did not advance.");
    });
  } catch (error) {
    const refusal = (error as { refusal?: { ok: false; code: string; message: string } }).refusal;
    if (refusal !== undefined) return refusal;
    throw error;
  }
  const provedAtMs = input.now.getTime();
  if (input.startsLease !== undefined && (checked.verb === "approve" || checked.verb === "accept" || checked.verb === "unlock")) {
    const pending = registry(PENDING, store);
    for (const [k, one] of pending) if (provedAtMs - one.provedAtMs > PASSKEY_CHALLENGE_TTL_MS) pending.delete(k);
    pending.set(checked.challenge, {
      deviceId: checked.deviceId,
      accountName: checked.accountName,
      credentialId: checked.credentialId,
      recoveryGeneration: store.workspaceIdentity().recoveryGeneration,
      accountGeneration: checked.accountGeneration,
      provedAtMs,
      expiresAtMs: provedAtMs + input.startsLease.minutes * 60_000,
      be: checked.be,
      bs: checked.bs,
    });
  }
  const { verb: _verb, challenge: _challenge, storedSignCount: _s, newSignCount: _n, ...result } = checked;
  return { ...result, provedAtMs };
}

/** Check and consume in one step (inside the verb's transaction). */
export function verifyPasskeyAction(
  store: Store,
  input: Parameters<typeof checkPasskeyAction>[1] & { startsLease?: { minutes: number } },
): PasskeyGateResult {
  const checked = checkPasskeyAction(store, input);
  if (!checked.ok) return checked;
  return consumePasskeyAction(store, checked, {
    repo: input.repo,
    now: input.now,
    ...(input.anyProject === true ? { anyProject: true as const } : {}),
    ...(input.startsLease === undefined ? {} : { startsLease: input.startsLease }),
  });
}

// ---- Approvals windows (leases): owned here, in memory only -------------------------------------------------------

/** A device's approvals window: in memory only (gone on restart), keyed by device and account, per store. */
interface PasskeyLease {
  deviceId: string;
  accountName: string;
  credentialId: string;
  recoveryGeneration: string;
  accountGeneration: number;
  provedAtMs: number;
  expiresAtMs: number;
  be: boolean;
  bs: boolean;
}

const LEASES = new WeakMap<Store, Map<string, PasskeyLease>>();
/** Window grants parked by a consumption, by challenge, until `startPasskeyLease` sees that consumption committed. */
const PENDING = new WeakMap<Store, Map<string, PasskeyLease>>();

function registry(of: WeakMap<Store, Map<string, PasskeyLease>>, store: Store): Map<string, PasskeyLease> {
  let map = of.get(store);
  if (map === undefined) { map = new Map(); of.set(store, map); }
  return map;
}
const leaseKey = (deviceId: string, accountName: string): string => `${deviceId}\0${accountName}`;

/**
 * Opens the approvals window a committed consumption parked (by its challenge): only a live assertion that was
 * verified and consumed for a routine approve/accept or an unlock, whose challenge row now reads consumed, by this
 * device and account. Returns when the window ends, or null when nothing opens (window set to Every approval, or no
 * such committed consumption).
 */
export function startPasskeyLease(store: Store, input: { deviceId: string; accountName: string; challenge: string }): string | null {
  const pending = registry(PENDING, store);
  const grant = pending.get(input.challenge);
  pending.delete(input.challenge);
  if (grant === undefined || grant.deviceId !== input.deviceId || grant.accountName !== input.accountName) return null;
  const row = getPasskeyChallenge(store.handle, input.challenge);
  if (row === null || row.consumedAt === null || row.deviceId !== input.deviceId || row.accountName !== input.accountName) return null;
  const windowMinutes = passkeyApprovalWindowMinutes(store);
  if (windowMinutes <= 0) return null;
  const lease = { ...grant, expiresAtMs: Math.min(grant.expiresAtMs, grant.provedAtMs + windowMinutes * 60_000) };
  registry(LEASES, store).set(leaseKey(input.deviceId, input.accountName), lease);
  return new Date(lease.expiresAtMs).toISOString();
}

/** The device's approvals window, if it still stands now: window setting above zero (and never longer than it now
 * allows), same recovery and account generations, and the account, device and credential all still standing. */
export function activePasskeyLease(store: Store, deviceId: string, accountName: string, now: Date): PasskeyLease | null {
  const leases = registry(LEASES, store);
  const key = leaseKey(deviceId, accountName);
  const lease = leases.get(key);
  if (lease === undefined) return null;
  const windowMinutes = passkeyApprovalWindowMinutes(store);
  const expiresAtMs = Math.min(lease.expiresAtMs, lease.provedAtMs + windowMinutes * 60_000);
  const standing = standingProblem(store, { accountName, repo: null, anyProject: true, deviceId, credentialId: lease.credentialId });
  if (
    windowMinutes <= 0 ||
    now.getTime() >= expiresAtMs ||
    lease.recoveryGeneration !== store.workspaceIdentity().recoveryGeneration ||
    !("account" in standing) ||
    standing.account.generation !== lease.accountGeneration
  ) {
    leases.delete(key);
    return null;
  }
  return { ...lease, expiresAtMs };
}

/** Re-verifies a device's approvals window inside a verb's transaction (the domain gate's side of `PasskeyLeaseUse`). */
export function verifyPasskeyLease(store: Store, input: { accountName: string; repo: string | null; proof: PasskeyLeaseUse; now: Date }): PasskeyGateResult {
  const lease = activePasskeyLease(store, input.proof.deviceId, input.accountName, input.now);
  if (lease === null) {
    return { ok: false, code: "step_up_required", message: "Your approvals window ended. Confirm with your passkey." };
  }
  const standing = standingProblem(store, { accountName: input.accountName, repo: input.repo, deviceId: lease.deviceId, credentialId: lease.credentialId });
  if (!("account" in standing)) return { ok: false, ...standing };
  return {
    ok: true,
    accountName: input.accountName,
    accountGeneration: lease.accountGeneration,
    deviceId: lease.deviceId,
    credentialId: lease.credentialId,
    be: lease.be,
    bs: lease.bs,
    provedAtMs: lease.provedAtMs,
  };
}

/** Ends approvals windows (all, an account's, or one device's): lock, passkey revoke, window change, device removal. */
export function clearPasskeyLeases(store: Store, accountName?: string, deviceId?: string): void {
  for (const map of [registry(LEASES, store), registry(PENDING, store)]) {
    for (const [k, lease] of map) {
      if ((accountName === undefined || lease.accountName === accountName) && (deviceId === undefined || lease.deviceId === deviceId)) map.delete(k);
    }
  }
}

/**
 * Policy invariant (ADR 0005 & docs/plans/chat-management.md §7):
 * Checks whether a workspace or project requires Passkeys for approvals (`passkey_approval_policy` table).
 * When enabled, `chat` (`chat-code`) approvals are refused.
 */
export const PASSKEY_REQUIRED_WORKSPACE_SCOPE = "*";

export function passkeyRequiredForApprovals(store: Store, repo: string | null): boolean {
  const workspaceVal = store.handle
    .prepare("SELECT required FROM passkey_approval_policy WHERE scope = ?")
    .get(PASSKEY_REQUIRED_WORKSPACE_SCOPE)?.["required"];
  if (Number(workspaceVal) === 1) return true;
  if (repo !== null) {
    const projectVal = store.handle
      .prepare("SELECT required FROM passkey_approval_policy WHERE scope = ?")
      .get(repo)?.["required"];
    if (Number(projectVal) === 1) return true;
  }
  return false;
}

export function setPasskeyRequiredForApprovals(store: Store, enabled: boolean, repo?: string): void {
  const scope = repo ?? PASSKEY_REQUIRED_WORKSPACE_SCOPE;
  const existing = store.handle
    .prepare("SELECT window_minutes FROM passkey_approval_policy WHERE scope = ?")
    .get(scope);
  const windowMinutes = existing !== undefined
    ? (parsePasskeyWindowMinutes(Number(existing["window_minutes"])) ?? DEFAULT_PASSKEY_WINDOW_MINUTES)
    : DEFAULT_PASSKEY_WINDOW_MINUTES;
  if (enabled) {
    store.handle
      .prepare("INSERT INTO passkey_approval_policy (scope, required, window_minutes) VALUES (?, 1, ?) ON CONFLICT(scope) DO UPDATE SET required = 1")
      .run(scope, windowMinutes);
  } else if (scope === PASSKEY_REQUIRED_WORKSPACE_SCOPE && existing !== undefined) {
    store.handle.prepare("UPDATE passkey_approval_policy SET required = 0 WHERE scope = ?").run(scope);
  } else {
    store.handle.prepare("DELETE FROM passkey_approval_policy WHERE scope = ?").run(scope);
  }
}

/**
 * Workspace-level Passkey freshness window for routine phone approvals (`0` = every time, `15` = 15 min default,
 * `60` = 1 hour). High-impact acts (`Ship`, `Land`, protected scopes, exception accepts) always prompt every time.
 */
export function passkeyApprovalWindowMinutes(store: Store): PasskeyWindowMinutes {
  const row = store.handle
    .prepare("SELECT window_minutes FROM passkey_approval_policy WHERE scope = ?")
    .get(PASSKEY_REQUIRED_WORKSPACE_SCOPE);
  if (row === undefined) return DEFAULT_PASSKEY_WINDOW_MINUTES;
  return parsePasskeyWindowMinutes(Number(row["window_minutes"])) ?? DEFAULT_PASSKEY_WINDOW_MINUTES;
}

/** Sets the Workspace approvals window; returns what it was. Callers end open windows (`clearPasskeyLeases`). */
export function setPasskeyApprovalWindowMinutes(store: Store, minutes: PasskeyWindowMinutes): PasskeyWindowMinutes {
  const before = passkeyApprovalWindowMinutes(store);
  store.handle
    .prepare(`
      INSERT INTO passkey_approval_policy (scope, required, window_minutes)
      VALUES (?, 0, ?)
      ON CONFLICT(scope) DO UPDATE SET window_minutes = excluded.window_minutes
    `)
    .run(PASSKEY_REQUIRED_WORKSPACE_SCOPE, minutes);
  return before;
}
