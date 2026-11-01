/**
 * Settings → Models, the one write path (docs/plans/spend-dashboard.md, slice 3): which model each role uses at the
 * installation or one project, changed in one transaction, ledgered before → after per row (clears included), and
 * never touching sealed work. Presets (D5: "Sized by job", "Opus for everything") and "Switch to it" are changes like
 * any other: their exact diff is shown first and the apply carries its digest.
 *
 * Model choices apply to NEW filings only. Nothing here reads or writes a scope, its approved profile or digest, a run
 * route, an approval, a mode's terms, or a routine's or standing order's pin: those were sealed at filing.
 */
import { createHash } from "node:crypto";
import { isAcpProvider } from "./acp-agents.js";
import { INSTALLATION_SCOPE, resolvePhaseAgent, resolveRouteCandidates } from "./agentconfig.js";
import { seenModels, type SeenModel } from "./model-catalog.js";
import { passwordlessOn } from "./passwordless.js";
import { exactModelId, recommendRoute, routeProblems, type PhaseRoute, type RouteCandidates } from "./phase-routing.js";
import { isProviderId, validateSpec } from "./provider.js";
import type { Store } from "./store.js";

export type SlotPhase = "plan" | "build" | "repair" | "review";
export type SlotTier = "routine" | "light" | "strong";
export type Slot = { phase: SlotPhase; tier: SlotTier };
export type Pair = { provider: string; model: string | null };
/** One row to set (an exact pair) or clear (null). */
/** A model is null only on the command line's `config set <phase> --provider p` (its harness default). */
export type ModelChange = { slot: Slot; to: { provider: string; model: string | null } | null };

/** Every row the editor owns, in the order the page and the diff show them. Alternates (`--also`) and the strong
 * repair row stay CLI-only; presets clear the strong repair row so repairs follow the builder. */
export const SLOTS: readonly Slot[] = Object.freeze([
  { phase: "plan", tier: "routine" }, { phase: "plan", tier: "strong" },
  { phase: "build", tier: "light" }, { phase: "build", tier: "routine" }, { phase: "build", tier: "strong" },
  { phase: "repair", tier: "routine" }, { phase: "review", tier: "routine" }, { phase: "review", tier: "strong" },
]);

/** Every row the write path accepts: the editor's, plus the strong repair row the CLI also sets. */
export const ALL_SLOTS: readonly Slot[] = Object.freeze([
  ...SLOTS.slice(0, 6), { phase: "repair", tier: "strong" }, ...SLOTS.slice(6),
] as Slot[]);
const order = (slot: Slot): number => ALL_SLOTS.findIndex(one => one.phase === slot.phase && one.tier === slot.tier);

export const slotKey = (slot: Slot): string => slot.tier === "routine" ? slot.phase : `${slot.phase}-${slot.tier}`;
export function slotOf(key: string): Slot | null {
  return SLOTS.find(one => slotKey(one) === key) ?? null;
}

/** The role in plain words. */
export function slotWords(slot: Slot): string {
  if (slot.phase === "build") return slot.tier === "light" ? "Builder for small tasks" : slot.tier === "strong" ? "Builder for large or risky tasks" : "Builder for routine tasks";
  if (slot.phase === "plan") return slot.tier === "strong" ? "Planner for large or risky tasks" : "Planner";
  const role = slot.phase === "repair" ? "Repair" : "Reviewer";
  return slot.tier === "strong" ? `${role} for large or risky tasks` : role;
}

export function rowAt(store: Store, scope: string, slot: Slot): Pair | null {
  const row = slot.tier === "routine" ? store.phaseConfig(scope, slot.phase) : store.phaseTierConfig(scope, slot.phase, slot.tier);
  return row === null ? null : { provider: row.provider, model: row.model };
}

const samePair = (a: Pair | null, b: Pair | null): boolean => a === null || b === null ? a === b : a.provider === b.provider && a.model === b.model;
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Every value the editor shows for a scope: its own rows and, for a project, the installation rows it inherits, and
 * the alternates described in words. A change to any of them makes an open form stale. */
