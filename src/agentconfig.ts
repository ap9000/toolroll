/**
 * Phase-agent resolution: which provider and model a phase runs on, layer
 * by layer, with the layers written down (Codex provider review, Q8).
 *
 *   pinned task agent  — stamped by a fire transaction; NOTHING overrides it
 *   explicit flags     — this pass's operator, per field
 *   project override   — phase_config row scoped to the canonical repo
 *   installation       — phase_config row scoped 'installation'
 *   review inheritance — when review is unset, the planner's complete pair
 *   default            — claude, harness default model
 *
 * Config rows are COMPLETE pairs (provider required, model optional), so a
 * partial override cannot marry a codex model to an inherited claude
 * provider. Flags are per-field with one stated rule: `--model` alone
 * rides whatever provider resolves; `--provider` alone runs that
 * provider's default model — a lower layer's model never crosses onto a
 * flag-chosen provider it was not written for.
 *
 * The resolved pair is validated before anything is claimed or spent, and
 * the caller snapshots it into the run row.
 */

import { isProviderId, validateSpec, type AgentSpec, type Phase, type ProviderId } from "./provider.js";
import { contestantProfileOf, type Store, type TaskRef } from "./store.js";
import { CLAUDE_LIMITS, CODEX_SHAPED_LIMITS, GEMINI_LIMITS, chainFromJson, canonicalChainJson, type ChainEntry, type ExecutionProfile, type UnattendedPermissionMode } from "./scope.js";
import { SUBSCRIPTION_CAPABLE } from "./keys.js";
import { exactModelId, legOf, PHASES, recommendRoute, routeFromJson, routeProblems, sameSpec, type CandidateTier, type ExactSpec, type PhaseRoute, type RouteCandidate, type RouteCandidates, type RouteEvidenceKind } from "./phase-routing.js";
import type { AcceptanceCriterion } from "./scope.js";

export const INSTALLATION_SCOPE = "installation";

export type PhaseFlags = { provider?: string | undefined; model?: string | undefined };

export type Resolution =
  | { ok: true; spec: AgentSpec; source: "pinned" | "flag" | "project" | "installation" | "default" }
  | { ok: false; problem: string };

/**
 * Fail-closed (not a fallback to claude — a refusal): gemini's own
 * `.gemini/` config loads hooks and MCP servers unconditionally
 * (provider.ts's geminiArgv), a leak claude and codex both now close for
 * review with a dedicated isolation argv. Until gemini earns the same, it
 * is not eligible to run the reviewer phase at all — however it got
 * resolved: pinned, flagged, or configured.
 */
function reviewEligible(phase: Phase, spec: AgentSpec): string | null {
  return phase === "review" && spec.provider === "gemini"
    ? "gemini has no isolation posture for the review phase yet (its own config can load hooks and MCP servers) — pin review to claude or codex"
    : null;
}

