import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { readSlackBlockActions, readSlackButton, slackBlockActionsSchema, slackButtonSchema } from "./slack-callback.js";

const taps = (JSON.parse(readFileSync(new URL("../../test/fixtures/chat/channel-callbacks.json", import.meta.url), "utf8")) as { slack: Array<{ name: string; body: Record<string, unknown> }> }).slack;

const read = (input: unknown): SampleVerdict => {
  const interaction = readSlackBlockActions(input);
  const button = interaction.ok ? readSlackButton(interaction.value) : interaction;
  return button.ok ? { ok: true } : { ok: false, lines: button.issues.map(issue => issue.line) };
};
const tap = taps[0]!.body;
const action = (tap["actions"] as Array<Record<string, unknown>>)[0]!;

describe("a Slack button tap", () => {
  it("holds: round trip, recorded taps read with Slack's other fields ignored, a button Toolroll didn't make is refused by path", () => {
    assertContract({ schema: slackBlockActionsSchema, read, valid: taps.map(one => ({ name: one.name, input: one.body })), invalid: [{ name: "not a message's button", input: { ...tap, container: undefined }, paths: ["container"] }] });
    assertContract({
      schema: slackButtonSchema,
      read,
      valid: [],
      invalid: [
        { name: "a token Toolroll didn't mint", input: { ...tap, actions: [{ ...action, value: "nope" }] }, paths: ["actions[0].value"] },
        { name: "another app's button", input: { ...tap, actions: [{ ...action, action_id: "approve_all" }] }, paths: ["actions[0].action_id"] },
        { name: "two buttons at once", input: { ...tap, actions: [action, action] }, paths: ["actions"] },
        { name: "no time", input: { ...tap, actions: [{ ...action, action_ts: undefined }] }, paths: ["actions[0].action_ts"] },
      ],
    });
  });

  it("reads the token each recorded tap carried", () => {
    const tokens = taps.map(one => {
      const interaction = readSlackBlockActions(one.body);
      const button = interaction.ok ? readSlackButton(interaction.value) : null;
      return button?.ok === true ? button.value.value : null;
    });
    expect(tokens).toEqual(["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"]);
  });
});
