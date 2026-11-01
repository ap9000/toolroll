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
import { exactModelId } from "./phase-routing.js";
import { isProviderId, validateSpec } from "./provider.js";
import type { Store } from "./store.js";

export type SlotPhase = "plan" | "build" | "repair" | "review";
export type SlotTier = "routine" | "light" | "strong";
export type Slot = { phase: SlotPhase; tier: SlotTier };
export type Pair = { provider: string; model: string | null };
/** One row to set (an exact pair) or clear (null). */
export type ModelChange = { slot: Slot; to: { provider: string; model: string } | null };

/** Every row the editor owns, in the order the page and the diff show them. Alternates (`--also`) and the strong
 * reviewer and repair rows stay CLI-only and are never written here. */
export const SLOTS: readonly Slot[] = Object.freeze([
  { phase: "plan", tier: "routine" }, { phase: "plan", tier: "strong" },
  { phase: "build", tier: "light" }, { phase: "build", tier: "routine" }, { phase: "build", tier: "strong" },
  { phase: "repair", tier: "routine" }, { phase: "review", tier: "routine" },
]);

/** Every row the write path accepts: the editor's, plus the strong repair and reviewer rows the CLI also sets. */
export const ALL_SLOTS: readonly Slot[] = Object.freeze([
  ...SLOTS.slice(0, 6), { phase: "repair", tier: "strong" }, { phase: "review", tier: "routine" }, { phase: "review", tier: "strong" },
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
    rows: { plan: OPUS, "plan-strong": OPUS, "build-light": HAIKU, build: SONNET, "build-strong": OPUS, repair: null, review: OPUS },
  },
  opus: {
    label: "Opus for everything",
    words: "Every task plans, builds and is reviewed on Opus 5.5, whatever its size.",
    rows: { plan: OPUS, "plan-strong": OPUS, "build-light": null, build: OPUS, "build-strong": OPUS, repair: null, review: OPUS },
  },
};
export const DEFAULT_PRESET: PresetName = "sized";
export const isPresetName = (value: string | null): value is PresetName => value === "sized" || value === "opus";

/** A preset as a change: every slot it names, as exact Claude ids, never an alias. A clear lets repair follow the
 * builder, and lets small tasks use the routine builder. */
export function presetChange(name: PresetName): ModelChange[] {
  return SLOTS.map(slot => {
    const model = PRESETS[name].rows[slotKey(slot)];
    return { slot, to: model === null || model === undefined ? null : { provider: "claude", model } };
  });
}

