/**
 * Explainable phase routing (v47), sized since v2.
 *
 * WHICH agent plans, builds, repairs, and reviews a task is decided here,
 * once, from signed facts — never guessed from a model's name and never
 * re-decided behind an approval's back. The policy is a small table over
 * explicit inputs:
 *
 *   size         — how big a change the task is (small / medium / large, risky or not)
 *   quality      — the evidence policy the scope signs (default / strict)
 *   evidence     — what the acceptance rubric demands (screenshots, …)
 *   publication  — how far the plane may carry the result unattended
 *   candidates   — the operator's CONFIGURED routine and strong agents
 *   overrides    — an approver's explicit per-phase choice, recorded
 *   pins         — a routine firing's or plan request's pinned pair
 *
 * and its output is one canonical ROUTE: four legs, each with an exact
 * provider AND an exact model id, which tier it came from, whether a
 * person overrode it, and plain-English reasons. The same inputs always
 * yield the same route and the same words — `recommendRoute` is pure, so
 * the surfaces (CLI, task page, chat) render one projection rather than
 * three.
 *
 * EXACTNESS is the law of this module: a candidate, an override, a pin,
 * and every frozen leg name an exact model id — "the harness default"
 * is not a term an approval can bind. A configuration that cannot make a
 * leg exact (no model configured, a cross-provider repair row, gemini on
 * the review phase) becomes a stated PROBLEM on that leg, and the scope
 * files unresolved with those words; nothing is guessed or substituted.
 *
 * Strength is never inferred: "strong" means the operator named a strong
 * candidate for that phase (`config set <phase> --tier strong …`). With
 * none configured, a demanding task still routes to the configured
 * default and SAYS so — and its posture reads as economical, because that
 * is what actually runs. Provider readiness is a runner's observation,
 * not a term — it rides beside the route (ready / unavailable / unknown),
 * it is stated wherever the route is shown, and an unavailable provider
 * is never substituted: admission halts with the reason.
 *
 * Every route carries `risk: "routine"`: the declared risk level was
 * removed in v115 (size does that job), and older sealed routes keep
 * whatever risk they were recommended for, read back exactly.
 *
 * Approval seals the route (`approvedRouteJson`); its digest folds into
 * the scope digest of EVERY route filed since v47 — routine-shaped routes
 * included — so a task-level route edit stales the approval exactly as a
 * goal edit does, while a global configuration change can never rewrite a
 * sealed route. Only a row proven to predate v47 (no route era) reads as
 * a legacy approval governed by its sealed profile alone.
 */

import { createHash } from "node:crypto";
import type { EvidenceKind } from "./contracts/acceptance-terms.js";
import {
  MODEL_ID_SHAPE,
  postureOf,
  readRouteOverrides,
  readSealedRoute,
  RISKS,
  ROUTE_PHASES,
  ROUTE_PROVIDERS,
  ROUTE_VERSION,
  TASK_SIZE_WORDS,
  taskSizingSchema,
  type PhaseRoute,
  type RouteLeg,
  type RouteOverride,
  type RouteVersion,
  type TaskSizing,
} from "./contracts/route.js";
import type { Phase, ProviderId } from "./provider.js";
import type { QualityMode } from "./quality.js";

/** The sealed route's shape is its contract (contracts/route.ts); these are its types. */
export type { PhaseRoute, RouteLeg, RouteOverride, RouteVersion, TaskSizing };
export { MODEL_ID_SHAPE };

// Type-only imports from provider.ts: it sits under evidence.ts and scope.ts
// in the module graph, and this policy is imported by scope.ts — a value
// import would be a cycle at load time. The route contract restates the id
// list, pinned to provider.ts's by the test suite.
export const PROVIDER_ID_LIST: readonly ProviderId[] = ROUTE_PROVIDERS;
function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_ID_LIST as readonly string[]).includes(value);
}
function exactModel(v: unknown): v is string {
  return typeof v === "string" && MODEL_ID_SHAPE.test(v);
}
/** The same exactness for callers outside this policy (the profile
 * rehydrator): one shape, one definition. */
export function exactModelId(v: unknown): v is string {
  return exactModel(v);
}

/** v2 adds the task's size (small / medium / large, risky or not), the
 * light tier, and plan headroom. A v1 route — sealed before sizing — still
 * reads back exactly and keeps its own digest domain. */
export { ROUTE_VERSION };
/** The durable route ERA a scope row carries once it was filed under this
 * policy: NULL on a row proven to predate v47 (legacy — the sealed profile
 * alone governs), this value on every row filed since. A row with an era
 * and no readable route is corrupt and fails closed. The era marks a ROUTED
 * row; which route version it holds rides in the snapshot itself. */
export const ROUTE_ERA = 1;
export const PHASES: readonly Phase[] = ROUTE_PHASES;
/** The review leg remains readable in signed history but is no longer scheduled. */
export const ACTIVE_PHASES: readonly Phase[] = ["plan", "build", "repair"];

/** The risk words a route sealed before v115 may carry (history); every route since says `routine`. */
export type RiskLevel = (typeof RISKS)[number];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return value === "routine" || value === "elevated" || value === "high";
}

/** How big a change the task is, sized once at filing (by the classifier,
 * by the description when it cannot answer, or by a person). */
export type TaskSize = TaskSizing["size"];
export const TASK_SIZES: readonly TaskSize[] = TASK_SIZE_WORDS;
export type SizeSource = TaskSizing["source"];

