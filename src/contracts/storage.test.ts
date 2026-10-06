import { describe, expect, it } from "vitest";
import { CLEANUP_CHOICES, parseCleanup } from "../storage.js";
import { parseContract } from "./contract.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { checkoutCleanupRowSchema, checkoutCleanupSchema } from "./storage.js";

const verdict = (input: unknown): SampleVerdict => {
  const parsed = parseContract(checkoutCleanupRowSchema, input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

describe("the checkout cleanup contract", () => {
  it("holds: the JSON Schema round trip loses nothing, the four saved values read, anything else is refused by field", () => {
    assertContract({
      schema: checkoutCleanupRowSchema,
      read: verdict,
      valid: checkoutCleanupSchema.options.map(cleanup => ({ name: cleanup, input: { id: 1, cleanup, updated_by: "someone" } })),
      invalid: [
        { name: "a word for a value", input: { cleanup: "week" }, paths: ["cleanup"] },
        { name: "no value", input: {}, paths: ["cleanup"] },
      ],
    });
    expect(CLEANUP_CHOICES.map(one => one.value)).toEqual(checkoutCleanupSchema.options);
  });

  it("reads typed words as before", () => {
    expect(["finished", " Done ", "0d", "2", "2  days", "7days", "A Week", "1w", "never", "OFF"].map(parseCleanup))
      .toEqual(["finished", "finished", "finished", "2d", "2d", "7d", "7d", "7d", "never", "never"]);
    expect(["", "on", "3d", "constructor"].map(parseCleanup)).toEqual([undefined, undefined, undefined, undefined]);
  });
});
