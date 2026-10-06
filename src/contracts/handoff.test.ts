import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { handoffSchema, parseHandoffArtifact, readHandoffArtifact } from "./handoff.js";
import { evidenceBaseline, evidenceSamples } from "../../test/evidence-replay.js";
import { handoffFixture } from "../../test/handoff-fixture.js";

const read = (input: unknown): SampleVerdict => {
  const parsed = readHandoffArtifact(input);
  return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
};

const current = handoffFixture(7, {
  model: "opus",
  route: { digest: "435a7e21f838c22e6a1537540b1ac85a", phase: "build", provider: "claude", model: "opus", chosen: "recommended" },
  changes: ["src/x.ts: rounded at cent precision"],
  verification: ["npx vitest run src/x.test.ts: pass"],
  followUps: [],
});
const { version: _version, ...fields } = current;
const savedHandoffs = evidenceSamples.flatMap(sample => (sample.handoff === null ? [] : [{ name: `${sample.run}/handoff.json`, input: JSON.parse(sample.handoff) as unknown }]));

describe("the handoff contract", () => {
  it("holds: the JSON Schema round trip loses nothing, saved and current handoffs read, malformed ones are refused by path", () => {
    expect(savedHandoffs).toHaveLength(15);
    assertContract({
      schema: handoffSchema,
      read,
      valid: [
        ...savedHandoffs,
        { name: "current version 1", input: current },
        { name: "schema 1 before routes and lists (M6.10)", input: (({ version: _v, ...old }) => ({ schema: 1, ...old }))(handoffFixture(7)) },
        { name: "schema 1 with a field this version does not know", input: { schema: 1, ...fields, retired: "x" } },
        { name: "no-change, not committed", input: { ...current, outcome: "no-change", committed: false, head: current.base } },
      ],
      invalid: [
        { name: "newer version", input: { ...current, version: 2 }, paths: ["version"] },
        { name: "neither version nor schema 1", input: fields, paths: ["version"] },
        { name: "version 1 is strict", input: { ...current, schema: 1 }, paths: ["payload"] },
        { name: "missing conclusion", input: { ...current, conclusion: undefined }, paths: ["conclusion"] },
        { name: "unknown outcome", input: { ...current, outcome: "failed" }, paths: ["outcome"] },
        { name: "unknown route phase", input: { ...current, route: { ...current.route, phase: "deploy" } }, paths: ["route.phase"] },
        { name: "decision ids are integers", input: { schema: 1, ...fields, decisionsIncorporated: ["13"] }, paths: ["decisionsIncorporated[0]"] },
        { name: "freshness names its head", input: { ...current, freshness: { stampedAt: "2026-10-05T00:00:00.000Z" } }, paths: ["freshness.currentAsOf"] },
      ],
    });
  });

  it("refuses bytes that are not JSON by path", () => {
    expect(parseHandoffArtifact("{")).toEqual({ ok: false, issues: [{ path: "payload", kind: "invalid", line: "payload: not JSON" }] });
  });
});

describe("the replayed evidence samples", () => {
  it("read as before: every field the saved handoff carried, with `schema: 1` read as `version: 1`", () => {
    for (const sample of evidenceSamples) {
      const { schema, ...before } = evidenceBaseline[sample.run]!.handoff!;
      expect(schema, sample.run).toBe(1);
      expect(parseHandoffArtifact(sample.handoff!), sample.run).toEqual({ ok: true, value: { version: 1, ...before } });
    }
  });
});
