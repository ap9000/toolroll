/**
 * Attack 23 (docs/plans/release-once.md): the release check's contracts — the fd-3 result lines, the report, the
 * inventory, the targeted plan, the obligation snapshot and receipt version 3 — accept what Toolroll writes and refuse
 * anything else by path.
 */
import { describe, expect, test } from "vitest";
import { parseContract } from "./contract.js";
import {
  checkInventorySchema, checkResultLineSchema, obligationSnapshotSchema, readCheckReport, sealedInventorySchema, targetedPlanSchema,
} from "./release-check.js";
import { readVerificationReceipt } from "./verification-receipt.js";

const ok = (schema: Parameters<typeof parseContract>[0], value: unknown) => parseContract(schema, value).ok;

describe("the release check's contracts", () => {
  test("fd-3 result lines: each shape the harness writes, and nothing else", () => {
    for (const line of [
      { kind: "unit-case", file: "src/a.test.ts", name: "suite > test", state: "failed", flaky: false },
      { kind: "unit-file", file: "src/a.test.ts", state: "passed", passed: 3, failed: 0, skipped: 1, flaky: false },
      { kind: "unit-end", reason: "passed", errors: 0 },
      { kind: "journey-inventory", script: "app", journeys: "scripted", groups: ["alpha"] },
      { kind: "journey", name: "opens the task", state: "passed" },
      { kind: "journey-end", browserCheck: "passed", unstopped: false, catalogue: 0 },
      { kind: "journey-group", script: "flows", journeys: "real", group: "beta", state: "failed", retried: false, unattributed: true, results: [] },
      { kind: "upgrade-inventory", versions: ["0.9.1"] },
      { kind: "upgrade-version", version: "0.9.1", state: "not-run" },
      { kind: "upgrade-end" },
    ]) expect(ok(checkResultLineSchema, line), JSON.stringify(line)).toBe(true);
    for (const line of [{ kind: "unit-case", file: "/etc/passwd", name: "x", state: "passed", flaky: false }, { kind: "unit-file", file: "../a", state: "passed", passed: 0, failed: 0, skipped: 0, flaky: false },
      { kind: "report", nonce: "x" }, { kind: "upgrade-version", version: "latest", state: "passed" }]) expect(ok(checkResultLineSchema, line), JSON.stringify(line)).toBe(false);
  });

  const report = { version: 1, nonce: "a".repeat(64), mode: "full", planDigest: null, exitCode: 0, parts: [{ part: "unit", selected: true, ran: true, code: 0, timedOut: false }],
    units: { reusedFromCI: false, finished: true, runErrors: 0, files: [{ file: "src/a.test.ts", state: "passed", passed: 1, failed: 0, skipped: 0, flaky: false }], identities: [] }, journeys: [], upgrades: null };
  test("the report", () => {
    expect(readCheckReport(report).ok).toBe(true);
    for (const bad of [{ ...report, nonce: "short" }, { ...report, mode: "partial" }, { ...report, extra: 1 }, { ...report, version: 2 }, { ...report, parts: [{ part: "everything" }] }])
      expect(readCheckReport(bad).ok).toBe(false);
  });

  test("the inventory, the plan and the snapshot", () => {
    const inventory = { version: 1, units: ["src/a.test.ts"], parts: ["typecheck", "build", "unit"] };
    expect(ok(checkInventorySchema, inventory)).toBe(true);
    expect(ok(sealedInventorySchema, { version: 1, sealed: inventory, declared: { groups: [], versions: [] } })).toBe(true);
    expect(ok(checkInventorySchema, { ...inventory, units: ["../x.test.ts"] })).toBe(false);
    const plan = { version: 1, base: 3, units: ["src/a.test.ts"], sanity: [], groups: [{ script: "app", kind: "scripted", groups: ["alpha"] }], versions: ["0.9.1"], parts: [], required: ["unit:src/a.test.ts::x"] };
    expect(ok(targetedPlanSchema, plan)).toBe(true);
    expect(ok(targetedPlanSchema, { ...plan, base: 0 })).toBe(false);
    expect(ok(targetedPlanSchema, { ...plan, parts: ["all"] })).toBe(false);
    expect(ok(obligationSnapshotSchema, { version: 1, authority: 1, base: 3, earlier: [{ run: 4, reportDigest: null, failed: ["unit:src/a.test.ts::x"] }] })).toBe(true);
    expect(ok(obligationSnapshotSchema, { version: 1, authority: 1, base: 3, earlier: [{ run: 4 }] })).toBe(false);
  });

  test("receipt version 3: coverage, the check and a composed check's links", () => {
    const base = { version: 3, run: 9, head: "h", base: null, scopeDigest: "d", command: { id: 1, repo: "/r", command: "c", timeoutMs: 1, digest: "g", recoverySetupDigest: null, approvedBy: "a", approvedAt: "t", revokedAt: null, revokedBy: null },
      result: { configured: true, ran: true, exitCode: 0 }, log: { artifactId: 1, sha256: "s", bytesStored: 1, bytesOriginal: 1, truncated: false, redacted: false, captureStatus: "ok" } };
    expect(readVerificationReceipt({ ...base, coverage: "full", check: { attempt: "full", report: "r", inventory: "i" } }).ok).toBe(true);
    expect(readVerificationReceipt({ ...base, coverage: "composed", check: { attempt: "targeted", report: "r", inventory: "i" },
      composed: { base: 3, baseReceipt: "x", baseReport: "y", authority: 1, carries: [2], artifacts: "a", plan: "p", snapshot: "s", report: "r" } }).ok).toBe(true);
    expect(readVerificationReceipt({ ...base, coverage: "everything" }).ok).toBe(false);
    expect(readVerificationReceipt({ ...base, coverage: "composed", composed: { base: 3 } }).ok).toBe(false);
  });
});