export function stateDigest(store: Store, scope: string): string {
  const rows = (one: string) => ({
    slots: ALL_SLOTS.map(slot => [slotKey(slot), rowAt(store, one, slot)]),
    also: store.listPhaseTierAlternates(one).map(row => [row.phase, row.tier, row.provider, row.model]),
  });
  return sha({ scope, installation: rows(INSTALLATION_SCOPE), project: scope === INSTALLATION_SCOPE ? null : rows(scope) });
}

/** The exact change a preview showed: its target and every set and clear, in slot order. */
export function changeDigest(scope: string, change: readonly ModelChange[]): string {
  const ordered = [...change].sort((a, b) => order(a.slot) - order(b.slot));
  return sha({ scope, change: ordered.map(one => [slotKey(one.slot), one.to === null ? null : [one.to.provider, one.to.model]]) });
}

export type DiffRow = { slot: Slot; before: Pair | null; after: Pair | null };
/** What a preview showed: the scope and every row's before → after. Bound into the apply, so a row that moved in
 * between, or a change the preview never showed, is refused. */
export function diffDigest(scope: string, diff: readonly DiffRow[]): string {
  return sha({ scope, diff: diff.map(row => [slotKey(row.slot), row.before, row.after]) });
}
/** A preview read from ONE snapshot: the rows it moves, what a cleared project row would inherit, and both digests
 * the apply must match. */
export function previewModelChange(store: Store, scope: string, change: readonly ModelChange[]): { rows: (DiffRow & { inherited: Pair | null })[]; state: string; change: string } {
  return store.transact(() => {
    const diff = diffOf(store, scope, change);
    return {
      rows: diff.map(row => ({ ...row, inherited: scope === INSTALLATION_SCOPE ? null : rowAt(store, INSTALLATION_SCOPE, row.slot) })),
      state: stateDigest(store, scope), change: diffDigest(scope, diff),
    };
  });
}
/** The rows this change really moves (a set to the value already there is no change). */
export function diffOf(store: Store, scope: string, change: readonly ModelChange[]): DiffRow[] {
  return ALL_SLOTS.flatMap(slot => {
    const wanted = change.find(one => slotKey(one.slot) === slotKey(slot));
    if (wanted === undefined) return [];
    const before = rowAt(store, scope, slot);
    const after = wanted.to === null ? null : { provider: wanted.to.provider, model: wanted.to.model };
    return samePair(before, after) ? [] : [{ slot, before, after }];
  });
}

// ---- presets (owner decision D5, 2026-10-31) -------------------------------

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
export type PresetName = "sized" | "opus";
export const PRESETS: Record<PresetName, { label: string; words: string; rows: Record<string, string | null> }> = {
  sized: {
    label: "Sized by job",
    words: "Small tasks build on Haiku 5.5, routine tasks on Sonnet 5.5, large or risky tasks on Opus 5.5. Planning and review always use Opus 5.5.",
    rows: { plan: OPUS, "plan-strong": OPUS, "build-light": HAIKU, build: SONNET, "build-strong": OPUS, repair: null, "repair-strong": null, review: OPUS, "review-strong": OPUS },
  },
  opus: {
    label: "Opus for everything",
    words: "Every task plans, builds and is reviewed on Opus 5.5, whatever its size.",
    rows: { plan: OPUS, "plan-strong": OPUS, "build-light": OPUS, build: OPUS, "build-strong": OPUS, repair: null, "repair-strong": null, review: OPUS, "review-strong": OPUS },
  },
};
export const DEFAULT_PRESET: PresetName = "sized";
export const isPresetName = (value: string | null): value is PresetName => value === "sized" || value === "opus";

/** A preset as a change: every slot, as exact Claude ids, never an alias. Repair rows are cleared so repairs follow
 * the builder of each size. */