export function isTaskSize(value: unknown): value is TaskSize {
  return value === "small" || value === "medium" || value === "large";
}

/** Whether a task makes no plan: a small change that is not risky (on an
 * older route sealed at elevated or high risk, it always planned). */
export function makesNoPlan(size: TaskSizing | null | undefined, risk: RiskLevel): boolean {
  return size != null && size.size === "small" && !size.risky && risk === "routine";
}

/** Where a size came from, in words. */
export function sizeSourceWords(source: SizeSource): string {
  return source === "classifier" ? "sized automatically" : source === "person" ? "set by a person" : "sized from the description";
}

/** Strict read of a stored sizing (the route contract's): exact keys, known words, bounded reason. */
export function parseSizing(raw: unknown): TaskSizing | null {
  const parsed = taskSizingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function riskTitle(risk: RiskLevel): string {
  return risk === "high" ? "High risk" : risk === "elevated" ? "Elevated risk" : "Routine";
}

/** A runner's non-spending observation of one provider. `unknown` is a
 * real answer (claude has no login probe that does not spend) and is never
 * upgraded to ready. */
export type ReadinessState = "ready" | "unavailable" | "unknown";

export type ReadinessObservation = {
  provider: ProviderId;
  state: ReadinessState;
  /** The probe's own words: "not logged in", "`codex` is not installed"… */
  reason: string;
  /** Which non-spending check produced this: version, identity, key, none. */
  probe: string;
  observedAt: string;
  runner: string;
};

export type CandidateTier = "light" | "routine" | "strong";
const TIER_RANK: Record<CandidateTier, number> = { light: 0, routine: 1, strong: 2 };

/** An exact agent: provider and model id, both required. */
export type ExactSpec = { provider: ProviderId; model: string };

export type RouteCandidate = ExactSpec & {
  /** Where the candidate was read from — provenance words, never a term. */
  source: string;
};

export type PhaseCandidates = {
  /** The operator's named LIGHT (fast) builder (`config set build --tier
   * light …`), or null/absent when none is configured. A small change
   * builds on it. Never inferred; the plan phase has none (a small change
   * makes no plan). */
  light?: RouteCandidate | null;
  routine: RouteCandidate;
  /** The operator's named strong agent for this phase, or null when none
   * is configured. Never inferred. */
  strong: RouteCandidate | null;
  /** v2: a tier may hold one more candidate per OTHER provider (`config
   * set <phase> [--tier …] --also --provider … --model …`) — e.g. a
   * routine builder on claude and on codex. At filing the one whose
   * provider has more plan room runs. Each list holds providers other
   * than its tier's own candidate, at most one each. */
  alternates?: Partial<Record<CandidateTier, readonly RouteCandidate[]>>;
};

/** The repair phase's candidates: with no repair row configured the
 * routine candidate is null and the leg INHERITS the build leg's exact
 * pair (repairs resume the builder's session). */
export type RepairCandidates = {
  routine: RouteCandidate | null;
  strong: RouteCandidate | null;
};

export type RouteCandidates = {
  plan: PhaseCandidates;
  build: PhaseCandidates;
  repair: RepairCandidates;
  review: PhaseCandidates;
};

/** The evidence kinds an acceptance rubric demands — `scope.ts` owns the
 * full type; the policy only needs the names. */
export type RouteEvidenceKind = EvidenceKind;

/** How far the plane may carry a result without a person: no publication
 * grant at all, a grant whose merges wait for a human (notify), or a live
 * mode that merges by itself (automerge). */
export type PublicationAuthority = "none" | "notify" | "automerge";

/** How much of one provider's plan is used, as it last said: the 5-hour
 * window and the weekly window, in percent; null when unknown. */
export type ProviderRoom = { provider: ProviderId; fiveHour: number | null; weekly: number | null };
/** Above these a provider has no headroom: even a candidate one tier
 * stronger on another provider takes the phase. Below them, a tier's
 * candidates on different providers still go to the one with more room. */
export const HEADROOM_FIVE_HOUR_LIMIT = 80;
export const HEADROOM_WEEKLY_LIMIT = 90;

/** The latest plan-window readings as headroom: a window whose reset time
 * has passed counts as empty; a reading older than its own window is
 * unknown. Weekly is the plan-wide week (`seven_day`), else the fullest
 * model-specific week. */
export function headroomFrom(
  limits: readonly { provider: string; window: string; usedPercent: number; windowMinutes: number | null; resetsAt: string | null; observedAt: string }[],
  now: Date,
): ProviderRoom[] {
  const out = new Map<ProviderId, ProviderRoom>();
  const value = (one: (typeof limits)[number]): number | null => {
    if (one.resetsAt !== null && Date.parse(one.resetsAt) <= now.getTime()) return 0;
    const age = now.getTime() - Date.parse(one.observedAt);
    if (!Number.isFinite(age) || (one.windowMinutes !== null && age > one.windowMinutes * 60_000)) return null;
    return one.usedPercent;
  };
  for (const one of limits) {
    if (!isProviderId(one.provider)) continue;
    const room = out.get(one.provider) ?? { provider: one.provider, fiveHour: null, weekly: null };
    const used = value(one);
    if (one.window === "five_hour") room.fiveHour = used;
    else if (one.window === "seven_day") room.weekly = used;
    else if (/^seven_day_/.test(one.window) && used !== null && room.weekly === null) room.weekly = used;
    out.set(one.provider, room);
  }
  // A plan-wide week beats a model's week: re-read seven_day last.
  for (const one of limits) if (isProviderId(one.provider) && one.window === "seven_day") out.get(one.provider)!.weekly = value(one);
  return [...out.values()].sort((a, b) => PROVIDER_ID_LIST.indexOf(a.provider) - PROVIDER_ID_LIST.indexOf(b.provider));
}

function tightWords(room: ProviderRoom): string | null {
  if (room.fiveHour !== null && room.fiveHour > HEADROOM_FIVE_HOUR_LIMIT) return `${room.provider} has used ${room.fiveHour}% of its 5-hour window`;
  if (room.weekly !== null && room.weekly > HEADROOM_WEEKLY_LIMIT) return `${room.provider} has used ${room.weekly}% of its weekly window`;
  return null;
}
function usedOf(room: ProviderRoom): number {
  return Math.max(room.fiveHour ?? 0, room.weekly ?? 0);
}

export type RouteInput = {
  qualityMode: QualityMode;
  evidence: readonly RouteEvidenceKind[];
  publication: PublicationAuthority;
  candidates: RouteCandidates;
  overrides: readonly RouteOverride[];
  /** Pinned exact pairs beat everything: a routine firing's build pin, a
   * plan request's plan pin, and — when an explicit approved profile files
   * the scope — its repair model on the build provider. */
  pins?: { plan?: ExactSpec | null; build?: ExactSpec | null; repair?: ExactSpec | null };
  /** How big the change is (v2): small builds on the light tier with no
   * plan; large or risky plans and builds on the strong tier. */
  size?: TaskSizing | null;
  /** Each provider's plan headroom at filing (v2): when a tier has
   * candidates on more than one provider, the one with more room runs; a
   * provider past its limits gives way even to a stronger tier. */
  headroom?: readonly ProviderRoom[];
};

const PHASE_NOUN: Record<Phase, string> = { plan: "planner", build: "builder", repair: "repair", review: "reviewer" };
const PHASE_VERB: Record<Phase, string> = { plan: "plans", build: "builds", repair: "repairs", review: "reviews" };

export function specWords(spec: { provider: string; model: string }): string {
  return `${spec.provider} · ${spec.model}`;
}

/**
 * THE TIERING TABLE. Each row is one signed fact and the phases it pushes
 * to the strong tier, with the sentence the route says for it. Order is
 * the order the reasons print in — stable by construction.
 */
type Demand = { when: (input: RouteInput) => boolean; phases: readonly Phase[]; reason: string };

const DEMANDS: readonly Demand[] = [
  {
    when: input => input.size?.size === "large",
    phases: ["plan", "build", "repair"],
    reason: "a large change — planning and building use the strongest configured agent",
  },
  {
    when: input => input.size?.risky === true,
    phases: ["plan", "build", "repair"],
    reason: "a risky change — planning and building use the strongest configured agent",
  },
  {
    when: input => input.qualityMode === "strict",
    phases: ["plan", "build", "repair", "review"],
    reason: "quality is strict / release — every role uses the strongest configured agent",
  },
  {
    when: input => input.evidence.includes("screenshot"),
    phases: ["build", "repair", "review"],
    reason: "acceptance requires screenshots — visual proof gets the strongest configured builder and reviewer",
  },
  {
    when: input => input.evidence.includes("manual-review"),
    phases: ["review"],
    reason: "acceptance asks for manual review — the strongest configured reviewer prepares it",
  },
  {
    when: input => input.publication === "automerge",
    phases: ["review"],
    reason: "a live mode merges by itself — the review is the last gate, so it runs on the strongest configured reviewer",
  },
];

function demandedTier(input: RouteInput, phase: Phase): { tier: CandidateTier; reasons: string[] } {
  const reasons = DEMANDS.filter(one => one.when(input) && one.phases.includes(phase)).map(one => one.reason);
  return reasons.length === 0 ? { tier: "routine", reasons: [] } : { tier: "strong", reasons };
}

function economyReason(input: RouteInput, phase: Phase): string {
  const facts = [
    // Said as it always was, so a route's words (and its digest) stay the same.
    "risk is routine",
    `quality is ${input.qualityMode === "strict" ? "strict" : "default"}`,
    ...(input.publication === "notify" ? ["publication waits for a person"] : []),
  ];
  return `${facts.join(", ")} — the configured ${PHASE_NOUN[phase]} is economical enough`;
}

function reviewProblem(spec: { provider: string }): string | null {
  return spec.provider === "gemini"
    ? "gemini has no isolation posture for the review phase yet — configure or override the reviewer to claude or codex"
    : null;
}

/**
 * The recommendation: pure, deterministic, table-driven. Same inputs,
 * same route, same words. Every leg it returns is exact; a leg the
 * configuration cannot make runnable carries a `problem` instead of a
 * guess.
 */
export function recommendRoute(input: RouteInput): PhaseRoute {
  const demands = DEMANDS.filter(one => one.when(input)).map(one => one.reason);
  const overrides = [...input.overrides]
    .filter(one => PHASES.includes(one.phase))
    .sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
  const overrideFor = (phase: Phase): RouteOverride | null => overrides.find(one => one.phase === phase) ?? null;

  const legs: RouteLeg[] = [];
  const small = input.size?.size === "small";
  const pick = (phase: "plan" | "build" | "review"): { spec: RouteCandidate; tier: CandidateTier; reasons: string[]; moved: boolean } => {
    const chosen = pickTier(phase);
    return phase === "review" ? { ...chosen, moved: false } : withHeadroom(input, phase, chosen);
  };
  const pickTier = (phase: "plan" | "build" | "review"): { spec: RouteCandidate; tier: CandidateTier; reasons: string[] } => {
    const demanded = demandedTier(input, phase);
    const candidates = input.candidates[phase];
    if (demanded.tier === "routine" && small && phase === "build") {
      const light = candidates.light ?? null;
      if (light !== null) return { spec: light, tier: "light", reasons: ["small change — a fast model builds it and no plan is made", `light builder from ${light.source}`] };
      return { spec: candidates.routine, tier: "routine", reasons: ["small change — no plan is made; no light builder is configured, so the configured builder runs it", `configured builder from ${candidates.routine.source}`] };
    }
    if (demanded.tier === "routine" && small && phase === "plan") {
      return { spec: candidates.routine, tier: "routine", reasons: ["small change — no plan is made", `configured planner from ${candidates.routine.source}`] };
    }
    if (demanded.tier === "strong") {
      if (candidates.strong !== null) {
        return { spec: candidates.strong, tier: "strong", reasons: [...demanded.reasons, `strong ${PHASE_NOUN[phase]} from ${candidates.strong.source}`] };
      }
      return {
        spec: candidates.routine,
        tier: "routine",
        reasons: [
          ...demanded.reasons,
          `no stronger ${PHASE_NOUN[phase]} is configured — using the configured default from ${candidates.routine.source}`,
        ],
      };
    }
    return { spec: candidates.routine, tier: "routine", reasons: [economyReason(input, phase), `configured ${PHASE_NOUN[phase]} from ${candidates.routine.source}`] };
  };

  // plan — pin > override > recommendation.
  {
    const rec = pick("plan");
    const pin = input.pins?.plan ?? null;
    const override = overrideFor("plan");
    const recommended = { provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier };
    if (pin !== null) {
      legs.push({ phase: "plan", provider: pin.provider, model: pin.model, tier: rec.tier, chosen: "pinned", recommended, reasons: [`pinned to ${specWords(pin)} by the plan request — nothing overrides a pin`], problem: null });
    } else if (override !== null) {
      legs.push({ phase: "plan", provider: override.provider, model: override.model, tier: rec.tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords(rec.spec)})`], problem: null });
    } else {
      legs.push({ phase: "plan", provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier, chosen: "recommended", recommended, reasons: rec.reasons, problem: null });
    }
  }

  // build — pin > override > recommendation.
  let buildMoved = false;
  const build = (() => {
    const rec = pick("build");
    buildMoved = rec.moved;
    const pin = input.pins?.build ?? null;
    const override = overrideFor("build");
    const recommended = { provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier };
    if (pin !== null || override !== null) buildMoved = false;
    const leg: RouteLeg =
      pin !== null
        ? { phase: "build", provider: pin.provider, model: pin.model, tier: rec.tier, chosen: "pinned", recommended, reasons: [`pinned to ${specWords(pin)} by the firing that filed this task — nothing overrides a pin`], problem: null }
        : override !== null
          ? { phase: "build", provider: override.provider, model: override.model, tier: rec.tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords(rec.spec)})`], problem: null }
          : { phase: "build", provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier, chosen: "recommended", recommended, reasons: rec.reasons, problem: null };
    legs.push(leg);
    return leg;
  })();

  // repair — ALWAYS the build provider (repair resumes the builder's
  // session; cross-provider repair does not exist). Only the model routes:
  // the same-provider strong row when demanded, else the same-provider
  // configured row, else the build's own exact model (inherit). A
  // configured row on ANOTHER provider is a stated problem, never skipped.
  {
    const demanded = demandedTier(input, "repair");
    const candidates = input.candidates.repair;
    const override = overrideFor("repair");
    let model: string;
    let tier: CandidateTier;
    let reasons: string[];
    let problem: string | null = null;
    // A build moved to another provider for headroom takes its repairs
    // with it: repair rows on the provider it left cannot resume its session.
    const usedRow = demanded.tier === "strong" && candidates.strong !== null ? candidates.strong : candidates.routine;
    if (buildMoved && usedRow !== null && usedRow.provider !== build.provider) {
      model = build.model;
      tier = "routine";
      reasons = [`the build moved to ${build.provider} for plan headroom — repairs resume its session with the build model (${build.model})`];
    } else if (demanded.tier === "strong" && candidates.strong !== null) {
      if (candidates.strong.provider === build.provider) {
        model = candidates.strong.model;
        tier = "strong";
        reasons = [...demanded.reasons, `strong repair model from ${candidates.strong.source}`];
      } else {
        model = build.model;
        tier = "routine";
        reasons = [...demanded.reasons, `the strong repair agent runs ${candidates.strong.provider}, not the build's ${build.provider}`];
        problem = `the strong repair agent runs ${candidates.strong.provider} but the build runs ${build.provider} — cross-provider repair does not exist; override the repair phase on ${build.provider} or fix \`config set repair --tier strong\``;
      }
    } else if (candidates.routine !== null) {
      if (candidates.routine.provider === build.provider) {
        model = candidates.routine.model;
        tier = "routine";
        reasons =
          demanded.tier === "strong"
            ? [...demanded.reasons, `no stronger repair model is configured — using the configured repair model from ${candidates.routine.source}`]
            : [economyReason(input, "repair"), `configured repair model from ${candidates.routine.source}`];
      } else {
        model = build.model;
        tier = "routine";
        reasons = [...(demanded.tier === "strong" ? demanded.reasons : [economyReason(input, "repair")]), `the configured repair agent runs ${candidates.routine.provider}, not the build's ${build.provider}`];
        problem = `the repair configuration names ${candidates.routine.provider} but the build runs ${build.provider} — cross-provider repair does not exist; fix \`config set repair\` or override the repair phase on ${build.provider}`;
      }
    } else {
      model = build.model;
      tier = "routine";
      reasons = [
        ...(demanded.tier === "strong" ? [...demanded.reasons, "no stronger repair model is configured"] : [economyReason(input, "repair")]),
        `no repair model is configured — repairs resume the builder's session on ${build.provider} with the build model (${build.model})`,
      ];
    }
    const recommended = { provider: build.provider, model, tier };
    const repairPin = input.pins?.repair ?? null;
    if (repairPin !== null) {
      legs.push({
        phase: "repair",
        provider: build.provider,
        model: repairPin.model,
        tier,
        chosen: "pinned",
        recommended,
        reasons: [`pinned to ${specWords({ provider: build.provider, model: repairPin.model })} by the approved profile that filed this task — same provider as the build`],
        problem: repairPin.provider === build.provider ? null : `the pinned repair agent runs ${repairPin.provider} but the build runs ${build.provider} — cross-provider repair does not exist`,
      });
    } else if (override !== null && override.provider === build.provider) {
      legs.push({ phase: "repair", provider: build.provider, model: override.model, tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords({ provider: build.provider, model })})`], problem: null });
    } else if (override !== null) {
      legs.push({ phase: "repair", provider: build.provider, model, tier, chosen: "recommended", recommended, reasons: [...reasons, `the repair override to ${override.provider} cannot apply — repairs stay on the build provider (${build.provider})`], problem: `the repair override names ${override.provider} but the build runs ${build.provider} — cross-provider repair does not exist; clear or change the override` });
    } else {
      legs.push({ phase: "repair", provider: build.provider, model, tier, chosen: "recommended", recommended, reasons: [...reasons, `same provider as the build (${build.provider}) — repairs resume the builder's session`], problem });
    }
  }

  // review — override > recommendation; gemini cannot run it at all.
  {
    const rec = pick("review");
    const override = overrideFor("review");
    const recommended = { provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier };
    if (override !== null) {
      legs.push({ phase: "review", provider: override.provider, model: override.model, tier: rec.tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords(rec.spec)})`], problem: reviewProblem(override) });
    } else {
      legs.push({ phase: "review", provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier, chosen: "recommended", recommended, reasons: rec.reasons, problem: reviewProblem(rec.spec) });
    }
  }

  return {
    version: ROUTE_VERSION,
    risk: "routine",
    qualityMode: input.qualityMode,
    publication: input.publication,
    evidence: [...new Set(input.evidence)].sort(),
    // The posture is what RUNS, not what was wanted: only a leg that
    // actually draws from a configured strong agent makes the route strong
    // — an overridden or pinned leg runs the person's choice, not a tier.
    posture: drawsStrong(legs) ? "strong" : "economy",
    demands,
    legs,
    overrides,
    size: input.size ?? null,
  };
}

/**
 * PLAN HEADROOM (v2), at filing:
 *
 *   - a tier with candidates on more than one provider (`--also`) runs on
 *     the provider with more plan room — the lower window use — so work
 *     spreads across plans before either fills;
 *   - a chosen provider past its limits (80% of the 5-hour window, 90% of
 *     the weekly) gives way to the roomiest other provider at the same
 *     tier or one tier stronger, never weaker.
 *
 * Readings are the providers' own; a provider with no reading is unknown,
 * never "empty", so nothing moves toward or away from it on a guess. Ties
 * keep the tier's own candidate. The choice and its reason are sealed with
 * the route.
 */
function withHeadroom(
  input: RouteInput,
  phase: "plan" | "build",
  chosen: { spec: RouteCandidate; tier: CandidateTier; reasons: string[] },
): { spec: RouteCandidate; tier: CandidateTier; reasons: string[]; moved: boolean } {
  const rooms = input.headroom ?? [];
  const roomOf = (provider: ProviderId): ProviderRoom | null => {
    const room = rooms.find(one => one.provider === provider) ?? null;
    return room !== null && (room.fiveHour !== null || room.weekly !== null) ? room : null;
  };
  const current = roomOf(chosen.spec.provider);
  if (current === null) return { ...chosen, moved: false };
  const tight = tightWords(current);
  const candidates = input.candidates[phase];
  const pool: { spec: RouteCandidate; tier: CandidateTier }[] = [];
  for (const tier of ["light", "routine", "strong"] as const) {
    const own = tier === "light" ? candidates.light ?? null : tier === "routine" ? candidates.routine : candidates.strong;
    for (const spec of [own, ...(candidates.alternates?.[tier] ?? [])]) {
      if (spec === null || spec.provider === chosen.spec.provider || pool.some(one => one.spec.provider === spec.provider && one.tier === tier)) continue;
      // Not tight: only the same tier competes on room. Tight: one tier stronger may take it too.
      if (tight === null ? tier !== chosen.tier : TIER_RANK[tier] < TIER_RANK[chosen.tier] || TIER_RANK[tier] > TIER_RANK[chosen.tier] + 1) continue;
      pool.push({ spec, tier });
    }
  }
  if (pool.length === 0) return { ...chosen, moved: false };
  const open = pool
    .map(one => ({ ...one, room: roomOf(one.spec.provider) }))
    .filter((one): one is { spec: RouteCandidate; tier: CandidateTier; room: ProviderRoom } => one.room !== null && tightWords(one.room) === null)
    .filter(one => tight !== null || usedOf(one.room) < usedOf(current))
    .sort((a, b) => usedOf(a.room) - usedOf(b.room) || TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  const best = open[0];
  if (best === undefined) {
    return tight === null ? { ...chosen, moved: false } : { ...chosen, reasons: [...chosen.reasons, `plan headroom: ${tight}, and no other configured ${PHASE_NOUN[phase]} has room — kept`], moved: false };
  }
  const why = tight ?? `${chosen.spec.provider} has used ${usedOf(current)}% of its plan`;
  return {
    spec: best.spec,
    tier: best.tier,
    reasons: [...chosen.reasons.slice(0, -1), `plan headroom: ${why} — ${best.spec.provider} has more room (${usedOf(best.room)}% used), so its ${best.tier} ${PHASE_NOUN[phase]} from ${best.spec.source} runs it`],
    moved: true,
  };
}

/** Whether any leg actually runs a configured strong agent. */
function drawsStrong(legs: readonly RouteLeg[]): boolean {
  return postureOf(legs) === "strong";
}

export function legOf(route: PhaseRoute, phase: Phase): RouteLeg {
  const leg = route.legs.find(one => one.phase === phase);
  if (leg === undefined) throw new Error(`route has no ${phase} leg`);
  return leg;
}

/** Every stated problem on the route, in phase order — a non-empty list
 * means the scope files unresolved with these words. */
export function routeProblems(route: PhaseRoute): string[] {
  return route.legs.filter(leg => leg.phase !== "review").flatMap(leg => (leg.problem === null ? [] : [`${leg.phase}: ${leg.problem}`]));
}

/** Whether two exact pairs are the same agent. */
export function sameSpec(a: { provider: string; model: string | null }, b: { provider: string; model: string | null }): boolean {
  return a.provider === b.provider && a.model === b.model;
}

// ---- canonical bytes, digest, strict rehydration ---------------------------

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The stored snapshot bytes: the version rides IN the snapshot. */
export function canonicalRouteJson(route: PhaseRoute): string {
  return canonicalJson({
    version: route.version,
    risk: route.risk,
    qualityMode: route.qualityMode,
    publication: route.publication,
    evidence: [...route.evidence].sort(),
    posture: route.posture,
    demands: route.demands,
    legs: route.legs.map(leg => ({
      phase: leg.phase,
      provider: leg.provider,
      model: leg.model,
      tier: leg.tier,
      chosen: leg.chosen,
      recommended: leg.recommended,
      reasons: leg.reasons,
      problem: leg.problem,
    })),
    overrides: route.overrides.map(one => ({ phase: one.phase, provider: one.provider, model: one.model, by: one.by, at: one.at })),
    // v2 carries the size it was routed for; a v1 snapshot's bytes never change.
    ...(route.version === 1 ? {} : { size: route.size === null ? null : { size: route.size.size, risky: route.size.risky, source: route.size.source, reason: route.size.reason } }),
  });
}

/** sha256 over a domain-separated canonical encoding, truncated to the
 * same 128 bits every other safety digest here uses. Its own domain, so a
 * route digest can never collide with a profile or chain digest. */
export function routeDigestOf(route: PhaseRoute): string {
  return createHash("sha256")
    .update(`standing-orders:route:v${route.version}:${canonicalRouteJson(route)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** Strict rehydration of a stored route through the route contract — every
 * field type-proved, every model an exact non-empty string, nothing unknown;
 * anything unexpected is null, never a guess. A null from a row that carries
 * a route era is a corrupt seal. */
// Recovery and normal admission share this strict decoder; neither may replace
// unreadable signed routing with a convenient current default.
export function routeFromJson(json: string | null): PhaseRoute | null {
  if (json === null) return null;
  const read = readRouteJson(json);
  return read.ok ? read.route : null;
}

/** Why a stored route does not read, as path-named lines (`legs[1].model: …`); null when it reads. */
export function routeJsonProblem(json: string): string | null {
  const read = readRouteJson(json);
  return read.ok ? null : read.lines.join("; ");
}

function readRouteJson(json: string): { ok: true; route: PhaseRoute } | { ok: false; lines: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, lines: ["payload: not valid JSON"] };
  }
  const read = readSealedRoute(parsed);
  return read.ok ? { ok: true, route: read.value } : { ok: false, lines: read.issues.map(one => one.line) };
}

/** Strict parse of an override list (the route contract's): one per phase,
 * every field proved, every model exact, in phase order. */
export function parseOverrides(raw: unknown): RouteOverride[] | null {
  const read = readRouteOverrides(raw);
  return read.ok ? read.value : null;
}

/** The stored override list (a task-level column). Malformed reads as
 * null — the caller files the scope unresolved rather than routing as if
 * nobody had overridden anything. */
export function overridesFromJson(json: string | null): RouteOverride[] | null {
  if (json === null) return [];
  try {
    return parseOverrides(JSON.parse(json));
  } catch {
    return null;
  }
}

export function canonicalOverridesJson(overrides: readonly RouteOverride[]): string | null {
  if (overrides.length === 0) return null;
  return canonicalJson(
    [...overrides]
      .sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase))
      .map(one => ({ phase: one.phase, provider: one.provider, model: one.model, by: one.by, at: one.at })),
  );
}