export function resolvePhaseAgent(
  store: Store,
  phase: Phase,
  repo: string | null,
  flags: PhaseFlags,
  /** The task being dispatched, when one is — its pin is authoritative. */
  ref?: Pick<TaskRef, "agentProvider" | "agentModel">,
): Resolution {
  // The pin: a firing resolved under approved terms must not be re-routed
  // by anything later, flags included (Codex provider review, critical 1).
  if (ref !== undefined && ref.agentProvider !== null) {
    if (!isProviderId(ref.agentProvider)) {
      return { ok: false, problem: `the task is pinned to unknown provider \`${ref.agentProvider}\`` };
    }
    const spec: AgentSpec = { provider: ref.agentProvider, model: ref.agentModel };
    const ineligible = reviewEligible(phase, spec);
    if (ineligible !== null) return { ok: false, problem: ineligible };
    const valid = validateSpec(spec);
    return valid.ok ? { ok: true, spec, source: "pinned" } : { ok: false, problem: valid.problem };
  }

  if (flags.provider !== undefined) {
    if (!isProviderId(flags.provider)) {
      return { ok: false, problem: `unknown provider \`${flags.provider}\`` };
    }
    const spec: AgentSpec = { provider: flags.provider, model: flags.model ?? null };
    const ineligible = reviewEligible(phase, spec);
    if (ineligible !== null) return { ok: false, problem: ineligible };
    const valid = validateSpec(spec);
    return valid.ok ? { ok: true, spec, source: "flag" } : { ok: false, problem: valid.problem };
  }

  const directProject = repo === null ? null : store.phaseConfig(repo, phase);
  const directInstallation = store.phaseConfig(INSTALLATION_SCOPE, phase);
  // Planning and review benefit from the same high-judgment model, while
  // execution can use a different provider. An explicit review row always
  // wins; only an unset review inherits the planner's complete pair.
  const inheritedProject = phase === "review" && directProject === null && directInstallation === null && repo !== null
    ? store.phaseConfig(repo, "plan")
    : null;
  const inheritedInstallation = phase === "review" && directProject === null && directInstallation === null
    ? store.phaseConfig(INSTALLATION_SCOPE, "plan")
    : null;
  const project = directProject ?? inheritedProject;
  const installation = directInstallation ?? inheritedInstallation;
  const row = project ?? installation;
  const source = project !== null ? ("project" as const) : installation !== null ? ("installation" as const) : ("default" as const);

  // A misconfigured row REFUSES instead of silently rerouting to claude
  // (foundations finding 3c): the operator wrote a provider; running a
  // different one is not a fallback, it is a substitution.
  if (row !== null && !isProviderId(row.provider)) {
    return { ok: false, problem: `the ${source} configuration names unknown provider \`${row.provider}\` — fix it with \`config set\`` };
  }
  const provider: ProviderId =
    row !== null && isProviderId(row.provider) ? row.provider : "claude";
  // --model alone rides the resolved provider; otherwise the pair comes
  // whole from the row that named the provider.
  const model = flags.model ?? (row !== null ? row.model : null);
  const spec: AgentSpec = { provider, model };
  const ineligible = reviewEligible(phase, spec);
  if (ineligible !== null) return { ok: false, problem: ineligible };
  const valid = validateSpec(spec);
  return valid.ok ? { ok: true, spec, source: flags.model !== undefined ? "flag" : source } : { ok: false, problem: valid.problem };
}

/**
 * The FILING resolver (foundations findings 13/15/19): the execution
 * profile a scope stores, resolved once, exactly, at filing. The model is
 * the exact string the argv will carry — the harness-default road refuses
 * here rather than floating (ruling 10). Repair precedence: the
 * --repair-model flag, else the repair phase-config row's MODEL (its
 * provider must equal the build provider — cross-provider repair does not
 * exist), else the literal "inherit". Callers that file scopes SAVE an
 * unresolved state on refusal (finding 19) — this function only says why.
 */
export type ProfileResolution =
  | { ok: true; profile: ExecutionProfile; provenance: { resolvedFrom: string; repairFrom: string } }
  | { ok: false; reason: "unknown-provider" | "no-model" | "repair-provider-mismatch"; problem: string };

export function resolveScopeProfile(
  store: Store,
  repo: string | null,
  ref: Pick<TaskRef, "agentProvider" | "agentModel"> | undefined,
  flags: PhaseFlags & { repairModel?: string | undefined; permissionMode?: UnattendedPermissionMode | undefined },
): ProfileResolution {
  const build = resolvePhaseAgent(store, "build", repo, flags, ref);
  if (!build.ok) return { ok: false, reason: "unknown-provider", problem: build.problem };
  const { provider, model } = build.spec;
  if (model === null || model === "") {
    return {
      ok: false,
      reason: "no-model",
      problem:
        "approvals bind exact routing — name --model on the scope, or set a default once with `config set build --provider " +
        provider +
        " --model <model>`",
    };
  }

  let repairModel = "inherit";
  let repairFrom = "inherit";
  if (flags.repairModel !== undefined && flags.repairModel !== "") {
    repairModel = flags.repairModel;
    repairFrom = "flag";
  } else {
    const repairRow = (repo === null ? null : store.phaseConfig(repo, "repair")) ?? store.phaseConfig(INSTALLATION_SCOPE, "repair");
    if (repairRow !== null) {
      if (repairRow.provider !== provider) {
        return {
          ok: false,
          reason: "repair-provider-mismatch",
          problem: `the repair configuration names provider \`${repairRow.provider}\` but the build runs \`${provider}\` — cross-provider repair does not exist; fix the repair row or name --repair-model`,
        };
      }
      if (repairRow.model !== null && repairRow.model !== "") {
        repairModel = repairRow.model;
        repairFrom = "config";
      }
    }
  }

  const permissionMode = flags.permissionMode ?? store.permissionDefault().mode;
  const profile: ExecutionProfile =
    provider === "claude"
      ? {
          provider,
          model,
          // Auto mode is designed for headless work: routine repository
          // commands and edits proceed, while risky acts still stop at the
          // provider's permission classifier. Full access is an explicit
          // installation or task choice and is sealed into this profile.
          permissionArgv: permissionMode,
          maxTurns: CLAUDE_LIMITS.maxTurns,
          repairMaxTurns: CLAUDE_LIMITS.repairMaxTurns,
          timeoutSeconds: CLAUDE_LIMITS.timeoutSeconds,
          timeoutKind: "idle",
          repairTimeoutSeconds: CLAUDE_LIMITS.repairTimeoutSeconds,
          repairModel,
        }
      : provider === "gemini"
        ? {
            provider,
            model,
            // The cross-provider choice resolves to Gemini's own real argv:
            // auto_edit for Auto, yolo for Full access.
            approvalArgv: permissionMode === "bypassPermissions" ? "yolo" : "auto_edit",
            maxTurns: "unsupported",
            repairMaxTurns: "unsupported",
            timeoutSeconds: GEMINI_LIMITS.timeoutSeconds,
            timeoutKind: "idle",
            repairTimeoutSeconds: GEMINI_LIMITS.repairTimeoutSeconds,
            repairModel,
          }
        : {
            provider,
            model,
            sandboxMode: permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write",
            maxTurns: "unsupported",
            repairMaxTurns: "unsupported",
            timeoutSeconds: CODEX_SHAPED_LIMITS.timeoutSeconds,
            timeoutKind: "idle",
            repairTimeoutSeconds: CODEX_SHAPED_LIMITS.repairTimeoutSeconds,
            repairModel,
          };
  return { ok: true, profile, provenance: { resolvedFrom: build.source, repairFrom } };
}