export function presetChange(name: PresetName): ModelChange[] {
  return ALL_SLOTS.map(slot => {
    const model = PRESETS[name].rows[slotKey(slot)];
    return { slot, to: model === null || model === undefined ? null : { provider: "claude", model } };
  });
}

/** The routes a task filed now would get at a scope, for every size and demand that picks a tier (inheritance,
 * review following the planner, and repair following each size's builder included), or the words for why none can. */
export const ROUTE_CASES: readonly { label: string; size: "small" | "medium" | "large"; risky: boolean; strict: boolean }[] = Object.freeze([
  { label: "small", size: "small", risky: false, strict: false }, { label: "routine", size: "medium", risky: false, strict: false },
  { label: "large", size: "large", risky: false, strict: false }, { label: "risky", size: "small", risky: true, strict: false },
  { label: "strict", size: "medium", risky: false, strict: true },
]);
export function effectiveRoutes(store: Store, repo: string | null): { ok: true; routes: { label: string; route: PhaseRoute }[] } | { ok: false; problem: string } {
  const candidates = resolveRouteCandidates(store, repo);
  if (!candidates.ok) return { ok: false, problem: candidates.problem };
  return { ok: true, routes: routesOf(candidates.candidates) };
}
/** Every size's and demand's route over these candidates. (A build moved to another provider for plan headroom takes
 * its repairs with it, so that move can't break a repair; a tier whose only candidate is another provider's is its
 * primary here, and checked.) */
function routesOf(candidates: RouteCandidates): { label: string; route: PhaseRoute }[] {
  const routes = ROUTE_CASES.map(one => ({ label: one.label, route: recommendRoute({ qualityMode: one.strict ? "strict" : "default", evidence: [], publication: "none",
    candidates, overrides: [], size: { size: one.size, risky: one.risky, source: "heuristic", reason: "" } }) }));
  return routes;
}

/** Which preset a scope's EFFECTIVE configuration matches (what each size would really run, inherited rows
 * included), or null ("a custom set"). */
export function presetInUse(store: Store, scope: string): PresetName | null {
  const effective = effectiveRoutes(store, scope === INSTALLATION_SCOPE ? null : scope);
  if (!effective.ok) return null;
  const legs = (label: string) => effective.routes.find(one => one.label === label)!.route.legs;
  const model = (label: string, phase: string) => legs(label).find(leg => leg.phase === phase);
  const want: Record<PresetName, Record<string, string>> = { sized: { small: HAIKU, routine: SONNET, large: OPUS, risky: OPUS, strict: OPUS }, opus: { small: OPUS, routine: OPUS, large: OPUS, risky: OPUS, strict: OPUS } };
  for (const name of ["sized", "opus"] as const) {
    const fits = ROUTE_CASES.every(one => {
      const build = model(one.label, "build"), repair = model(one.label, "repair"), plan = model(one.label, "plan"), review = model(one.label, "review");
      return build?.provider === "claude" && build.model === want[name][one.label] && repair?.model === build.model
        && plan?.provider === "claude" && plan.model === OPUS && review?.provider === "claude" && review.model === OPUS;
    });
    if (fits) return name;
  }
  return null;
}

/** "Switch to it": every row at this scope that names `from` names `to` instead. */
export function switchChange(store: Store, scope: string, from: string, to: string): ModelChange[] {
  return SLOTS.flatMap(slot => {
    const row = rowAt(store, scope, slot);
    return row !== null && row.provider === "claude" && row.model === from ? [{ slot, to: { provider: "claude", model: to } }] : [];
  });
}