/** Which preset the scope's own rows match exactly, or null ("Custom"). */
export function presetInUse(store: Store, scope: string): PresetName | null {
  for (const name of ["sized", "opus"] as const) {
    if (presetChange(name).every(one => samePair(rowAt(store, scope, one.slot), one.to))) return name;
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
export type ModelAuthority = { actor: string; generation: number; live: () => boolean };
export type ApplyInput = {
  scope: string;
  change: readonly ModelChange[];
  /** The state the person saw, and (for a preview) the exact change it showed. */
  expected: { state: string; change?: string };
  /** The console: exact ids, an eligible reviewer, and the resulting configuration checked. The CLI keeps its own
   * per-row checks. */
  strict: boolean;
  knownProject: (repo: string) => boolean;
};
export type ApplyRefusal = { ok: false; reason: "authority" | "unknown-project" | "stale" | "invalid"; problem: string };
export type ApplyResult = { ok: true; diff: DiffRow[]; unresolved: string | null } | ApplyRefusal;

class Refused extends Error { constructor(readonly refusal: ApplyRefusal) { super(refusal.problem); } }

/** Why one row can't be written as asked, or null. */
function rowProblem(change: ModelChange, strict: boolean): string | null {
  const { slot, to } = change;
  if (order(slot) < 0) return "Only the builder has a small-task model.";
  if (to === null) return null;
  if (!isProviderId(to.provider)) return `${slotWords(slot)}: choose a known provider.`;
  const valid = validateSpec({ provider: to.provider, model: to.model });
  if (!valid.ok) return `${slotWords(slot)}: ${valid.problem}`;
  if (strict && !exactModelId(to.model)) return `${slotWords(slot)}: choose an exact model.`;
  if ((slot.phase === "plan" || slot.phase === "review") && isAcpProvider(to.provider)) return `${slotWords(slot)}: this agent builds and repairs only. Choose Claude or Codex.`;
  if (strict && slot.phase === "review" && to.provider === "gemini") return "Gemini cannot review yet. Choose Claude or Codex.";
  return null;
}

/** Projects with rows of their own: an installation change reaches them through inheritance. */
function projectsWithRows(store: Store): string[] {
  return (store.handle.prepare(`SELECT scope FROM phase_config WHERE scope != ? UNION SELECT scope FROM phase_tier_config WHERE scope != ?
    UNION SELECT scope FROM phase_tier_alternate WHERE scope != ? ORDER BY scope`).all(INSTALLATION_SCOPE, INSTALLATION_SCOPE, INSTALLATION_SCOPE) as { scope: string }[]).map(one => String(one.scope));
}

/** Why a scope's resulting configuration can't file a task, or null: every phase resolves to an exact pair, the
 * reviewer is eligible, and repair runs on the effective builder's provider (inheritance included). */
export function scopeProblem(store: Store, repo: string | null): string | null {
  const candidates = resolveRouteCandidates(store, repo);
  if (!candidates.ok) return candidates.problem;
  const build = resolvePhaseAgent(store, "build", repo, {});
  if (!build.ok) return build.problem;
  const review = resolvePhaseAgent(store, "review", repo, {});
  if (!review.ok) return review.problem;
  const repair = (repo === null ? null : store.phaseConfig(repo, "repair")) ?? store.phaseConfig(INSTALLATION_SCOPE, "repair");
  if (repair !== null && repair.provider !== build.spec.provider) return `Repairs must use the builder's provider (${build.spec.provider}).`;
  return null;
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
      const account = store.accountOf(authority.actor);
      if (account === null || account.revokedAt !== null || account.generation !== authority.generation || !store.isInstanceOperator(authority.actor) || !authority.live()) {
        throw new Refused({ ok: false, reason: "authority", problem: "Only an instance operator, signed in now, can change models." });
      }
      const scope = input.scope;
      if (scope !== INSTALLATION_SCOPE && !input.knownProject(scope)) throw new Refused({ ok: false, reason: "unknown-project", problem: "That isn't a project here." });
      if (stateDigest(store, scope) !== input.expected.state) throw new Refused({ ok: false, reason: "stale", problem: "Models changed since this page loaded. Nothing was saved. Review the current choices and try again." });
      if (input.expected.change !== undefined && changeDigest(scope, input.change) !== input.expected.change) throw new Refused({ ok: false, reason: "stale", problem: "This change is not the one you reviewed. Nothing was saved." });
      const keys = input.change.map(one => slotKey(one.slot));
      if (new Set(keys).size !== keys.length) throw new Refused({ ok: false, reason: "invalid", problem: "Each role can change once per save." });
      for (const one of input.change) {
        const problem = rowProblem(one, input.strict);
        if (problem !== null) throw new Refused({ ok: false, reason: "invalid", problem });
      }
      // The CLI's own rows have always been allowed part-way (`config show` names what's missing); the console checks
      // the whole result.
      const affected: (string | null)[] = !input.strict ? [] : scope === INSTALLATION_SCOPE ? [null, ...projectsWithRows(store)] : [scope];
      const before = new Map(affected.map(repo => [repo, scopeProblem(store, repo)]));
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
      // A scope that could file tasks before must still file them after. One that couldn't yet (a new installation
      // part-way through choosing) may be saved, and the page says what is still missing.
      let unresolved: string | null = null;
      for (const target of affected) {
        const problem = scopeProblem(store, target);
        if (problem === null) continue;
        if (before.get(target) === null) {
          throw new Refused({ ok: false, reason: "invalid", problem: target === repo ? `Nothing was saved: ${problem}` : `Nothing was saved: ${target} would stop working: ${problem}` });
        }
        if (target === repo) unresolved = problem;
      }
      return { ok: true as const, diff, unresolved };
    });
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
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