export type ChainResolution =
  | { ok: true; chain: ChainEntry[]; kind: "profile" | "chain" }
  | { ok: false; reason: "base-unresolved" | "bad-fallback" | "duplicate"; problem: string };

/**
 * Resolve the full EXECUTION CHAIN a scope files under (v30): the base
 * (entry 0) is the ordinary single-profile resolution wearing the base
 * provider's auth mode; the fallbacks are the scope's configured entries,
 * each resolved to a WHOLE ExecutionProfile (repair per entry). With no
 * fallbacks configured, the result is `kind: "profile"` — a single-profile
 * approval, byte-identical to today (NOT an explicit chain). With
 * fallbacks, it is `kind: "chain"` and the approval binds the whole thing.
 * The base auth mode is passed in (the caller reads it from the managed
 * key store) so resolution stays pure and testable.
 */
export function resolveScopeChain(
  store: Store,
  repo: string | null,
  ref: Pick<TaskRef, "agentProvider" | "agentModel"> | undefined,
  flags: PhaseFlags & { repairModel?: string | undefined; permissionMode?: UnattendedPermissionMode | undefined },
  baseAuthMode: "subscription" | "api-key",
): ChainResolution {
  const base = resolveScopeProfile(store, repo, ref, flags);
  if (!base.ok) return { ok: false, reason: "base-unresolved", problem: base.problem };
  const unreadable = repo === null ? null : store.fallbackConfigProblem(repo);
  if (unreadable !== null) return { ok: false, reason: "bad-fallback", problem: unreadable };
  const fallbacks = repo === null ? [] : store.fallbackConfig(repo);
  if (fallbacks.length === 0) {
    // No fallbacks: a legacy single-profile approval, unchanged.
    return { ok: true, chain: [{ profile: base.profile, authMode: baseAuthMode }], kind: "profile" };
  }
  const entries: ChainEntry[] = [{ profile: base.profile, authMode: baseAuthMode }];
  for (const one of fallbacks) {
    if (!isProviderId(one.provider) || one.model === undefined || one.model === "") {
      return { ok: false, reason: "bad-fallback", problem: `a fallback entry names an unknown provider or empty model (${one.provider}:${one.model})` };
    }
    if (one.authMode !== "subscription" && one.authMode !== "api-key") {
      return { ok: false, reason: "bad-fallback", problem: `a fallback entry has an unknown auth mode` };
    }
    // An entry can only pin an auth mode its provider can actually take:
    // "subscription" on a provider with no login (openrouter) would seal an
    // entry that can never authenticate (E3d, gateway pin).
    if (one.authMode === "subscription" && !SUBSCRIPTION_CAPABLE[one.provider]) {
      return { ok: false, reason: "bad-fallback", problem: `${one.provider} has no subscription login — this entry must use an API key` };
    }
    // The model rides provider argv (F+G review, finding 1): the SAME
    // argv-safety validation every other sealed model passes — never a
    // leading dash, control bytes, or whitespace into a harness's argv.
    const argvSafe = validateSpec({ provider: one.provider, model: one.model });
    if (!argvSafe.ok) {
      return { ok: false, reason: "bad-fallback", problem: argvSafe.problem };
    }
    entries.push({ profile: contestantProfileOf(one.provider, one.model, one.repairModel ?? "inherit", flags.permissionMode ?? store.permissionDefault().mode), authMode: one.authMode });
  }
  // Re-prove the whole chain through the strict rehydrator: it rejects
  // exact-duplicate entries and any malformed shape, so what the approval
  // seals is exactly what dispatch will re-derive.
  const proven = chainFromJson(canonicalChainJson(entries));
  if (proven === null) {
    return { ok: false, reason: "duplicate", problem: "the fallback chain has a duplicate entry (same profile and auth mode) or is malformed" };
  }
  return { ok: true, chain: proven, kind: "chain" };
}