const FAMILY = /^claude-(opus|sonnet|haiku|fable)-/;
/** For each exact Claude id this scope uses, the newest model of its family the watch has seen, when that is newer. */
export function newerModels(store: Store, scope: string): { from: string; to: SeenModel; slots: Slot[] }[] {
  const seen = seenModels(store, "claude");
  const used = new Map<string, Slot[]>();
  for (const slot of SLOTS) {
    const row = rowAt(store, scope, slot);
    if (row?.provider === "claude" && row.model !== null && FAMILY.test(row.model)) used.set(row.model, [...used.get(row.model) ?? [], slot]);
  }
  return [...used].flatMap(([from, slots]) => {
    const family = FAMILY.exec(from)![1];
    const current = seen.find(one => one.id === from) ?? null;
    const newest = seen.filter(one => one.id.startsWith(`claude-${family}-`) && one.releasedAt !== null)
      .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""))[0];
    if (newest === undefined || newest.id === from || !exactModelId(newest.id)) return [];
    if (current !== null && current.releasedAt !== null && newest.releasedAt! <= current.releasedAt) return [];
    return [{ from, to: newest, slots }];
  });
}

// ---- the one write path ------------------------------------------------------

/** Who is acting, proved by the caller's own step-up, and re-proved here inside the transaction: the same account,
 * still active, still an unrestricted instance operator, at the credential generation the proof was made under, on a
 * session (or local CLI login) that is still live. */
export type ModelAuthority = {
  actor: string;
  /** The credential generation the proof was checked against (read before the proof, never after). */
  generation: number;
  /** How the person proved it (scope.ts AuthMethod): a Passwordless session or remembered CLI login stands only while
   * Passwordless is still on, and is re-checked here. */
  method: string;
  live: () => boolean;
};
const PERSON_PROOFS = new Set(["password-now", "sso-now", "session", "cli-login"]);
export type ApplyInput = {
  scope: string;
  change: readonly ModelChange[];
  /** The state a page showed, and (for a preview) the exact change it showed; null on the command line, which shows
   * nothing before it writes. */
  expected: { state: string; change?: string } | null;
  /** The console: exact ids only. The CLI may also name a floating name, or a routine row with no model. The
   * resulting configuration is checked the same way for both. */
  strict: boolean;
  knownProject: (repo: string) => boolean;
  /** The command line's other rows, under the same proof, target and result checks: another provider's candidate on
   * a tier (`--also`), and removing a light planner left from before light became build-only. */
  extra?: readonly ExtraWrite[];
};
export type ExtraWrite =
  | { kind: "also-set"; phase: "plan" | "build"; tier: SlotTier; provider: string; model: string }
  | { kind: "also-clear"; phase: "plan" | "build"; tier: SlotTier; provider: string | null }
  | { kind: "legacy-light-clear"; phase: SlotPhase };
export type ApplyRefusal = { ok: false; reason: "authority" | "unknown-project" | "stale" | "invalid"; problem: string };
export type ApplyResult = { ok: true; diff: DiffRow[]; unresolved: string | null; extra: number } | ApplyRefusal;

class Refused extends Error { constructor(readonly refusal: ApplyRefusal) { super(refusal.problem); } }

/** Why one row can't be written as asked, or null. */
function rowProblem(change: ModelChange, strict: boolean): string | null {
  const { slot, to } = change;
  if (order(slot) < 0) return "Only the builder has a small-task model.";
  if (to === null) return null;
  if (!isProviderId(to.provider)) return `${slotWords(slot)}: choose a known provider.`;
  const valid = validateSpec({ provider: to.provider, model: to.model });
  if (!valid.ok) return `${slotWords(slot)}: ${valid.problem}`;
  if (to.model === null && (strict || slot.tier !== "routine")) return `${slotWords(slot)}: choose an exact model.`;
  if (to.model !== null && !exactModelId(to.model)) return `${slotWords(slot)}: choose an exact model.`;
  if ((slot.phase === "plan" || slot.phase === "review") && isAcpProvider(to.provider)) return `${slotWords(slot)}: this agent builds and repairs only. Choose Claude or Codex.`;
  if (strict && slot.phase === "review" && to.provider === "gemini") return "Gemini cannot review yet. Choose Claude or Codex.";
  return null;
}