// ---- the shared projection -----------------------------------------------

export type ReadinessLookup = (provider: ProviderId) => (Pick<ReadinessObservation, "state" | "reason" | "runner" | "observedAt"> & Partial<Pick<ReadinessObservation, "probe">>) | null;

export type RouteLegProjection = RouteLeg & {
  readiness: ReadinessState;
  readinessReason: string | null;
  readinessRunner: string | null;
  observedAt: string | null;
  /** One line every surface prints for this leg. */
  words: string;
};

export type RouteProjection = {
  digest: string;
  risk: RiskLevel;
  riskTitle: string;
  posture: PhaseRoute["posture"];
  postureWords: string;
  demands: string[];
  legs: RouteLegProjection[];
  /** The compact plain-English line: who does what, and whether any of
   * them is a stronger-than-default agent. */
  summary: string;
  /** True when any leg is known-unavailable — admission halts, nothing
   * substitutes. */
  halted: boolean;
  /** Every stated leg problem, phase-prefixed. */
  problems: string[];
  /** The size the route was made for (v2), or null. */
  size: TaskSizing | null;
  /** The plain line an approval card leads with — "Small change: fast
   * model, no plan" — or null on an unsized route. */
  sizeWords: string | null;
  /** Why it was sized so, and by whom, or null. */
  sizeReason: string | null;
};

