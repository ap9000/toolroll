import { describe, expect, test } from "vitest";
import { CLAUDE_EXACT } from "./model-catalog.js";
import { agentModelName, modelName } from "./model-names.js";

describe("one name per model", () => {
  test.each([
    ["claude", "claude-opus-5-5", "Claude Opus 5.5"],
    ["claude", "claude-sonnet-5-5", "Claude Sonnet 5.5"],
    [null, "claude-haiku-5-5", "Claude Haiku 5.5"],
    ["claude", "claude-opus-4-1", "Claude Opus 4.1"],
    ["claude", "opus", "Claude Opus"],
    ["anthropic-api", "sonnet", "Claude Sonnet"],
    // An id it doesn't know stays the id, whoever runs it.
    ["codex", "gpt-5.5-codex", "gpt-5.5-codex"],
    ["codex", "opus", "opus"],
    ["openrouter", "anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5"],
    ["claude", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-latest"],
    ["claude", null, "the default model"],
    ["claude", "default", "the default model"],
  ] as const)("%s %s → %s", (provider, id, name) => {
    expect(modelName(provider, id)).toBe(name);
  });

  test("the Models editor's labels are the names", () => {
    for (const one of CLAUDE_EXACT) expect(modelName("claude", one.value)).toBe(one.label);
  });

  test.each([
    ["claude", "claude-opus-5-5", "Claude Opus 5.5"],
    ["claude", null, "Claude"],
    ["codex", "gpt-5.5", "Codex · gpt-5.5"],
    ["gemini", "gemini-2.5-pro", "Gemini · gemini-2.5-pro"],
  ] as const)("with its agent: %s %s → %s", (provider, id, name) => {
    expect(agentModelName(provider, id)).toBe(name);
  });
});