// ---- route candidates (v47, phase routing) --------------------------------

/**
 * The two candidate tiers the routing policy chooses between, per phase,
 * read from configuration ONLY — never inferred from a model's name:
 *
 *   routine — the ordinary resolution above (project > installation,
 *             review inheriting the planner's pair), i.e. exactly the
 *             agent every pre-v47 scope resolved to — but EXACT: a phase
 *             whose resolution has no model id cannot be a candidate,
 *             because an approval binds exact routing. Repair is the one
 *             phase with no routine candidate of its own when nothing is
 *             configured: it inherits the build leg (repairs resume the
 *             builder's session), and the policy says so.
 *   strong  — the operator's named strong row (`config set <phase> --tier
 *             strong …`), project over installation, review inheriting the
 *             plan's strong row when it has none of its own; null when
 *             nothing is configured, and the route then SAYS so.
 *
 * A misconfigured row — unknown provider, missing model, argv-unsafe
 * model — REFUSES with the words to fix it; the caller files the scope
 * unresolved with them. Nothing is skipped or guessed.
 */
export type CandidatesResolution =
  | { ok: true; candidates: RouteCandidates }
  | { ok: false; phase: Phase; problem: string };

const PHASE_NOUN: Record<Phase, string> = { plan: "planner", build: "builder", repair: "repair", review: "reviewer" };

