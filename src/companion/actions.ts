/**
 * Gate 2 Companion Actions — Passkey Registration, Challenge Minting, Idempotency State Machine, and
 * Per-Verb Transactional Dispatch (`docs/adr/0005-passkey-phone-approvals.md`,
 * `docs/plans/companion-app/threat-model-and-routes.md` §3).
 *
 * Every high-trust mutation routes directly into Toolroll's real domain gate:
 *   - `task.approve` → `src/scope.ts:approve()`
 *   - `task.accept`  → `src/assignment.ts:acceptAndCompleteAsOperator()` (+ `completeAndOpenPullRequest` when `publish`)
 *   - `task.land`    → `src/local-landing.ts:land()`
 *   - `task.ship`    → `src/pull-request-flow.ts:mergeAsPerson()`
 *
 * Every paired-device call runs under `PairedDevicePrincipal` (`requestFromThisComputer === false`), never over loopback.
 */

import { acceptAndCompleteAsOperator, acceptWindowCovers, assignmentOf } from "../assignment.js";
import { land, readLanding } from "../local-landing.js";
import { verifyApproverStanding, type VerifiedApprover } from "../principal.js";
import { completeAndOpenPullRequest, mergeAsPerson } from "../pull-request-flow.js";
import { approvalWindowCovers, approve } from "../scope.js";
import { requestContext } from "../server/request-context.js";
import type { CompanionReadRuntime } from "./reads.js";
import type { PairedDevicePrincipal } from "./daemon.js";
import {
  claimDeviceIdempotency,
  consumePasskeyChallenge,
  deviceAccountStands,
  getAccountPasskey,
  getPairedDevice,
  getPasskeyChallenge,
  insertAccountPasskey,
  listActiveAccountPasskeys,
  pruneDeviceIdempotency,
  prunePasskeyChallenges,
  reconcileIdempotencyOnStartup,
  savePasskeyChallenge,
  settleDeviceIdempotency,
} from "./store.js";
import {
  acceptBindingOf,
  buildActionChallenge,
  canonicalJson,
  derivePasskeyUserHandle,
  minutesWords,
  normalizeAcceptNote,
  passkeyProofDetail,
  PASSKEY_CHALLENGE_TTL_MS,
  PASSKEY_ORIGIN,
  PASSKEY_RP_ID,
  PASSKEY_RP_NAME,
  randomChallenge32,
  sha256,
  verifyRegistrationResponse,
  type PasskeyVerb,
  type VerbChallengeBinding,
  type WebAuthnAssertionPayload,
} from "./webauthn.js";
import {
  activePasskeyLease,
  clearPasskeyLeases,
  passkeyApprovalWindowMinutes,
  startPasskeyLease,
  verifyPasskeyAction,
  type PasskeyActionProof,
  type PasskeyAssertionProof,
} from "./passkey-gate.js";
import type { PublishExec } from "../publish.js";
import type { Runner } from "../backend.js";

/** The ledger act an approvals unlock writes (who, which passkey, which phone, for how long). */
export const APPROVALS_UNLOCKED_ACTION = "approvals unlocked";

