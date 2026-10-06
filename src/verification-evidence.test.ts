import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { budgetedStatJson, parseNumstat, storeEvidence } from "./evidence.js";
import { openStore, type Store, type VerifyCommand } from "./store.js";
import { failedVerificationEvidence, isVerificationReceipt, sealVerificationReceipt, verificationEvidence } from "./verification-evidence.js";
import { readVerificationView } from "./contracts/verification-view.js";
import { presented } from "../test/route-fixture.js";

const T0 = new Date("2026-10-05T10:00:00Z"), T1 = new Date("2026-10-05T10:01:00Z");
const REPO = "/repos/receipts", HEAD = "a".repeat(40), BASE = "b".repeat(40);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("verification receipts read through their schema", () => {
  let store: Store, dir: string, runId: number, command: VerifyCommand;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-receipt-"));
    store = openStore(join(dir, "orders.db"));
    store.createTask({ id: "gate", title: "Check the gate" }, T0);
    const ref = store.lookupRef("gate")!;
    store.placeTask(ref.id, REPO);
    command = store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "operator" }, T0);
    runId = store.startRun({ taskRef: ref.id, leaseId: "lease", runner: "builder", branch: "so/gate", worktree: join(dir, "wt"), now: T1, ...presented(store, ref.id) });
    store.stampRun(runId, { baseRevision: BASE });
    store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "done" });
    storeEvidence(store, dir, runId, "check-log", "check-log.txt", Buffer.from("$ npm test\n12 passed\n"), "sh -c npm test (exit 0)", T1, { captureStatus: "ok" });
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const receiptArtifact = () => store.artifactsFor(runId).find(isVerificationReceipt)!;
  let rewrites = 0;
  const rewrite = (change: (value: Record<string, unknown>) => unknown) => {
    const artifact = receiptArtifact();
    const payload = change(JSON.parse(readFileSync(join(dir, artifact.key), "utf8")) as Record<string, unknown>);
    store.handle.prepare("DELETE FROM artifact WHERE id = ?").run(artifact.id);
    storeEvidence(store, dir, runId, "structured-output", `replacement-receipt-${++rewrites}.json`, Buffer.from(JSON.stringify(payload)), artifact.capture, T1, { captureStatus: "ok" });
  };

  test("a direct gate is sealed as version 1 in the writer's key order, and its view and digest are the sealed bytes", () => {
    sealVerificationReceipt(store, dir, runId, HEAD, command, { configured: true, ran: true, exitCode: 0 }, T1);
    const sealed = readFileSync(join(dir, receiptArtifact().key), "utf8");
    const log = store.artifactsFor(runId).find(one => one.kind === "check-log")!;
    const expected = { version: 1, run: runId, head: HEAD, base: BASE, scopeDigest: null, command, result: { configured: true, ran: true, exitCode: 0 },
      log: { artifactId: log.id, sha256: log.sha256, bytesStored: log.bytesStored, bytesOriginal: log.bytesOriginal, truncated: false, redacted: false, captureStatus: "ok" } };
    expect(sealed).toBe(JSON.stringify(expected, null, 1));
    const view = verificationEvidence(store, dir, runId);
    expect(view).toEqual({ ok: true, bytes: JSON.stringify(expected), digest: hash({ receipt: expected, receipts: store.artifactsFor(runId).filter(isVerificationReceipt) }) });
  });

  test("a malformed receipt is refused by path; a newer one plainly", () => {
    sealVerificationReceipt(store, dir, runId, HEAD, command, { configured: true, ran: true, exitCode: 0 }, T1);
    rewrite(value => ({ ...value, result: { configured: true, ran: true, exitCode: 0, attemptFailed: true } }));
    expect(verificationEvidence(store, dir, runId)).toEqual({ ok: false, problem: "The verification receipt is malformed: result: unknown key 'attemptFailed'" });
    rewrite(value => ({ ...value, result: { configured: true, ran: true, exitCode: 0 }, version: 3 }));
    expect(verificationEvidence(store, dir, runId)).toEqual({ ok: false, problem: "The verification receipt is malformed: version: made by a newer Toolroll (version 3; this one reads up to 2)" });
  });

  test("reuse is version 2's: a direct receipt naming it is refused, and a reused one must be bound to an observation follow-up", () => {
    sealVerificationReceipt(store, dir, runId, HEAD, command, { configured: true, ran: true, exitCode: 0 }, T1);
    rewrite(value => ({ ...value, reusedFrom: { run: runId - 1, digest: "x" }, executedHere: false }));
    expect(verificationEvidence(store, dir, runId)).toEqual({ ok: false, problem: "The gate reuse receipt has an unsupported version." });
    rewrite(value => ({ ...value, version: 2 }));
    expect(verificationEvidence(store, dir, runId)).toEqual({ ok: false, problem: "The reused gate is not bound to an unchanged observation follow-up." });
  });

  test("the writer refuses a receipt its own schema would refuse", () => {
    expect(() => sealVerificationReceipt(store, dir, runId, HEAD, { ...command, id: 1.5 }, { configured: true, ran: true, exitCode: 0 }, T1))
      .toThrow("The verification receipt does not match its contract: command.id: must be an integer (got a number)");
  });

  test("a legacy gate reads its log header and candidate inventory through their schemas; its view reads back as written", () => {
    store.handle.prepare("DELETE FROM artifact WHERE run = ?").run(runId);
    const header = (exit: number) => `=== Attempt summary ===\n- Project check · attempt 1: (exit ${exit})\n\n=== Project check · attempt 1 ===\n$ npm test\n(exit ${exit})\n\n--- stdout ---\nboom\n`;
    const legacy = (log: string, stat: string) => {
      store.handle.prepare("DELETE FROM artifact WHERE run = ?").run(runId);
      storeEvidence(store, dir, runId, "check-log", `check-log-${++rewrites}.txt`, Buffer.from(log), "sh -c npm test", T1, { captureStatus: "ok" });
      storeEvidence(store, dir, runId, "diff-stat", `terminal-diff-stat-${rewrites}.json`, Buffer.from(stat), "git diff --numstat -z", T1, { captureStatus: "ok" });
      return verificationEvidence(store, dir, runId);
    };
    const stat = budgetedStatJson(parseNumstat("1\t0\tsrc/a.ts\u0000", BASE, HEAD)).toString("utf8");
    const view = legacy(header(1), JSON.stringify({ ...JSON.parse(stat), extra: true }));
    expect(view.ok && view.bytes !== null).toBe(true);
    const bytes = (view as { bytes: string }).bytes;
    expect(JSON.parse(bytes)).toMatchObject({ version: 1, source: "legacy machine log header", run: runId, head: HEAD, base: BASE, command, result: { configured: true, ran: true, exitCode: 1 } });
    const read = readVerificationView(bytes);
    expect(read.ok && JSON.stringify(read.value)).toBe(bytes);
    expect(failedVerificationEvidence(store, dir, runId)).toEqual({ kind: "none" });
    expect(legacy(header(0), JSON.stringify({ ...JSON.parse(stat), filesTruncated: true }))).toEqual({ ok: false, problem: "Legacy verification candidate endpoints do not match." });
    expect(legacy(header(0), "not json")).toEqual({ ok: false, problem: "Legacy candidate inventory is unreadable." });
    // Before the schema, a literal null inventory threw out of the gate; now it is the same refusal as any other mismatch.
    expect(legacy(header(0), "null")).toEqual({ ok: false, problem: "Legacy verification candidate endpoints do not match." });
    expect(legacy("$ npm test\nok\n", stat)).toEqual({ ok: false, problem: "The original log lacks an unambiguous machine gate receipt; historical output was not reconstructed." });
  });
});