export function resolveRouteCandidates(store: Store, repo: string | null, pins: { plan?: ExactSpec | null; build?: ExactSpec | null } = {}): CandidatesResolution {
  // The LIGHT tier (v2): the operator's named fast builder, project over
  // installation, never inherited and never inferred. Only the build phase
  // has one: a small change makes no plan, and repairs resume the builder.
  const lightOf = (phase: "build"): { ok: true; light: RouteCandidate | null } | { ok: false; problem: string } => {
    const project = repo === null ? null : store.phaseTierConfig(repo, phase, "light");
    const row = project ?? store.phaseTierConfig(INSTALLATION_SCOPE, phase, "light");
    if (row === null) return { ok: true, light: null };
    const source = project !== null ? "project (light)" : "installation (light)";
    if (!isProviderId(row.provider) || row.model === null || row.model === "") {
      return { ok: false, problem: `the ${source} ${PHASE_NOUN[phase]} names ${row.provider}${row.model === null || row.model === "" ? " with no model" : ` · ${row.model}`} — a light agent is an exact pair: \`config set ${phase} --tier light --provider … --model …\`, or \`--clear\` it` };
    }
    const valid = validateSpec({ provider: row.provider, model: row.model });
    if (!valid.ok) return { ok: false, problem: `the ${source} ${PHASE_NOUN[phase]}: ${valid.problem}` };
    return { ok: true, light: { provider: row.provider, model: row.model, source } };
  };
  // Alternates (v2): one more candidate per provider on a tier, project over installation.
  const alternatesOf = (phase: "plan" | "build", tier: CandidateTier): { ok: true; alternates: RouteCandidate[] } | { ok: false; problem: string } => {
    const project = repo === null ? [] : store.phaseTierAlternates(repo, phase, tier);
    const rows = project.length > 0 ? project : store.phaseTierAlternates(INSTALLATION_SCOPE, phase, tier);
    const source = `${project.length > 0 ? "project" : "installation"} (${tier}, also)`;
    const alternates: RouteCandidate[] = [];
    for (const row of rows) {
      if (!isProviderId(row.provider)) return { ok: false, problem: `the ${source} ${PHASE_NOUN[phase]} names unknown provider ${row.provider} — \`config clear ${phase} --also --provider ${row.provider}\`` };
      const valid = validateSpec({ provider: row.provider, model: row.model });
      if (!valid.ok) return { ok: false, problem: `the ${source} ${PHASE_NOUN[phase]}: ${valid.problem}` };
      alternates.push({ provider: row.provider, model: row.model, source });
    }
    return { ok: true, alternates };
  };
  const strongOf = (phase: Phase): { ok: true; strong: RouteCandidate | null } | { ok: false; problem: string } => {
    const strongProject = repo === null ? null : store.phaseTierConfig(repo, phase, "strong");
    const strongInstallation = store.phaseTierConfig(INSTALLATION_SCOPE, phase, "strong");
    const inheritedProject = phase === "review" && strongProject === null && strongInstallation === null && repo !== null ? store.phaseTierConfig(repo, "plan", "strong") : null;
    const inheritedInstallation = phase === "review" && strongProject === null && strongInstallation === null ? store.phaseTierConfig(INSTALLATION_SCOPE, "plan", "strong") : null;
    const row = strongProject ?? inheritedProject ?? strongInstallation ?? inheritedInstallation;
    const source =
      strongProject !== null ? "project (strong)" : inheritedProject !== null ? "project (strong, inherited from plan)" : strongInstallation !== null ? "installation (strong)" : inheritedInstallation !== null ? "installation (strong, inherited from plan)" : null;
    if (row === null || source === null) return { ok: true, strong: null };
    if (!isProviderId(row.provider) || row.model === null || row.model === "") {
      return { ok: false, problem: `the ${source} ${PHASE_NOUN[phase]} names ${row.provider}${row.model === null || row.model === "" ? " with no model" : ` · ${row.model}`} — a strong agent is an exact pair: \`config set ${phase} --tier strong --provider … --model …\`, or \`--clear\` it` };
    }
    const valid = validateSpec({ provider: row.provider, model: row.model });
    if (!valid.ok) return { ok: false, problem: `the ${source} ${PHASE_NOUN[phase]}: ${valid.problem}` };
    return { ok: true, strong: { provider: row.provider, model: row.model, source } };
  };

  const exact = (phase: "plan" | "build" | "review"): { ok: true; routine: RouteCandidate } | { ok: false; problem: string } => {
    const routine = resolvePhaseAgent(store, phase, repo, {});
    if (!routine.ok) return { ok: false, problem: routine.problem };
    if (routine.spec.model === null || routine.spec.model === "") {
      // A PINNED exact pair (a routine firing's approved profile, a plan
      // request's pin) is the phase's agent whatever the configuration
      // says — it stands in as the candidate when nothing exact is
      // configured, so a firing never depends on today's config.
      const pin = phase === "plan" ? pins.plan ?? null : phase === "build" ? pins.build ?? null : null;
      if (pin !== null) return { ok: true, routine: { provider: pin.provider, model: pin.model, source: "the pinned agent" } };
      return {
        ok: false,
        problem: `approvals bind exact routing — the ${PHASE_NOUN[phase]} (${routine.spec.provider}) has no exact model: set one once with \`config set ${phase} --provider ${routine.spec.provider} --model <model>\``,
      };
    }
    return { ok: true, routine: { provider: routine.spec.provider, model: routine.spec.model, source: routine.source === "default" ? "the built-in default" : routine.source } };
  };

  const out: Partial<RouteCandidates> = {};
  for (const phase of ["plan", "build", "review"] as const) {
    const routine = exact(phase);
    const strong = strongOf(phase);
    // Retain the historical four-leg encoding, but retired reviewer settings
    // cannot prevent a new task from planning or building. This leg never runs.
    if (phase === "review" && (!routine.ok || !strong.ok)) {
      out.review = out.plan!;
      continue;
    }
    if (!routine.ok) return { ok: false, phase, problem: routine.problem };
    if (!strong.ok) return { ok: false, phase, problem: strong.problem };
    const light = phase === "build" ? lightOf(phase) : { ok: true as const, light: null };
    if (!light.ok) return { ok: false, phase, problem: light.problem };
    if (phase === "review") {
      out.review = { routine: routine.routine, strong: strong.strong };
      continue;
    }
    // A tier's candidates on other providers (`--also`), one per provider.
    const alternates: Partial<Record<CandidateTier, RouteCandidate[]>> = {};
    let primary: { light: RouteCandidate | null; strong: RouteCandidate | null } = { light: light.light, strong: strong.strong };
    for (const tier of (phase === "build" ? ["light", "routine", "strong"] : ["routine", "strong"]) as CandidateTier[]) {
      const read = alternatesOf(phase, tier);
      if (!read.ok) return { ok: false, phase, problem: read.problem };
      const own = tier === "routine" ? routine.routine : primary[tier];
      // With no candidate of its own, a tier's first alternate stands as it.
      const list = own === null ? read.alternates.slice(1) : read.alternates.filter(one => one.provider !== own.provider);
      if (own === null && read.alternates[0] !== undefined) primary = { ...primary, [tier]: read.alternates[0] };
      if (list.length > 0) alternates[tier] = list;
    }
    out[phase] = {
      routine: routine.routine,
      strong: primary.strong,
      ...(primary.light === null ? {} : { light: primary.light }),
      ...(Object.keys(alternates).length === 0 ? {} : { alternates }),
    };
  }
  // Repair: the configured row is optional (inherit is the law when none
  // exists), but a row that EXISTS must be exact — a provider the policy
  // can hold against the build's, and a model id.
  const repairProject = repo === null ? null : store.phaseConfig(repo, "repair");
  const repairRow = repairProject ?? store.phaseConfig(INSTALLATION_SCOPE, "repair");
  const repairSource = repairProject !== null ? "project" : "installation";
  let repairRoutine: RouteCandidate | null = null;
  if (repairRow !== null) {
    if (!isProviderId(repairRow.provider) || repairRow.model === null || repairRow.model === "") {
      return { ok: false, phase: "repair", problem: `the ${repairSource} repair configuration names ${repairRow.provider}${repairRow.model === null || repairRow.model === "" ? " with no model" : ` · ${repairRow.model}`} — approvals bind exact routing: \`config set repair --provider … --model …\` names an exact pair, or clear it so repairs inherit the build agent` };
    }
    const valid = validateSpec({ provider: repairRow.provider, model: repairRow.model });
    if (!valid.ok) return { ok: false, phase: "repair", problem: `the ${repairSource} repair configuration: ${valid.problem}` };
    repairRoutine = { provider: repairRow.provider, model: repairRow.model, source: repairSource };
  }
  const repairStrong = strongOf("repair");
  if (!repairStrong.ok) return { ok: false, phase: "repair", problem: repairStrong.problem };
  out.repair = { routine: repairRoutine, strong: repairStrong.strong };
  return { ok: true, candidates: out as RouteCandidates };
}

