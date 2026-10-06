import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { codingHandoffReceiptSchema, parseCodingHandoffReceipt, readCodingHandoffReceipt, type CodingHandoffReceipt } from "./coding-handoff.js";
import { savedHandoff } from "../../test/coding-fixtures.js";

const read = (input: unknown): SampleVerdict => {
  const parsed = readCodingHandoffReceipt(input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

const saved = JSON.parse(savedHandoff.handoff.payload) as CodingHandoffReceipt;
const [first] = saved.acceptance;

describe("the coding handoff receipt contract", () => {
  it("holds: the JSON Schema round trip loses nothing, the saved receipt reads, malformed ones are refused by path", () => {
    assertContract({
      schema: codingHandoffReceiptSchema,
      read,
      valid: [
        { name: "saved by 0.9.36", input: saved },
        { name: "a criterion saved without how", input: { ...saved, acceptance: [{ id: "c1", statement: first!.statement, evidence: ["check"] }] } },
      ],
      invalid: [
        { name: "newer version", input: { ...saved, version: 2 }, paths: ["version"] },
        { name: "receipts always carried a version", input: (({ version: _v, ...rest }) => rest)(saved), paths: ["version"] },
        { name: "strict about unknown keys", input: { ...saved, approved: true }, paths: ["payload"] },
        { name: "missing candidate", input: { ...saved, candidate: undefined }, paths: ["candidate"] },
        { name: "generation is an integer", input: { ...saved, generation: "1" }, paths: ["generation"] },
        { name: "changed paths are strings", input: { ...saved, changedPaths: ["mobile.md", 3] }, paths: ["changedPaths[1]"] },
        { name: "criterion evidence is a known kind", input: { ...saved, acceptance: [{ ...first, evidence: ["vibes"] }] }, paths: ["acceptance[0].evidence[0]"] },
        { name: "criterion is strict", input: { ...saved, acceptance: [{ ...first, signed: true }] }, paths: ["acceptance[0]"] },
      ],
    });
  });

  it("reads the saved bytes exactly: the parsed receipt serializes to the payload it came from", () => {
    const parsed = parseCodingHandoffReceipt(savedHandoff.handoff.payload);
    expect(parsed).toEqual({ ok: true, value: saved });
    if (parsed.ok) expect(JSON.stringify(parsed.value)).toBe(savedHandoff.handoff.payload);
    expect(parseCodingHandoffReceipt("{")).toEqual({ ok: false, issues: [{ path: "payload", kind: "invalid", line: "payload: not JSON" }] });
  });

  it("distinguishes a null candidate from a missing candidate", () => {
    expect(read({ ...saved, candidate: null })).toEqual({ ok: false, lines: ["candidate: must be a string (got null)"] });
    expect(read({ ...saved, candidate: undefined })).toEqual({ ok: false, lines: ["candidate: required"] });
  });
});
