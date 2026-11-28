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
import { ACCEPT_PROVED_ACTION, acceptAndCompleteAsOperator, assignmentOf } from "../assignment.js";
import { verifyApproverByPassword } from "../principal.js";
import { LAND_PROVED_ACTION } from "../local-landing.js";
import { MERGE_PROVED_ACTION } from "../pull-request-flow.js";
import { APPROVAL_PROOF, addApprover, approvalOf, approve, personApprovalOf, proofDetailOf, propose } from "../scope.js";
import { createCompanionActions, CompanionActionError, type CompanionActionHandlers } from "./actions.js";
import type { CompanionReadRuntime } from "./reads.js";
import type { PairedDevicePrincipal } from "./daemon.js";
import { setPasskeyApprovalWindowMinutes, setPasskeyRequiredForApprovals } from "./passkey-gate.js";
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
import { encodeCbor } from "./webauthn-test-support.js";
import {
  derivePasskeyUserHandle,
  PASSKEY_ORIGIN,
  PASSKEY_RP_ID,
  verifyAssertionResponse,
  verifyRegistrationResponse,
  type WebAuthnAssertionPayload,
} from "./webauthn.js";
import { storeEvidence } from "../evidence.js";
import { scopeApprovedForDispatch } from "../dispatch.js";
import { run as execRun } from "../exec.js";
import { activePasskeyLease, startPasskeyLease } from "./passkey-gate.js";
import { revokePairedDeviceRecord, getPasskeyChallenge } from "./store.js";
import { passkeyProofDetail } from "./webauthn.js";
import { sealVerificationReceipt } from "../verification-evidence.js";
import { recordRunCheckLevel } from "../check-levels.js";
import type { PublishExec } from "../publish.js";