/** A task's pinned pair as an EXACT spec, or the words for why it cannot
 * route: a pin with no model id binds nothing exact. */
export function exactPinOf(provider: string | null, model: string | null, phase: "plan" | "build"): { ok: true; pin: ExactSpec | null } | { ok: false; problem: string } {
  if (provider === null) return { ok: true, pin: null };
  if (!isProviderId(provider)) return { ok: false, problem: `the task's ${phase} pin names unknown provider \`${provider}\`` };
  if (model === null || model === "") {
    return { ok: false, problem: phase === "plan" ? `the plan pin names ${provider} with no exact model — \`task plan <id> --provider ${provider} --model <model>\` names one` : `the task's build pin names ${provider} with no exact model — approvals bind exact routing` };
  }
  // An exact pin is an exact ID: a stored model that is not argv-safe (a
  // leading dash, whitespace, a control byte) files the scope unresolved
  // in words rather than riding into a route or a spawn.
  if (!exactModelId(model)) {
    return { ok: false, problem: `the task's ${phase} pin names ${provider} with a model that is not an exact id — re-pin it with an exact model id` };
  }
  return { ok: true, pin: { provider, model } };
}

/**
 * THE ROUTE A TASK RUNS UNDER, for dispatch and every surface:
 *
 *   approved   — the sealed route when the approval stands (authoritative;
 *                mutable configuration never rewrites it);
 *   proposed   — the WORKING proposed route the next approval would seal;
 *   live       — no scope yet (a plan request): a live recommendation from
 *                the task's own risk, overrides, and pins over today's
 *                configuration;
 *   legacy     — a row PROVEN to predate v47 (no route era): its sealed
 *                profile alone governs the build; plan and review resolve
 *                from configuration at run time, and the surfaces say so;
 *   unreadable — a routed row whose route data is missing, malformed, or
 *                does not verify against its approval, or a task whose
 *                configuration cannot make an exact route: FAIL CLOSED,
 *                with the words. Nothing dispatches on it.
 *
 * `source` says which, so a surface never presents a live recommendation
 * as a sealed term and a runner never runs a legacy road on a routed row.
 */
