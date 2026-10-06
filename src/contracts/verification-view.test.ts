import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { LEGACY_GATE_SOURCE, legacyGateViewSchema, readVerificationView } from "./verification-view.js";
import { evidenceSamples } from "../../test/evidence-replay.js";

const read = (input: unknown): SampleVerdict => {
  const parsed = readVerificationView(JSON.stringify(input));
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

const sealed = evidenceSamples.flatMap(sample => (sample.receipt === null ? [] : [JSON.parse(sample.receipt) as Record<string, unknown>]));
const direct = sealed[0]!;
const legacy = {
  version: 1, source: LEGACY_GATE_SOURCE, run: 7, head: "a".repeat(40), base: "b".repeat(40), scopeDigest: null, command: direct["command"],
  result: { configured: true, ran: true, exitCode: 0 }, log: direct["log"], candidate: { ...(direct["log"] as object), artifactId: 9 },
};

describe("the gate view contract", () => {
  it("holds: every saved receipt and a legacy log-header view read; a broken view is refused by path", () => {
    assertContract({
      schema: legacyGateViewSchema,
      read,
      valid: [...sealed.map((input, index) => ({ name: `saved receipt ${index}`, input })), { name: "legacy log header", input: legacy }],
      invalid: [
        { name: "legacy view without its candidate", input: { ...legacy, candidate: undefined }, paths: ["candidate"] },
        { name: "legacy view from another source", input: { ...legacy, source: "a guess" }, paths: ["source"] },
        { name: "legacy view with an exit code out of range", input: { ...legacy, result: { configured: true, ran: true, exitCode: 300 } }, paths: ["result.exitCode"] },
        { name: "a receipt from a newer Toolroll", input: { ...direct, version: 3 }, paths: ["version"] },
      ],
    });
    expect(readVerificationView("not json")).toMatchObject({ ok: false, issues: [{ path: "payload" }] });
  });

  it("returns the view as written: a sealed version 1 receipt keeps its version and key order", () => {
    const bytes = JSON.stringify(direct);
    const view = readVerificationView(bytes);
    expect(view.ok && JSON.stringify(view.value)).toBe(bytes);
    expect(view.ok && (view.value as unknown as { version: number }).version).toBe(1);
  });
});

describe("docs/plans/zod-revamp.md", () => {
  it("marks wave 4 item 20 done", () => {
    const doc = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| 20 ✅ \| \*\*Evidence files\*\*/m);
    expect(doc.slice(doc.indexOf("## Done"))).toContain("**20. Evidence files**");
  });
});