const T0 = new Date("2026-11-28T10:00:00.000Z");
/** Device ids as the daemon mints them (daemon.ts: `dev_` + 16 hex = 20 characters), so proof rows are sized for real. */
const DEVICE_1 = "dev_0f1e2d3c4b5a6978";
const DEVICE_2 = "dev_8796a5b4c3d2e1f0";
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

  function createTaskWithScope(taskId: string, touches: string[] = ["src/auth.ts"]): { digest: string; taskRef: string } {
    store.createTask({ id: taskId, title: `Task ${taskId}` }, now);
    const ref = store.refFor("built-in", taskId);
    store.placeTask(ref.id, REPO, {}, now);
    const scope = propose(store, {
      taskId,
      goal: `Complete ${taskId}`,
      touches,
      acceptance: [{ id: "c1", statement: "Tests pass", how: null, evidence: ["check"] }],
      now,
    });
    return { digest: scope.digest, taskRef: ref.id };
  }

  function seedReviewableResult(taskId: string, opts: { refuted?: boolean; touches?: string[] } = {}): { runId: number; receiptDigest: string; headSha: string } {
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
    const { digest, taskRef } = createTaskWithScope(taskId, opts.touches);
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
    if (opts.refuted === true) store.saveProofVerdict(runId, "refuted", ["The report doesn't match its changes."], now, [{ id: "c1", statement: "Tests pass", requiredEvidence: ["check"], state: "fail", detail: [], answered: [], review: null }] as never, "refuted");
    else store.saveProofVerdict(runId, "verified", [], now, [{ id: "c1", statement: "Tests pass", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null }] as never, "verified");
    storeEvidence(store, evidenceRoot, runId, "terminal-diff", "diff.patch", Buffer.from(patch), "git diff (exit 0)", now, { captureStatus: "ok" });
    storeEvidence(store, evidenceRoot, runId, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ schema: 1, head: HEAD, base: BASE, filesTruncated: false, fileCount: 1, files: [{ path: "src/auth.ts" }] })), "git diff --numstat", now, { captureStatus: "ok" });
    storeEvidence(store, evidenceRoot, runId, "check-log", "checks.txt", Buffer.from("1 passed\n"), "true", now, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, runId, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, now);
    store.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [] }, now);
    const assigned = assignmentOf(store, taskId, now, { principal: "operator", repos: [REPO] }, evidenceRoot);
    expect(assigned?.receipt).not.toBeNull();
    return { runId, receiptDigest: assigned!.receipt!.digest, headSha: HEAD };
  }

  function seedPullRequest(taskId: string, runId: number, headSha: string): void {
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
    const refId = store.refFor("built-in", taskId).id;
    const pubId = store.createPublicationIntent({
      run: runId,
      taskRef: refId,
      githubRepo: "ap9000/toolroll",
      remote: "origin",
      base: "main",
      head: `toolroll/${taskId}`,
      headSha: headSha,
      bodyHash: "body-hash-1",
      draft: false,
    }, now);
    store.markPublicationPushed(pubId, now);
    store.markPublicationOpened(pubId, 42, "https://github.com/ap9000/toolroll/pull/42", now);
    store.handle
      .prepare("INSERT INTO pull_request_follow (publication, flow_card, revisions, created_at, updated_at) VALUES (?, NULL, 0, ?, ?)")
      .run(pubId, now.toISOString(), now.toISOString());
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
    principal = pairDevice(DEVICE_1, "alex");
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

      const status = (await actions.passkeyStatus(principal)) as { registered: boolean; count: number; enrollmentOpen: boolean; rpId: string; windowMinutes: number; freshUntil: string | null };
      expect(status).toEqual({ registered: true, count: 1, enrollmentOpen: false, rpId: PASSKEY_RP_ID, windowMinutes: 15, freshUntil: null });

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
      const otherDev = pairDevice(DEVICE_2, "alex");

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
      const h1 = derivePasskeyUserHandle("ws-first", "alex");
      const h2 = derivePasskeyUserHandle("ws-second", "alex");
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
      const detail = JSON.parse(proofRow!.detail) as { dev: string; verb: string; digest: string };
      expect(detail).toMatchObject({ dev: principal.deviceId, verb: "approve", digest });
      expect(proofRow!.detail.toLowerCase()).not.toContain("face id");
      expect(proofDetailOf(proofRow!.detail)).toEqual({ at: now.toISOString(), digest });

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
      const approveCh = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-approve-2", digest: digest2, forceFresh: true })) as { challenge: string };
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
      expect(JSON.parse(proof!.detail)).toMatchObject({ verb: "accept", dev: principal.deviceId });
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
      expect(JSON.parse(landProof!.detail)).toMatchObject({ verb: "land", digest: planKey, dev: principal.deviceId });
    });

    test("task.ship writes merge proved inside reservation transaction before gh pr merge", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { runId, headSha: HEAD_SHA } = seedReviewableResult("t-ship-1");
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");

      const MERGE_SHA = "b".repeat(40);
      seedPullRequest("t-ship-1", runId, HEAD_SHA);

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

  describe("Tiered Passkey approval freshness window (Every time / 15 min / 1 hour)", () => {
    test("caches routine approve and clean accept inside the fixed window, records honest passkey-fresh proof, and enforces step-up for high-impact acts & revocation", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const userHandle = derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");

      // 1. First approval requires a live Passkey assertion and starts the 15-min window.
      const { digest: d1 } = createTaskWithScope("t-win-1");
      const ch1 = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-win-1", digest: d1 })) as {
        challenge: string;
        freshApproved: boolean;
      };
      expect(ch1.freshApproved).toBe(false);
      const r1 = (await actions.taskApprove(principal, {
        task: "t-win-1",
        digest: d1,
        challenge: ch1.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, ch1.challenge, userHandle),
      })) as { ok: boolean; approved: boolean; freshUntil: string | null };
      expect(r1.approved).toBe(true);
      expect(r1.freshUntil).toBe(new Date(T0.getTime() + 15 * 60_000).toISOString());

      // 2. Routine second approve 5 minutes later uses fresh session without WebAuthn prompt.
      now = new Date(T0.getTime() + 5 * 60_000);
      const { digest: d2 } = createTaskWithScope("t-win-2");
      const ch2 = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-win-2", digest: d2 })) as {
        freshApproved: boolean;
        freshUntil: string | null;
      };
      expect(ch2.freshApproved).toBe(true);
      const r2 = (await actions.taskApprove(principal, {
        task: "t-win-2",
        digest: d2,
        idempotencyKey: randomUUID(),
        useFreshSession: true,
      })) as { ok: boolean; approved: boolean };
      expect(r2.approved).toBe(true);
      expect(personApprovalOf(store, "t-win-2")).toMatchObject({ ok: true, by: "alex", method: "passkey-fresh" });
      const freshProof = store.handle
        .prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1")
        .get("t-win-2", APPROVAL_PROOF) as { outcome: string; detail: string };
      expect(freshProof.outcome).toBe("passkey-fresh");
      const freshDetail = JSON.parse(freshProof.detail) as { provedAt: string; dev: string };
      expect(freshDetail.provedAt).toBe(T0.toISOString());
      expect(freshDetail.dev).toBe(principal.deviceId);
      expect(proofDetailOf(freshProof.detail)).toEqual({ at: now.toISOString(), digest: d2 });

      // 3. Clean accept (publish: false) works under fresh session; publish: true refuses fresh session!
      const { runId: accRunId, receiptDigest: accDigest } = seedReviewableResult("t-win-accept");
      const pubCh = (await actions.approvalChallenge(principal, {
        verb: "accept",
        task: "t-win-accept",
        runId: accRunId,
        receiptDigest: accDigest,
        publish: true,
      })) as { freshApproved: boolean };
      expect(pubCh.freshApproved).toBe(false);
      await expect(actions.taskAccept(principal, {
        task: "t-win-accept",
        runId: accRunId,
        receiptDigest: accDigest,
        publish: true,
        idempotencyKey: randomUUID(),
        useFreshSession: true,
      })).rejects.toMatchObject({ code: "passkey_step_up_required" });

      const cleanCh = (await actions.approvalChallenge(principal, {
        verb: "accept",
        task: "t-win-accept",
        runId: accRunId,
        receiptDigest: accDigest,
        publish: false,
      })) as { freshApproved: boolean };
      expect(cleanCh.freshApproved).toBe(true);
      const accRes = (await actions.taskAccept(principal, {
        task: "t-win-accept",
        runId: accRunId,
        receiptDigest: accDigest,
        publish: false,
        idempotencyKey: randomUUID(),
        useFreshSession: true,
      })) as { ok: boolean; accepted: boolean };
      expect(accRes.accepted).toBe(true);
      const accProof = store.handle
        .prepare("SELECT outcome FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1")
        .get("t-win-accept", ACCEPT_PROVED_ACTION) as { outcome: string };
      expect(accProof.outcome).toBe("passkey-fresh");

      // 4. Land NEVER uses the fresh session window even while unlocked.
      const landCh = (await actions.approvalChallenge(principal, { verb: "land", task: "t-win-accept" })) as { freshApproved: boolean };
      expect(landCh.freshApproved).toBe(false);

      // 5. Window is FIXED (never extended by use): advancing past T0 + 15 min expires it.
      now = new Date(T0.getTime() + 16 * 60_000);
      const { digest: d3 } = createTaskWithScope("t-win-3");
      const ch3 = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-win-3", digest: d3 })) as { freshApproved: boolean };
      expect(ch3.freshApproved).toBe(false);
      await expect(actions.taskApprove(principal, {
        task: "t-win-3",
        digest: d3,
        idempotencyKey: randomUUID(),
        useFreshSession: true,
      })).rejects.toMatchObject({ code: "passkey_step_up_required" });

      // 6. 1-hour window works, and `passkey.lock` or switching to `0` (Every time) immediately locks it.
      setPasskeyApprovalWindowMinutes(store, 60);
      const ch3Live = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-win-3", digest: d3 })) as { challenge: string };
      await actions.taskApprove(principal, {
        task: "t-win-3",
        digest: d3,
        challenge: ch3Live.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, ch3Live.challenge, userHandle),
      });
      now = new Date(now.getTime() + 45 * 60_000); // 45 min into 60-min window -> still unlocked!
      const status60 = (await actions.passkeyStatus(principal)) as { windowMinutes: number; freshUntil: string | null };
      expect(status60.windowMinutes).toBe(60);
      expect(status60.freshUntil).not.toBeNull();

      // Explicit lock from iPhone immediately invalidates the active window.
      await actions.passkeyLock(principal);
      const { digest: d4 } = createTaskWithScope("t-win-4");
      await expect(actions.taskApprove(principal, {
        task: "t-win-4",
        digest: d4,
        idempotencyKey: randomUUID(),
        useFreshSession: true,
      })).rejects.toMatchObject({ code: "passkey_step_up_required" });

      // Switching Mac setting to 0 ("Every time") prevents any fresh session from being created.
      setPasskeyApprovalWindowMinutes(store, 0);
      const ch4 = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-win-4", digest: d4 })) as { challenge: string };
      const r4 = (await actions.taskApprove(principal, {
        task: "t-win-4",
        digest: d4,
        challenge: ch4.challenge,
        idempotencyKey: randomUUID(),
        assertion: buildAssertionPayload(key, ch4.challenge, userHandle),
      })) as { freshUntil: string | null };
      expect(r4.freshUntil).toBeNull();
    });
  });
  describe("Fix round: windows only from verified routine acts, outcomes replayed exactly, one Accept binding", () => {
    const userHandle = () => derivePasskeyUserHandle(store.workspaceIdentity().id, "alex");
    const refOf = (taskId: string) => store.refFor("built-in", taskId).id;

    async function liveApprove(taskId: string, digest: string, key: SimulatedPasskey, dev = principal): Promise<{ ok: boolean; approved: boolean; freshUntil: string | null; secondApprover?: boolean }> {
      const ch = (await actions.approvalChallenge(dev, { verb: "approve", task: taskId, digest, forceFresh: true })) as { challenge: string };
      return (await actions.taskApprove(dev, { task: taskId, digest, challenge: ch.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, ch.challenge, userHandle()) })) as never;
    }

    async function unlock(key: SimulatedPasskey, minutes?: number): Promise<{ ok: boolean; unlocked: boolean; freshUntil: string | null; minutes: number }> {
      const params = minutes === undefined ? {} : { minutes };
      const ch = (await actions.approvalChallenge(principal, { verb: "unlock", ...params })) as { challenge: string; wording: string };
      return (await actions.passkeyUnlock(principal, { ...params, challenge: ch.challenge, assertion: buildAssertionPayload(key, ch.challenge, userHandle()) })) as never;
    }

    function protectSrc(): void {
      store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["src/**"] }, "alex", now);
    }

    test("C1: a land replay (forged assertion) and a ship confer no approvals window", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { runId, receiptDigest } = seedReviewableResult("t-c1");
      const acceptCh = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-c1", runId, receiptDigest, forceFresh: true })) as { challenge: string };
      await actions.taskAccept(principal, { task: "t-c1", runId, receiptDigest, challenge: acceptCh.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, acceptCh.challenge, userHandle()) });
      const landCh = (await actions.approvalChallenge(principal, { verb: "land", task: "t-c1" })) as { challenge: string; binding: { planKey: string } };
      await actions.taskLand(principal, { task: "t-c1", key: landCh.binding.planKey, challenge: landCh.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, landCh.challenge, userHandle()) });
      await actions.passkeyLock(principal);

      // The same landing key again, with a made-up assertion: answered as a replay, and it opens nothing.
      const forged = { ...buildAssertionPayload(key, "not-a-challenge", userHandle()), signature: Buffer.from("forged").toString("base64url") };
      const replay = (await actions.taskLand(principal, { task: "t-c1", key: landCh.binding.planKey, challenge: "not-a-challenge", idempotencyKey: randomUUID(), assertion: forged })) as { replayed: boolean; freshUntil: string | null };
      expect(replay.replayed).toBe(true);
      expect(replay.freshUntil).toBeNull();
      expect(((await actions.passkeyStatus(principal)) as { freshUntil: string | null }).freshUntil).toBeNull();
      const { digest } = createTaskWithScope("t-c1-next");
      await expect(actions.taskApprove(principal, { task: "t-c1-next", digest, idempotencyKey: randomUUID(), useFreshSession: true })).rejects.toMatchObject({ code: "passkey_step_up_required" });
    });

    test("F3: the domain gate refuses a fabricated window proof (the gate owns the registry)", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { digest } = createTaskWithScope("t-f3");
      const fabricated = { kind: "fresh", deviceId: principal.deviceId, credentialId: key.credentialId, verifiedAtMs: now.getTime(), expiresAtMs: now.getTime() + 60_000, be: true, bs: true };
      expect(approve(store, "t-f3", "alex", now, digest, "", {}, undefined, undefined, fabricated as never)).toMatchObject({ ok: false });
      expect(approve(store, "t-f3", "alex", now, digest, "", {}, undefined, undefined, { kind: "lease", deviceId: principal.deviceId } as never)).toMatchObject({ ok: false });
      expect(approvalOf(store.getScope("t-f3")).approved).toBe(false);
    });

    test("C2: a protected result needs a live assertion even when separation of duties is already met; a vote opens no window", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
      // Open a window with a routine approval (before the project protects anything).
      const { digest } = createTaskWithScope("t-c2-routine");
      expect((await liveApprove("t-c2-routine", digest, key)).freshUntil).not.toBeNull();
      const { runId, receiptDigest } = seedReviewableResult("t-c2");
      // Two people already approved the exact plan: separation of duties is satisfied for the completer.
      const approvedDigest = store.getScope("t-c2")!.approvedDigest!;
      for (const who of ["alex", "sam"]) store.handle.prepare("INSERT INTO scope_approval_vote (task_id, digest, approver, at, proof) VALUES (?, ?, ?, ?, 'password-now')").run("t-c2", approvedDigest, who, now.toISOString());
      protectSrc();
      const hint = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-c2", runId, receiptDigest })) as { freshApproved: boolean };
      expect(hint.freshApproved).toBe(false);
      await expect(actions.taskAccept(principal, { task: "t-c2", runId, receiptDigest, idempotencyKey: randomUUID(), useFreshSession: true }))
        .rejects.toMatchObject({ code: "passkey_step_up_required" });

      // A second approver's vote on protected work, by live assertion, opens no window.
      await actions.passkeyLock(principal);
      const { digest: pd } = createTaskWithScope("t-c2-vote");
      const vote = await liveApprove("t-c2-vote", pd, key);
      expect(vote.secondApprover).toBe(true);
      expect(((await actions.passkeyStatus(principal)) as { freshUntil: string | null }).freshUntil).toBeNull();
    });

    test("C4/C6: approvals by live passkey and by window dispatch, and their proofs fit the ledger at production lengths", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { digest } = createTaskWithScope("t-c4-live");
      expect((await liveApprove("t-c4-live", digest, key)).approved).toBe(true);
      expect(scopeApprovedForDispatch(store, refOf("t-c4-live"), now)).toBe(true);
      now = new Date(T0.getTime() + 60_000);
      const { digest: d2 } = createTaskWithScope("t-c4-window");
      expect(await actions.taskApprove(principal, { task: "t-c4-window", digest: d2, idempotencyKey: randomUUID(), useFreshSession: true })).toMatchObject({ approved: true });
      expect(personApprovalOf(store, "t-c4-window")).toMatchObject({ ok: true, method: "passkey-fresh" });
      expect(scopeApprovedForDispatch(store, refOf("t-c4-window"), now)).toBe(true);
      for (const [task, d] of [["t-c4-live", digest], ["t-c4-window", d2]] as const) {
        const row = store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(task, APPROVAL_PROOF) as { detail: string };
        expect(row.detail.length).toBeLessThan(300);
        expect(proofDetailOf(row.detail)?.digest).toBe(d);
      }
      // The longest detail this build writes (window proof, 64-hex digest, long credential id), through recordAction.
      const detail = passkeyProofDetail({ at: now, provedAtMs: T0.getTime(), generation: 123456, digest: "f".repeat(64), verb: "approve", credentialId: "c".repeat(1024), pairedDeviceId: DEVICE_1, be: true, bs: true });
      store.recordAction({ at: now.toISOString(), actor: "alex", repo: REPO, taskId: "t-c6", runId: null, action: APPROVAL_PROOF, outcome: "passkey-fresh", source: "work", detail });
      const kept = store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = 't-c6'").get() as { detail: string };
      expect(kept.detail).toBe(detail);
      expect(proofDetailOf(kept.detail)).toEqual({ at: now.toISOString(), digest: "f".repeat(64) });
    });

    test("C7: an Accept refused for its missing reason consumes nothing", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { runId, receiptDigest } = seedReviewableResult("t-c7", { refuted: true });
      const ch = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-c7", runId, receiptDigest })) as { challenge: string };
      await expect(actions.taskAccept(principal, { task: "t-c7", runId, receiptDigest, challenge: ch.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, ch.challenge, userHandle()) }))
        .rejects.toMatchObject({ code: "refused", message: expect.stringContaining("Accepting needs a reason") });
      expect(getPasskeyChallenge(store.handle, ch.challenge)?.consumedAt).toBeNull();
    });

    test("C8: Land reads the clock right before consuming: a challenge that expired during the git work is refused", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { runId, receiptDigest } = seedReviewableResult("t-c8");
      const acceptCh = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-c8", runId, receiptDigest })) as { challenge: string };
      await actions.taskAccept(principal, { task: "t-c8", runId, receiptDigest, challenge: acceptCh.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, acceptCh.challenge, userHandle()) });
      // Writing the landing commit takes longer than the challenge lives.
      const slowGit: typeof execRun = async (file, args, options) => {
        if (args.includes("hash-object")) now = new Date(now.getTime() + 125_000);
        return execRun(file, args, options);
      };
      const slow = createCompanionActions({ runtime, workspaceLabel: () => "Studio Mac", git: slowGit });
      const landCh = (await slow.approvalChallenge(principal, { verb: "land", task: "t-c8" })) as { challenge: string; binding: { planKey: string } };
      await expect(slow.taskLand(principal, { task: "t-c8", key: landCh.binding.planKey, challenge: landCh.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, landCh.challenge, userHandle()) }))
        .rejects.toMatchObject({ code: "refused", message: expect.stringContaining("expired") });
      expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE task_id = ? AND action = ?").get("t-c8", LAND_PROVED_ACTION)).toEqual({ n: 0 });
    });

    test("C9/C10: a refused request replays as the same error; only an unconfirmed external effect is unknown", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      // A definite refusal (stale plan) replays as that refusal, never as a success result.
      const { digest } = createTaskWithScope("t-c9");
      const ch = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-c9", digest })) as { challenge: string };
      const stale = { task: "t-c9", digest: "0".repeat(64), challenge: ch.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, ch.challenge, userHandle()) };
      await expect(actions.taskApprove(principal, stale)).rejects.toMatchObject({ code: "refused" });
      await expect(actions.taskApprove(principal, stale)).rejects.toMatchObject({ code: "refused" });

      // A landing refused before anything ran (stale plan key) is a definite failure too, not an unknown outcome.
      const { runId, receiptDigest } = seedReviewableResult("t-c10");
      const acceptCh = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-c10", runId, receiptDigest })) as { challenge: string };
      await actions.taskAccept(principal, { task: "t-c10", runId, receiptDigest, challenge: acceptCh.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, acceptCh.challenge, userHandle()) });
      const landCh = (await actions.approvalChallenge(principal, { verb: "land", task: "t-c10" })) as { challenge: string };
      const staleLand = { task: "t-c10", key: "0123456789abcdef", challenge: landCh.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, landCh.challenge, userHandle()) };
      await expect(actions.taskLand(principal, staleLand)).rejects.toMatchObject({ code: "refused" });
      await expect(actions.taskLand(principal, staleLand)).rejects.toMatchObject({ code: "refused" });

      // A merge that ran but couldn't be read back may have happened: unknown, and it stays unknown on replay.
      const { runId: shipRun, headSha } = seedReviewableResult("t-c10-ship");
      seedPullRequest("t-c10-ship", shipRun, headSha);
      let merged = false;
      const publishExec: PublishExec = async (_cmd, args) => {
        const joined = args.join(" ");
        if (joined.includes("pr merge")) { merged = true; return { ok: true, code: 0, stdout: "", stderr: "" }; }
        if (joined.includes("pr view") && merged) return { ok: false, code: 1, stdout: "", stderr: "network down" };
        if (joined.includes("pr view")) {
          return { ok: true, code: 0, stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: headSha, baseRefName: "main", url: "https://github.com/ap9000/toolroll/pull/42",
            mergeCommit: null, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }), stderr: "" };
        }
        return { ok: true, code: 0, stdout: "", stderr: "" };
      };
      const shipActions = createCompanionActions({ runtime, workspaceLabel: () => "Studio Mac", publishExec });
      const shipCh = (await shipActions.approvalChallenge(principal, { verb: "ship", runId: shipRun })) as { challenge: string };
      const ship = { runId: shipRun, challenge: shipCh.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, shipCh.challenge, userHandle()) };
      await expect(shipActions.taskShip(principal, ship)).rejects.toMatchObject({ code: "outcome_unknown" });
      await expect(shipActions.taskShip(principal, ship)).rejects.toMatchObject({ code: "outcome_unknown" });
    });

    test("C11: Accept without a run id and with a padded note binds the same bytes on both sides", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { receiptDigest } = seedReviewableResult("t-c11");
      const ch = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-c11", receiptDigest, note: "  looks right  " })) as { challenge: string };
      expect(await actions.taskAccept(principal, { task: "t-c11", receiptDigest, note: "  looks right  ", challenge: ch.challenge, idempotencyKey: randomUUID(), assertion: buildAssertionPayload(key, ch.challenge, userHandle()) }))
        .toMatchObject({ ok: true, accepted: true });
    });

    test("windows end on device removal and on a password change (account generation)", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { digest } = createTaskWithScope("t-end-1");
      expect((await liveApprove("t-end-1", digest, key)).freshUntil).not.toBeNull();
      store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
      expect(activePasskeyLease(store, principal.deviceId, "alex", now)).toBeNull();

      const dev2 = pairDevice(DEVICE_2, "alex");
      const { digest: d2 } = createTaskWithScope("t-end-2");
      expect((await liveApprove("t-end-2", d2, key, dev2)).freshUntil).not.toBeNull();
      expect(activePasskeyLease(store, DEVICE_2, "alex", now)).not.toBeNull();
      expect(revokePairedDeviceRecord(store.handle, DEVICE_2, now)).toBe(true);
      expect(activePasskeyLease(store, DEVICE_2, "alex", now)).toBeNull();
    });

    test("R1: an Accept named by the root reads protection from its current revision and the whole ancestry", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      const { digest } = createTaskWithScope("t-r1-routine");
      expect((await liveApprove("t-r1-routine", digest, key)).freshUntil).not.toBeNull();
      // The root declared only src/auth.ts; its revision also declares a file the project protects.
      const rootRun = seedReviewableResult("t-r1").runId;
      seedReviewableResult("t-r1-v2", { touches: ["src/auth.ts", "config/keys.json"] });
      const brief = Number(store.handle.prepare("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (?, 'revision-brief', 'brief-r1', 0, 0, ?, 'fixture', ?)")
        .run(rootRun, "0".repeat(64), now.toISOString()).lastInsertRowid);
      store.handle.prepare("UPDATE task_ref SET revision_of = 't-r1', revision_brief_artifact = ? WHERE backend = 'built-in' AND external_id = 't-r1-v2'").run(brief);
      store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["config/**"] }, "alex", now);
      const before = assignmentOf(store, "t-r1", now, { principal: "operator", repos: [REPO] }, evidenceRoot)!;
      expect(before.receipt?.taskId).toBe("t-r1-v2");
      const { runId, digest: receiptDigest } = before.receipt!;
      const hint = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-r1", runId, receiptDigest })) as { freshApproved: boolean };
      expect(hint.freshApproved).toBe(false);
      await expect(actions.taskAccept(principal, { task: "t-r1", runId, receiptDigest, idempotencyKey: randomUUID(), useFreshSession: true }))
        .rejects.toMatchObject({ code: "passkey_step_up_required" });
      expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = ?").get(ACCEPT_PROVED_ACTION)).toEqual({ n: 0 });
    });

    test("R2: a window grant from a rolled-back Accept never opens after the same challenge is consumed for protected work", async () => {
      const key = createSimulatedPasskey();
      await enrollKey(key);
      expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
      const { runId, receiptDigest } = seedReviewableResult("t-r2");
      const ch = (await actions.approvalChallenge(principal, { verb: "accept", task: "t-r2", runId, receiptDigest })) as { challenge: string };
      const proof = { deviceId: principal.deviceId, challenge: ch.challenge, assertion: buildAssertionPayload(key, ch.challenge, userHandle()) };
      const who = verifyApproverByPassword(store, "alex", alexToken, [REPO]);
      if (!who.ok) throw new Error("alex sign-in failed");
      // Routine at first: the consumption parks a window grant, then the completion is refused and all of it rolls back.
      expect(acceptAndCompleteAsOperator(store, "t-r2", { runId, receiptDigest, note: null, passkey: proof }, who.who, now, evidenceRoot,
        () => ({ ok: false, reason: "refused", message: "Not now." }))).toMatchObject({ ok: false, message: "Not now." });
      expect(getPasskeyChallenge(store.handle, ch.challenge)?.consumedAt).toBeNull();
      // Now the work is protected (separation of duties already met): the same challenge is consumed for it and commits.
      const approvedDigest = store.getScope("t-r2")!.approvedDigest!;
      for (const name of ["alex", "sam"]) store.handle.prepare("INSERT INTO scope_approval_vote (task_id, digest, approver, at, proof) VALUES (?, ?, ?, ?, 'password-now')").run("t-r2", approvedDigest, name, now.toISOString());
      protectSrc();
      expect(acceptAndCompleteAsOperator(store, "t-r2", { runId, receiptDigest, note: null, passkey: proof }, who.who, now, evidenceRoot)).toMatchObject({ ok: true });
      expect(getPasskeyChallenge(store.handle, ch.challenge)?.consumedAt).not.toBeNull();
      // The stale routine grant is gone: nothing opens.
      expect(startPasskeyLease(store, { deviceId: principal.deviceId, accountName: "alex", challenge: ch.challenge })).toBeNull();
      expect(activePasskeyLease(store, principal.deviceId, "alex", now)).toBeNull();
    });

    describe("passkey.unlock", () => {
      test("refused when the Mac asks every time; the phone can tell", async () => {
        const key = createSimulatedPasskey();
        await enrollKey(key);
        setPasskeyApprovalWindowMinutes(store, 0);
        await expect(actions.approvalChallenge(principal, { verb: "unlock" })).rejects.toMatchObject({ code: "approvals_window_off" });
        await expect(actions.passkeyUnlock(principal, { challenge: "x", assertion: buildAssertionPayload(key, "x", userHandle()) })).rejects.toMatchObject({ code: "approvals_window_off" });
      });

      test("an unlock lets a routine approval through without an assertion, and it dispatches; wording names the phone", async () => {
        const key = createSimulatedPasskey();
        await enrollKey(key);
        const ch = (await actions.approvalChallenge(principal, { verb: "unlock" })) as { wording: string; binding: unknown };
        expect(ch.wording).toBe("Unlock approvals on Alex iPhone 16 Pro for 15 minutes");
        expect(ch.binding).toEqual({ verb: "unlock", minutes: 15 });
        const res = await unlock(key);
        expect(res).toMatchObject({ ok: true, unlocked: true, minutes: 15, freshUntil: new Date(T0.getTime() + 15 * 60_000).toISOString() });
        expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE action = 'approvals unlocked'").get()).toEqual({ outcome: "passkey" });
        const { digest } = createTaskWithScope("t-unlock");
        const hint = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-unlock", digest })) as { freshApproved: boolean };
        expect(hint.freshApproved).toBe(true);
        expect(await actions.taskApprove(principal, { task: "t-unlock", digest, idempotencyKey: randomUUID(), useFreshSession: true })).toMatchObject({ approved: true });
        expect(scopeApprovedForDispatch(store, refOf("t-unlock"), now)).toBe(true);
        // Locking (the phone going to the background) ends it.
        await actions.passkeyLock(principal);
        expect(((await actions.passkeyStatus(principal)) as { freshUntil: string | null }).freshUntil).toBeNull();
      });

      test("an unlock never covers a protected accept, land or publish", async () => {
        const key = createSimulatedPasskey();
        await enrollKey(key);
        const { runId, receiptDigest } = seedReviewableResult("t-unlock-protected");
        protectSrc();
        expect((await unlock(key)).unlocked).toBe(true);
        await expect(actions.taskAccept(principal, { task: "t-unlock-protected", runId, receiptDigest, idempotencyKey: randomUUID(), useFreshSession: true }))
          .rejects.toMatchObject({ code: "passkey_step_up_required" });
        await expect(actions.taskAccept(principal, { task: "t-unlock-protected", runId, receiptDigest, publish: true, idempotencyKey: randomUUID(), useFreshSession: true }))
          .rejects.toMatchObject({ code: "passkey_step_up_required" });
        const landCh = (await actions.approvalChallenge(principal, { verb: "land", task: "t-unlock-protected" }).catch(() => ({ freshApproved: false }))) as { freshApproved: boolean };
        expect(landCh.freshApproved).toBe(false);
      });

      test("a replayed or forged unlock opens nothing", async () => {
        const key = createSimulatedPasskey();
        await enrollKey(key);
        const ch = (await actions.approvalChallenge(principal, { verb: "unlock" })) as { challenge: string };
        const forged = buildAssertionPayload(key, ch.challenge, userHandle(), { corruptSignature: true });
        await expect(actions.passkeyUnlock(principal, { challenge: ch.challenge, assertion: forged })).rejects.toMatchObject({ code: "passkey_failed" });
        expect(((await actions.passkeyStatus(principal)) as { freshUntil: string | null }).freshUntil).toBeNull();
        const good = buildAssertionPayload(key, ch.challenge, userHandle());
        expect(await actions.passkeyUnlock(principal, { challenge: ch.challenge, assertion: good })).toMatchObject({ unlocked: true });
        await actions.passkeyLock(principal);
        await expect(actions.passkeyUnlock(principal, { challenge: ch.challenge, assertion: good })).rejects.toMatchObject({ code: "passkey_failed" });
        expect(((await actions.passkeyStatus(principal)) as { freshUntil: string | null }).freshUntil).toBeNull();
        // An approve challenge can't unlock either (verb-bound).
        const { digest } = createTaskWithScope("t-unlock-cross");
        const approveCh = (await actions.approvalChallenge(principal, { verb: "approve", task: "t-unlock-cross", digest })) as { challenge: string };
        await expect(actions.passkeyUnlock(principal, { challenge: approveCh.challenge, assertion: buildAssertionPayload(key, approveCh.challenge, userHandle()) }))
          .rejects.toMatchObject({ code: "passkey_failed" });
      });

      test("the phone may ask for less than the Mac's window, never more", async () => {
        const key = createSimulatedPasskey();
        await enrollKey(key);
        expect((await unlock(key, 5)).freshUntil).toBe(new Date(T0.getTime() + 5 * 60_000).toISOString());
        await actions.passkeyLock(principal);
        const longer = await unlock(key, 60);
        expect(longer).toMatchObject({ minutes: 15, freshUntil: new Date(T0.getTime() + 15 * 60_000).toISOString() });
        await expect(actions.approvalChallenge(principal, { verb: "unlock", minutes: 0 })).rejects.toMatchObject({ code: "invalid_params" });
      });
    });
  });
});
