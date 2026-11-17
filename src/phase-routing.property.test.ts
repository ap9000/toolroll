/**
 * Properties of the route's sealed bytes (phase-routing.ts canonicalRouteJson, canonical-json.ts): the bytes an
 * approval seals don't depend on the order keys were written in, read back to the same bytes, and a classifier's name
 * (`size.by`) is in them only when present, so every route sealed before it existed keeps its digest.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { canonicalJson } from "./canonical-json.js";
import { EVIDENCE_KINDS } from "./contracts/acceptance-terms.js";
import { canonicalRouteJson, recommendRoute, routeDigestOf, routeFromJson, type PhaseRoute, type RouteCandidates, type RouteInput, type TaskSizing } from "./phase-routing.js";
import { PROPERTY, shuffled } from "../test/property.js";

/** The same value with every object's keys written in another order (arrays keep theirs: their order means something). */
function reordered(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((one, at) => reordered(one, seed + at + 1));
  if (value === null || typeof value !== "object") return value;
  const keys = shuffled(Object.keys(value), seed);
  return Object.fromEntries(keys.map((key, at) => [key, reordered((value as Record<string, unknown>)[key], seed * 31 + at + 7)]));
}

const c = (provider: "claude" | "codex", model: string, source = "installation") => ({ provider, model, source });
const candidates: RouteCandidates = {
  plan: { routine: c("claude", "sonnet"), strong: c("claude", "opus", "installation (strong)") },
  build: { routine: c("claude", "sonnet"), strong: c("claude", "opus", "installation (strong)"), light: c("claude", "haiku", "installation (light)") },
  repair: { routine: null, strong: null },
  review: { routine: c("codex", "gpt-5"), strong: null },
};
const sizing: fc.Arbitrary<TaskSizing> = fc.record({
  size: fc.constantFrom("small", "medium", "large"),
  risky: fc.boolean(),
  source: fc.constantFrom("classifier", "heuristic", "person"),
  reason: fc.stringMatching(/^[a-z][a-z ,;]{0,59}$/),
});
const by = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .:/~()_-]{0,40}$/);
const input: fc.Arbitrary<RouteInput> = fc.record({
  qualityMode: fc.constantFrom("default", "strict"),
  evidence: fc.subarray([...EVIDENCE_KINDS]),
  publication: fc.constantFrom("none", "notify", "automerge"),
  size: fc.option(sizing, { nil: null }),
  overrides: fc.subarray(["plan", "build", "review"] as const).chain(phases => fc.tuple(...phases.map(phase =>
    fc.record({ phase: fc.constant(phase), provider: fc.constantFrom("claude", "codex"), model: fc.constantFrom("sonnet", "opus", "gpt-5"), by: fc.constantFrom("alex", "sam"), at: fc.constant("2026-10-04T12:00:00.000Z") })))),
}).map(one => ({ ...one, candidates }) as RouteInput);

/** The bytes as they were before a size could name its classifier (`by`): pinned, so an old seal's digest never moves. */
function bytesBeforeBy(route: PhaseRoute): string {
  return canonicalJson({
    version: route.version, risk: route.risk, qualityMode: route.qualityMode, publication: route.publication, evidence: [...route.evidence].sort(),
    posture: route.posture, demands: route.demands,
    legs: route.legs.map(leg => ({ phase: leg.phase, provider: leg.provider, model: leg.model, tier: leg.tier, chosen: leg.chosen, recommended: leg.recommended, reasons: leg.reasons, problem: leg.problem,
      ...(route.version === 3 && leg.selection !== undefined ? { selection: leg.selection } : {}) })),
    overrides: route.overrides.map(one => ({ phase: one.phase, provider: one.provider, model: one.model, by: one.by, at: one.at })),
    ...(route.version === 1 ? {} : { size: route.size === null ? null : { size: route.size.size, risky: route.size.risky, source: route.size.source, reason: route.size.reason } }),
  });
}

describe("canonical JSON, for any value", () => {
  test("its bytes don't depend on the order keys were written in, and read back to the same bytes", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.integer(), (value, seed) => {
      const bytes = canonicalJson(value);
      expect(canonicalJson(reordered(value, seed))).toBe(bytes);
      expect(canonicalJson(JSON.parse(bytes))).toBe(bytes);
    }), PROPERTY);
  });
});

describe("a route's sealed bytes, for any filing", () => {
  test("the same under any key order, and read back strictly to the same bytes and digest", () => {
    fc.assert(fc.property(input, fc.integer(), (filing, seed) => {
      const route = recommendRoute(filing);
      const bytes = canonicalRouteJson(route);
      expect(canonicalRouteJson(reordered(route, seed) as PhaseRoute)).toBe(bytes);
      expect(routeDigestOf(reordered(route, seed) as PhaseRoute)).toBe(routeDigestOf(route));
      const back = routeFromJson(bytes);
      expect(back).not.toBeNull();
      expect(canonicalRouteJson(back!)).toBe(bytes);
    }), PROPERTY);
  });

  test("a size without a classifier's name keeps the bytes it had before `by` existed (absent or undefined alike); with one, the name is sealed", () => {
    fc.assert(fc.property(input, by, (filing, name) => {
      const route = recommendRoute(filing);
      if (route.size === null) return;
      const { by: _none, ...unnamed } = route.size;
      const without: PhaseRoute = { ...route, size: unnamed };
      expect(canonicalRouteJson(without)).toBe(bytesBeforeBy(without));
      expect(canonicalRouteJson({ ...route, size: { ...unnamed, by: undefined } })).toBe(bytesBeforeBy(without));
      const named: PhaseRoute = { ...route, size: { ...unnamed, by: name } };
      expect(routeDigestOf(named)).not.toBe(routeDigestOf(without));
      expect(routeFromJson(canonicalRouteJson(named))?.size?.by).toBe(name);
      expect(routeDigestOf(routeFromJson(canonicalRouteJson(named))!)).toBe(routeDigestOf(named));
    }), PROPERTY);
  });
});
