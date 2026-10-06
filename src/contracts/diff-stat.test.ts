import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { parseContract } from "./contract.js";
import { diffStatSchema, readCandidateEndpoints, savedInventoryPaths } from "./diff-stat.js";
import { budgetedStatJson, parseNumstat } from "../evidence.js";

const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const written = budgetedStatJson(parseNumstat("1\t2\tsrc/a.ts\u0000-\t-\tlogo.png\u00004\t0\t\u0000old.ts\u0000new.ts\u0000", BASE, HEAD)).toString("utf8");
const stat = JSON.parse(written) as Record<string, unknown>;
const files = stat["files"] as Record<string, unknown>[];
const read = (input: unknown): SampleVerdict => {
  const parsed = parseContract(diffStatSchema, input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};
const inventory = (value: unknown) => savedInventoryPaths(typeof value === "string" ? value : JSON.stringify(value), HEAD, BASE);

describe("the diff-stat contract", () => {
  it("holds: what the writer makes reads, in its own key order; unknown keys are ignored; broken stats are refused by path", () => {
    expect(written).toBe(JSON.stringify({ schema: 1, base: BASE, head: HEAD, fileCount: 3, additions: 5, deletions: 2, binaryCount: 1,
      files: [{ path: "src/a.ts", additions: 1, deletions: 2 }, { path: "logo.png", additions: null, deletions: null }, { path: "new.ts", additions: 4, deletions: 0, renamedFrom: "old.ts" }],
      filesTruncated: false }));
    assertContract({
      schema: diffStatSchema,
      read,
      valid: [
        { name: "as written", input: stat },
        { name: "an unknown key", input: { ...stat, extra: 1 } },
        { name: "an unknown file key", input: { ...stat, files: [{ ...files[0], extra: true }] } },
      ],
      invalid: [
        { name: "another schema", input: { ...stat, schema: 2 }, paths: ["schema"] },
        { name: "no head", input: { ...stat, head: undefined }, paths: ["head"] },
        { name: "a file without a path", input: { ...stat, files: [{ additions: 1, deletions: 1 }] }, paths: ["files[0].path"] },
      ],
    });
  });

  it("reads a legacy gate's endpoints as the old check did: only head, base and whether the list was cut", () => {
    expect(readCandidateEndpoints(stat)).toEqual({ ok: true, value: { head: HEAD, base: BASE, filesTruncated: false } });
    expect(readCandidateEndpoints({ head: HEAD, base: null, filesTruncated: true })).toMatchObject({ ok: true, value: { base: null, filesTruncated: true } });
    for (const bad of [null, [], "x", { ...stat, filesTruncated: undefined }, { ...stat, head: 1 }]) {
      expect(readCandidateEndpoints(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("gives a saved assessment the changed paths of a complete inventory for this candidate only", () => {
    expect(inventory(written)).toEqual(new Set(["src/a.ts", "logo.png", "new.ts"]));
    expect(inventory({ schema: 1, head: HEAD, base: BASE, filesTruncated: false, fileCount: 1, files: [{ path: "x" }] })).toEqual(new Set(["x"]));
    for (const [name, bad] of Object.entries({
      cut: { ...stat, filesTruncated: true }, otherHead: { ...stat, head: BASE }, otherSchema: { ...stat, schema: 2 }, miscounted: { ...stat, fileCount: 2 },
      twice: { ...stat, files: [files[0], files[0], files[1]] }, pathless: { ...stat, files: [null, files[1], files[2]] }, notJson: "{", nothing: "null",
    })) expect(inventory(bad), name).toBeNull();
  });
});
