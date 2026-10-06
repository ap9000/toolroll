import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { discordButtonSchema, discordComponentInteractionSchema, readDiscordButtonToken, readDiscordComponentInteraction } from "./discord-callback.js";

const taps = (JSON.parse(readFileSync(new URL("../../test/fixtures/chat/channel-callbacks.json", import.meta.url), "utf8")) as { discord: Array<{ name: string; body: Record<string, unknown> }> }).discord;

const read = (input: unknown): SampleVerdict => {
  const interaction = readDiscordComponentInteraction(input);
  const token = interaction.ok ? readDiscordButtonToken(interaction.value) : interaction;
  return token.ok ? { ok: true } : { ok: false, lines: token.issues.map(issue => issue.line) };
};
const tap = taps[0]!.body;

describe("a Discord button tap", () => {
  it("holds: round trip, recorded taps read with Discord's other fields ignored, a button Toolroll didn't make is refused by path", () => {
    assertContract({
      schema: discordComponentInteractionSchema,
      read,
      valid: taps.map(one => ({ name: one.name, input: one.body })),
      invalid: [
        { name: "not a component", input: { ...tap, type: 2 }, paths: ["type"] },
        { name: "no message", input: { ...tap, message: undefined }, paths: ["message"] },
      ],
    });
    assertContract({
      schema: discordButtonSchema,
      read,
      valid: [],
      invalid: [
        { name: "another app's button", input: { ...tap, data: { component_type: 2, custom_id: "approve" } }, paths: ["data.custom_id"] },
        { name: "no custom id", input: { ...tap, data: { component_type: 2 } }, paths: ["data.custom_id"] },
      ],
    });
  });

  it("reads the token each recorded tap carried", () => {
    expect(taps.map(one => {
      const interaction = readDiscordComponentInteraction(one.body);
      const token = interaction.ok ? readDiscordButtonToken(interaction.value) : null;
      return token?.ok === true ? token.value : null;
    })).toEqual(["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"]);
  });
});