/** What actually runs: stronger agents only when a leg draws from one. */
export function postureWords(route: Pick<PhaseRoute, "legs">): string {
  const active = route.legs.filter(leg => leg.phase !== "review");
  if (drawsStrong(active)) return "stronger configured agents";
  return active.some(leg => leg.phase === "build" && leg.chosen === "recommended" && leg.tier === "light") ? "a fast configured agent" : "everyday configured agents";
}

/** The size line, plainly: what the size does to this route. */
export function sizeWords(route: Pick<PhaseRoute, "legs" | "size" | "risk">): string | null {
  if (route.size === null) return null;
  const build = route.legs.find(leg => leg.phase === "build");
  // Said from the build leg that actually runs: another demand (strict quality, screenshots) can lift it.
  const model = build?.tier === "light" ? "fast model" : build?.tier === "strong" ? "strongest model" : "everyday model";
  if (makesNoPlan(route.size, route.risk)) return `Small change: ${model}, no plan`;
  // (A route sealed at elevated or high risk planned a small change too.)
  const label = route.size.size === "large" ? "Large change" : route.size.size === "small" ? (route.size.risky ? "Small but risky change" : "Small change") : route.size.risky ? "Risky change" : "Medium change";
  if (route.size.size !== "large" && !route.size.risky && route.risk === "routine") return build?.tier === "strong" ? "Medium change: strongest agents" : "Medium change: everyday agents";
  return build?.tier === "strong" ? `${label}: strongest agents plan and build` : `${label}: planned first, everyday agents (no stronger agent is configured)`;
}

