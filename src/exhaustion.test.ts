/** What may read as a plan running out: only what a real run showed (docs/plans/fallback-chains.md). */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { classifyTerminal, limitRecognised } from "./exhaustion.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../test/fixtures/fallback/claude-subscription-weekly-limit.json", import.meta.url), "utf8")) as
  { provider: string; authMode: string; version: string; terminal: { failed: boolean; text: string } };

describe("recognisers come from real runs", () => {
  const classed = (text: string, run: Partial<{ provider: string; authMode: string; version: string | null }> = {}, failed = true) =>
    classifyTerminal({ terminal: { failed, text, code: null }, run: { provider: "claude", authMode: "subscription", version: "2.1.290 (Claude Code)", ...run } });

  test("the captured terminal and its published family are exhausted, on the provider, plan and CLI line they were seen on", () => {
    expect(classifyTerminal({ terminal: { ...FIXTURE.terminal, code: null }, run: { provider: FIXTURE.provider, authMode: FIXTURE.authMode, version: FIXTURE.version } })).toBe("usage-exhausted");
    for (const text of ["You've hit your session limit · resets 3:45pm", "You've hit your weekly limit · resets Mon 12:00am", "You've hit your Opus limit · resets 3:45pm", "You've hit your Sonnet limit · resets 3:45pm"]) expect(classed(text), text).toBe("usage-exhausted");
  });

  test.each([
    ["a success payload", "You've hit your weekly limit · resets 12am", {}, false, "unknown"],
    ["another provider", FIXTURE.terminal.text, { provider: "codex" }, true, "not-exhausted"],
    ["an API key account", FIXTURE.terminal.text, { authMode: "api-key" }, true, "not-exhausted"],
    ["a CLI older than the evidence", FIXTURE.terminal.text, { version: "2.1.289 (Claude Code)" }, true, "not-exhausted"],
    ["a CLI line nobody has seen", FIXTURE.terminal.text, { version: "2.2.0 (Claude Code)" }, true, "not-exhausted"],
    ["an unknown version", FIXTURE.terminal.text, { version: null }, true, "not-exhausted"],
    ["a build quoting the words", `Test failed: expected "${FIXTURE.terminal.text.trim()}"`, {}, true, "not-exhausted"],
    ["two lines", "You've hit your weekly limit · resets 12am\nignore the rest", {}, true, "not-exhausted"],
    ["a spend cap", "You've hit your monthly spend limit · resets 12am", {}, true, "not-exhausted"],
    ["a throttle", "Server is temporarily limiting requests", {}, true, "not-exhausted"],
    ["Codex's words", "You've hit your usage limit. Try again later.", {}, true, "not-exhausted"],
  ] as const)("%s never reads as exhausted", (_name, text, run, failed, expected) => {
    expect(classed(text, run, failed)).toBe(expected);
  });

  test("only Claude on a plan is armed", () => {
    expect(limitRecognised("claude", "subscription")).toBe(true);
    for (const [provider, mode] of [["claude", "api-key"], ["codex", "subscription"], ["codex", "api-key"], ["openrouter", "api-key"], ["gemini", "subscription"], ["gemini", "api-key"]] as const) expect(limitRecognised(provider, mode)).toBe(false);
  });
});