/** Mac consent window duration for enrolling a passkey on an iPhone (5 minutes). */
export const PASSKEY_ENROLLMENT_WINDOW_MS = 5 * 60 * 1000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class CompanionActionError extends Error {
  constructor(
    readonly code:
      | "invalid_params"
      | "not_found"
      | "standing_revoked"
      | "enrollment_closed"
      | "no_passkey"
      | "passkey_failed"
      | "passkey_step_up_required"
      | "idempotency_key_conflict"
      | "in_progress"
      | "outcome_unknown"
      | "refused"
      | "approvals_window_off"
      | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface CompanionActionHandlers {
  passkeyStatus: (principal: PairedDevicePrincipal) => Promise<unknown> | unknown;
  passkeyLock: (principal: PairedDevicePrincipal) => Promise<unknown> | unknown;
  passkeyRegisterBegin: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  passkeyRegisterFinish: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  approvalChallenge: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskApprove: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskAccept: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskLand: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskShip: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  /** `passkey.unlock`: one live passkey assertion opens this phone's approvals window (routine approve/accept only). */
  passkeyUnlock: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Open a signed-in Mac consent window allowing an approver's iPhone to register a Passkey. */
  openEnrollmentWindow: (accountName: string, deviceId?: string | null) => { expiresAtMs: number };
  /** Check whether an enrollment window is currently open for an account/device. */
  isEnrollmentOpen: (accountName: string, deviceId?: string | null) => boolean;
  /** Close any open enrollment window for an account. */
  closeEnrollmentWindow: (accountName: string) => void;
  /** End approvals windows (passkey revoke, window change, device removal, lock): delegates to the gate's registry. */
  clearFreshLeases: (accountName?: string, deviceId?: string) => void;
  /** Sweep expired challenges & bounded idempotency retention (called on daemon startup & hourly sweep). */
  sweep: () => void;
}

export interface CompanionActionDeps {
  runtime: CompanionReadRuntime;
  workspaceLabel: () => string;
  /** Called after a mutation commits so live UI subscribers refresh immediately. */
  onMutated?: () => void;
  /** Test/fork overrides for WebAuthn RP ID / origin and external runners. */
  rpId?: string;
  expectedOrigin?: string;
  git?: Runner;
  publishExec?: PublishExec;
}

interface EnrollmentWindow {
  accountName: string;
  deviceId: string | null;
  expiresAtMs: number;
}

function parseAssertion(raw: unknown): WebAuthnAssertionPayload {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CompanionActionError("invalid_params", "assertion object is required");
  }
  const obj = raw as Record<string, unknown>;
  const credentialId = obj["credentialId"];
  const clientDataJSON = obj["clientDataJSON"];
  const authenticatorData = obj["authenticatorData"];
  const signature = obj["signature"];
  const userHandle = obj["userHandle"];
  if (
    typeof credentialId !== "string" || credentialId.length === 0 ||
    typeof clientDataJSON !== "string" || clientDataJSON.length === 0 ||
    typeof authenticatorData !== "string" || authenticatorData.length === 0 ||
    typeof signature !== "string" || signature.length === 0 ||
    typeof userHandle !== "string" || userHandle.length === 0
  ) {
    throw new CompanionActionError("invalid_params", "assertion is missing required WebAuthn fields");
  }
  return { credentialId, clientDataJSON, authenticatorData, signature, userHandle };
}

function requireIdempotencyKey(params: Record<string, unknown>): string {
  const key = params["idempotencyKey"];
  if (typeof key !== "string" || !UUID_V4.test(key)) {
    throw new CompanionActionError("invalid_params", "idempotencyKey (UUIDv4) is required");
  }
  return key.toLowerCase();
}

function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== "string" || val.length === 0) {
    throw new CompanionActionError("invalid_params", `${key} is required`);
  }
  return val;
}

