import { describe, expect, it } from "vitest";
import { canonicalRouteJson, overridesFromJson, parseSizing, routeFromJson, routeJsonProblem } from "../phase-routing.js";
import { TEXT_LIMITS } from "../text-limits.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import { readRouteOverrides, readSealedRoute, routeOverrideSchema, sealedRouteSchema, taskSizingSchema } from "./route.js";
import { scopeFixtures } from "../../test/scope-replay.js";

const { rows } = scopeFixtures();

const verdict = (read: { ok: true } | { ok: false; issues: readonly { line: string }[] }): SampleVerdict => (read.ok ? { ok: true } : { ok: false, lines: read.issues.map(one => one.line) });
const routeRead = (input: unknown): SampleVerdict => verdict(readSealedRoute(input));

const savedRoutes = rows.task_scope.flatMap(row =>
  ["proposed_route_json", "approved_route_json", "route_json"].flatMap(column =>
    typeof row[column] === "string" ? [{ name: `${String(row["task_id"] ?? row["id"])} ${column}`, json: String(row[column]) }] : [],
  ),
);
const v1 = JSON.parse(savedRoutes.find(one => one.name.startsWith("v47/"))!.json) as Record<string, unknown> & { legs: Record<string, unknown>[] };
const v2 = JSON.parse(savedRoutes.find(one => one.name === "current/cur-small proposed_route_json")!.json) as Record<string, unknown> & { legs: Record<string, unknown>[]; size: unknown };
const override = { phase: "plan", provider: "claude", model: "claude-opus-4-1", by: "approver-one", at: "2026-09-20T12:00:00.000Z" };
const leg = (route: typeof v2, index: number, change: Record<string, unknown>) => ({ ...route, legs: route.legs.map((one, at) => (at === index ? { ...one, ...change } : one)) });

describe("the sealed route contract", () => {
  it("holds: the round trip loses nothing, every saved route reads in its version, malformed ones are refused by path", () => {
    expect(savedRoutes.length).toBe(20);
    expect(v1["version"]).toBe(1);
    expect(v2["size"]).toMatchObject({ size: "small" });
    assertContract({
      schema: sealedRouteSchema,
      read: routeRead,
      valid: [
        ...savedRoutes.map(one => ({ name: one.name, input: JSON.parse(one.json) as unknown })),
        { name: "overrides in any order", input: { ...v2, overrides: [{ ...override, phase: "build" }, override] } },
        { name: "evidence in any order", input: { ...v2, evidence: ["screenshot", "check"] } },
      ],
      invalid: [
        { name: "a newer version", input: { ...v2, version: 3 }, paths: ["version"] },
        { name: "no version", input: { ...v2, version: undefined }, paths: ["version"] },
        { name: "an unknown key", input: { ...v2, note: "x" }, paths: ["payload"] },
        { name: "a version 1 route has no size", input: { ...v1, size: null }, paths: ["payload"] },
        { name: "a version 2 route says its size", input: { ...v2, size: undefined }, paths: ["size"] },
        { name: "a light tier in version 1", input: { ...v1, legs: v1.legs.map((one, at) => (at === 1 ? { ...one, tier: "light" } : one)) }, paths: ["legs[1].tier"] },
        { name: "three legs", input: { ...v2, legs: v2.legs.slice(0, 3) }, paths: ["legs"] },
        { name: "legs out of order", input: { ...v2, legs: [v2.legs[1], v2.legs[0], v2.legs[2], v2.legs[3]] }, paths: ["legs[0].phase", "legs[1].phase"] },
        { name: "a model that is not an exact id", input: leg(v2, 1, { model: "-rf" }), paths: ["legs[1].model"] },
        { name: "an unknown provider", input: leg(v2, 0, { provider: "skynet" }), paths: ["legs[0].provider"] },
        { name: "an empty problem", input: leg(v2, 2, { problem: "" }), paths: ["legs[2].problem"] },
        { name: "a posture its legs do not run", input: { ...v2, posture: "strong" }, paths: ["posture"] },
        { name: "two overrides for one phase", input: { ...v2, overrides: [override, override] }, paths: ["overrides[1].phase"] },
        { name: "an override by nobody", input: { ...v2, overrides: [{ ...override, by: "" }] }, paths: ["overrides[0].by"] },
        { name: "a size reason over its limit", input: { ...v2, size: { ...(v2.size as object), reason: "x".repeat(TEXT_LIMITS.sizeReason + 1) } }, paths: ["size.reason"] },
      ],
    });
  });

  it("reads every saved route back to its stored bytes, in its own version", () => {
    for (const one of savedRoutes) {
      const route = routeFromJson(one.json);
      expect(route, one.name).not.toBeNull();
      expect(canonicalRouteJson(route!), one.name).toBe(one.json);
      if (route!.version === 1) expect(route!.size).toBeNull();
    }
  });

  it("refuses with path-named lines, and the scope's refusal carries them", () => {
    expect(routeJsonProblem(JSON.stringify({ ...v2, posture: "strong" }))).toBe('posture: must be "economy": that is what its legs run');
    expect(routeJsonProblem(JSON.stringify({ ...v2, version: 3 }))).toBe("version: made by a newer Toolroll (version 3; this one reads up to 2)");
    expect(routeJsonProblem("{")).toBe("payload: not valid JSON");
    expect(routeFromJson(JSON.stringify(leg(v2, 1, { model: "-rf" })))).toBeNull();
  });

  it("covers the override list and the task size as they are stored on their own", () => {
    assertContract({
      schema: routeOverrideSchema,
      read: input => verdict(readRouteOverrides([input])),
      valid: [{ name: "an override", input: override }],
      invalid: [
        { name: "no attribution time", input: { ...override, at: undefined }, paths: ["overrides[0].at"] },
        { name: "an unknown phase", input: { ...override, phase: "deploy" }, paths: ["overrides[0].phase"] },
      ],
    });
    expect(overridesFromJson(JSON.stringify([{ ...override, phase: "build" }, override]))?.map(one => one.phase)).toEqual(["plan", "build"]);
    expect(overridesFromJson(JSON.stringify([override, override]))).toBeNull();
    expect(overridesFromJson(null)).toEqual([]);
    assertContract({
      schema: taskSizingSchema,
      read: input => (parseSizing(input) === null ? { ok: false, lines: ["payload: not a sizing"] } : { ok: true }),
      valid: [{ name: "a sizing", input: { size: "large", risky: true, source: "person", reason: "" } }],
      invalid: [
        { name: "an unknown size", input: { size: "huge", risky: false, source: "person", reason: "" }, paths: ["payload"] },
        { name: "an extra key", input: { size: "small", risky: false, source: "person", reason: "", by: "x" }, paths: ["payload"] },
      ],
    });
  });
});
