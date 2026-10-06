import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { readVerificationReceipt, verificationReceiptSchema } from "./verification-receipt.js";
import { evidenceBaseline, evidenceSamples } from "../../test/evidence-replay.js";

const read = (input: unknown): SampleVerdict => {
  const parsed = readVerificationReceipt(input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

const savedReceipts = evidenceSamples.flatMap(sample => (sample.receipt === null ? [] : [{ name: `${sample.run}/verification-receipt.json`, input: JSON.parse(sample.receipt) as Record<string, unknown> }]));
const direct = savedReceipts[0]!.input;
const reused = { ...direct, version: 2, reusedFrom: { run: 2437, digest: "a".repeat(64) }, executedHere: false };

describe("the verification receipt contract", () => {
  it("holds: the JSON Schema round trip loses nothing, saved direct and reused receipts read, malformed ones are refused by path", () => {
    expect(savedReceipts).toHaveLength(9);
    assertContract({
      schema: verificationReceiptSchema,
      read,
      valid: [
        ...savedReceipts,
        { name: "reused gate (version 2)", input: reused },
        { name: "attempt failed", input: { ...direct, result: { configured: true, ran: false, attemptFailed: true, failure: "timed-out" } } },
        { name: "setup replayed", input: { ...direct, result: { configured: true, ran: true, exitCode: 0, setupReplayed: true } } },
      ],
      invalid: [
        { name: "newer version", input: { ...direct, version: 3 }, paths: ["version"] },
        { name: "no version", input: { ...direct, version: undefined }, paths: ["version"] },
        { name: "unknown key", input: { ...direct, source: "legacy machine log header" }, paths: ["payload"] },
        { name: "missing command digest", input: { ...direct, command: { ...(direct["command"] as object), digest: undefined } }, paths: ["command.digest"] },
        { name: "an extra result field", input: { ...direct, result: { configured: true, ran: true, exitCode: 0, attemptFailed: true } }, paths: ["result"] },
        { name: "exit code out of range", input: { ...direct, result: { configured: true, ran: true, exitCode: 300 } }, paths: ["result.exitCode"] },
        { name: "log binding is complete", input: { ...direct, log: { ...(direct["log"] as object), sha256: undefined } }, paths: ["log.sha256"] },
        { name: "a reused gate did not execute here", input: { ...reused, executedHere: true }, paths: ["executedHere"] },
      ],
    });
  });

  it("reads a direct receipt without reuse, and a reused one with its source", () => {
    expect(readVerificationReceipt(direct)).toMatchObject({ ok: true, value: { version: 2, run: 2438 } });
    expect(readVerificationReceipt(direct).ok && (readVerificationReceipt(direct) as { value: { reusedFrom?: unknown } }).value.reusedFrom).toBeUndefined();
    expect(readVerificationReceipt(reused)).toMatchObject({ ok: true, value: { reusedFrom: { run: 2437 }, executedHere: false } });
  });
});

describe("the replayed evidence samples", () => {
  it("keep their bytes: the view a saved receipt gives is the bytes and hash recorded before the schema", () => {
    for (const sample of evidenceSamples) {
      const before = evidenceBaseline[sample.run]!.receipt;
      if (sample.receipt === null) {
        expect(before).toBeNull();
        continue;
      }
      const saved = JSON.parse(sample.receipt) as unknown;
      expect(readVerificationReceipt(saved).ok, sample.run).toBe(true);
      const bytes = JSON.stringify(saved);
      expect({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") }, sample.run).toEqual(before);
    }
  });
});
