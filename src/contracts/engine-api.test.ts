/**
 * The engine API's one contract (solo-workbench plan A0): the JSON fixtures in test/fixtures/engine-api/ (taken from the
 * console's real answers, paths replaced) parse as their schemas exactly, keys and all, so a Rust client checking the
 * same files checks the same shapes. Every response the contract names has a fixture.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { checkEngineResponse, ENGINE_API_VERSION, ENGINE_RESPONSES, engineContractDigest, engineJsonSchemas, type EngineResponseName } from "./engine-api.js";

const DIR = new URL("../../test/fixtures/engine-api/", import.meta.url);
/** Each fixture file and the response it is. */
const FIXTURES: Record<string, EngineResponseName> = {
  "live-session-window.json": "liveSessionWindow",
  "live-session-window-sub-missing.json": "liveSessionWindow",
  "live-session-window-thread.json": "liveSessionWindow",
  "live-threads.json": "liveThreads",
  "work-rows.json": "workRows",
  "step-cards-just-code.json": "stepCards",
  "step-cards-plan-first.json": "stepCards",
  "step-cards-sent-back.json": "stepCards",
  "step-cards-plan-stopped.json": "stepCards",
  "approval-card.json": "approvalCard",
  "approval-card-problem.json": "approvalCard",
  "result-diff.json": "resultDiff",
  "result-diff-no-result.json": "resultDiff",
  "result-diff-file.json": "resultDiffFile",
  "result-diff-context.json": "resultDiffContext",
  "link-redemption.json": "linkRedemption",
  "refusal.json": "refusal",
  "hello.json": "hello",
  "agents.json": "agents",
  "agents-none-signed-in.json": "agents",
  "models.json": "models",
  "lead-chat.json": "leadChat",
  "work-rows-every-kind.json": "workRows",
  "term-state.json": "termState",
  "term-started.json": "termStarted",
  "term-start-refused.json": "termStarted",
  "automations.json": "automations",
  "automations-every-kind.json": "automations",
  "projects.json": "projects",
};
/** Not a response: every schema as JSON Schema, with the contract's digest (what a client generates its models from). */
const SCHEMAS = "schemas.json";
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, DIR), "utf8"));

describe("the engine API's fixtures", () => {
  test("every file is named, and every response has one", () => {
    expect(readdirSync(DIR).filter(one => one.endsWith(".json") && one !== SCHEMAS).sort()).toEqual(Object.keys(FIXTURES).sort());
    expect([...new Set(Object.values(FIXTURES))].sort()).toEqual(Object.keys(ENGINE_RESPONSES).sort());
  });

  test.each(Object.entries(FIXTURES))("%s parses as %s, nothing dropped", (name, response) => {
    const input = fixture(name);
    const parsed = (ENGINE_RESPONSES[response].schema as z.ZodType).safeParse(input);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    // Strip mode would drop a key the schema doesn't name: the fixture and the schema agree on every key.
    expect(parsed.data).toEqual(input);
  });

  test("another version, a missing field or a wrong type is a disagreement (reported, by path, never by value)", () => {
    const steps = fixture("step-cards-just-code.json") as Record<string, unknown>;
    const lines: string[] = [];
    const report = (route: string, issues: readonly { path: string; kind: string }[]) => { lines.push(`${route} ${issues.map(one => `${one.path} ${one.kind}`).join(",")}`); };
    for (const bad of [{ ...steps, version: ENGINE_API_VERSION + 1 }, { ...steps, cards: [{ key: "plan" }] }, { ...steps, liveRun: "1" }]) {
      expect(checkEngineResponse("stepCards", bad, report)).toBe(bad);
    }
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("Fix t-done");
    const redemption = fixture("link-redemption.json") as Record<string, unknown>;
    expect(ENGINE_RESPONSES.linkRedemption.schema.safeParse({ ...redemption, key: "short" }).success).toBe(false);
  });
});

test("schemas.json is the contract as it is now (ENGINE_WRITE_SCHEMAS=1 rewrites it on purpose)", () => {
  const now = { digest: engineContractDigest(), version: ENGINE_API_VERSION, ...engineJsonSchemas() };
  if (process.env["ENGINE_WRITE_SCHEMAS"] === "1") writeFileSync(new URL(SCHEMAS, DIR), `${JSON.stringify(now, null, 2)}\n`);
  expect(fixture(SCHEMAS)).toEqual(now);
  expect(now.digest).toMatch(/^[0-9a-f]{64}$/);
});
