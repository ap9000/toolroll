import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonUndefinedAsNull } from "./canonical-json.js";
import { unattendedTermsJson, type UnattendedTerms } from "./flow-unattended.js";
import { toolDigest } from "./project-tools.js";
import { CHAIN_DIGEST_VERSION, PROFILE_DIGEST_VERSION, canonicalChainJson, canonicalProfileJson, type ChainEntry, type ExecutionProfile } from "./scope.js";
import { PHASES, canonicalOverridesJson, canonicalRouteJson, type PhaseRoute, type RouteOverride } from "./phase-routing.js";
import { modeTermsJson, type ModeTerms } from "./modes.js";
import { canonicalContractJson } from "./planner-source.js";
import type { ToolSpec } from "./contracts/integration-metadata.js";

// ---- oracles: the seven private copies exactly as they stood before they were shared -------------------------------
// These bytes are sealed into stored approvals and digests; every shared call must reproduce them for every input.

function flowUnattendedCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flowUnattendedCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${flowUnattendedCanonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function projectToolsCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(projectToolsCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${projectToolsCanonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scopeCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(scopeCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${scopeCanonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function phaseRoutingCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(phaseRoutingCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${phaseRoutingCanonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function modesCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(modesCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${modesCanonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function plannerCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(plannerCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const body = value as Record<string, unknown>;
    return `{${Object.keys(body)
      .sort()
      .map(key => `${JSON.stringify(key)}:${plannerCanonicalJson(body[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function plannerSourceCanonicalContractJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(plannerSourceCanonicalContractJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const body = value as Record<string, unknown>;
    return `{${Object.keys(body)
      .sort()
      .map(key => `${JSON.stringify(key)}:${plannerSourceCanonicalContractJson(body[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---- a seeded generator of awkward values ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["", "a", "A", "b", "B", "aa", "a b", "10", "2", "-1", "é", "é", "ß", "日本", "😀", "\ud83d", "\u0000", "\n", "\"", "\\", "__proto__", "constructor", "toString", "Z", "z", "version", "digestVersion"];
const NUMBERS = [0, -0, 1, -1, 1e21, 1e-7, 1.5, -2.25, 2 ** 53, -(2 ** 53) - 2, Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity, -Infinity, 123456789.123];
const STRINGS = ["", "x", "héllo", "😀", "\ud800", "  ", "tab\there", "quote\"", "back\\slash", "<script>", "\u0000\u001f"];

function value(rand: () => number, depth: number): unknown {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const roll = rand();
  if (depth <= 0 || roll < 0.45) {
    const leaf = rand();
    if (leaf < 0.12) return undefined;
    if (leaf < 0.22) return null;
    if (leaf < 0.32) return rand() < 0.5;
    if (leaf < 0.6) return rand() < 0.6 ? pick(NUMBERS) : (rand() - 0.5) * 10 ** Math.floor(rand() * 30 - 10);
    if (leaf < 0.95) return rand() < 0.7 ? pick(STRINGS) : pick(KEYS);
    if (leaf < 0.975) return new Date(Math.floor(rand() * 2e12));
    return () => 1;
  }
  if (roll < 0.7) {
    const length = Math.floor(rand() * 5);
    const out: unknown[] = rand() < 0.1 ? new Array(length) : [];
    if (out.length === 0) for (let i = 0; i < length; i++) out.push(value(rand, depth - 1));
    return out;
  }
  const out: Record<string, unknown> = {};
  const size = Math.floor(rand() * 6);
  // Own data properties, "__proto__" included, never a prototype swap.
  for (let i = 0; i < size; i++) Object.defineProperty(out, pick(KEYS), { value: value(rand, depth - 1), enumerable: true, configurable: true, writable: true });
  return out;
}

const SAMPLES = (() => {
  const rand = prng(0x5eed);
  const out: unknown[] = [undefined, null, -0, 1e21, [undefined], [undefined, null], { a: undefined }, { b: 1, a: undefined, "😀": [-0] }, [], {}, new Array(2)];
  for (let i = 0; i < 4000; i++) out.push(value(rand, 4));
  return out;
})();

const objectSamples = SAMPLES.filter((one): one is Record<string, unknown> => one !== null && typeof one === "object" && !Array.isArray(one));
const sha32 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);

describe("canonical JSON keeps every sealed byte", () => {
  it("canonicalJson matches each undefined-dropping copy for every value", () => {
    for (const one of SAMPLES) {
      const got = canonicalJson(one);
      expect(got).toBe(flowUnattendedCanonicalJson(one));
      expect(got).toBe(projectToolsCanonical(one));
      expect(got).toBe(scopeCanonicalJson(one));
      expect(got).toBe(phaseRoutingCanonicalJson(one));
      expect(got).toBe(modesCanonicalJson(one));
    }
  });

  it("canonicalJsonUndefinedAsNull matches the planner copies for every value", () => {
    for (const one of SAMPLES) {
      const got = canonicalJsonUndefinedAsNull(one);
      expect(got).toBe(plannerCanonicalJson(one));
      expect(got).toBe(plannerSourceCanonicalContractJson(one));
      expect(canonicalContractJson(one)).toBe(plannerSourceCanonicalContractJson(one));
    }
  });

  it("the two stay distinct where they always differed", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJsonUndefinedAsNull({ a: undefined, b: 1 })).toBe('{"a":null,"b":1}');
    expect(canonicalJson([undefined, 1])).toBe("[,1]");
    expect(canonicalJsonUndefinedAsNull([undefined, 1])).toBe("[null,1]");
  });

  it("each call site produces its old bytes", () => {
    for (const one of objectSamples) {
      expect(unattendedTermsJson(one as UnattendedTerms)).toBe(flowUnattendedCanonicalJson(one));
      expect(modeTermsJson(one as ModeTerms)).toBe(modesCanonicalJson(one));
      expect(canonicalProfileJson(one as ExecutionProfile)).toBe(scopeCanonicalJson({ digestVersion: PROFILE_DIGEST_VERSION, profile: one }));
      expect(canonicalChainJson([one, one] as unknown as ChainEntry[])).toBe(scopeCanonicalJson({ digestVersion: CHAIN_DIGEST_VERSION, chain: [one, one] }));
      const { about: _about, ...terms } = one;
      expect(toolDigest(one as ToolSpec)).toBe(sha32(`standing-orders:tool:v1:${projectToolsCanonical(terms)}`));
    }
  });

  it("phase routing bytes match for random route fields", () => {
    const rand = prng(0xc0de);
    for (let i = 0; i < 500; i++) {
      const at = () => value(rand, 2);
      const override = (phase: string) => ({ phase, provider: at(), model: at(), by: at(), at: at() }) as unknown as RouteOverride;
      const overrides = [override("review"), override("build"), override("plan")];
      expect(canonicalOverridesJson(overrides)).toBe(phaseRoutingCanonicalJson(
        [...overrides].sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase))
          .map(one => ({ phase: one.phase, provider: one.provider, model: one.model, by: one.by, at: one.at })),
      ));
      const route = {
        version: 1, risk: at(), qualityMode: at(), publication: at(), evidence: ["b", "a"], posture: at(), demands: at(),
        legs: [{ phase: "plan", provider: at(), model: at(), tier: at(), chosen: at(), recommended: at(), reasons: at(), problem: at() }],
        overrides: [],
      } as unknown as PhaseRoute;
      expect(canonicalRouteJson(route)).toBe(phaseRoutingCanonicalJson({
        version: route.version, risk: route.risk, qualityMode: route.qualityMode, publication: route.publication, evidence: ["a", "b"],
        posture: route.posture, demands: route.demands,
        legs: route.legs.map(leg => ({ phase: leg.phase, provider: leg.provider, model: leg.model, tier: leg.tier, chosen: leg.chosen, recommended: leg.recommended, reasons: leg.reasons, problem: leg.problem })),
        overrides: [],
      }));
    }
  });
});
