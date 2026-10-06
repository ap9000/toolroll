import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { readTeamsSubmit, teamsSubmitSchema } from "./teams-callback.js";

const taps = (JSON.parse(readFileSync(new URL("../../test/fixtures/chat/channel-callbacks.json", import.meta.url), "utf8")) as { teams: Array<{ name: string; value: unknown }> }).teams;

const read = (input: unknown): SampleVerdict => {
  const token = readTeamsSubmit(input);
  return token.ok ? { ok: true } : { ok: false, lines: token.issues.map(issue => issue.line) };
};

describe("a Teams card's button", () => {
  it("holds: round trip, recorded submits read, data Toolroll didn't make is refused by path", () => {
    assertContract({
      schema: teamsSubmitSchema,
      read,
      valid: taps.map(one => ({ name: one.name, input: one.value })),
      invalid: [
        { name: "a token Toolroll didn't mint", input: { so: "nope" }, paths: ["value.so"] },
        { name: "no token", input: {}, paths: ["value.so"] },
        { name: "Toolroll's data is strict", input: { so: "0123456789abcdef0123456789abcdef", extra: 1 }, paths: ["value"] },
        { name: "not an object", input: "0123456789abcdef0123456789abcdef", paths: ["value"] },
      ],
    });
    expect(readTeamsSubmit(taps[0]!.value)).toEqual({ ok: true, value: "0123456789abcdef0123456789abcdef" });
  });
});