/** Projects with rows of their own: an installation change reaches them through inheritance. */
function projectsWithRows(store: Store): string[] {
  return (store.handle.prepare(`SELECT scope FROM phase_config WHERE scope != ? UNION SELECT scope FROM phase_tier_config WHERE scope != ?
    UNION SELECT scope FROM phase_tier_alternate WHERE scope != ? ORDER BY scope`).all(INSTALLATION_SCOPE, INSTALLATION_SCOPE, INSTALLATION_SCOPE) as { scope: string }[]).map(one => String(one.scope));
}

export type ScopeCheck = { kind: "ok" } | { kind: "incomplete" | "invalid"; problem: string };
/**
 * Whether tasks can be filed at a scope with its resulting configuration. INCOMPLETE: a role has no exact model yet
 * (setup in progress; saved, and said). INVALID: something set can't run: an unknown provider, an ineligible reviewer,
 * or a route of any size or demand (small, routine, large, risky, strict) whose repair can't resume its builder,
 * inherited rows included. An invalid result is never saved.
 */
export function checkScope(store: Store, repo: string | null): ScopeCheck {
  const build = resolvePhaseAgent(store, "build", repo, {});
  if (!build.ok) return { kind: "invalid", problem: build.problem };
  const plan = resolvePhaseAgent(store, "plan", repo, {});
  if (!plan.ok) return { kind: "invalid", problem: plan.problem };
  // The reviewer is not checked here: an unset reviewer follows the planner, and routing deliberately never lets a
  // reviewer setting stop a task from planning or building (agentconfig.ts resolveRouteCandidates; that leg never
  // runs). So a Gemini planner with no reviewer of its own stays a valid configuration. A reviewer row written here is
  // still refused when an ACP agent, and in the editor when Gemini (rowProblem).
  const repair = (repo === null ? null : store.phaseConfig(repo, "repair")) ?? store.phaseConfig(INSTALLATION_SCOPE, "repair");
  if (repair !== null && repair.provider !== build.spec.provider) return { kind: "invalid", problem: `Repairs must use the builder's provider (${build.spec.provider}).` };
  // What is configured is checked first, with a stand-in for any role that has no model yet, so a missing planner
  // never hides a repair that can't resume its builder: every size's and demand's route, inherited rows included.
  const standIn = (spec: { provider: string; model: string | null }) => isProviderId(spec.provider) ? { provider: spec.provider, model: spec.model ?? "not-chosen-yet" } : null;
  const configured = resolveRouteCandidates(store, repo, { plan: standIn(plan.spec), build: standIn(build.spec) });
  if (!configured.ok) return { kind: /has no exact model/.test(configured.problem) ? "incomplete" : "invalid", problem: configured.problem };
  for (const route of routesOf(configured.candidates)) {
    const problems = routeProblems(route.route);
    if (problems.length > 0) return { kind: "invalid", problem: `${route.label} tasks: ${problems[0]}` };
  }
  const effective = effectiveRoutes(store, repo);
  if (!effective.ok) return { kind: /has no exact model/.test(effective.problem) ? "incomplete" : "invalid", problem: effective.problem };
  return { kind: "ok" };
}
/** A resolver's words for a browser: what is wrong, never a terminal command to fix it. */
export function browserWords(problem: string): string {
  const said = problem.split(" — ")[0]!.replace(/`[^`]*`/g, "").replace(/\s+([:;,.])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return said.length === 0 ? "This choice can't run." : `${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? "" : "."}`;
}

/** The problem alone, or null when tasks can be filed. */
export function scopeProblem(store: Store, repo: string | null): string | null {
  const checked = checkScope(store, repo);
  return checked.kind === "ok" ? null : checked.problem;
}

const pairWords = (pair: Pair | null): string => pair === null ? "not set" : `${pair.provider} · ${pair.model ?? "its default model"}`;
const ACTION_OF = (slot: Slot): string => slot.tier === "routine" ? `agent for ${slot.phase} changed` : `${slot.tier} agent for ${slot.phase} changed`;

/**
 * Apply one change in ONE transaction: re-prove the actor, check the target and that nothing moved since the person
 * looked, check every row, write every set and clear, check the resulting configuration (no scope it reaches, the
 * target or a project inheriting from it, may stop resolving), and ledger before → after for each row. Any refusal
 * rolls everything back: a preset that fails on its last row writes nothing.
 */
export function applyModelChoices(store: Store, input: ApplyInput, authority: ModelAuthority, now: Date): ApplyResult {
  try {
    return store.transact(() => {
      // A savepoint, so a refusal rolls back these writes even inside a caller's transaction (project setup).
      store.handle.exec("SAVEPOINT model_choices");
      try {
        const result = applyLocked(store, input, authority, now);
        store.handle.exec("RELEASE model_choices");
        return result;
      } catch (error) {
        store.handle.exec("ROLLBACK TO model_choices");
        store.handle.exec("RELEASE model_choices");
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

function applyLocked(store: Store, input: ApplyInput, authority: ModelAuthority, now: Date): { ok: true; diff: DiffRow[]; unresolved: string | null; extra: number } {
  {
    {
      const account = store.accountOf(authority.actor);
      const standsNow = PERSON_PROOFS.has(authority.method) && ((authority.method !== "session" && authority.method !== "cli-login") || passwordlessOn(store));
      if (account === null || account.revokedAt !== null || account.generation !== authority.generation || !store.isInstanceOperator(authority.actor) || !authority.live() || !standsNow) {
        throw new Refused({ ok: false, reason: "authority", problem: "Only an instance operator, signed in now, can change models." });
      }
      const scope = input.scope;
      if (scope !== INSTALLATION_SCOPE && !input.knownProject(scope)) throw new Refused({ ok: false, reason: "unknown-project", problem: "That isn't a project here." });
      // A page's form or preview: refused when what it showed moved since. The command line shows nothing first
      // (`expected: null`): its change applies to the rows as they stand inside this transaction, and the result is
      // checked below against exactly those rows, so concurrent command-line writers serialize instead of refusing.
      if (input.expected !== null) {
        if (stateDigest(store, scope) !== input.expected.state) throw new Refused({ ok: false, reason: "stale", problem: "Models changed since this page loaded. Nothing was saved. Review the current choices and try again." });
        if (input.expected.change !== undefined && diffDigest(scope, diffOf(store, scope, input.change)) !== input.expected.change) throw new Refused({ ok: false, reason: "stale", problem: "This change is not the one you reviewed. Nothing was saved." });
      }
      const keys = input.change.map(one => slotKey(one.slot));
      if (new Set(keys).size !== keys.length) throw new Refused({ ok: false, reason: "invalid", problem: "Each role can change once per save." });
      for (const one of input.change) {
        const problem = rowProblem(one, input.strict);
        if (problem !== null) throw new Refused({ ok: false, reason: "invalid", problem });
      }
      const affected: (string | null)[] = scope === INSTALLATION_SCOPE ? [null, ...projectsWithRows(store)] : [scope];
      const before = new Map(affected.map(repo => [repo, checkScope(store, repo).kind]));
      const diff = diffOf(store, scope, input.change);
      const repo = scope === INSTALLATION_SCOPE ? null : scope;
      for (const row of diff) {
        const { slot, after } = row;
        if (slot.tier === "routine") {
          // setPhaseConfig keeps its own before → after entry.
          if (after !== null) { store.setPhaseConfig(scope, slot.phase, after.provider, after.model, authority.actor, now); continue; }
          store.clearPhaseConfig(scope, slot.phase);
        } else if (after !== null) {
          store.setPhaseTierConfig(scope, slot.phase, slot.tier, after.provider, after.model, authority.actor, now);
        } else {
          store.clearPhaseTierConfig(scope, slot.phase, slot.tier);
        }
        store.recordAction({ at: now.toISOString(), actor: authority.actor, repo, taskId: null, runId: null, action: ACTION_OF(slot), outcome: "changed", source: "policy", detail: `${pairWords(row.before)} → ${pairWords(after)}` });
      }
      let extra = 0;
      for (const op of input.extra ?? []) extra += extraWrite(store, scope, repo, op, authority.actor, now);
      // INVALID is never saved, for the target or any project inheriting from it. INCOMPLETE (a role with no exact
      // model yet) is saved and said for the target; another project that could file tasks before must still.
      let unresolved: string | null = null;
      for (const target of affected) {
        const checked = checkScope(store, target);
        if (checked.kind === "ok") continue;
        const where = target === repo ? "" : `${target} would stop working: `;
        if (checked.kind === "invalid" || (target !== repo && before.get(target) === "ok")) {
          throw new Refused({ ok: false, reason: "invalid", problem: `Nothing was saved: ${where}${checked.problem}` });
        }
        if (target === repo) unresolved = checked.problem;
      }
      return { ok: true as const, diff, unresolved, extra };
    }
  }
}

// ---- what the page shows besides the editor ------------------------------------

export type RecentRun = { runId: number; taskId: string; role: string; chosen: string | null; ranOn: string | null; at: string };
/** The latest runs' floating or exact choice next to the model their provider reported: no verdict. */
export function recentRuns(store: Store, limit = 8): RecentRun[] {
  return (store.handle.prepare(`SELECT run.id, task_ref.external_id, run.role, run.model, run.model_reported, run.started_at FROM run
    JOIN task_ref ON task_ref.id = run.task_ref ORDER BY run.started_at DESC, run.id DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 50))) as Record<string, unknown>[])
    .map(row => ({ runId: Number(row["id"]), taskId: String(row["external_id"]), role: String(row["role"]), chosen: row["model"] == null ? null : String(row["model"]),
      ranOn: row["model_reported"] == null ? null : String(row["model_reported"]), at: String(row["started_at"]) }));
}