export function readinessWords(state: ReadinessState, reason: string | null): string {
  if (state === "ready") return "ready";
  if (state === "unavailable") return `UNAVAILABLE${reason === null ? "" : ` — ${reason}`}`;
  return `readiness unknown${reason === null ? "" : ` — ${reason}`}`;
}

export function chosenWords(leg: Pick<RouteLeg, "chosen" | "tier">): string {
  return leg.chosen === "override" ? "overridden" : leg.chosen === "pinned" ? "pinned" : leg.tier === "strong" ? "recommended · strong" : leg.tier === "light" ? "recommended · fast" : "recommended";
}

/**
 * The one-line Agents summary every surface can show above the details:
 * agents grouped by identical pair, in phase order — "claude · sonnet
 * plans, builds, and repairs; claude · opus reviews" — with the posture
 * said honestly (stronger agents only when one is actually selected).
 */
export function agentsSummary(route: Pick<PhaseRoute, "legs"> & { size?: TaskSizing | null; risk?: RiskLevel }): string {
  const groups: { spec: string; verbs: string[] }[] = [];
  // A small change makes no plan: its planner is not one of the agents that work on it.
  const unplanned = makesNoPlan(route.size, route.risk ?? "routine");
  for (const leg of route.legs.filter(leg => leg.phase !== "review" && !(unplanned && leg.phase === "plan" && leg.chosen === "recommended"))) {
    const spec = specWords(leg);
    const group = groups.find(one => one.spec === spec);
    if (group === undefined) groups.push({ spec, verbs: [PHASE_VERB[leg.phase]] });
    else group.verbs.push(PHASE_VERB[leg.phase]);
  }
  const list = (verbs: string[]): string => (verbs.length <= 1 ? verbs.join("") : verbs.length === 2 ? `${verbs[0]} and ${verbs[1]}` : `${verbs.slice(0, -1).join(", ")}, and ${verbs.at(-1)}`);
  return groups.map(one => `${one.spec} ${list(one.verbs)}`).join("; ");
}