export type TaskRoute =
  | { kind: "route"; route: PhaseRoute; source: "approved" | "proposed" | "live" }
  | { kind: "legacy"; profile: ExecutionProfile; approved: boolean }
  | { kind: "unreadable"; problem: string };

export function routeOfTask(store: Store, taskId: string, ref: TaskRef | null, now: Date): TaskRoute | null {
  const sealed = store.sealedRouteOf(taskId);
  if (sealed.ok) return { kind: "route", route: sealed.route, source: "approved" };
  const scope = store.getScope(taskId);
  if (scope !== null) {
    if (scope.routeEra == null) {
      const profile = scope.approvedProfile ?? scope.profile ?? null;
      return profile === null ? null : { kind: "legacy", profile, approved: sealed.reason !== "unapproved" && scope.approvedAt !== null && scope.approvedDigest === scope.digest };
    }
    if (sealed.reason === "unreadable") return { kind: "unreadable", problem: sealed.detail };
    const proposed = routeFromJson(scope.proposedRouteJson ?? null);
    if (proposed !== null) return { kind: "route", route: proposed, source: "proposed" };
    return { kind: "unreadable", problem: scope.unresolvedReason ?? "the filed route cannot be read — re-file the scope" };
  }
  const repo = ref?.repo ?? null;
  const overrides = ref === null || ref.routeOverrides === undefined ? [] : ref.routeOverrides;
  if (overrides === null) return { kind: "unreadable", problem: "the task's recorded route overrides cannot be read — clear or re-record them with `task route`" };
  const planPin = exactPinOf(ref?.planProvider ?? null, ref?.planModel ?? null, "plan");
  if (!planPin.ok) return { kind: "unreadable", problem: planPin.problem };
  const buildPin = exactPinOf(ref?.agentProvider ?? null, ref?.agentModel ?? null, "build");
  if (!buildPin.ok) return { kind: "unreadable", problem: buildPin.problem };
  const candidates = resolveRouteCandidates(store, repo, { plan: planPin.pin, build: buildPin.pin });
  if (!candidates.ok) return { kind: "unreadable", problem: candidates.problem };
  const route = recommendRoute({
    risk: ref?.riskLevel ?? "routine",
    qualityMode: ref?.qualityMode ?? store.qualityDefault().mode,
    evidence: [],
    publication: store.publicationAuthorityOf(repo, now),
    candidates: candidates.candidates,
    overrides,
    pins: { plan: planPin.pin, build: buildPin.pin },
    size: ref?.sizing ?? null,
    headroom: store.planHeadroom(now),
  });
  return { kind: "route", route, source: "live" };
}

// ---- routine authority (v48) ---------------------------------------------

/**
 * THE ROUTINE'S FROZEN AUTHORITY, resolved once at filing: the four-role
 * route a routine's firings will run under, and the execution profile that
 * restates its build and repair legs exactly. Routine tasks declare routine
 * risk; the rubric's evidence needs, the installation's quality default,
 * and the repository's publication authority are the other signed inputs.
 * A configuration that cannot make an exact, runnable route answers with
 * the words — the routine files unresolved and cannot be approved until
 * it is filed again under a configuration that can.
 */
export type RoutineAuthority =
  | { ok: true; route: PhaseRoute; profile: ExecutionProfile }
  | { ok: false; problem: string };

