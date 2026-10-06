import { describe, expect, it } from "vitest";
import { isRetentionKind, parsePeriod } from "../retention.js";
import { parseContract } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { retentionPeriodsSchema, retentionRowSchema } from "./retention.js";

const verdict = (input: unknown): SampleVerdict => {
  const parsed = parseContract(retentionPeriodsSchema, input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

describe("the retention settings contract", () => {
  it("holds: the JSON Schema round trip loses nothing, periods of 1 to 3650 days or forever read, others are refused by kind", () => {
    const forever = { evidence: null, checkouts: null, chat: null, notifications: null };
    assertContract({
      schema: retentionPeriodsSchema,
      read: verdict,
      valid: [
        { name: "the defaults", input: { ...forever, evidence: 28 } },
        { name: "the bounds, with an extra key ignored", input: { evidence: 1, checkouts: 3650, chat: 90, notifications: null, later: 5 } },
      ],
      invalid: [
        { name: "zero days", input: { ...forever, evidence: 0 }, paths: ["evidence"] },
        { name: "over ten years", input: { ...forever, chat: 3651 }, paths: ["chat"] },
        { name: "part days", input: { ...forever, checkouts: 1.5 }, paths: ["checkouts"] },
        { name: "a missing kind", input: { evidence: 28, checkouts: null, chat: null }, paths: ["notifications"] },
      ],
    });
    expect(retentionRowSchema.safeParse({ kind: "chat", days: null, updated_by: "someone" }).success).toBe(true);
  });

  it("reads typed periods and kinds as before", () => {
    expect(["forever", " Never ", "1d", "90", "12w", "10y", "3650"].map(parsePeriod)).toEqual([null, null, 1, 90, 84, 3650, 3650]);
    expect(["0", "11y", "3651", "1.5", "", "d"].map(parsePeriod)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(["evidence", "notifications", "Evidence", "constructor", "toString"].map(isRetentionKind)).toEqual([true, true, false, false, false]);
  });
});
