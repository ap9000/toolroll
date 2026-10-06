/**
 * A sealed route (phase-routing.ts): which exact agent plans, builds, repairs and reviews a task, as a scope's
 * `proposed_route_json` / `approved_route_json` and a standing order's route keep it. One schema covering both versions
 * a route has been saved in — version 1 (sealed before sizing: no `size`, routine and strong tiers) and version 2 —
 * plus the override list and the task size it carries. The rules JSON Schema cannot state run in plain code after
 * parsing, each with a path-named error: the legs run plan, build, repair, review in that order; the posture is what
 * the legs actually run; one override per phase.
 *
 * Reading never rewrites: a version 1 route stays version 1 (its digest domain and bytes are its own), and reads with
 * no size. phase-routing.ts `canonicalRouteJson` / `routeDigestOf` encode the parsed value, so a sealed route's digest
 * is what it always was.
 */

import { z } from "zod";
import { EVIDENCE_KINDS } from "./acceptance-terms.js";
import { limited, parseContract, versioned, type ContractIssue, type ContractResult } from "./contract.js";

/** The phases a route has a leg for, in the order its legs run. */
export const ROUTE_PHASES = ["plan", "build", "repair", "review"] as const;
/** provider.ts's provider ids, restated (provider.ts sits above phase-routing.ts in the module graph) and pinned to
 * them by the test suite. */
export const ROUTE_PROVIDERS = ["claude", "codex", "openrouter", "gemini"] as const;
/** provider.ts's MODEL_ID, restated for the same reason: an exact model id is argv-safe — no leading dash, no
 * whitespace or control bytes. */
export const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const RISKS = ["routine", "elevated", "high"] as const;
export const TASK_SIZE_WORDS = ["small", "medium", "large"] as const;

/** The route version this code seals; version 1 (before sizing) still reads. */
export const ROUTE_VERSION = 2;

const phase = z.enum(ROUTE_PHASES);
const provider = z.enum(ROUTE_PROVIDERS);
const model = z.string().regex(MODEL_ID_SHAPE, { error: "must be an exact model id: letters, digits and . _ : / -, not starting with a dash" });
const text = z.string().min(1);

/** How big a change the task is, as it was sized (by the classifier, the description, or a person). */
export const taskSizingSchema = z.strictObject({
  size: z.enum(TASK_SIZE_WORDS),
  risky: z.boolean(),
  source: z.enum(["classifier", "heuristic", "person"]),
  reason: limited("size reason", "sizeReason"),
});

/** An approver's explicit per-phase choice, recorded with attribution. */
export const routeOverrideSchema = z.strictObject({ phase, provider, model, by: text, at: text });

function legSchema<const T extends readonly [string, ...string[]]>(tiers: T) {
  const tier = z.enum(tiers);
  return z.strictObject({
    phase,
    provider,
    model,
    tier,
    chosen: z.enum(["recommended", "override", "pinned"]),
    recommended: z.strictObject({ provider, model, tier }),
    reasons: z.array(z.string()),
    problem: text.nullable(),
  });
}

/** One leg of a version 2 route: the light tier exists. */
export const routeLegSchema = legSchema(["light", "routine", "strong"]);

const terms = {
  risk: z.enum(RISKS),
  qualityMode: z.enum(["default", "strict"]),
  publication: z.enum(["none", "notify", "automerge"]),
  evidence: z.array(z.enum(EVIDENCE_KINDS)),
  posture: z.enum(["economy", "strong"]),
  demands: z.array(z.string()),
};

export const sealedRouteV1Schema = versioned(1, {
  ...terms,
  legs: z.array(legSchema(["routine", "strong"])).length(ROUTE_PHASES.length),
  overrides: z.array(routeOverrideSchema),
});

export const sealedRouteV2Schema = versioned(ROUTE_VERSION, {
  ...terms,
  legs: z.array(routeLegSchema).length(ROUTE_PHASES.length),
  overrides: z.array(routeOverrideSchema),
  size: taskSizingSchema.nullable(),
});

/** A sealed route as saved, in either version. */
export const sealedRouteSchema = z.discriminatedUnion("version", [sealedRouteV1Schema, sealedRouteV2Schema]);

export type SealedRoute = z.infer<typeof sealedRouteSchema>;
export type RouteVersion = SealedRoute["version"];
export type RouteLeg = z.infer<typeof routeLegSchema>;
export type RouteOverride = z.infer<typeof routeOverrideSchema>;
export type TaskSizing = z.infer<typeof taskSizingSchema>;
/** A route as every reader returns it: a version 1 route reads with no size. */
export type PhaseRoute = Omit<z.infer<typeof sealedRouteV2Schema>, "version"> & { version: RouteVersion };

/** The posture legs actually run under: strong only when a leg runs a configured strong agent as recommended. */
export function postureOf(legs: readonly Pick<RouteLeg, "chosen" | "tier">[]): "economy" | "strong" {
  return legs.some(leg => leg.chosen === "recommended" && leg.tier === "strong") ? "strong" : "economy";
}

const issue = (path: string, what: string): ContractIssue => ({ path, kind: "bad-value", line: `${path}: ${what}` });

/** Overrides as read: one per phase (a second is named by path), in phase order. */
function overridesOf(overrides: readonly RouteOverride[], at: string): ContractResult<RouteOverride[]> {
  const issues = overrides.flatMap((one, index) =>
    overrides.findIndex(other => other.phase === one.phase) === index ? [] : [issue(`${at}[${index}].phase`, `${JSON.stringify(one.phase)} appears twice`)],
  );
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: [...overrides].sort((a, b) => ROUTE_PHASES.indexOf(a.phase) - ROUTE_PHASES.indexOf(b.phase)) };
}

/** Read a task's recorded override list (a list on its own, as `route_overrides_json` keeps it). */
export function readRouteOverrides(input: unknown): ContractResult<RouteOverride[]> {
  const parsed = parseContract(z.object({ overrides: z.array(routeOverrideSchema) }), { overrides: input });
  return parsed.ok ? overridesOf(parsed.value.overrides, "overrides") : parsed;
}

/** Read a sealed route: either version as itself, every leg, override and the size proved, nothing unknown. */
export function readSealedRoute(input: unknown): ContractResult<PhaseRoute> {
  const version = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["version"] : undefined;
  if (typeof version === "number" && Number.isInteger(version) && version > ROUTE_VERSION) {
    return { ok: false, issues: [{ path: "version", kind: "newer-version", line: `version: made by a newer Toolroll (version ${version}; this one reads up to ${ROUTE_VERSION})` }] };
  }
  const parsed = parseContract(sealedRouteSchema, input);
  if (!parsed.ok) return parsed;
  const route = parsed.value;
  const issues = route.legs.flatMap((leg, index) => (leg.phase === ROUTE_PHASES[index] ? [] : [issue(`legs[${index}].phase`, `must be ${JSON.stringify(ROUTE_PHASES[index])} (legs run plan, build, repair, review)`)]));
  const posture = postureOf(route.legs);
  if (posture !== route.posture) issues.push(issue("posture", `must be ${JSON.stringify(posture)}: that is what its legs run`));
  const overrides = overridesOf(route.overrides, "overrides");
  if (!overrides.ok) issues.push(...overrides.issues);
  if (issues.length > 0 || !overrides.ok) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: route.version,
      risk: route.risk,
      qualityMode: route.qualityMode,
      publication: route.publication,
      evidence: [...route.evidence].sort(),
      posture: route.posture,
      demands: route.demands,
      legs: route.legs,
      overrides: overrides.value,
      size: route.version === 1 ? null : route.size,
    },
  };
}
