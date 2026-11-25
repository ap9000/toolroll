/**
 * The Mac app's per-task model pick on an approved task (docs/plans/mac-change-models.md, revised): the pick is the
 * owner's yes to the new agent, and only to it. This is the one question both the writer (local-owner-acts.ts
 * localOwnerChangeAgents) and approve()'s narrow branch ask: between the sealed route and profile and the ones the pick
 * just re-filed, did exactly one of the planner or the builder change (with the repair agent, the builder's usual twin),
 * and nothing else — the other agents, the route's terms, what builds may reach and do, the chain and how the agent
 * bills? Anything else differing is a change the person never saw, so nothing carries over.
 *
 * Pure over its inputs (and a billing lookup), kept apart so scope.ts loads it without the roads that use it.
 */
import { canonicalJson } from "./canonical-json.js";
import { legOf, routeFromJson, sameSpec, type PhaseRoute } from "./phase-routing.js";
import { levelOfProfile } from "./policy.js";
import type { ExecutionProfile } from "./scope.js";

/** One side of the comparison: a route's stored bytes, its execution profile, and its (historical) fallback chain. */
export type AgentChangeSide = { routeJson: string | null | undefined; profile: ExecutionProfile | null | undefined; chainJson: string | null | undefined };
type Pair = { provider: string; model: string };
export type AgentOnlyChange = { ok: true; phase: "plan" | "build"; from: Pair; to: Pair } | { ok: false; why: string };

/** What builds may reach and do, beside the agent itself: the parts of a profile a new builder must keep exactly. */
const KEPT_PROFILE_KEYS = ["network", "writes", "checkAccess", "fencePolicy", "readDeny", "machLookup"] as const;

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const pairOf = (leg: { provider: string; model: string }): Pair => ({ provider: leg.provider, model: leg.model });

/**
 * Whether `next` differs from `sealed` only by one picked agent (see the module note). `billingOf` answers how a
 * provider bills here (store.agentsFor); a pick that moves between a plan and an API key is not carried over.
 */
export function agentOnlyChange(sealed: AgentChangeSide, next: AgentChangeSide, billingOf: (provider: string) => string | null): AgentOnlyChange {
  const was = routeFromJson(sealed.routeJson ?? null), now = routeFromJson(next.routeJson ?? null);
  if (was === null || now === null) return { ok: false, why: "a route can't be read" };
  const terms = routeTermsProblem(was, now);
  if (terms !== null) return { ok: false, why: terms };
  const changed = (["plan", "build", "repair", "review"] as const).filter(phase => !sameSpec(legOf(was, phase), legOf(now, phase)));
  const phase = changed.length === 1 && changed[0] === "plan" ? "plan"
    : changed.includes("build") && changed.every(one => one === "build" || one === "repair") ? "build" : null;
  if (phase === null) return { ok: false, why: changed.length === 0 ? "no agent changed" : `${changed.join(", ")} changed` };
  // The repair agent moves only as the builder's twin: the same provider as the new builder.
  if (changed.includes("repair") && legOf(now, "repair").provider !== legOf(now, "build").provider) return { ok: false, why: "the repair agent changed on its own" };
  // Every override but the picked role's stays exactly as it was sealed.
  const others = (route: PhaseRoute) => route.overrides.filter(one => one.phase !== phase && !(phase === "build" && one.phase === "repair"));
  if (!same(others(was), others(now))) return { ok: false, why: "another role's choice changed" };
  const profile = profileProblem(sealed.profile, next.profile, phase, legOf(now, "build"));
  if (profile !== null) return { ok: false, why: profile };
  if ((sealed.chainJson ?? null) !== (next.chainJson ?? null)) return { ok: false, why: "the fallback chain changed" };
  const from = pairOf(legOf(was, phase)), to = pairOf(legOf(now, phase));
  if (billingOf(from.provider) !== billingOf(to.provider)) return { ok: false, why: "how the agent bills changed" };
  return { ok: true, phase, from, to };
}

/** The route's own terms (everything but its legs, overrides and the posture those legs imply), sealed against next. */
function routeTermsProblem(was: PhaseRoute, now: PhaseRoute): string | null {
  if (was.version !== now.version) return "the route's version changed";
  if (was.risk !== now.risk || was.qualityMode !== now.qualityMode || was.publication !== now.publication) return "the route's terms changed";
  if (!same([...was.evidence].sort(), [...now.evidence].sort()) || !same(was.demands, now.demands) || !same(was.size, now.size)) return "the route's terms changed";
  return null;
}

/** The profile: a new planner leaves it exactly as sealed; a new builder is the profile's agent, and keeps what builds
 * may reach and do (the same provider: everything but the model; another provider: its permission level and every
 * reach setting). */
function profileProblem(was: ExecutionProfile | null | undefined, now: ExecutionProfile | null | undefined, phase: "plan" | "build", build: Pair): string | null {
  if (was == null || now == null) return "a profile can't be read";
  if (phase === "plan") return same(was, now) ? null : "the build settings changed";
  if (now.provider !== build.provider || now.model !== build.model) return "the build settings don't name the new builder";
  if (was.provider === now.provider) {
    const rest = (one: ExecutionProfile) => ({ ...one, model: undefined, repairModel: undefined });
    return same(rest(was), rest(now)) ? null : "the build settings changed";
  }
  if (levelOfProfile(was) !== levelOfProfile(now)) return "what the builder may do changed";
  for (const key of KEPT_PROFILE_KEYS) if (!same((was as Record<string, unknown>)[key], (now as Record<string, unknown>)[key])) return "what builds may reach changed";
  return null;
}