export function legLine(leg: RouteLegProjection): string {
  return `${leg.phase.padEnd(7)}${specWords(leg)}  [${chosenWords(leg)}] — ${readinessWords(leg.readiness, leg.readinessReason)}${leg.problem === null ? "" : ` — ${leg.problem}`}`;
}

/** The one projection CLI, task page, and chat all render from. */
export function projectRoute(route: PhaseRoute, readiness: ReadinessLookup): RouteProjection {
  const legs = route.legs.filter(leg => leg.phase !== "review").map(leg => {
    const seen = readiness(leg.provider);
    const state: ReadinessState = seen === null ? "unknown" : seen.state;
    const projected: RouteLegProjection = {
      ...leg,
      reasons: leg.reasons.map(reason => reason.replace("builder and reviewer", "builder")),
      readiness: state,
      readinessReason: seen === null ? "no runner has reported this provider yet" : seen.reason,
      readinessRunner: seen === null ? null : seen.runner,
      observedAt: seen === null ? null : seen.observedAt,
      words: "",
    };
    projected.words = legLine(projected);
    return projected;
  });
  return {
    digest: routeDigestOf(route),
    risk: route.risk,
    riskTitle: route.risk === "routine" && route.size?.risky ? "Risky" : riskTitle(route.risk),
    posture: drawsStrong(legs) ? "strong" : "economy",
    postureWords: postureWords(route),
    demands: route.demands.filter(reason => !/review/i.test(reason)),
    legs,
    summary: agentsSummary(route),
    halted: legs.some(leg => leg.readiness === "unavailable"),
    problems: routeProblems(route),
    size: route.size,
    sizeWords: sizeWords(route),
    // A person's size already says who set it.
    sizeReason: route.size === null ? null : route.size.source === "person" && route.size.reason !== "" ? route.size.reason : `${route.size.reason === "" ? "" : `${route.size.reason} · `}${sizeSourceWords(route.size.source)}`,
  };
}