export function resolveRoutineAuthority(store: Store, repo: string, acceptance: readonly AcceptanceCriterion[], now: Date): RoutineAuthority {
  const candidates = resolveRouteCandidates(store, repo);
  if (!candidates.ok) return { ok: false, problem: candidates.problem };
  const route = recommendRoute({
    risk: "routine",
    qualityMode: store.qualityDefault().mode,
    evidence: [...new Set(acceptance.flatMap(one => one.evidence))] as RouteEvidenceKind[],
    publication: store.publicationAuthorityOf(repo, now),
    candidates: candidates.candidates,
    overrides: [],
  });
  const problems = routeProblems(route);
  if (problems.length > 0) return { ok: false, problem: problems.join("; ") };
  const build = legOf(route, "build");
  const repair = legOf(route, "repair");
  // The repair model rides as a flag only when the leg says more than
  // "the build's own model" — an inheriting repair stays the stable
  // literal "inherit" (= the exact build model), as saveScope files it.
  const inheriting = candidates.candidates.repair.routine === null && repair.chosen === "recommended" && repair.tier === "routine" && repair.model === build.model;
  const resolved = resolveScopeProfile(store, repo, undefined, { provider: build.provider, model: build.model, ...(inheriting ? {} : { repairModel: repair.model }) });
  if (!resolved.ok) return { ok: false, problem: resolved.problem };
  const repairModel = resolved.profile.repairModel === "inherit" ? resolved.profile.model : resolved.profile.repairModel;
  if (!sameSpec(resolved.profile, build) || repairModel !== repair.model) {
    return { ok: false, problem: `the agent profile (${resolved.profile.provider} · ${resolved.profile.model}, repair ${repairModel}) does not match the route (${build.provider} · ${build.model}, repair ${repair.model})` };
  }
  return { ok: true, route, profile: resolved.profile };
}

// ---- the operator's agent choices (v48) -----------------------------------

/** One agent a surface shows for one role: an exact pair, where it comes
 * from, whether it is the role's current leg, and whether it can be
 * CHOSEN — only a pair the active configuration names for this role is
 * selectable; a current leg the configuration no longer names is shown
 * for what runs today and nothing more. */
export type AgentChoice = ExactSpec & { source: string; current: boolean; selectable: boolean };

/**
 * THE ROLE'S CONFIGURED CHOICES (v48), simple and role-specific: for each
 * role, exactly the exact pairs the active configuration names FOR THAT
 * ROLE — its everyday agent and its strong agent — and nothing borrowed
 * from another role. Repair runs only the build leg's provider (repairs
 * resume the builder's session): its choices are the configured repair
 * rows on that provider plus the build role's own configured agents on
 * it, so an operator can keep repairs on the builder without naming a
 * repair row. Gemini never reviews. Nothing is typed free-hand and
 * nothing unconfigured is selectable: an approval binds an exact agent
 * the operator named once, in configuration.
 *
 * The role's CURRENT leg rides along marked `current`; when the
 * configuration no longer names it (a stale override, a routine's pin)
 * it is display-only — `selectable: false` — so a surface can say what
 * runs today without offering to re-pick it. Empty when the
 * configuration cannot make exact candidates at all; the surface then
 * says so instead of guessing.
 */
export function agentChoicesFor(store: Store, repo: string | null, route: PhaseRoute | null): Record<Phase, AgentChoice[]> {
  const empty: Record<Phase, AgentChoice[]> = { plan: [], build: [], repair: [], review: [] };
  const candidates = resolveRouteCandidates(store, repo);
  if (!candidates.ok) return empty;
  const buildProvider = route === null ? candidates.candidates.build.routine.provider : legOf(route, "build").provider;
  const configuredFor = (phase: Phase): RouteCandidate[] => {
    const tiers = candidates.candidates[phase];
    const everyOf = (one: RouteCandidates["build"]): (RouteCandidate | null)[] => [
      one.light ?? null,
      one.routine,
      one.strong,
      ...Object.values(one.alternates ?? {}).flatMap(list => [...(list ?? [])]),
    ];
    const own: (RouteCandidate | null)[] = phase === "repair"
      ? [tiers.routine, tiers.strong, ...everyOf(candidates.candidates.build)]
      : phase === "review" ? [tiers.routine, tiers.strong] : everyOf(candidates.candidates[phase]);
    const out: RouteCandidate[] = [];
    for (const one of own) {
      if (one === null || out.some(seen => sameSpec(seen, one))) continue;
      if (phase === "review" && one.provider === "gemini") continue;
      if (phase === "repair" && one.provider !== buildProvider) continue;
      if (!validateSpec({ provider: one.provider, model: one.model }).ok) continue;
      out.push(one);
    }
    return out;
  };
  const out: Record<Phase, AgentChoice[]> = { plan: [], build: [], repair: [], review: [] };
  for (const phase of PHASES.filter(one => one !== "review")) {
    const current = route === null ? null : legOf(route, phase);
    const offered = configuredFor(phase).map(one => ({ provider: one.provider, model: one.model, source: one.source, current: current !== null && sameSpec(current, one), selectable: true }));
    if (current !== null && !offered.some(one => sameSpec(one, current))) {
      offered.push({ provider: current.provider, model: current.model, source: "this task's current agent — not in today's configuration", current: true, selectable: false });
    }
    out[phase] = offered;
  }
  return out;
}
