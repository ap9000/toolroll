/**
 * Transactional Passkey Verification Gate (ADR 0005).
 *
 * Called directly inside each verb's real domain transaction (`scope.ts:approve`,
 * `assignment.ts:acceptAndCompleteAsOperator`, `local-landing.ts:land`, `pull-request-flow.ts:mergeAsPerson`).
 * Never writes a parallel ledger entry outside the real domain gate.
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
  PASSKEY_ORIGIN,
  PASSKEY_RP_ID,
  verifyAssertionResponse,
  type PasskeyVerb,
  type VerbChallengeBinding,
  type WebAuthnAssertionPayload,
} from "./webauthn.js";

export interface PasskeyActionProof {
  readonly deviceId: string;
  readonly challenge: string;
  readonly assertion: WebAuthnAssertionPayload;
  readonly rpId?: string;
  readonly expectedOrigin?: string;
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
  }
  | { ok: false; code: string; message: string };

/**
 * Verifies (and optionally atomically consumes) a single-use verb-specific passkey assertion.
 *
 * - `consume: false`: pre-flight check before expensive external/git prep (`land`, `ship`).
 * - `consume: true`: MUST run inside the verb's `store.transact()` so challenge consumption, signCount update,
 *   proof row, and domain state change commit or roll back together.
 */
export function verifyPasskeyAction(
  store: Store,
  input: {
    accountName: string;
    repo: string | null;
    verb: PasskeyVerb;
    expectedBinding: VerbChallengeBinding;
    proof: PasskeyActionProof;
    now: Date;
    consume: boolean;
  },
): PasskeyGateResult {
  const identity = store.workspaceIdentity();
  const account = store.accountOf(input.accountName);
  if (account === null || account.revokedAt !== null || account.role !== "approver") {
    return { ok: false, code: "not_an_approver", message: "Only an active approver account can authorize this act." };
  }
  if (input.repo === null || !store.accountCanAccess(input.accountName, input.repo)) {
    return { ok: false, code: "not_an_approver", message: "You don't have access to this project." };
  }

  // Re-verify active paired-device standing (device active, non-revoked, current recoveryGeneration, current accountGeneration).
  const device = getPairedDevice(store.handle, input.proof.deviceId);
  if (
    device === null ||
    device.revokedAt !== null ||
    device.activatedAt === null ||
    device.accountName !== input.accountName ||
    device.recoveryGeneration !== identity.recoveryGeneration ||
    !deviceAccountStands(device, account)
  ) {
    return { ok: false, code: "device_revoked", message: "This iPhone is no longer paired or your account changed." };
  }

  // Load and verify single-use verb-specific challenge.
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
  const expectedBindingJson = canonicalJson(input.expectedBinding);
  if (challengeRow.bindingJson !== expectedBindingJson) {
    return { ok: false, code: "binding_mismatch", message: "The target changed since the approval challenge was issued." };
  }

  // Verify credential belongs to (workspaceId, accountName, recoveryGeneration) and is not revoked.
  const cred = getAccountPasskey(store.handle, input.proof.assertion.credentialId);
  if (
    cred === null ||
    cred.revokedAt !== null ||
    cred.workspaceId !== identity.id ||
    cred.accountName !== input.accountName ||
    cred.recoveryGeneration !== identity.recoveryGeneration
  ) {
    return { ok: false, code: "credential_not_allowed", message: "That passkey is not active for your account on this Mac." };
  }

  const expectedUserHandle = derivePasskeyUserHandle(identity.id, input.accountName);
  const verified = verifyAssertionResponse({
    payload: input.proof.assertion,
    expectedChallenge: challengeRow.challenge,
    expectedUserHandle,
    storedPublicKeySpki: cred.publicKeySpki,
    storedSignCount: cred.signCount,
    rpId: input.proof.rpId ?? PASSKEY_RP_ID,
    expectedOrigin: input.proof.expectedOrigin ?? PASSKEY_ORIGIN,
  });
  if (!verified.ok) return verified;

  if (input.consume) {
    const consumed = consumePasskeyChallenge(store.handle, challengeRow.challenge, input.now);
    if (!consumed) {
      return { ok: false, code: "challenge_used", message: "That approval challenge was already used or expired." };
    }
    updateAccountPasskeyUsage(store.handle, cred.credentialId, verified.newSignCount, input.now);
  }

  return {
    ok: true,
    accountName: input.accountName,
    accountGeneration: account.generation,
    deviceId: input.proof.deviceId,
    credentialId: cred.credentialId,
    be: verified.be,
    bs: verified.bs,
  };
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
  if (enabled) {
    store.handle.prepare("INSERT OR REPLACE INTO passkey_approval_policy (scope, required) VALUES (?, 1)").run(scope);
  } else {
    store.handle.prepare("DELETE FROM passkey_approval_policy WHERE scope = ?").run(scope);
  }
}