/** One of the command line's other rows, ledgered; how many rows it changed. */
function extraWrite(store: Store, scope: string, repo: string | null, op: ExtraWrite, actor: string, now: Date): number {
  const ledger = (action: string, detail: string) => store.recordAction({ at: now.toISOString(), actor, repo, taskId: null, runId: null, action, outcome: "changed", source: "policy", detail });
  if (op.kind === "legacy-light-clear") {
    const before = store.phaseTierConfig(scope, op.phase, "light");
    if (before === null || !store.clearPhaseTierConfig(scope, op.phase, "light")) return 0;
    ledger(`light agent for ${op.phase} changed`, `${pairWords(before)} → not set`);
    return 1;
  }
  if (op.tier === "light" && op.phase !== "build") throw new Refused({ ok: false, reason: "invalid", problem: "Only the builder has a small-task model." });
  if (op.kind === "also-clear") {
    const before = store.phaseTierAlternates(scope, op.phase, op.tier).filter(row => op.provider === null || row.provider === op.provider);
    const removed = store.clearPhaseTierAlternates(scope, op.phase, op.tier, op.provider);
    for (const row of before) ledger(`other-provider ${op.tier} agent for ${op.phase} changed`, `${pairWords(row)} → not set`);
    return removed;
  }
  if (!isProviderId(op.provider)) throw new Refused({ ok: false, reason: "invalid", problem: "Choose a known provider." });
  const valid = validateSpec({ provider: op.provider, model: op.model });
  if (!valid.ok || !exactModelId(op.model)) throw new Refused({ ok: false, reason: "invalid", problem: valid.ok ? "Choose an exact model." : valid.problem });
  const before = store.phaseTierAlternates(scope, op.phase, op.tier).find(row => row.provider === op.provider) ?? null;
  if (before !== null && before.model === op.model) return 0;
  store.setPhaseTierAlternate(scope, op.phase, op.tier, op.provider, op.model, actor, now);
  ledger(`other-provider ${op.tier} agent for ${op.phase} changed`, `${pairWords(before)} → ${pairWords({ provider: op.provider, model: op.model })}`);
  return 1;
}