/** The approval-card lines: one route header, one line per leg, then the
 * reasons indented — identical bytes on every text surface. */
export function routeWords(projection: RouteProjection, indent = "  "): string[] {
  const pad = `${indent}             `;
  return [
    `${indent}route        ${projection.riskTitle.toLowerCase()} · ${projection.postureWords} · ${projection.digest}`,
    ...(projection.sizeWords === null ? [] : [`${indent}size         ${projection.sizeWords} — ${projection.sizeReason}`]),
    `${pad}${projection.summary}`,
    ...projection.legs.flatMap(leg => [`${pad}${leg.words}`, ...leg.reasons.map(reason => `${pad}    ${reason}`)]),
    ...(projection.halted ? [`${pad}HALTED: a provider on this route is reported unavailable — nothing substitutes; override the phase or restore the provider`] : []),
  ];
}

/** The empty readiness lookup: every provider unknown. */
export const NO_READINESS: ReadinessLookup = () => null;

/** How a run's provenance names the leg it spent as: the frozen leg's own
 * word, and `legacy` for a run governed by a pre-routing approval. Before
 * v115, `legacy` also named a watched session's run, and `fallback` an
 * approved fallback entry's; those rows still read back. */
export type RouteChosen = RouteLeg["chosen"] | "legacy" | "fallback";
export const ROUTE_CHOSEN: readonly RouteChosen[] = ["recommended", "override", "pinned", "legacy", "fallback"];

