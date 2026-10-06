import { describe, expect, it } from "vitest";
import { isProviderId, validateSpec, validModelId } from "../provider.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { agentSpecSchema } from "./provider.js";

const verdict = (input: unknown): SampleVerdict => {
  const checked = validateSpec(input as never);
  return checked.ok ? { ok: true } : { ok: false, lines: [checked.problem] };
};

describe("the agent spec contract", () => {
  it("holds: the JSON Schema round trip loses nothing, and each refusal names provider or model", () => {
    assertContract({
      schema: agentSpecSchema,
      read: verdict,
      valid: [
        { name: "a harness default", input: { provider: "claude", model: null } },
        { name: "an OpenRouter model", input: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" } },
        { name: "a Gemini model", input: { provider: "gemini", model: "gemini-2.5-flash" } },
      ],
      invalid: [
        { name: "an unknown provider", input: { provider: "bard", model: null }, paths: ["provider"] },
        { name: "a leading dash", input: { provider: "codex", model: "-x" }, paths: ["model"] },
        { name: "OpenRouter without a model", input: { provider: "openrouter", model: null }, paths: ["model"] },
        { name: "Gemini without a model", input: { provider: "gemini", model: null }, paths: ["model"] },
      ],
    });
  });

  it("never repeats a pasted credential in a refusal", () => {
    for (const spec of [{ provider: "sk-ant-api03-SENTINEL", model: null }, { provider: "codex", model: "sk-or-v1 SENTINEL" }]) {
      const checked = validateSpec(spec as never);
      expect(checked.ok).toBe(false);
      expect(JSON.stringify(checked)).not.toContain("SENTINEL");
    }
  });

  it("reads ids as before, including an untyped model read as its text", () => {
    expect(["claude", "codex", "openrouter", "gemini", "Claude", "constructor"].map(isProviderId)).toEqual([true, true, true, true, false, false]);
    expect([null, "opus", "a".repeat(128), "a".repeat(129), "", "x y", undefined].map(model => validModelId(model as never))).toEqual([true, true, true, false, false, false, true]);
  });
});
