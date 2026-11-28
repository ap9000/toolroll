/**
 * Gate 2 Passkey Phone Approvals Security & Transactional Verification Suite
 * (`docs/adr/0005-passkey-phone-approvals.md`, `docs/plans/companion-app/threat-model-and-routes.md` §5 items 6–7).
 *
 * Covers:
 * - Pure-Node WebAuthn ES256/P-256 registration & assertion verification (UP/UV/AT, rpIdHash, origin, userHandle,
 *   signature, signCount 0->0 and monotonic, duplicate credentialId, off-curve/non-P-256 rejection, unique user.id
 *   per workspaceId).
 * - Enrollment consent window enforcement, single-use challenges, expiry, cross-device/cross-account/cross-verb replay.
 * - `passkey_required_approvals` policy refusing `chat` (chat-code) approvals while permitting Passkey approvals.
 * - Real transactional per-verb gates (`task.approve`, `task.accept`, `task.land`, `task.ship`) writing honest ADR 0005
 *   audit proofs inside the domain transaction and refusing stale targets.
 * - `device_idempotency` state machine: completed replay, 409 payload/method conflict, in_flight -> in_progress,
 *   startup reconciliation (`in_flight -> unknown -> outcome_unknown`), and 24h / 1,000-row retention pruning.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store.js";
import { ACCEPT_PROVED_ACTION, assignmentOf } from "../assignment.js";
import { LAND_PROVED_ACTION } from "../local-landing.js";
import { MERGE_PROVED_ACTION } from "../pull-request-flow.js";
import { APPROVAL_PROOF, addApprover, approvalOf, approve, personApprovalOf, propose } from "../scope.js";
import { createCompanionActions, CompanionActionError, type CompanionActionHandlers } from "./actions.js";
import type { CompanionReadRuntime } from "./reads.js";
import type { PairedDevicePrincipal } from "./daemon.js";
import { setPasskeyRequiredForApprovals } from "./passkey-gate.js";
import {
  activatePendingDevice,
  claimDeviceIdempotency,
  listActiveAccountPasskeys,
  pruneDeviceIdempotency,
  reconcileIdempotencyOnStartup,
  revokeAccountPasskey,
  savePendingDevice,
  settleDeviceIdempotency,
} from "./store.js";
import {
  derivePasskeyUserHandle,
  encodeCbor,
  PASSKEY_ORIGIN,
  PASSKEY_RP_ID,
  verifyAssertionResponse,
  verifyRegistrationResponse,
  type WebAuthnAssertionPayload,
} from "./webauthn.js";
import { storeEvidence } from "../evidence.js";
import { sealVerificationReceipt } from "../verification-evidence.js";
import { recordRunCheckLevel } from "../check-levels.js";
import type { PublishExec } from "../publish.js";

const T0 = new Date("2026-11-28T10:00:00.000Z");
let REPO = "/repo/gate2-passkey";

interface SimulatedPasskey {
  credentialId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  x: Buffer;
  y: Buffer;
  signCount: number;
}

function createSimulatedPasskey(credentialId = `cred-${randomUUID()}`): SimulatedPasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return {
    credentialId: Buffer.from(credentialId, "utf8").toString("base64url"),
    privateKey,
    publicKey,
    x: Buffer.from(jwk.x, "base64url"),
    y: Buffer.from(jwk.y, "base64url"),
    signCount: 0,
  };
}

function buildRegistrationPayload(
  key: SimulatedPasskey,
  challenge: string,
  opts: {
    rpId?: string;
    origin?: string;
    type?: string;
    flags?: number;
    signCount?: number;
    coseOverrides?: Map<number, unknown>;
    credentialIdOverride?: string;
  } = {},
) {
  const rpHash = createHash("sha256").update(opts.rpId ?? PASSKEY_RP_ID).digest();
  const flags = opts.flags ?? (0x01 | 0x04 | 0x08 | 0x10 | 0x40); // UP|UV|BE|BS|AT
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(opts.signCount ?? key.signCount, 0);
  const aaguid = Buffer.alloc(16, 0);
  const credIdBuf = Buffer.from(key.credentialId, "base64url");
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(credIdBuf.length, 0);
  const coseMap = new Map<number, number | Buffer>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, key.x],
    [-3, key.y],
  ]);
  if (opts.coseOverrides !== undefined) {
    for (const [k, v] of opts.coseOverrides.entries()) coseMap.set(k, v as number | Buffer);
  }
  const authData = Buffer.concat([rpHash, Buffer.from([flags]), counter, aaguid, credLen, credIdBuf, encodeCbor(coseMap)]);
  const attObj = encodeCbor(new Map<string, string | Buffer | Map<string, never>>([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authData],
  ]));
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: opts.type ?? "webauthn.create",
    challenge,
    origin: opts.origin ?? PASSKEY_ORIGIN,
  }), "utf8").toString("base64url");

  return {
    credentialId: opts.credentialIdOverride ?? key.credentialId,
    clientDataJSON,
    attestationObject: attObj.toString("base64url"),
  };
}

function buildAssertionPayload(
  key: SimulatedPasskey,
  challenge: string,
  userHandle: Buffer,
  opts: {
    rpId?: string;
    origin?: string;
    type?: string;
    flags?: number;
    signCount?: number;
    corruptSignature?: boolean;
    signerKey?: KeyObject;
    userHandleOverride?: Buffer;
  } = {},
): WebAuthnAssertionPayload {
  const rpHash = createHash("sha256").update(opts.rpId ?? PASSKEY_RP_ID).digest();
  const flags = opts.flags ?? (0x01 | 0x04 | 0x08 | 0x10); // UP|UV|BE|BS
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(opts.signCount ?? key.signCount, 0);
  const authData = Buffer.concat([rpHash, Buffer.from([flags]), counter]);
  const clientRaw = Buffer.from(JSON.stringify({
    type: opts.type ?? "webauthn.get",
    challenge,
    origin: opts.origin ?? PASSKEY_ORIGIN,
  }), "utf8");
  const clientHash = createHash("sha256").update(clientRaw).digest();
  const sig = cryptoSign("sha256", Buffer.concat([authData, clientHash]), opts.signerKey ?? key.privateKey);
  if (opts.corruptSignature) sig[sig.length - 1] = sig[sig.length - 1]! ^ 0xff;
  return {
    credentialId: key.credentialId,
    clientDataJSON: clientRaw.toString("base64url"),
    authenticatorData: authData.toString("base64url"),
    signature: sig.toString("base64url"),
    userHandle: (opts.userHandleOverride ?? userHandle).toString("base64url"),
  };
}

describe("Gate 2: WebAuthn verifier, Passkey enrollment, per-verb transactions, and idempotency", () => {
  let dir = "";
  let evidenceRoot = "";
  let store: Store;
  let now = new Date(T0.getTime());
  let principal: PairedDevicePrincipal;
  let actions: CompanionActionHandlers;
  let runtime: CompanionReadRuntime;
  let alexToken = "";

  function makeRuntime(s: Store): CompanionReadRuntime {
    return {
      store: s,
      clock: () => now,
      evidenceRoot,
      visible: (repo: string | null) => repo !== null,
      familyOf: (taskId: string) => s.taskFamilyOf(taskId, null, true),
      runVisible: () => true,
      taskRepoOf: (taskRef: string) => s.refById(taskRef)?.repo ?? null,
      workAccess: () => ({ ok: true, mode: "owner", actor: "alex" } as never),
      options: {} as never,
      liveCeiling: () => ({ repos: new Set([REPO]), roots: new Set([REPO]) }),
    };
  }

  function pairDevice(deviceId: string, accountName: string): PairedDevicePrincipal {
    const id = store.workspaceIdentity();
    const account = store.accountOf(accountName)!;
    savePendingDevice(store.handle, {
      deviceId,
      accountName,
      deviceName: "Alex iPhone 16 Pro",
      phoneStaticPub: Buffer.alloc(32, 7),
      deviceRelayPub: Buffer.alloc(32, 8),
      devicePsk: Buffer.alloc(32, 9),
      recoveryGeneration: id.recoveryGeneration,
      accountGeneration: account.generation,
      createdAt: now.toISOString(),
    });
    expect(activatePendingDevice(store, deviceId, now)).toBe("activated");
    return {
      deviceId,
      accountName,
      recoveryGeneration: id.recoveryGeneration,
      requestFromThisComputer: false,
    };
  }

  async function enrollKey(key: SimulatedPasskey, dev = principal): Promise<void> {
    actions.openEnrollmentWindow(dev.accountName, dev.deviceId);
    const begin = (await actions.passkeyRegisterBegin(dev, {})) as { challenge: string; user: { id: string } };
    const reg = buildRegistrationPayload(key, begin.challenge);
    const fin = (await actions.passkeyRegisterFinish(dev, {
      challenge: begin.challenge,
      credentialId: reg.credentialId,
      clientDataJSON: reg.clientDataJSON,
      attestationObject: reg.attestationObject,
      label: "Alex iPhone",
    })) as { ok: boolean; credentialId: string };
    expect(fin.ok).toBe(true);
    expect(fin.credentialId).toBe(key.credentialId);
  }

  function createTaskWithScope(taskId: string): { digest: string; taskRef: string } {
    store.createTask({ id: taskId, title: `Task ${taskId}` }, now);
    const ref = store.refFor("built-in", taskId);
    store.placeTask(ref.id, REPO, {}, now);
    const scope = propose(store, {
      taskId,
      goal: `Complete ${taskId}`,
      touches: ["src/auth.ts"],
      acceptance: [{ id: "c1", statement: "Tests pass", how: null, evidence: ["check"] }],
      now,
    });
    return { digest: scope.digest, taskRef: ref.id };
  }

  function seedReviewableResult(taskId: string): { runId: number; receiptDigest: string; headSha: string } {
    const BASE = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"]).toString("utf8").trim();
    const branch = `toolroll/${taskId}`;
    execFileSync("git", ["-C", REPO, "checkout", "-q", "-b", branch, BASE]);
    writeFileSync(join(REPO, "src", "auth.ts"), "new\n", "utf8");
    execFileSync("git", ["-C", REPO, "add", "src/auth.ts"]);
    execFileSync("git", ["-C", REPO, "commit", "-q", "-m", `build ${taskId}`]);
    const HEAD = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"]).toString("utf8").trim();
    const patch = execFileSync("git", ["-C", REPO, "diff", BASE, HEAD]).toString("utf8");
    execFileSync("git", ["-C", REPO, "checkout", "-q", "main"]);
    store.setVerifyCommand({ repo: REPO, command: "true", timeoutMs: 30_000, approvedBy: "alex" }, now);
    const { digest, taskRef } = createTaskWithScope(taskId);
    expect(store.sealScopeApproval(taskId, "alex", now)).toBe(true);
    const authority = store.routeAuthorityFor(taskRef, "builder");
    if (!authority?.ok) throw new Error("route authority unavailable");
    const runId = store.startRun({
      taskRef,
      leaseId: `lease-${taskId}`,
      runner: "claude",
      branch,
      worktree: "/tmp/wt",
      now,
      route: authority.stamp,
    });
    store.stampRun(runId, { scopeDigest: digest, baseRevision: BASE });
    store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Built cleanly." });
    store.finishRun(runId, { outcome: "built", committed: true, now });
    store.setTaskState(taskId, "done", now);
    recordRunCheckLevel(store, { id: runId, taskId, repo: REPO }, "full", "project", now);
    store.saveProofVerdict(runId, "verified", [], now, [{ id: "c1", statement: "Tests pass", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null }] as never, "verified");
    storeEvidence(store, evidenceRoot, runId, "terminal-diff", "diff.patch", Buffer.from(patch), "git diff (exit 0)", now, { captureStatus: "ok" });
    storeEvidence(store, evidenceRoot, runId, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ schema: 1, head: HEAD, base: BASE, filesTruncated: false, fileCount: 1, files: [{ path: "src/auth.ts" }] })), "git diff --numstat", now, { captureStatus: "ok" });
    storeEvidence(store, evidenceRoot, runId, "check-log", "checks.txt", Buffer.from("1 passed\n"), "true", now, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, runId, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, now);
    store.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [] }, now);
    const assigned = assignmentOf(store, taskId, now, { principal: "operator", repos: [REPO] }, evidenceRoot);
    expect(assigned?.receipt).not.toBeNull();
    return { runId, receiptDigest: assigned!.receipt!.digest, headSha: HEAD };
  }

  beforeEach(() => {
    now = new Date(T0.getTime());
    dir = mkdtempSync(join(tmpdir(), "toolroll-gate2-"));
    evidenceRoot = join(dir, "evidence");
    const repoPath = join(dir, "repo");
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "auth.ts"), "old\n", "utf8");
    execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
    execFileSync("git", ["-C", repoPath, "config", "user.email", "alex@toolroll.dev"]);
    execFileSync("git", ["-C", repoPath, "config", "user.name", "Alex"]);
    execFileSync("git", ["-C", repoPath, "add", "."]);
    execFileSync("git", ["-C", repoPath, "commit", "-q", "-m", "init"]);
    REPO = realpathSync(repoPath);
    store = openStore(join(dir, "orders.db"));
    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex approver setup failed");
    alexToken = alex.token;
    for (const phase of ["build", "plan", "review"] as const) {
      store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
    }
    runtime = makeRuntime(store);
    principal = pairDevice("dev_iphone_1", "alex");
    actions = createCompanionActions({ runtime, workspaceLabel: () => "Studio Mac" });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("WebAuthn registration and verifier invariants", () => {
    test("rejects registration when Mac enrollment window is closed, succeeds when open, and blocks duplicate credentialId", async () => {
      await expect(actions.passkeyRegisterBegin(principal, {})).rejects.toMatchObject({ code: "enrollment_closed" });

      const key = createSimulatedPasskey();
      await enrollKey(key);

      const status = (await actions.passkeyStatus(principal)) as { registered: boolean; count: number; enrollmentOpen: boolean; rpId: string };
      expect(status).toEqual({ registered: true, count: 1, enrollmentOpen: false, rpId: PASSKEY_RP_ID });

      // Duplicate credentialId must be rejected even with a brand-new enrollment window.
      actions.openEnrollmentWindow("alex", principal.deviceId);
      const begin2 = (await actions.passkeyRegisterBegin(principal, {})) as { challenge: string };
      const dupPayload = buildRegistrationPayload(key, begin2.challenge);
      await expect(actions.passkeyRegisterFinish(principal, { challenge: begin2.challenge, ...dupPayload }))
        .rejects.toMatchObject({ code: "passkey_failed" });
    });

    test("rejects replayed, expired, and cross-device registration challenges", async () => {
      const key1 = createSimulatedPasskey("cred-1");
      const key2 = createSimulatedPasskey("cred-2");
      const otherDev = pairDevice("dev_iphone_2", "alex");

      actions.openEnrollmentWindow("alex", null);
      const begin = (await actions.passkeyRegisterBegin(principal, {})) as { challenge: string };

      // Cross-device attempt with principal's challenge is refused.
      await expect(actions.passkeyRegisterFinish(otherDev, {
        challenge: begin.challenge,
        ...buildRegistrationPayload(key2, begin.challenge),
      })).rejects.toMatchObject({ code: "passkey_failed" });

      // Expired challenge is refused.
      now = new Date(T0.getTime() + 125_000);
      await expect(actions.passkeyRegisterFinish(principal, {
        challenge: begin.challenge,
        ...buildRegistrationPayload(key1, begin.challenge),
      })).rejects.toMatchObject({ code: "passkey_failed" });

      // Fresh challenge succeeds once; replay fails.
      now = new Date(T0.getTime() + 130_000);
      actions.openEnrollmentWindow("alex", principal.deviceId);
      const fresh = (await actions.passkeyRegisterBegin(principal, {})) as { challenge: string };
      const reg = buildRegistrationPayload(key1, fresh.challenge);
      await actions.passkeyRegisterFinish(principal, { challenge: fresh.challenge, ...reg });
      actions.openEnrollmentWindow("alex", principal.deviceId);
      await expect(actions.passkeyRegisterFinish(principal, { challenge: fresh.challenge, ...reg }))
        .rejects.toMatchObject({ code: "passkey_failed" });
    });

    test("verifier rejects bad origin, bad rpIdHash, UP=0, UV=0, AT=0, non-P-256 algorithm, and off-curve point", () => {
      const key = createSimulatedPasskey();
      const ch = "challenge_abc_123";

      expect(verifyRegistrationResponse({ payload: buildRegistrationPayload(key, ch), expectedChallenge: ch }).ok).toBe(true);
      expect(verifyRegistrationResponse({ payload: buildRegistrationPayload(key, ch, { origin: "https://evil.example" }), expectedChallenge: ch }))
        .toMatchObject({ ok: false, code: "origin_mismatch" });
      expect(verifyRegistrationResponse({ payload: buildRegistrationPayload(key, ch, { rpId: "evil.example" }), expectedChallenge: ch }))
        .toMatchObject({ ok: false, code: "rp_id_mismatch" });
      expect(verifyRegistrationResponse({ payload: buildRegistrationPayload(key, ch, { flags: 0x04 | 0x40 }), expectedChallenge: ch }))
        .toMatchObject({ ok: false, code: "user_presence_required" });
      expect(verifyRegistrationResponse({ payload: buildRegistrationPayload(key, ch, { flags: 0x01 | 0x40 }), expectedChallenge: ch }))
        .toMatchObject({ ok: false, code: "user_verification_required" });
      expect(verifyRegistrationResponse({ payload: buildRegistrationPayload(key, ch, { flags: 0x01 | 0x04 }), expectedChallenge: ch }))
        .toMatchObject({ ok: false, code: "attested_credential_missing" });
      expect(verifyRegistrationResponse({
        payload: buildRegistrationPayload(key, ch, { coseOverrides: new Map([[3, -257]]) }),
        expectedChallenge: ch,
      })).toMatchObject({ ok: false, code: "unsupported_algorithm" });
      expect(verifyRegistrationResponse({
        payload: buildRegistrationPayload(key, ch, { coseOverrides: new Map([[-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 1)]]) }),
        expectedChallenge: ch,
      })).toMatchObject({ ok: false, code: "invalid_public_key" });
    });

    test("derives distinct 32-byte user.id across two workspaces for the same accountName", () => {
      const h1 = derivePasskeyUserHandle("ws-mac-studio", "alex");
      const h2 = derivePasskeyUserHandle("ws-macbook-pro", "alex");
      expect(h1.length).toBe(32);
      expect(h2.length).toBe(32);
      expect(h1.equals(h2)).toBe(false);
    });

    test("assertion verifier checks userHandle, origin, rpIdHash, UP, UV, signature, and signCount (0->0 ok, non-monotonic rejected)", () => {
      const key = createSimulatedPasskey();
      const ch = "assert_ch_1";
      const reg = verifyRegistrationResponse({ payload: buildRegistrationPayload(key, ch), expectedChallenge: ch });
      if (!reg.ok) throw new Error("reg failed");
      const userHandle = derivePasskeyUserHandle("ws-1", "alex");
      const otherHandle = derivePasskeyUserHandle("ws-2", "alex");

      // 0 -> 0 accepted (Apple iCloud synced passkeys).
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { signCount: 0 }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 0,
      }).ok).toBe(true);

      // Strictly increasing non-zero signCount accepted; non-monotonic rejected.
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { signCount: 5 }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 4,
      }).ok).toBe(true);
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { signCount: 4 }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 4,
      })).toMatchObject({ ok: false, code: "sign_count_regression" });

      // Wrong userHandle, origin, rpIdHash, UP=0, UV=0, bad signature all rejected.
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, otherHandle),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 0,
      })).toMatchObject({ ok: false, code: "user_handle_mismatch" });
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { origin: "https://phish.example" }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 0,
      })).toMatchObject({ ok: false, code: "origin_mismatch" });
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { rpId: "phish.example" }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 0,
      })).toMatchObject({ ok: false, code: "rp_id_mismatch" });
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { flags: 0x04 }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 0,
      })).toMatchObject({ ok: false, code: "user_presence_required" });
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { flags: 0x01 }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 0,
      })).toMatchObject({ ok: false, code: "user_verification_required" });
      expect(verifyAssertionResponse({
        payload: buildAssertionPayload(key, ch, userHandle, { corruptSignature: true }),
        expectedChallenge: ch,
        expectedUserHandle: userHandle,
        storedPublicKeySpki: reg.publicKeySpki,
        storedSignCount: 0,
      })).toMatchObject({ ok: false, code: "signature_invalid" });
    });
  });

  describe("Per-verb transactional gates, cross-verb replay, revocation, and chat-code policy", () => {
    test("task.approve verifies passkey inside transaction, writes honest ADR 0005 APPROVAL_PROOF, blocks replay & revoked cred", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { digest } = createTaskWithScope("t-approve-1");
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");

      const ch = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-approve-1", digest })) as {
        challenge: string;
        verb: string;
      };
      expect(ch.verb).toBe("approve");
      const assertion = buildAssertionPayload(key, ch.challenge, userHandle);

      const res = (await actions.taskApprove(principal, {
        task: "t-approve-1",
        digest,
        challenge: ch.challenge,
        idempotencyKey: randomUUID(),
        assertion,
      })) as { ok: boolean; approved: boolean };
      expect(res).toMatchObject({ ok: true, approved: true });

      // Approved in store under person basis and honest ADR 0005 audit wording.
      const approval = approvalOf(store.getScope("t-approve-1"));
      expect(approval.approved).toBe(true);
      if (approval.approved) expect(approval.by).toBe("alex");
      expect(personApprovalOf(store, "t-approve-1")).toMatchObject({ ok: true, by: "alex", method: "passkey" });
      const proofRow = store.handle
        .prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1")
        .get("t-approve-1", APPROVAL_PROOF) as { outcome: string; detail: string } | undefined;
      expect(proofRow?.outcome).toBe("passkey");
      const detail = JSON.parse(proofRow!.detail) as { summary: string; deviceId: string; uv: boolean };
      expect(detail.uv).toBe(true);
      expect(detail.deviceId).toBe(principal.deviceId);
      expect(detail.summary).toContain("Passkey user verification");
      expect(detail.summary.toLowerCase()).not.toContain("face id");

      // Replaying the same consumed challenge with a new idempotencyKey is refused.
      const { digest: digest2 } = createTaskWithScope("t-approve-2");
      await expect(actions.taskApprove(principal, {
        task: "t-approve-2",
        digest: digest2,
        challenge: ch.challenge,
        idempotencyKey: randomUUID(),
        assertion,
      })).rejects.toMatchObject({ code: "refused" });

      // Cross-verb replay: an `approve` challenge cannot be submitted to `task.accept`.
      const { runId, receiptDigest } = seedReviewableResult("t-cross-verb");
      const approveCh = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-approve-2", digest: digest2 })) as { challenge: string };
      await expect(actions.taskAccept(principal, {
        task: "t-cross-verb",
        runId,
        receiptDigest,
        challenge: approveCh.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, approveCh.challenge, userHandle),
      })).rejects.toMatchObject({ code: "refused" });

      // Independent passkey revocation immediately invalidates the passkey without unpairing the device.
      expect(revokeAccountPasskey(store.handle, key.credentialId, "alex", now)).toBe(true);
      expect(listActiveAccountPasskeys(store.handle, store.workspaceIdentity().id, "alex", store.workspaceIdentity().recoveryGeneration)).toHaveLength(0);
      await expect(actions.taskApprove(principal, {
        task: "t-approve-2",
        digest: digest2,
        challenge: approveCh.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, approveCh.challenge, userHandle),
      })).rejects.toMatchObject({ code: "refused" });
    });

    test("passkey_required_approvals policy refuses chat-code approval while allowing passkey approval", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      setPasskeyRequiredForApprovals(store, true);
      const { digest } = createTaskWithScope("t-policy-1");

      // Chat-code approval is refused under policy.
      const chatRes = approve(store, "t-policy-1", "alex", now, digest, "", {}, undefined, { modeDigest: "mode-1", shown: null });
      expect(chatRes).toMatchObject({ ok: false, reason: "policy" });

      // Passkey approval succeeds cleanly.
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");
      const ch = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-policy-1", digest })) as { challenge: string };
      const pkRes = (await actions.taskApprove(principal, {
        task: "t-policy-1",
        digest,
        challenge: ch.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, ch.challenge, userHandle),
      })) as { ok: boolean; approved: boolean };
      expect(pkRes.approved).toBe(true);
    });

    test("task.accept writes accept proved + completion atomically and refuses stale receipt", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { runId, receiptDigest } = seedReviewableResult("t-accept-1");
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");

      const ch = (await actions.approvalChallenge(principal, {
        verb: "accept",
        task: "t-accept-1",
        runId,
        receiptDigest,
      })) as { challenge: string };

      // Stale receipt is refused.
      await expect(actions.taskAccept(principal, {
        task: "t-accept-1",
        runId,
        receiptDigest: "stale_digest",
        challenge: ch.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, ch.challenge, userHandle),
      })).rejects.toMatchObject({ code: "refused" });

      // Exact receipt commits atomically and writes `accept proved`.
      const res = (await actions.taskAccept(principal, {
        task: "t-accept-1",
        runId,
        receiptDigest,
        challenge: ch.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, ch.challenge, userHandle),
      })) as { ok: boolean; accepted: boolean };
      expect(res).toMatchObject({ ok: true, accepted: true });

      const proof = store.handle
        .prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1")
        .get("t-accept-1", ACCEPT_PROVED_ACTION) as { outcome: string; detail: string } | undefined;
      expect(proof?.outcome).toBe("passkey");
      expect(proof?.detail).toContain("Passkey user verification");
    });

    test("task.land writes land proved inside landing transaction and refuses stale plan key", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { runId, receiptDigest } = seedReviewableResult("t-land-1");
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");

      // First accept the task so it is ready to land.
      const acceptCh = (await actions.approvalChallenge(principal, {
        verb: "accept",
        task: "t-land-1",
        runId,
        receiptDigest,
      })) as { challenge: string };
      await actions.taskAccept(principal, {
        task: "t-land-1",
        runId,
        receiptDigest,
        challenge: acceptCh.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, acceptCh.challenge, userHandle),
      });

      // Use real local git against our temporary repository to verify full end-to-end landing + atomic proof.
      const landActions = createCompanionActions({ runtime, workspaceLabel: () => "Studio Mac" });

      const landCh = (await landActions.approvalChallenge(principal, {
        verb: "land",
        task: "t-land-1",
      })) as { challenge: string; binding: { planKey: string } };
      const planKey = landCh.binding.planKey;

      // Stale plan key refused.
      await expect(landActions.taskLand(principal, {
        task: "t-land-1",
        key: "stale_plan_key",
        challenge: landCh.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, landCh.challenge, userHandle),
      })).rejects.toMatchObject({ code: "refused" });

      // Matching plan key lands and writes `land proved`.
      const landed = (await landActions.taskLand(principal, {
        task: "t-land-1",
        key: planKey,
        challenge: landCh.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, landCh.challenge, userHandle),
      })) as { ok: boolean; landed: boolean };
      expect(landed).toMatchObject({ ok: true, landed: true });

      const landProof = store.handle
        .prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1")
        .get("t-land-1", LAND_PROVED_ACTION) as { outcome: string; detail: string } | undefined;
      expect(landProof?.outcome).toBe("passkey");
      expect(landProof?.detail).toContain("Passkey user verification");
    });

    test("task.ship writes merge proved inside reservation transaction before gh pr merge", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { runId, headSha: HEAD_SHA } = seedReviewableResult("t-ship-1");
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");

      const MERGE_SHA = "b".repeat(40);
      store.savePublicationGrant({
        repo: REPO,
        githubRepo: "ap9000/toolroll",
        remote: "origin",
        headPrefix: "toolroll/",
        base: "main",
        capabilities: ["push", "pr"],
        selector: "ours",
        draft: false,
        grantedBy: "alex",
        merge: true,
        mergeMethod: "squash",
        mergeDeleteBranch: false,
      }, now);
      const refId = store.refFor("built-in", "t-ship-1").id;
      const pubId = store.createPublicationIntent({
        run: runId,
        taskRef: refId,
        githubRepo: "ap9000/toolroll",
        remote: "origin",
        base: "main",
        head: "toolroll/t-ship-1",
        headSha: HEAD_SHA,
        bodyHash: "body-hash-1",
        draft: false,
      }, now);
      store.markPublicationPushed(pubId, now);
      store.markPublicationOpened(pubId, 42, "https://github.com/ap9000/toolroll/pull/42", now);
      store.handle
        .prepare("INSERT INTO pull_request_follow (publication, flow_card, revisions, created_at, updated_at) VALUES (?, NULL, 0, ?, ?)")
        .run(pubId, now.toISOString(), now.toISOString());

      let mergedOnRemote = false;
      let proofExistedWhenGhMergeRan = false;
      const publishExec: PublishExec = async (_cmd, args) => {
        const joined = args.join(" ");
        if (joined.includes("pr view")) {
          return {
            ok: true,
            code: 0,
            stdout: JSON.stringify({
              state: mergedOnRemote ? "MERGED" : "OPEN",
              isDraft: false,
              headRefOid: HEAD_SHA,
              baseRefName: "main",
              url: "https://github.com/ap9000/toolroll/pull/42",
              mergeCommit: mergedOnRemote ? { oid: MERGE_SHA } : null,
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
          };
        }
        if (joined.includes("pr merge")) {
          const row = store.handle
            .prepare("SELECT outcome FROM action_ledger WHERE task_id = ? AND action = ?")
            .get("t-ship-1", MERGE_PROVED_ACTION) as { outcome: string } | undefined;
          proofExistedWhenGhMergeRan = row?.outcome === "passkey";
          mergedOnRemote = true;
          return { ok: true, code: 0, stdout: "", stderr: "" };
        }
        return { ok: true, code: 0, stdout: "", stderr: "" };
      };
      const shipActions = createCompanionActions({ runtime, workspaceLabel: () => "Studio Mac", publishExec });

      const shipCh = (await shipActions.approvalChallenge(principal, {
        verb: "ship",
        runId,
      })) as { challenge: string };

      const shipped = (await shipActions.taskShip(principal, {
        runId,
        challenge: shipCh.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, shipCh.challenge, userHandle),
      })) as { ok: boolean; shipped: boolean };
      expect(shipped).toMatchObject({ ok: true, shipped: true });
      expect(proofExistedWhenGhMergeRan).toBe(true);
    });
  });

  describe("device_idempotency state machine and retention", () => {
    test("replays completed outcome without re-executing, returns conflict on mismatched payload/method, handles in_flight and startup reconciliation", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { digest } = createTaskWithScope("t-idem-1");
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");

      const ch = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-idem-1", digest })) as { challenge: string };
      const assertion = buildAssertionPayload(key, ch.challenge, userHandle);
      const idemKey = randomUUID();

      const first = (await actions.taskApprove(principal, {
        task: "t-idem-1",
        digest,
        challenge: ch.challenge,
        idempotencyKey: idemKey,
        assertion,
      })) as { ok: boolean; approved: boolean; task: string };
      expect(first).toMatchObject({ ok: true, approved: true, task: "t-idem-1" });

      // Same device + same idempotencyKey + same payload replays stored outcome (even though challenge is already consumed!).
      const replay = (await actions.taskApprove(principal, {
        task: "t-idem-1",
        digest,
        challenge: ch.challenge,
        idempotencyKey: idemKey,
        assertion,
      })) as { ok: boolean; approved: boolean; task: string };
      expect(replay).toEqual(first);

      // Same key with different payload -> idempotency_key_conflict.
      await expect(actions.taskApprove(principal, {
        task: "t-idem-other",
        digest,
        challenge: ch.challenge,
        idempotencyKey: idemKey,
        assertion,
      })).rejects.toMatchObject({ code: "idempotency_key_conflict" });

      // Same key with different method -> idempotency_key_conflict.
      await expect(actions.taskAccept(principal, {
        task: "t-idem-1",
        receiptDigest: "r1",
        challenge: ch.challenge,
        idempotencyKey: idemKey,
        assertion,
      })).rejects.toMatchObject({ code: "idempotency_key_conflict" });

      // In-flight collision -> in_progress; after startup reconciliation -> unknown -> outcome_unknown.
      const stuckKey = randomUUID();
      const targetHash = createHash("sha256")
        .update(JSON.stringify({ method: "task.approve", target: { sawDigest: digest, taskId: "t-idem-1" } }))
        .digest("hex");
      expect(claimDeviceIdempotency(store.handle, {
        deviceId: principal.deviceId,
        idempotencyKey: stuckKey,
        method: "task.approve",
        requestHash: targetHash,
        now,
      })).toEqual({ status: "claimed" });

      await expect(actions.taskApprove(principal, {
        task: "t-idem-1",
        digest,
        challenge: ch.challenge,
        idempotencyKey: stuckKey,
        assertion,
      })).rejects.toBeInstanceOf(CompanionActionError);
      await expect(actions.taskApprove(principal, {
        task: "t-idem-1",
        digest,
        challenge: ch.challenge,
        idempotencyKey: stuckKey,
        assertion,
      })).rejects.toMatchObject({ code: "in_progress" });

      expect(reconcileIdempotencyOnStartup(store.handle, now)).toBe(1);
      await expect(actions.taskApprove(principal, {
        task: "t-idem-1",
        digest,
        challenge: ch.challenge,
        idempotencyKey: stuckKey,
        assertion,
      })).rejects.toMatchObject({ code: "outcome_unknown" });
    });

    test("prunes idempotency rows older than 24h and enforces 1,000-row per-device cap", () => {
      const oldTime = new Date(T0.getTime() - 25 * 60 * 60 * 1000);
      const oldKey = randomUUID();
      claimDeviceIdempotency(store.handle, {
        deviceId: principal.deviceId,
        idempotencyKey: oldKey,
        method: "task.approve",
        requestHash: "old-row",
        now: oldTime,
      });
      settleDeviceIdempotency(store.handle, principal.deviceId, oldKey, "completed", "{}", oldTime);

      // Insert 1,010 settled recent rows for the device.
      for (let i = 0; i < 1_010; i++) {
        const ts = new Date(T0.getTime() - (1_010 - i) * 1000);
        const key = randomUUID();
        claimDeviceIdempotency(store.handle, {
          deviceId: principal.deviceId,
          idempotencyKey: key,
          method: "task.approve",
          requestHash: `row-${i}`,
          now: ts,
        });
        settleDeviceIdempotency(store.handle, principal.deviceId, key, "completed", "{}", ts);
      }

      pruneDeviceIdempotency(store.handle, T0);
      const count = Number(
        store.handle.prepare("SELECT count(*) AS n FROM device_idempotency WHERE device_id = ?").get(principal.deviceId)?.["n"],
      );
      expect(count).toBe(1_000);
    });
  });
});