/** One run's route provenance: the exact provider and model that ran,
 * under which route (or legacy profile) digest, as which leg. */
export type RouteStamp = { routeDigest: string; phase: Phase; provider: string; model: string | null; chosen: RouteChosen };

/** A run's role, as the route phase it spends as: a scout runs the build
 * leg's agent (the same sealed profile a build proves against). */
export function phaseOfRole(role: "builder" | "repair" | "planner" | "scout" | "reviewer"): Phase {
  return role === "planner" ? "plan" : role === "repair" ? "repair" : role === "reviewer" ? "review" : "build";
}

/**
 * Strict proof of a route stamp's SHAPE, before anything about it is
 * believed: a known phase and provenance word, a known provider, a
 * non-empty digest, and an exact model on every stamp except a legacy
 * one (a pre-routing profile may carry no model). Anything else is the
 * words for why — admission refuses on them, never coerces.
 */
export function routeStampProblem(stamp: unknown): string | null {
  if (stamp === null || typeof stamp !== "object") return "the route stamp is not an object";
  const s = stamp as Record<string, unknown>;
  if (!str(s["routeDigest"])) return "the route stamp names no route digest";
  if (!str(s["phase"]) || !PHASES.includes(s["phase"] as Phase)) return `the route stamp names an unknown phase ${JSON.stringify(s["phase"])}`;
  if (!str(s["chosen"]) || !ROUTE_CHOSEN.includes(s["chosen"] as RouteChosen)) return `the route stamp names an unknown provenance ${JSON.stringify(s["chosen"])}`;
  if (!str(s["provider"]) || !isProviderId(s["provider"])) return `the route stamp names an unknown provider ${JSON.stringify(s["provider"])}`;
  const model = s["model"];
  if (model !== null && !str(model)) return "the route stamp's model is neither an exact id nor null";
  if (model !== null && !exactModel(model)) return `the route stamp's model ${JSON.stringify(model)} is not a model id (letters, digits, and . _ : / -, never leading with a dash)`;
  if (model === null && s["chosen"] !== "legacy") return `a ${String(s["chosen"])} leg names an exact model — the stamp carries none`;
  return null;
}
