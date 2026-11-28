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

import { acceptAndCompleteAsOperator, assignmentOf } from "../assignment.js";
import { land, readLanding } from "../local-landing.js";
import { verifyApproverStanding, type VerifiedApprover } from "../principal.js";
import { completeAndOpenPullRequest, mergeAsPerson } from "../pull-request-flow.js";
import { approve } from "../scope.js";
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
  buildActionChallenge,
  canonicalJson,
  derivePasskeyUserHandle,
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
import type { PasskeyActionProof } from "./passkey-gate.js";
import type { PublishExec } from "../publish.js";
import type { Runner } from "../backend.js";

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
      | "idempotency_key_conflict"
      | "in_progress"
      | "outcome_unknown"
      | "refused"
      | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface CompanionActionHandlers {
  passkeyStatus: (principal: PairedDevicePrincipal) => Promise<unknown> | unknown;
  passkeyRegisterBegin: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  passkeyRegisterFinish: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  approvalChallenge: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskApprove: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskAccept: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskLand: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  taskShip: (principal: PairedDevicePrincipal, params: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Open a signed-in Mac consent window allowing an approver's iPhone to register a Passkey. */
  openEnrollmentWindow: (accountName: string, deviceId?: string | null) => { expiresAtMs: number };
  /** Check whether an enrollment window is currently open for an account/device. */
  isEnrollmentOpen: (accountName: string, deviceId?: string | null) => boolean;
  /** Close any open enrollment window for an account. */
  closeEnrollmentWindow: (accountName: string) => void;
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

  /** Executes a Gate 2 mutation under `device_idempotency` state machine (conflict / in_flight / completed / unknown). */
  async function withIdempotency<T>(
    principal: PairedDevicePrincipal,
    method: string,
    idempotencyKey: string,
    canonicalTarget: Record<string, unknown>,
    opts: { externalSideEffect?: boolean },
    work: () => Promise<T> | T,
  ): Promise<T> {
    const requestHash = sha256(canonicalJson({ method, target: canonicalTarget })).toString("hex");
    const claim = claimDeviceIdempotency(store.handle, {
      deviceId: principal.deviceId,
      idempotencyKey,
      method,
      requestHash,
      now: now(),
    });
    if (claim.status === "conflict") {
      throw new CompanionActionError("idempotency_key_conflict", "This idempotency key was already used for a different request.");
    }
    if (claim.status === "in_flight") {
      throw new CompanionActionError("in_progress", "That action is already running on your Mac.");
    }
    if (claim.status === "unknown") {
      throw new CompanionActionError("outcome_unknown", "The previous attempt didn't finish cleanly. Refresh to check the current state.");
    }
    if (claim.status === "completed") {
      return JSON.parse(claim.outcomeJson) as T;
    }
    try {
      const outcome = await work();
      settleDeviceIdempotency(store.handle, principal.deviceId, idempotencyKey, "completed", JSON.stringify(outcome), now());
      pruneDeviceIdempotency(store.handle, now());
      return outcome;
    } catch (error) {
      if (opts.externalSideEffect === true) {
        // ADR 0004: an unexpected error mid-external side effect (git/gh) moves to `unknown`, never blindly retried.
        settleDeviceIdempotency(store.handle, principal.deviceId, idempotencyKey, "unknown", null, now());
        if (error instanceof CompanionActionError) throw error;
        throw new CompanionActionError("outcome_unknown", "The outcome couldn't be confirmed. Refresh before trying again.");
      }
      if (error instanceof CompanionActionError) {
        const storedErr = { ok: false, code: error.code, message: error.message };
        settleDeviceIdempotency(store.handle, principal.deviceId, idempotencyKey, "completed", JSON.stringify(storedErr), now());
        throw error;
      }
      settleDeviceIdempotency(store.handle, principal.deviceId, idempotencyKey, "unknown", null, now());
      throw new CompanionActionError("outcome_unknown", "Something went wrong on your Mac. Refresh to check the current state.");
    }
  }

  return {
    openEnrollmentWindow,
    isEnrollmentOpen,
    closeEnrollmentWindow,
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
      };
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
      const { accountName, who } = standsApprover(principal);
      const identity = store.workspaceIdentity();
      const activeCreds = listActiveAccountPasskeys(store.handle, identity.id, accountName, identity.recoveryGeneration);
      if (activeCreds.length === 0) {
        throw new CompanionActionError("no_passkey", "Set up a passkey in Settings before approving from this iPhone.");
      }

      const verbRaw = requireString(params, "verb");
      if (verbRaw !== "approve" && verbRaw !== "accept" && verbRaw !== "land" && verbRaw !== "ship") {
        throw new CompanionActionError("invalid_params", "verb must be approve, accept, land, or ship");
      }
      const verb = verbRaw as PasskeyVerb;
      const t = now();
      prunePasskeyChallenges(store.handle, t);

      let binding: VerbChallengeBinding;
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
        binding = { verb: "approve", taskId: family.current.id, sawDigest };
      } else if (verb === "accept") {
        const taskId = requireString(params, "task");
        if (!TASK_ID.test(taskId)) throw new CompanionActionError("invalid_params", "Invalid task id.");
        const before = assignmentOf(store, taskId, t, { principal: "operator", repos: who.repos }, runtime.evidenceRoot);
        if (before === null || !runtime.visible(before.repo) || !store.accountCanAccess(accountName, before.repo)) {
          throw new CompanionActionError("not_found", "No such task.");
        }
        if (before.receipt === null) throw new CompanionActionError("refused", "This task has no result ready to accept.");
        const runId = typeof params["runId"] === "number" ? params["runId"] : before.receipt.runId;
        const receiptDigest = typeof params["receiptDigest"] === "string" && params["receiptDigest"].length > 0 ? params["receiptDigest"] : before.receipt.digest;
        const note = typeof params["note"] === "string" ? params["note"] : null;
        const publish = params["publish"] === true;
        if (receiptDigest !== before.receipt.digest || (runId !== null && runId !== before.receipt.runId)) {
          throw new CompanionActionError("refused", "This result changed. Refresh before accepting.");
        }
        binding = { verb: "accept", taskId, runId, receiptDigest, noteHash: sha256(note ?? "").toString("hex"), publish };
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
      } else {
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
      }

      const built = buildActionChallenge({
        workspaceId: identity.id,
        recoveryGeneration: identity.recoveryGeneration,
        accountName,
        deviceId: principal.deviceId,
        binding,
      });
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
        challenge: built.challenge,
        rpId,
        allowCredentials: activeCreds.map(c => ({ id: c.credentialId, type: "public-key" })),
        userVerification: "required",
        verb,
        wording: built.wording,
        expiresAt,
        binding,
      };
    },

    taskApprove: async (principal, params) => {
      const { accountName } = standsApprover(principal);
      const idempotencyKey = requireIdempotencyKey(params);
      const taskId = requireString(params, "task");
      const sawDigest = requireString(params, "digest");
      const challenge = requireString(params, "challenge");
      const assertion = parseAssertion(params["assertion"]);

      return withIdempotency(principal, "task.approve", idempotencyKey, { taskId, sawDigest }, { externalSideEffect: false }, () => {
        const family = requestContext.run({ csrf: "", returnTo: "/", actor: accountName }, () => runtime.familyOf(taskId));
        if (family === null || family.problem !== null || !runtime.visible(family.current.repo) || !store.accountCanAccess(accountName, family.current.repo)) {
          throw new CompanionActionError("not_found", "No such task.");
        }
        const proof: PasskeyActionProof = { deviceId: principal.deviceId, challenge, assertion, rpId, expectedOrigin };
        const res = approve(store, family.current.id, accountName, now(), sawDigest, "", {}, undefined, undefined, proof);
        if (!res.ok) {
          if (res.reason === "changed") throw new CompanionActionError("refused", "This plan changed. Refresh and review the latest terms.");
          if (res.reason === "policy") throw new CompanionActionError("refused", res.message);
          if (res.reason === "second-approver") {
            deps.onMutated?.();
            return { ok: true, approved: false, secondApprover: true, have: res.have, need: res.need };
          }
          throw new CompanionActionError("refused", `Couldn't approve this task (${res.reason}).`);
        }
        deps.onMutated?.();
        return { ok: true, approved: true, task: family.current.id, digest: res.scope.digest };
      });
    },

    taskAccept: async (principal, params) => {
      const { who } = standsApprover(principal);
      const idempotencyKey = requireIdempotencyKey(params);
      const taskId = requireString(params, "task");
      const receiptDigest = requireString(params, "receiptDigest");
      const runId = typeof params["runId"] === "number" ? params["runId"] : null;
      const note = typeof params["note"] === "string" && params["note"].trim().length > 0 ? params["note"].trim() : null;
      const publish = params["publish"] === true;
      const challenge = requireString(params, "challenge");
      const assertion = parseAssertion(params["assertion"]);

      return withIdempotency(principal, "task.accept", idempotencyKey, { taskId, runId, receiptDigest, note, publish }, { externalSideEffect: publish }, () => {
        const proof: PasskeyActionProof = { deviceId: principal.deviceId, challenge, assertion, rpId, expectedOrigin };
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
        if (!done.ok) throw new CompanionActionError("refused", done.message);
        deps.onMutated?.();
        return { ok: true, accepted: true, published: publish, prUrl: openedPrUrl, prNumber: openedPrNumber };
      });
    },

    taskLand: async (principal, params) => {
      const { who } = standsApprover(principal);
      const idempotencyKey = requireIdempotencyKey(params);
      const taskId = requireString(params, "task");
      const key = requireString(params, "key");
      const into = typeof params["into"] === "string" && params["into"].length > 0 ? params["into"] : undefined;
      const undo = params["undo"] === true;
      const challenge = requireString(params, "challenge");
      const assertion = parseAssertion(params["assertion"]);

      return withIdempotency(principal, "task.land", idempotencyKey, { taskId, key, into: into ?? null, undo }, { externalSideEffect: true }, async () => {
        const proof: PasskeyActionProof = { deviceId: principal.deviceId, challenge, assertion, rpId, expectedOrigin };
        const res = await land(
          store,
          taskId,
          { key, ...(into === undefined ? {} : { into }), ...(undo ? { undo: true } : {}) },
          { kind: "passkey", who, proof },
          { repos: who.repos },
          now(),
          { root: runtime.evidenceRoot, ...(deps.git === undefined ? {} : { git: deps.git }) },
        );
        if (!res.ok) throw new CompanionActionError("refused", res.message);
        deps.onMutated?.();
        return {
          ok: true,
          landed: true,
          replayed: res.replayed,
          branch: res.branch,
          commit: res.commit,
          mode: res.mode,
          handoffCommand: res.handoff?.command ?? null,
        };
      });
    },

    taskShip: async (principal, params) => {
      const { accountName } = standsApprover(principal);
      const idempotencyKey = requireIdempotencyKey(params);
      const runIdRaw = params["runId"];
      if (typeof runIdRaw !== "number" || !Number.isInteger(runIdRaw) || runIdRaw <= 0) {
        throw new CompanionActionError("invalid_params", "runId is required");
      }
      const anyway = params["anyway"] === true;
      const challenge = requireString(params, "challenge");
      const assertion = parseAssertion(params["assertion"]);

      return withIdempotency(principal, "task.ship", idempotencyKey, { runId: runIdRaw, anyway }, { externalSideEffect: true }, async () => {
        const proof: PasskeyActionProof = { deviceId: principal.deviceId, challenge, assertion, rpId, expectedOrigin };
        const res = await mergeAsPerson(store, {
          runId: runIdRaw,
          name: accountName,
          passkey: proof,
          anyway,
          ...(deps.publishExec === undefined ? {} : { exec: deps.publishExec }),
          clock: runtime.clock,
        });
        if (!res.ok) throw new CompanionActionError("refused", res.message);
        deps.onMutated?.();
        return { ok: true, shipped: true, commit: res.commit };
      });
    },
  };
}