export function createCompanionActions(deps: CompanionActionDeps): CompanionActionHandlers {
  const { runtime } = deps;
  const store = runtime.store;
  const rpId = deps.rpId ?? PASSKEY_RP_ID;
  const expectedOrigin = deps.expectedOrigin ?? PASSKEY_ORIGIN;
  const windows = new Map<string, EnrollmentWindow>();

  const clearFreshLeases = (accountName?: string, deviceId?: string): void => clearPasskeyLeases(store, accountName, deviceId);
  /** When this device's approvals window ends, or null (the gate's registry, re-checked now). */
  const windowUntil = (principal: PairedDevicePrincipal): string | null => {
    const lease = activePasskeyLease(store, principal.deviceId, principal.accountName, now());
    return lease === null ? null : new Date(lease.expiresAtMs).toISOString();
  };
  /** After a committed act: a live routine approve/accept opens the window (the gate decides); else what stands. */
  const windowAfter = (principal: PairedDevicePrincipal, proof: PasskeyActionProof): string | null =>
    (proof.kind === "lease" ? null : startPasskeyLease(store, { deviceId: principal.deviceId, accountName: principal.accountName, challenge: proof.challenge }))
      ?? windowUntil(principal);
  /** The proof a request carries: this device's approvals window (only where `lease` is allowed) or a live assertion. */
  const proofOf = (principal: PairedDevicePrincipal, params: Record<string, unknown>, lease: boolean): PasskeyActionProof => {
    if (params["useFreshSession"] === true) {
      if (!lease) throw new CompanionActionError("passkey_step_up_required", "Confirm with your passkey for this action.");
      return { kind: "lease", deviceId: principal.deviceId };
    }
    return liveProofOf(principal, params);
  };
  const liveProofOf = (principal: PairedDevicePrincipal, params: Record<string, unknown>): PasskeyAssertionProof =>
    ({ kind: "assertion", deviceId: principal.deviceId, challenge: requireString(params, "challenge"), assertion: parseAssertion(params["assertion"]), rpId, expectedOrigin });
  /** An unlock's length: the phone may ask for less than the Mac's window, never more. */
  const unlockMinutes = (params: Record<string, unknown>, windowMinutes: number): number => {
    const raw = params["minutes"];
    if (raw === undefined || raw === null) return windowMinutes;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new CompanionActionError("invalid_params", "minutes must be a positive whole number");
    return Math.min(raw, windowMinutes);
  };
  const windowOff = (): CompanionActionError =>
    new CompanionActionError("approvals_window_off", "Your Mac asks for your passkey on every approval, so approvals can't be unlocked.");

  // Startup reconciliation (threat-model-and-routes.md §3): move lingering in_flight rows to unknown.
  reconcileIdempotencyOnStartup(store.handle, runtime.clock());
  pruneDeviceIdempotency(store.handle, runtime.clock());
  prunePasskeyChallenges(store.handle, runtime.clock());

  function now(): Date {
    return runtime.clock();
  }

  function standsApprover(principal: PairedDevicePrincipal): { accountName: string; account: NonNullable<ReturnType<typeof store.accountOf>>; who: VerifiedApprover; deviceName: string } {
    const accountName = principal.accountName;
    const identity = store.workspaceIdentity();
    const device = getPairedDevice(store.handle, principal.deviceId);
    const account = store.accountOf(accountName);
    if (
      device === null ||
      device.revokedAt !== null ||
      device.activatedAt === null ||
      device.accountName !== accountName ||
      device.recoveryGeneration !== identity.recoveryGeneration ||
      identity.recoveryGeneration !== principal.recoveryGeneration ||
      !deviceAccountStands(device, account)
    ) {
      throw new CompanionActionError("standing_revoked", "This iPhone is no longer paired.");
    }
    if (account === null || account.role !== "approver") {
      throw new CompanionActionError("refused", "Only an approver account can authorize actions from iPhone.");
    }
    const repos = store.knownRepos().filter(r => runtime.visible(r) && store.accountCanAccess(accountName, r));
    const verified = verifyApproverStanding(store, accountName, account.generation, repos);
    if (!verified.ok) {
      throw new CompanionActionError("standing_revoked", "Your account standing changed. Pair again.");
    }
    return { accountName, account, who: verified.who, deviceName: device.deviceName };
  }

  function isEnrollmentOpen(accountName: string, deviceId: string | null = null): boolean {
    const win = windows.get(accountName);
    if (win === undefined) return false;
    if (now().getTime() > win.expiresAtMs) {
      windows.delete(accountName);
      return false;
    }
    return win.deviceId === null || deviceId === null || win.deviceId === deviceId;
  }

  function openEnrollmentWindow(accountName: string, deviceId: string | null = null): { expiresAtMs: number } {
    const expiresAtMs = now().getTime() + PASSKEY_ENROLLMENT_WINDOW_MS;
    windows.set(accountName, { accountName, deviceId, expiresAtMs });
    return { expiresAtMs };
  }

  function closeEnrollmentWindow(accountName: string): void {
    windows.delete(accountName);
  }

  /**
   * Runs a Gate 2 mutation under the `device_idempotency` state machine (conflict / in_flight / completed / unknown).
   * A finished request's outcome is stored discriminated: a replay returns the same result, or throws the same error.
   * `unknown` only when the outcome may have happened without being confirmed: a domain answer of `outcome_unknown`
   * (an external effect that ran but couldn't be read back) or an unexpected exception. Every other refusal is a
   * definite failure, replayed as that error.
   */
  async function withIdempotency<T>(
    principal: PairedDevicePrincipal,
    method: string,
    idempotencyKey: string,
    canonicalTarget: Record<string, unknown>,
    work: () => Promise<T> | T,
  ): Promise<T> {
    const requestHash = sha256(canonicalJson({ method, target: canonicalTarget })).toString("hex");
    const claim = claimDeviceIdempotency(store.handle, { deviceId: principal.deviceId, idempotencyKey, method, requestHash, now: now() });
    if (claim.status === "conflict") {
      throw new CompanionActionError("idempotency_key_conflict", "This idempotency key was already used for a different request.");
    }
    if (claim.status === "in_flight") throw new CompanionActionError("in_progress", "That action is already running on your Mac.");
    if (claim.status === "unknown") {
      throw new CompanionActionError("outcome_unknown", "The previous attempt didn't finish cleanly. Refresh to check the current state.");
    }
    if (claim.status === "completed") {
      const stored = JSON.parse(claim.outcomeJson) as { kind?: unknown; value?: unknown; code?: unknown; message?: unknown };
      if (stored.kind === "ok") return stored.value as T;
      if (stored.kind === "error" && typeof stored.code === "string" && typeof stored.message === "string") {
        throw new CompanionActionError(stored.code as CompanionActionError["code"], stored.message);
      }
      throw new CompanionActionError("outcome_unknown", "The previous attempt didn't finish cleanly. Refresh to check the current state.");
    }
    const settle = (state: "completed" | "unknown", outcome: unknown): void => {
      settleDeviceIdempotency(store.handle, principal.deviceId, idempotencyKey, state, outcome === null ? null : JSON.stringify(outcome), now());
      pruneDeviceIdempotency(store.handle, now());
    };
    let outcome: T;
    try {
      outcome = await work();
    } catch (error) {
      if (error instanceof CompanionActionError && error.code !== "outcome_unknown") {
        settle("completed", { kind: "error", code: error.code, message: error.message });
        throw error;
      }
      settle("unknown", null);
      if (error instanceof CompanionActionError) throw error;
      throw new CompanionActionError("outcome_unknown", "Something went wrong on your Mac. Refresh to check the current state.");
    }
    settle("completed", { kind: "ok", value: outcome });
    return outcome;
  }

  /** One verb: the device's standing, its idempotency key, then the work under the state machine (live UI refreshed after). */
  async function perform<T>(
    principal: PairedDevicePrincipal,
    params: Record<string, unknown>,
    method: string,
    target: Record<string, unknown>,
    work: (standing: ReturnType<typeof standsApprover>) => Promise<T> | T,
  ): Promise<T> {
    const standing = standsApprover(principal);
    const idempotencyKey = requireIdempotencyKey(params);
    return withIdempotency(principal, method, idempotencyKey, target, async () => {
      const out = await work(standing);
      deps.onMutated?.();
      return out;
    });
  }

  return {
    openEnrollmentWindow,
    isEnrollmentOpen,
    closeEnrollmentWindow,
    clearFreshLeases,
    sweep: () => {
      const t = now();
      prunePasskeyChallenges(store.handle, t);
      pruneDeviceIdempotency(store.handle, t);
      for (const [k, w] of windows.entries()) {
        if (t.getTime() > w.expiresAtMs) windows.delete(k);
      }
    },

    passkeyStatus: async principal => {
      const { accountName } = standsApprover(principal);
      const identity = store.workspaceIdentity();
      const active = listActiveAccountPasskeys(store.handle, identity.id, accountName, identity.recoveryGeneration);
      return {
        registered: active.length > 0,
        count: active.length,
        enrollmentOpen: isEnrollmentOpen(accountName, principal.deviceId),
        rpId,
        windowMinutes: passkeyApprovalWindowMinutes(store),
        freshUntil: windowUntil(principal),
      };
    },

    passkeyLock: async principal => {
      const { accountName } = standsApprover(principal);
      clearFreshLeases(accountName, principal.deviceId);
      return { ok: true, locked: true };
    },

    passkeyRegisterBegin: async principal => {
      const { accountName } = standsApprover(principal);
      if (!isEnrollmentOpen(accountName, principal.deviceId)) {
        throw new CompanionActionError(
          "enrollment_closed",
          "Open Settings → Phone on your Mac and click Enable passkey on iPhone first.",
        );
      }
      const identity = store.workspaceIdentity();
      const t = now();
      prunePasskeyChallenges(store.handle, t);
      const challenge = randomChallenge32();
      const expiresAt = new Date(t.getTime() + PASSKEY_CHALLENGE_TTL_MS).toISOString();
      const userHandle = derivePasskeyUserHandle(identity.id, accountName).toString("base64url");
      const active = listActiveAccountPasskeys(store.handle, identity.id, accountName, identity.recoveryGeneration);

      savePasskeyChallenge(store.handle, {
        challenge,
        kind: "register",
        workspaceId: identity.id,
        accountName,
        deviceId: principal.deviceId,
        recoveryGeneration: identity.recoveryGeneration,
        bindingJson: canonicalJson({ kind: "register", deviceId: principal.deviceId }),
        expiresAt,
      });

      return {
        challenge,
        rp: { id: rpId, name: PASSKEY_RP_NAME },
        user: {
          id: userHandle,
          name: accountName,
          displayName: deps.workspaceLabel(),
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        excludeCredentials: active.map(c => ({ id: c.credentialId, type: "public-key" })),
        expiresAt,
      };
    },

    passkeyRegisterFinish: async (principal, params) => {
      const challenge = requireString(params, "challenge");
      const clientDataJSON = requireString(params, "clientDataJSON");
      const attestationObject = requireString(params, "attestationObject");
      const credentialIdParam = typeof params["credentialId"] === "string" ? params["credentialId"] : undefined;
      const customLabel = typeof params["label"] === "string" && params["label"].trim().length > 0 ? params["label"].trim() : null;

      return store.transact(() => {
        const { accountName, deviceName } = standsApprover(principal);
        if (!isEnrollmentOpen(accountName, principal.deviceId)) {
          throw new CompanionActionError("enrollment_closed", "The passkey enrollment window closed. Start again on your Mac.");
        }
        const identity = store.workspaceIdentity();
        const t = now();
        const row = getPasskeyChallenge(store.handle, challenge);
        if (
          row === null ||
          row.kind !== "register" ||
          row.consumedAt !== null ||
          Date.parse(row.expiresAt) <= t.getTime() ||
          row.workspaceId !== identity.id ||
          row.accountName !== accountName ||
          row.deviceId !== principal.deviceId ||
          row.recoveryGeneration !== identity.recoveryGeneration
        ) {
          throw new CompanionActionError("passkey_failed", "That registration challenge expired or isn't valid. Try again.");
        }

        const verified = verifyRegistrationResponse({
          payload: {
            ...(credentialIdParam === undefined ? {} : { credentialId: credentialIdParam }),
            clientDataJSON,
            attestationObject,
          },
          expectedChallenge: row.challenge,
          rpId,
          expectedOrigin,
        });
        if (!verified.ok) {
          throw new CompanionActionError("passkey_failed", verified.message);
        }

        // ADR 0005: credentialId MUST be brand new.
        if (getAccountPasskey(store.handle, verified.credentialId) !== null) {
          throw new CompanionActionError("passkey_failed", "That passkey is already registered.");
        }

        const consumed = consumePasskeyChallenge(store.handle, row.challenge, t);
        if (!consumed) {
          throw new CompanionActionError("passkey_failed", "Registration challenge was already used.");
        }

        const userHandle = derivePasskeyUserHandle(identity.id, accountName).toString("base64url");
        const label = customLabel ?? deviceName;
        const inserted = insertAccountPasskey(store.handle, {
          credentialId: verified.credentialId,
          workspaceId: identity.id,
          accountName,
          userHandle,
          publicKeySpki: verified.publicKeySpki,
          signCount: verified.signCount,
          label,
          createdAt: t.toISOString(),
          recoveryGeneration: identity.recoveryGeneration,
        });
        if (!inserted) {
          throw new CompanionActionError("passkey_failed", "That passkey is already registered.");
        }
        closeEnrollmentWindow(accountName);
        deps.onMutated?.();
        return { ok: true, credentialId: verified.credentialId, label };
      });
    },

    approvalChallenge: async (principal, params) => {
      const { accountName, who, deviceName } = standsApprover(principal);
      const identity = store.workspaceIdentity();
      const activeCreds = listActiveAccountPasskeys(store.handle, identity.id, accountName, identity.recoveryGeneration);
      if (activeCreds.length === 0) {
        throw new CompanionActionError("no_passkey", "Set up a passkey in Settings before approving from this iPhone.");
      }

      const verbRaw = requireString(params, "verb");
      if (verbRaw !== "approve" && verbRaw !== "accept" && verbRaw !== "land" && verbRaw !== "ship" && verbRaw !== "unlock") {
        throw new CompanionActionError("invalid_params", "verb must be approve, accept, land, ship, or unlock");
      }
      const verb = verbRaw as PasskeyVerb;
      const forceFresh = params["forceFresh"] === true;
      const t = now();
      prunePasskeyChallenges(store.handle, t);

      let binding: VerbChallengeBinding;
      /** Whether this device's approvals window may carry the act (the domain gate's own rule, asked here as a hint). */
      let windowCovers = false;
      let wording: string | null = null;
      if (verb === "approve") {
        const taskId = requireString(params, "task");
        if (!TASK_ID.test(taskId)) throw new CompanionActionError("invalid_params", "Invalid task id.");
        const family = requestContext.run({ csrf: "", returnTo: "/", actor: accountName }, () => runtime.familyOf(taskId));
        if (family === null || family.problem !== null || !runtime.visible(family.current.repo) || !store.accountCanAccess(accountName, family.current.repo)) {
          throw new CompanionActionError("not_found", "No such task.");
        }
        const scope = store.getScope(family.current.id);
        if (scope === null) throw new CompanionActionError("refused", "This task has no plan waiting for approval.");
        const sawDigest = typeof params["digest"] === "string" && params["digest"].length > 0 ? params["digest"] : scope.digest;
        if (sawDigest !== scope.digest) {
          throw new CompanionActionError("refused", "This plan changed. Refresh before approving.");
        }
        windowCovers = approvalWindowCovers(store, family.current.id, accountName);
        binding = { verb: "approve", taskId: family.current.id, sawDigest };
      } else if (verb === "accept") {
        const taskId = requireString(params, "task");
        if (!TASK_ID.test(taskId)) throw new CompanionActionError("invalid_params", "Invalid task id.");
        const before = assignmentOf(store, taskId, t, { principal: "operator", repos: who.repos }, runtime.evidenceRoot);
        if (before === null || !runtime.visible(before.repo) || !store.accountCanAccess(accountName, before.repo)) {
          throw new CompanionActionError("not_found", "No such task.");
        }
        if (before.receipt === null) throw new CompanionActionError("refused", "This task has no result ready to accept.");
        const runId = typeof params["runId"] === "number" ? params["runId"] : null;
        const receiptDigest = typeof params["receiptDigest"] === "string" && params["receiptDigest"].length > 0 ? params["receiptDigest"] : before.receipt.digest;
        const publish = params["publish"] === true;
        if (receiptDigest !== before.receipt.digest || (runId !== null && runId !== before.receipt.runId)) {
          throw new CompanionActionError("refused", "This result changed. Refresh before accepting.");
        }
        windowCovers = acceptWindowCovers(store, taskId, before, publish, runtime.evidenceRoot);
        binding = acceptBindingOf({ taskId, runId, receiptDigest, note: params["note"], publish }, before.receipt.runId);
      } else if (verb === "land") {
        const taskId = requireString(params, "task");
        if (!TASK_ID.test(taskId)) throw new CompanionActionError("invalid_params", "Invalid task id.");
        const into = typeof params["into"] === "string" && params["into"].length > 0 ? params["into"] : null;
        const undo = params["undo"] === true;
        const read = await readLanding(store, taskId, { repos: who.repos }, t, {
          root: runtime.evidenceRoot,
          ...(deps.git === undefined ? {} : { git: deps.git }),
          ...(into === null ? {} : { into }),
          ...(undo ? { undo: true } : {}),
        });
        if (!read.ok) throw new CompanionActionError("refused", read.message);
        if (!("plan" in read)) throw new CompanionActionError("refused", "This result has already landed.");
        const planKey = typeof params["key"] === "string" && params["key"].length > 0 ? params["key"] : read.plan.key;
        if (planKey !== read.plan.key) throw new CompanionActionError("refused", "The landing plan changed. Refresh first.");
        binding = { verb: "land", taskId, planKey, into, undo };
      } else if (verb === "ship") {
        const runIdRaw = params["runId"];
        if (typeof runIdRaw !== "number" || !Number.isInteger(runIdRaw) || runIdRaw <= 0) {
          throw new CompanionActionError("invalid_params", "runId is required");
        }
        const run = store.getRun(runIdRaw);
        const taskRef = run === null ? null : store.refById(run.taskRef);
        if (run === null || taskRef === null || taskRef.repo === null || !runtime.visible(taskRef.repo) || !store.accountCanAccess(accountName, taskRef.repo)) {
          throw new CompanionActionError("not_found", "No such run.");
        }
        const publication = store.publicationForRun(runIdRaw);
        const grant = store.publicationGrantFor(taskRef.repo);
        if (publication === null || publication.prNumber === null) {
          throw new CompanionActionError("refused", "This result has no open pull request to merge.");
        }
        const method = grant?.mergeMethod ?? "squash";
        const anyway = params["anyway"] === true;
        binding = { verb: "ship", runId: runIdRaw, taskId: taskRef.externalId, prNumber: publication.prNumber, headSha: publication.headSha, method, anyway };
      } else {
        const windowMinutes = passkeyApprovalWindowMinutes(store);
        if (windowMinutes <= 0) throw windowOff();
        const minutes = unlockMinutes(params, windowMinutes);
        binding = { verb: "unlock", minutes };
        wording = `Unlock approvals on ${deviceName} for ${minutesWords(minutes)}`;
      }

      const built = buildActionChallenge({
        workspaceId: identity.id,
        recoveryGeneration: identity.recoveryGeneration,
        accountName,
        deviceId: principal.deviceId,
        binding,
      });
      const allowCredentials = activeCreds.map(c => ({ id: c.credentialId, type: "public-key" }));

      const freshUntil = !forceFresh && windowCovers ? windowUntil(principal) : null;
      if (freshUntil !== null) {
        return { challenge: "", rpId, allowCredentials, userVerification: "required", verb, wording: built.wording, expiresAt: freshUntil, binding, freshApproved: true, freshUntil };
      }

      const expiresAt = new Date(t.getTime() + PASSKEY_CHALLENGE_TTL_MS).toISOString();
      savePasskeyChallenge(store.handle, {
        challenge: built.challenge,
        kind: verb,
        workspaceId: identity.id,
        accountName,
        deviceId: principal.deviceId,
        recoveryGeneration: identity.recoveryGeneration,
        bindingJson: built.bindingJson,
        expiresAt,
      });
      return {
        challenge: built.challenge, rpId, allowCredentials, userVerification: "required", verb, wording: wording ?? built.wording, expiresAt, binding,
        freshApproved: false, freshUntil: null,
      };
    },

    passkeyUnlock: async (principal, params) => {
      const { accountName } = standsApprover(principal);
      const proof = liveProofOf(principal, params);
      const windowMinutes = passkeyApprovalWindowMinutes(store);
      if (windowMinutes <= 0) throw windowOff();
      const minutes = unlockMinutes(params, windowMinutes);
      store.transact(() => {
        const t = now();
        const unlocked = verifyPasskeyAction(store, {
          accountName, repo: null, anyProject: true, verb: "unlock", expectedBinding: { verb: "unlock", minutes }, proof, now: t, startsLease: { minutes },
        });
        if (!unlocked.ok) throw new CompanionActionError("passkey_failed", unlocked.message);
        store.recordAction({ at: t.toISOString(), actor: accountName, repo: null, taskId: null, runId: null, action: APPROVALS_UNLOCKED_ACTION, outcome: "passkey", source: "request",
          detail: passkeyProofDetail({ at: t, generation: unlocked.accountGeneration, digest: `${minutes}m`, verb: "unlock", credentialId: unlocked.credentialId,
            pairedDeviceId: unlocked.deviceId, be: unlocked.be, bs: unlocked.bs }) });
      });
      const freshUntil = startPasskeyLease(store, { deviceId: principal.deviceId, accountName, challenge: proof.challenge });
      return { ok: true, unlocked: freshUntil !== null, minutes, windowMinutes, freshUntil };
    },

    taskApprove: async (principal, params) => {
      const taskId = requireString(params, "task");
      const sawDigest = requireString(params, "digest");
      const proof = proofOf(principal, params, true);
      return perform(principal, params, "task.approve", { taskId, sawDigest }, ({ accountName }) => {
        const family = requestContext.run({ csrf: "", returnTo: "/", actor: accountName }, () => runtime.familyOf(taskId));
        if (family === null || family.problem !== null || !runtime.visible(family.current.repo) || !store.accountCanAccess(accountName, family.current.repo)) {
          throw new CompanionActionError("not_found", "No such task.");
        }
        const res = approve(store, family.current.id, accountName, now(), sawDigest, "", {}, undefined, undefined, proof);
        if (!res.ok) {
          if (res.reason === "password-now") throw new CompanionActionError("passkey_step_up_required", "Confirm with your passkey to approve this task.");
          if (res.reason === "changed") throw new CompanionActionError("refused", "This plan changed. Refresh and review the latest terms.");
          if (res.reason === "policy") throw new CompanionActionError("refused", res.message);
          // A second approver's vote is recorded, and opens no approvals window.
          if (res.reason === "second-approver") return { ok: true, approved: false, secondApprover: true, have: res.have, need: res.need };
          throw new CompanionActionError("refused", `Couldn't approve this task (${res.reason}).`);
        }
        return { ok: true, approved: true, task: family.current.id, digest: res.scope.digest, freshUntil: windowAfter(principal, proof) };
      });
    },

    taskAccept: async (principal, params) => {
      const taskId = requireString(params, "task");
      const receiptDigest = requireString(params, "receiptDigest");
      const runId = typeof params["runId"] === "number" ? params["runId"] : null;
      const note = normalizeAcceptNote(params["note"]);
      const publish = params["publish"] === true;
      // Publishing always takes a live assertion; the domain gate refuses a window for anything else that isn't routine.
      const proof = proofOf(principal, params, !publish);
      return perform(principal, params, "task.accept", { taskId, runId, receiptDigest, note, publish }, ({ who }) => {
        let openedPrUrl: string | null = null;
        let openedPrNumber: number | null = null;
        const done = publish
          ? acceptAndCompleteAsOperator(store, taskId, { runId, receiptDigest, note, publish: true, passkey: proof }, who, now(), runtime.evidenceRoot, digest => {
            const targetRunId = runId ?? assignmentOf(store, taskId, now(), { principal: "operator", repos: who.repos }, runtime.evidenceRoot)?.receipt?.runId ?? null;
            if (targetRunId === null) return { ok: false, reason: "stale", message: "No result run found to publish." };
            const pub = completeAndOpenPullRequest(store, { taskId, digest, runId: targetRunId, who, root: runtime.evidenceRoot }, now());
            if (!pub.ok) return { ok: false, reason: "not-publishable", message: pub.message };
            openedPrUrl = pub.publication.prUrl;
            openedPrNumber = pub.publication.prNumber;
            return { ok: true, digest };
          })
          : acceptAndCompleteAsOperator(store, taskId, { runId, receiptDigest, note, publish: false, passkey: proof }, who, now(), runtime.evidenceRoot);
        // Every refusal here rolled back whole (the pull request is only owed inside the same savepoint): a definite failure.
        if (!done.ok) throw new CompanionActionError(done.reason === "step-up-required" ? "passkey_step_up_required" : "refused", done.message);
        return { ok: true, accepted: true, published: publish, prUrl: openedPrUrl, prNumber: openedPrNumber, freshUntil: windowAfter(principal, proof) };
      });
    },

    taskLand: async (principal, params) => {
      const taskId = requireString(params, "task");
      const key = requireString(params, "key");
      const into = typeof params["into"] === "string" && params["into"].length > 0 ? params["into"] : undefined;
      const undo = params["undo"] === true;
      const proof = liveProofOf(principal, params);
      return perform(principal, params, "task.land", { taskId, key, into: into ?? null, undo }, async ({ who }) => {
        const res = await land(
          store,
          taskId,
          { key, ...(into === undefined ? {} : { into }), ...(undo ? { undo: true } : {}) },
          { kind: "passkey", who, proof, clock: runtime.clock },
          { repos: who.repos },
          now(),
          { root: runtime.evidenceRoot, ...(deps.git === undefined ? {} : { git: deps.git }) },
        );
        // land() refuses only when nothing landed; a crash mid-landing throws and settles `unknown`. A landing (or a
        // replay of one) never opens an approvals window.
        if (!res.ok) throw new CompanionActionError("refused", res.message);
        return { ok: true, landed: true, replayed: res.replayed, branch: res.branch, commit: res.commit, mode: res.mode, handoffCommand: res.handoff?.command ?? null, freshUntil: windowUntil(principal) };
      });
    },

    taskShip: async (principal, params) => {
      const runIdRaw = params["runId"];
      if (typeof runIdRaw !== "number" || !Number.isInteger(runIdRaw) || runIdRaw <= 0) {
        throw new CompanionActionError("invalid_params", "runId is required");
      }
      const anyway = params["anyway"] === true;
      const proof = liveProofOf(principal, params);
      return perform(principal, params, "task.ship", { runId: runIdRaw, anyway }, async ({ accountName }) => {
        const res = await mergeAsPerson(store, {
          runId: runIdRaw,
          name: accountName,
          passkey: proof,
          anyway,
          ...(deps.publishExec === undefined ? {} : { exec: deps.publishExec }),
          clock: runtime.clock,
        });
        if (!res.ok) {
          // The merge ran but GitHub couldn't be read back: it may have merged. Anything else merged nothing.
          if (res.reason === "unconfirmed") throw new CompanionActionError("outcome_unknown", res.message);
          throw new CompanionActionError("refused", res.message);
        }
        return { ok: true, shipped: true, commit: res.commit, freshUntil: windowUntil(principal) };
      });
    },
  };
}
