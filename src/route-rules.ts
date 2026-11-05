/**
 * Earned rules (docs/plans/results-routing.md, slice 2): suggesting a cheaper model from a project's own result
 * records, accepting it as a rule with a bounded switch-back grant, and the rule switching itself off when its sealed
 * terms trip. A rule is a separate layer: it never edits the owner's Models rows, and it routes only through the one
 * precedence order (phase-routing.ts selectBuildLeg). Every task is still approved, and its route stays sealed.
 *
 * Doors (Authority): accepting, keeping a paused rule and switching suggestions on take a person with a step-up;
 * turning a rule off, dropping a paused one, Not now and switching suggestions off also take this computer's local
 * owner inside exactly that act. A lead token or a remote API token is refused. The writer (route-store.ts) re-proves
 * the door inside the write's transaction.
 *
 * A policy path (release-auto.ts EVAL_POLICY): the thresholds, the grant's terms and the trigger decide when a model
 * routes and when it stops, so a change here needs a person.
 */
import { createHash } from "node:crypto";
import { INSTALLATION_SCOPE } from "./agentconfig.js";
import { canonicalJson } from "./canonical-json.js";
import { REASON_WORDS, type NotCountedReason, type Selection } from "./contracts/route-results.js";
import { checkScope, effectiveRoutes } from "./model-choices.js";
import { seenModel, seenModels } from "./model-catalog.js";
import { exactModelId, legOf, routeFromJson, type PhaseRoute } from "./phase-routing.js";
import {
  endRuleByDoor, endRuleByPlane, endTrialByDoor, insertEarnedRule, insertTrial, keepPausedRule, liveEarnedRules, liveTrialFor, modelsGenerationOf, proveRuleDoor, recordNotNow,
  ruleHoldOf, trialOrdinalOf, trialPlaceLive, trialPlacesOf, writeSuggestModels, type RuleAct, type RuleDoor, type RuleRefusalReason,
} from "./route-store.js";
import { BUILT_IN, type Store } from "./store.js";

// ---- the terms ----------------------------------------------------------------------------------------------------

/** The policy version a grant is sealed under: a grant sealed under another version pauses its rule. */
export const ROUTING_POLICY_VERSION = 1;
const DAY = 24 * 60 * 60_000;
/** When to suggest (Suggest and trigger terms): records of the last 90 days, the newest 20 decided. */
export const SUGGEST_TERMS = Object.freeze({ windowDays: 90, newest: 20, minDecided: 10, minMature: 0.9, lastClean: 3, configuredGap: 0.05, maxNotCounted: 1 / 3 });
/** How long a grant lasts, how long Not now keeps a suggestion quiet, and when Needs you says a grant ends soon. */
export const GRANT_DAYS = 90;
export const NOT_NOW_DAYS = 30;
export const EXPIRY_WARNING_DAYS = 7;

/** A rule's switch-back terms, sealed at acceptance (route_rule.grant_json) and read only from there. */
export type Grant = {
  policyVersion: number;
  cutoff: string;
  expires: string;
  /** Switch off when more than `max` of the latest `window` decided records are rejected. */
  reject: { window: number; max: number };
  /** Once `window` decided records exist: switch off when fewer than `min` of the latest `window` are mature. */
  mature: { window: number; min: number };
  /** Switch off when more than `max` of the latest `window` closed exposures were approved with another model. */
  declined: { window: number; max: number };
};
export function grantFor(now: Date): Grant {
  return { policyVersion: ROUTING_POLICY_VERSION, cutoff: now.toISOString(), expires: new Date(now.getTime() + GRANT_DAYS * DAY).toISOString(),
    reject: { window: 5, max: 1 }, mature: { window: 10, min: 0.8 }, declined: { window: 10, max: 2 } };
}
function readGrant(json: unknown): Grant | null {
  try {
    const value = JSON.parse(String(json)) as Partial<Grant>;
    const pair = (one: unknown, key: "max" | "min"): boolean => typeof one === "object" && one !== null && Number.isInteger((one as Record<string, unknown>)["window"]) && typeof (one as Record<string, unknown>)[key] === "number";
    if (typeof value.policyVersion !== "number" || typeof value.cutoff !== "string" || typeof value.expires !== "string"
      || !Number.isFinite(Date.parse(value.cutoff)) || !Number.isFinite(Date.parse(value.expires))
      || !pair(value.reject, "max") || !pair(value.mature, "min") || !pair(value.declined, "max")) return null;
    return value as Grant;
  } catch { return null; }
}

/** The switch-back terms in words, as the review shows them before acceptance and Settings after. */
export function grantWords(grant: Grant): string[] {
  return [
    `It switches itself off if ${grant.reject.max + 1} of the latest ${grant.reject.window} decided tasks are rejected,`,
    `if fewer than ${Math.round(grant.mature.min * 100)}% of the latest ${grant.mature.window} decided tasks are accepted and checked (once there are ${grant.mature.window}),`,
    `or if ${grant.declined.max + 1} of the latest ${grant.declined.window} approvals picked another model.`,
    `It ends on ${grant.expires.slice(0, 10)} unless you accept it again. Tasks already approved keep the model they were approved with.`,
  ];
}

// ---- reading rules -------------------------------------------------------------------------------------------------

export type RuleState = "active" | "trialling" | "paused" | "switched-off" | "turned-off" | "expired" | "dropped" | "finished";
export type RuleRow = {
  id: number; repo: string; cohortSize: "small" | "medium"; kind: "rule" | "trial"; provider: string; model: string;
  configured: { provider: string; model: string | null }; state: RuleState; generation: number; grant: Grant | null;
  prices: Prices | null; depends: Record<string, number> | null; acceptedBy: string; acceptedAt: string;
  endedAt: string | null; endedBy: string | null; endReason: string | null;
  /** A trial's number of places (slice 3); null for a rule. */
  limit: number | null;
};
/** Listed prices, in dollars per million tokens, as snapshotted. */
export type Prices = { model: { in: number; out: number }; configured: { in: number; out: number } };

function readRule(row: Record<string, unknown>): RuleRow {
  const parse = <T>(json: unknown): T | null => { try { return JSON.parse(String(json)) as T; } catch { return null; } };
  return {
    id: Number(row["id"]), repo: String(row["repo"]), cohortSize: row["cohort_size"] === "medium" ? "medium" : "small", kind: row["kind"] === "trial" ? "trial" : "rule",
    provider: String(row["provider"]), model: String(row["model"]),
    configured: { provider: String(row["configured_provider"]), model: row["configured_model"] == null ? null : String(row["configured_model"]) },
    state: String(row["state"]) as RuleState, generation: Number(row["generation"]), grant: readGrant(row["grant_json"]),
    prices: parse<Prices>(row["prices_json"]), depends: parse<Record<string, number>>(row["depends_json"]),
    acceptedBy: String(row["accepted_by"]), acceptedAt: String(row["accepted_at"]),
    endedAt: row["ended_at"] == null ? null : String(row["ended_at"]), endedBy: row["ended_by"] == null ? null : String(row["ended_by"]),
    endReason: row["end_reason"] == null ? null : String(row["end_reason"]),
    limit: row["trial_limit"] == null ? null : Number(row["trial_limit"]),
  };
}
export function ruleById(store: Store, id: number): RuleRow | null {
  const row = store.handle.prepare("SELECT * FROM route_rule WHERE id = ?").get(id);
  return row === undefined ? null : readRule(row);
}
/** A project's rules a person sees: the live ones (active, paused) and, for 30 days, the ones that ended (a Not now
 * offer is not a rule and is left out). */
export function rulesOf(store: Store, repo: string, now: Date): RuleRow[] {
  return store.handle.prepare(`SELECT * FROM route_rule WHERE repo = ? AND kind = 'rule' AND COALESCE(end_reason, '') != 'not-now'
      AND (state IN ('active','trialling','paused') OR ended_at >= ?) ORDER BY cohort_size, id DESC`)
    .all(repo, new Date(now.getTime() - NOT_NOW_DAYS * DAY).toISOString()).map(readRule);
}

/** Whether a project offers suggestions (its "Suggest cheaper models" switch; a project not saved here reads on). */
export function suggestModelsOn(store: Store, repo: string): boolean {
  const row = store.handle.prepare("SELECT suggest_models FROM project WHERE path = ?").get(repo);
  return row === undefined || Number(row["suggest_models"]) === 1;
}

/** The configuration generations a rule for this project depends on: the installation's and the project's build and
 * repair rows. */
export function dependsOf(store: Store, repo: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const scope of [INSTALLATION_SCOPE, repo]) for (const phase of ["build", "repair"]) out[`${scope}|${phase}`] = modelsGenerationOf(store, scope, phase);
  return out;
}

// ---- evidence ------------------------------------------------------------------------------------------------------

type RecordRow = { task: string; state: string; reason: string | null; firstStartedAt: string; apiMicrousd: number; unknownRuns: number; subscriptionRuns: number };
/** A cohort's records of one model, newest first (by their family's first code-writing run, then task id). */
function cohortRecords(store: Store, repo: string, size: "small" | "medium", provider: string, model: string, since: string): RecordRow[] {
  return store.handle.prepare(`SELECT t.external_id AS task, r.state, r.reason, r.first_started_at, r.api_microusd, r.unknown_runs, r.subscription_runs
      FROM route_record r JOIN task_ref t ON t.id = r.task_ref
     WHERE r.repo = ? AND r.cohort_size = ? AND r.provider = ? AND r.model = ? AND r.first_started_at > ?
     ORDER BY r.first_started_at DESC, t.external_id DESC`).all(repo, size, provider, model, since)
    .map(row => ({ task: String(row["task"]), state: String(row["state"]), reason: row["reason"] == null ? null : String(row["reason"]), firstStartedAt: String(row["first_started_at"]),
      apiMicrousd: Number(row["api_microusd"]), unknownRuns: Number(row["unknown_runs"]), subscriptionRuns: Number(row["subscription_runs"]) }));
}
const decidedOf = (rows: readonly RecordRow[]) => rows.filter(one => one.state === "mature" || one.state === "rejected");

export type Evidence = {
  /** The newest decided records counted (at most SUGGEST_TERMS.newest), how many of them were accepted and checked. */
  decided: number; mature: number; rejected: number;
  /** Records in the window not counted, and their reasons with how many each. */
  notCounted: number; notCountedReasons: { reason: NotCountedReason; count: number }[]; total: number;
  /** The newest decided tasks, by id, newest first. */
  tasks: string[];
  /** Observed median API dollars a task, over mature records priced in dollars; null below 5 such records. */
  medianMicrousd: number | null;
};
function evidenceOf(rows: readonly RecordRow[]): Evidence {
  const decided = decidedOf(rows).slice(0, SUGGEST_TERMS.newest);
  const notCounted = rows.filter(one => one.state === "not-counted");
  const reasons = new Map<NotCountedReason, number>();
  for (const one of notCounted) if (one.reason !== null) reasons.set(one.reason as NotCountedReason, (reasons.get(one.reason as NotCountedReason) ?? 0) + 1);
  const priced = decided.filter(one => one.state === "mature" && one.unknownRuns === 0 && one.subscriptionRuns === 0 && one.apiMicrousd > 0).map(one => one.apiMicrousd).sort((a, b) => a - b);
  const median = priced.length < 5 ? null : priced.length % 2 === 1 ? priced[(priced.length - 1) / 2]! : Math.round((priced[priced.length / 2 - 1]! + priced[priced.length / 2]!) / 2);
  return {
    decided: decided.length, mature: decided.filter(one => one.state === "mature").length, rejected: decided.filter(one => one.state === "rejected").length,
    notCounted: notCounted.length, notCountedReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    total: rows.length, tasks: decided.map(one => one.task), medianMicrousd: median,
  };
}

function pricesOf(store: Store, provider: string, model: string): { in: number; out: number } | null {
  if (provider !== "claude") return null;
  const seen = seenModel(store, "claude", model);
  return seen === null || seen.inputUsd === null || seen.outputUsd === null ? null : { in: seen.inputUsd, out: seen.outputUsd };
}

/** The model's own name when the catalog knows it ("Claude Haiku 5.5"), else its id. */
export function modelName(store: Store, model: string): string {
  return seenModel(store, "claude", model)?.name ?? model;
}

// ---- suggestions ---------------------------------------------------------------------------------------------------

export type Suggestion = {
  /** `<size>:<model>:<offer>` — what the person reviews, and what accept and Not now name. */
  id: string;
  repo: string; cohortSize: "small" | "medium"; provider: "claude"; model: string; name: string;
  configured: { provider: string; model: string; name: string };
  evidence: Evidence; configuredEvidence: Evidence; prices: Prices; depends: Record<string, number>;
  /** Three digests the offer binds: the evidence, the prices, and the configuration generations. */
  offer: { evidence: string; prices: string; depends: string };
  grant: Grant;
};
const short = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 12);
const sizeWord = (size: "small" | "medium") => size === "small" ? "small" : "routine";

/** One cohort's configured builder now (the configured rows alone, never a rule), or null when it can't be read. */
function configuredBuilder(store: Store, repo: string, size: "small" | "medium"): { provider: string; model: string } | null {
  const routes = effectiveRoutes(store, repo, { rules: false });
  if (!routes.ok) return null;
  const route = routes.routes.find(one => one.label === (size === "small" ? "small" : "routine"))?.route;
  const leg = route === undefined ? null : legOf(route, "build");
  return leg === null ? null : { provider: leg.provider, model: leg.model };
}

/** What an offer for this cohort and model would say now, whether or not it qualifies: the parts its digests bind,
 * and why it doesn't qualify (null: it does). */
export function offerNow(store: Store, repo: string, size: "small" | "medium", model: string, now: Date): { suggestion: Suggestion | null; why: string | null; parts: Suggestion["offer"] | null } {
  const configured = configuredBuilder(store, repo, size);
  if (configured === null) return { suggestion: null, why: "the configured builder can't be read", parts: null };
  if (configured.provider !== "claude") return { suggestion: null, why: "only Claude reports the model it ran, so only a Claude builder can earn a rule", parts: null };
  if (model === configured.model) return { suggestion: null, why: "that is the configured builder already", parts: null };
  const since = new Date(now.getTime() - SUGGEST_TERMS.windowDays * DAY).toISOString();
  const rows = cohortRecords(store, repo, size, "claude", model, since);
  const evidence = evidenceOf(rows);
  const configuredEvidence = evidenceOf(cohortRecords(store, repo, size, "claude", configured.model, since));
  const cheaper = pricesOf(store, "claude", model), standing = pricesOf(store, "claude", configured.model);
  const prices: Prices | null = cheaper === null || standing === null ? null : { model: cheaper, configured: standing };
  const depends = dependsOf(store, repo);
  const parts = { evidence: short({ repo, size, model, configured, rows: rows.map(one => [one.task, one.state, one.reason]), standing: decidedOf(cohortRecords(store, repo, size, "claude", configured.model, since)).slice(0, SUGGEST_TERMS.newest).map(one => [one.task, one.state]) }),
    prices: short(prices), depends: short(depends) };
  const decided = decidedOf(rows).slice(0, SUGGEST_TERMS.newest);
  const share = (one: Evidence) => one.decided === 0 ? 0 : one.mature / one.decided;
  const why = evidence.decided < SUGGEST_TERMS.minDecided ? `${evidence.decided} decided tasks so far; ${SUGGEST_TERMS.minDecided} are needed`
    : share(evidence) < SUGGEST_TERMS.minMature ? "fewer than 90% of its decided tasks were accepted with checks passing"
    : decided.slice(0, SUGGEST_TERMS.lastClean).some(one => one.state === "rejected") ? "one of its latest 3 decided tasks was rejected"
    : configuredEvidence.decided >= SUGGEST_TERMS.minDecided && share(configuredEvidence) - share(evidence) > SUGGEST_TERMS.configuredGap + 1e-9 ? "the configured model does more than 5 points better here"
    : evidence.total > 0 && evidence.notCounted / evidence.total > SUGGEST_TERMS.maxNotCounted + 1e-9 ? "more than a third of its tasks couldn't be counted"
    : prices === null ? "one of the two models has no listed price"
    : !(prices.model.in < prices.configured.in && prices.model.out < prices.configured.out) ? "it isn't cheaper than the configured model on both input and output"
    : null;
  if (why !== null) return { suggestion: null, why, parts };
  return {
    suggestion: {
      id: `${size}:${model}:${parts.evidence.slice(0, 4)}${parts.prices.slice(0, 4)}${parts.depends.slice(0, 4)}`,
      repo, cohortSize: size, provider: "claude", model, name: modelName(store, model),
      configured: { ...configured, name: modelName(store, configured.model) }, evidence, configuredEvidence, prices: prices!, depends, offer: parts, grant: grantFor(now),
    },
    why: null, parts,
  };
}

/** A suggestion id read back: its cohort, model and the three digest prefixes it was offered under. */
export function readSuggestionId(id: string): { size: "small" | "medium"; model: string; evidence: string; prices: string; depends: string } | null {
  const match = /^(small|medium):([A-Za-z0-9][A-Za-z0-9._/-]{0,127}):([0-9a-f]{12})$/.exec(id);
  if (match === null) return null;
  return { size: match[1] as "small" | "medium", model: match[2]!, evidence: match[3]!.slice(0, 4), prices: match[3]!.slice(4, 8), depends: match[3]!.slice(8, 12) };
}

/** Whether a Not now on this cohort and model is still within its 30 days. */
function notNowStands(store: Store, repo: string, size: "small" | "medium", model: string, now: Date): boolean {
  return store.handle.prepare(`SELECT 1 FROM route_rule WHERE repo = ? AND cohort_size = ? AND model = ? AND state = 'dropped' AND end_reason = 'not-now' AND ended_at > ? LIMIT 1`)
    .get(repo, size, model, new Date(now.getTime() - NOT_NOW_DAYS * DAY).toISOString()) !== undefined;
}

/**
 * The suggestions a project offers now: per size (small, routine), the cheapest Claude model whose records here earn
 * it, unless a rule for that size is live, the project's switch is off, or a person said Not now within 30 days.
 */
export function suggestionsFor(store: Store, repo: string, now: Date): Suggestion[] {
  if (!suggestModelsOn(store, repo)) return [];
  const out: Suggestion[] = [];
  for (const size of ["small", "medium"] as const) {
    if (store.handle.prepare("SELECT 1 FROM route_rule WHERE repo = ? AND cohort_size = ? AND state IN ('active','trialling','paused')").get(repo, size) !== undefined) continue;
    const since = new Date(now.getTime() - SUGGEST_TERMS.windowDays * DAY).toISOString();
    const models = store.handle.prepare(`SELECT DISTINCT model FROM route_record WHERE repo = ? AND cohort_size = ? AND provider = 'claude' AND model IS NOT NULL AND first_started_at > ? ORDER BY model`)
      .all(repo, size, since).map(row => String(row["model"]));
    const offers = models.filter(model => !notNowStands(store, repo, size, model, now)).flatMap(model => { const one = offerNow(store, repo, size, model, now).suggestion; return one === null ? [] : [one]; });
    offers.sort((a, b) => a.prices.model.in - b.prices.model.in || a.prices.model.out - b.prices.model.out || a.model.localeCompare(b.model));
    if (offers[0] !== undefined) out.push(offers[0]);
  }
  return out;
}

/** A suggestion in plain words, the evidence first. */
export function suggestionWords(suggestion: Suggestion): string {
  const e = suggestion.evidence;
  return `${suggestion.name} for ${sizeWord(suggestion.cohortSize)} tasks instead of ${suggestion.configured.name}: ${e.mature} of the last ${e.decided} decided similar tasks were accepted with checks passing${notCountedWords(e)}.`;
}
function notCountedWords(e: Evidence): string {
  if (e.notCounted === 0) return "";
  const reasons = e.notCountedReasons.slice(0, 2).map(one => REASON_WORDS[one.reason]).join("; ");
  return ` (${e.notCounted} more not counted${reasons === "" ? "" : `: ${reasons}`})`;
}
const dollarsOf = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

// ---- the doors -----------------------------------------------------------------------------------------------------

export type RuleRefusal = { ok: false; reason: RuleRefusalReason | "stale-suggestion" | "price-changed" | "config-changed" | "invalid" | "taken" | "not-found" | "unknown-project"; problem: string };
const REFUSAL_WORDS: Record<RuleRefusal["reason"], string> = {
  "lead-refused": "A lead or an API token can't change which models run. A person does this.",
  authority: "Only an instance operator who can open this project, signed in now, can do this.",
  "stale-suggestion": "This suggestion is out of date: its results changed. Nothing was saved. Review the current suggestion.",
  "price-changed": "A listed price changed since this suggestion was made. Nothing was saved. Review it again.",
  "config-changed": "Models changed since this suggestion was made. Nothing was saved. Review it again.",
  invalid: "This rule can't run with the current models. Nothing was saved.",
  taken: "Another model already has a rule for these tasks. Nothing was saved.",
  "not-found": "That rule or suggestion isn't here any more.",
  "unknown-project": "That isn't a project here.",
};
const refused = (reason: RuleRefusal["reason"], problem = REFUSAL_WORDS[reason]): RuleRefusal => ({ ok: false, reason, problem });
class Refused extends Error { constructor(readonly refusal: RuleRefusal) { super(refusal.problem); } }

/** One door act in one transaction, with a savepoint so a refusal rolls back its writes even inside a caller's. */
function act<T>(store: Store, body: () => T): T | RuleRefusal {
  try {
    return store.transact(() => {
      store.handle.exec("SAVEPOINT route_rules");
      try {
        const result = body();
        store.handle.exec("RELEASE route_rules");
        return result;
      } catch (error) {
        store.handle.exec("ROLLBACK TO route_rules");
        store.handle.exec("RELEASE route_rules");
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}
function prove(store: Store, door: RuleDoor, which: RuleAct, repo: string) {
  const proved = proveRuleDoor(store, door, which, repo);
  if (!proved.ok) throw new Refused(refused(proved.reason));
  return proved.door;
}
const known = (store: Store, repo: string) => store.knownRepos().includes(repo) || store.handle.prepare("SELECT 1 FROM project WHERE path = ?").get(repo) !== undefined;

/**
 * Accept a suggestion as a rule, in one transaction: the person re-proved; the offer still earned, at the same
 * prices and on the same configuration generations it was offered under; the configuration valid with the rule
 * added (checkScope); and the size's one winner free. A refusal names which: `stale-suggestion`, `price-changed`,
 * `config-changed`, `invalid` or `taken`.
 */
export function acceptSuggestion(store: Store, input: { repo: string; id: string }, door: RuleDoor, now: Date): { ok: true; rule: number; suggestion: Suggestion } | RuleRefusal {
  return act(store, () => {
    if (!known(store, input.repo)) throw new Refused(refused("unknown-project"));
    const proved = prove(store, door, "accept", input.repo);
    const asked = readSuggestionId(input.id);
    if (asked === null) throw new Refused(refused("not-found"));
    if (store.handle.prepare("SELECT 1 FROM route_rule WHERE repo = ? AND cohort_size = ? AND state IN ('active','trialling','paused')").get(input.repo, asked.size) !== undefined) throw new Refused(refused("taken"));
    const now_ = offerNow(store, input.repo, asked.size, asked.model, now);
    if (now_.parts !== null && now_.parts.depends.slice(0, 4) !== asked.depends) throw new Refused(refused("config-changed"));
    if (now_.parts !== null && now_.parts.prices.slice(0, 4) !== asked.prices) throw new Refused(refused("price-changed"));
    if (now_.suggestion === null || now_.parts === null || now_.parts.evidence.slice(0, 4) !== asked.evidence || !suggestModelsOn(store, input.repo)) throw new Refused(refused("stale-suggestion"));
    const suggestion = now_.suggestion;
    const candidate = { id: 0, generation: 1, cohortSize: suggestion.cohortSize, provider: "claude" as const, model: suggestion.model, configured: { provider: suggestion.configured.provider, model: suggestion.configured.model } };
    const checked = checkScope(store, input.repo, { rules: [...liveEarnedRules(store, input.repo), candidate] });
    if (checked.kind !== "ok") throw new Refused(refused("invalid", `${REFUSAL_WORDS.invalid} ${checked.problem}`));
    const rule = insertEarnedRule(store, proved, { repo: input.repo, cohortSize: suggestion.cohortSize, provider: "claude", model: suggestion.model,
      configuredProvider: suggestion.configured.provider, configuredModel: suggestion.configured.model, grant: suggestion.grant, prices: suggestion.prices, depends: suggestion.depends }, now);
    if (rule === null) throw new Refused(refused("taken"));
    store.recordAction({ at: now.toISOString(), actor: proved.actor, repo: input.repo, taskId: null, runId: null, action: "earned rule accepted", outcome: "changed", source: "policy",
      detail: `${sizeWord(suggestion.cohortSize)} tasks build on ${suggestion.model} instead of ${suggestion.configured.model} (rule ${rule})` });
    return { ok: true as const, rule, suggestion };
  });
}

/** Turn a live rule off, or drop a paused one. Tasks already approved keep the model they were approved with. */
export function turnOffRule(store: Store, ruleId: number, door: RuleDoor, now: Date): { ok: true; rule: RuleRow } | RuleRefusal {
  return act(store, () => {
    const rule = ruleById(store, ruleId);
    if (rule === null || rule.kind !== "rule" || !["active", "trialling", "paused"].includes(rule.state)) throw new Refused(refused("not-found"));
    const proved = prove(store, door, "turn-off", rule.repo);
    if (!endRuleByDoor(store, proved, rule.id, rule.generation, now)) throw new Refused(refused("not-found"));
    store.recordAction({ at: now.toISOString(), actor: proved.actor, repo: rule.repo, taskId: null, runId: null, action: rule.state === "paused" ? "earned rule dropped" : "earned rule turned off",
      outcome: "changed", source: "policy", detail: `${sizeWord(rule.cohortSize)} tasks build on the configured model again (rule ${rule.id})` });
    resolveRuleNotices(store, rule.id, now);
    return { ok: true as const, rule: ruleById(store, rule.id)! };
  });
}

/** Keep a paused rule: live again on the configuration as it stands, if that configuration can run it. */
export function keepRule(store: Store, ruleId: number, door: RuleDoor, now: Date): { ok: true; rule: RuleRow } | RuleRefusal {
  return act(store, () => {
    const rule = ruleById(store, ruleId);
    if (rule === null || rule.kind !== "rule" || rule.state !== "paused") throw new Refused(refused("not-found"));
    const proved = prove(store, door, "keep", rule.repo);
    if (rule.grant === null || rule.grant.policyVersion !== ROUTING_POLICY_VERSION || Date.parse(rule.grant.expires) <= now.getTime()) throw new Refused(refused("stale-suggestion", "This rule's terms ended. Nothing was saved."));
    const configured = configuredBuilder(store, rule.repo, rule.cohortSize);
    if (configured === null || configured.provider !== rule.configured.provider || configured.model !== rule.configured.model) {
      throw new Refused(refused("config-changed", "The configured builder for these tasks changed, so this rule's evidence no longer compares with it. Drop it; a new suggestion follows from new results."));
    }
    const candidate = { id: rule.id, generation: rule.generation + 1, cohortSize: rule.cohortSize, provider: "claude" as const, model: rule.model, configured: rule.configured };
    const checked = checkScope(store, rule.repo, { rules: [...liveEarnedRules(store, rule.repo), candidate] });
    if (checked.kind !== "ok") throw new Refused(refused("invalid", `${REFUSAL_WORDS.invalid} ${checked.problem}`));
    if (!keepPausedRule(store, proved, rule.id, rule.generation, dependsOf(store, rule.repo))) throw new Refused(refused("not-found"));
    store.recordAction({ at: now.toISOString(), actor: proved.actor, repo: rule.repo, taskId: null, runId: null, action: "earned rule kept", outcome: "changed", source: "policy",
      detail: `${sizeWord(rule.cohortSize)} tasks build on ${rule.model} again (rule ${rule.id})` });
    resolveRuleNotices(store, rule.id, now);
    return { ok: true as const, rule: ruleById(store, rule.id)! };
  });
}

/** Not now: the suggestion stays quiet for 30 days. */
export function dismissSuggestion(store: Store, input: { repo: string; id: string }, door: RuleDoor, now: Date): { ok: true } | RuleRefusal {
  return act(store, () => {
    if (!known(store, input.repo)) throw new Refused(refused("unknown-project"));
    const proved = prove(store, door, "dismiss", input.repo);
    const asked = readSuggestionId(input.id) ?? readTrialOfferId(input.id);
    if (asked === null) throw new Refused(refused("not-found"));
    const configured = configuredBuilder(store, input.repo, asked.size);
    recordNotNow(store, proved, { repo: input.repo, cohortSize: asked.size, provider: "claude", model: asked.model, configuredProvider: configured?.provider ?? "claude",
      configuredModel: configured?.model ?? null, prices: { model: pricesOf(store, "claude", asked.model), configured: configured === null ? null : pricesOf(store, configured.provider, configured.model) } }, now);
    return { ok: true as const };
  });
}

/** A project's "Suggest cheaper models" switch: on takes a person's step-up, off also the local owner. */
export function setSuggestModels(store: Store, repo: string, on: boolean, door: RuleDoor): { ok: true } | RuleRefusal {
  return act(store, () => {
    const proved = prove(store, door, on ? "suggest-on" : "suggest-off", repo);
    if (!writeSuggestModels(store, proved, repo, on)) throw new Refused(refused("unknown-project"));
    return { ok: true as const };
  });
}

// ---- switching off ---------------------------------------------------------------------------------------------------

export type TripResult = { trips: false } | { trips: true; why: string };
/** Whether a grant's sealed terms trip on these decided records (newest first) and closed exposures (newest first,
 * true = approved with another model). Pure. Pending and provisional records are never passed in. */
export function tripOf(grant: Grant, decided: readonly ("mature" | "rejected")[], exposures: readonly boolean[]): TripResult {
  const rejected = decided.slice(0, grant.reject.window).filter(one => one === "rejected").length;
  if (rejected > grant.reject.max) return { trips: true, why: `${rejected} of the latest ${Math.min(grant.reject.window, decided.length)} decided tasks were rejected` };
  if (decided.length >= grant.mature.window) {
    const latest = decided.slice(0, grant.mature.window);
    const mature = latest.filter(one => one === "mature").length;
    if (mature / latest.length < grant.mature.min) return { trips: true, why: `only ${mature} of the latest ${latest.length} decided tasks were accepted with checks passing` };
  }
  const declined = exposures.slice(0, grant.declined.window).filter(Boolean).length;
  if (declined > grant.declined.max) return { trips: true, why: `${declined} of the latest ${Math.min(grant.declined.window, exposures.length)} approvals picked another model` };
  return { trips: false };
}

/** The evidence a rule's trigger reads: its model's decided records in its cohort since the grant's cutoff, and its
 * closed exposures, both newest first and in a fixed order. */
function triggerInputs(store: Store, rule: RuleRow, grant: Grant): { decided: ("mature" | "rejected")[]; exposures: boolean[] } {
  const decided = decidedOf(cohortRecords(store, rule.repo, rule.cohortSize, rule.provider, rule.model, grant.cutoff)).map(one => one.state as "mature" | "rejected");
  const exposures = store.handle.prepare(`SELECT e.id, (SELECT kind FROM route_exposure_event c WHERE c.exposure = e.id AND c.kind IN ('approved-as-proposed','approved-with-other','cancelled') ORDER BY c.id LIMIT 1) AS closer,
      (SELECT MIN(p.id) FROM route_exposure_event p WHERE p.exposure = e.id AND p.kind = 'proposed') AS first
      FROM route_exposure e WHERE e.rule = ? AND e.closed_at IS NOT NULL AND e.created_at >= ? ORDER BY first DESC, e.id DESC`).all(rule.id, grant.cutoff)
    .map(row => row["closer"] === "approved-with-other");
  return { decided, exposures };
}

export type SwitchOffOutcome = "kept" | "switched-off" | "paused" | "expired" | "moved";
/**
 * One rule's check, as ONE transaction: re-read the rule and its generation; any configuration generation it depends
 * on that moved pauses it (never a switch-off on terms it no longer has); an ended grant ends it, a grant sealed under
 * another policy or by an account that's gone pauses it; then the trigger, recomputed from records with the sealed
 * terms, switches it off by compare-and-swap on its generation — and the configuration is checked without it, or the
 * switch-off rolls back and the rule pauses instead.
 */
export function switchOffIfTripped(store: Store, ruleId: number, now: Date): { outcome: SwitchOffOutcome; why: string | null } {
  return store.transact(() => {
    const rule = ruleById(store, ruleId);
    if (rule === null || rule.state !== "active" || rule.kind !== "rule") return { outcome: "moved" as const, why: null };
    const pause = (why: string) => endRuleByPlane(store, rule.id, rule.generation, "paused", why, now) ? { outcome: "paused" as const, why } : { outcome: "moved" as const, why: null };
    const depends = rule.depends ?? {};
    const moved = Object.keys(depends).length === 0 || Object.entries(depends).some(([key, generation]) => {
      const at = key.lastIndexOf("|");
      return at <= 0 || modelsGenerationOf(store, key.slice(0, at), key.slice(at + 1)) !== generation;
    });
    if (moved) return pause("config-changed");
    const grant = rule.grant;
    if (grant === null) return pause("grant-unreadable");
    if (Date.parse(grant.expires) <= now.getTime()) return endRuleByPlane(store, rule.id, rule.generation, "expired", "grant-ended", now) ? { outcome: "expired" as const, why: "its 90 days ended" } : { outcome: "moved" as const, why: null };
    if (grant.policyVersion !== ROUTING_POLICY_VERSION) return pause("policy-changed");
    const granter = store.accountOf(rule.acceptedBy);
    if (granter === null || granter.revokedAt !== null) return pause("granter-gone");
    const inputs = triggerInputs(store, rule, grant);
    const trip = tripOf(grant, inputs.decided, inputs.exposures);
    if (!trip.trips) return { outcome: "kept" as const, why: null };
    store.handle.exec("SAVEPOINT switch_off");
    if (!endRuleByPlane(store, rule.id, rule.generation, "switched-off", trip.why, now)) { store.handle.exec("RELEASE switch_off"); return { outcome: "moved" as const, why: null }; }
    if (checkScope(store, rule.repo).kind === "invalid") {
      store.handle.exec("ROLLBACK TO switch_off");
      store.handle.exec("RELEASE switch_off");
      return pause("config-invalid");
    }
    store.handle.exec("RELEASE switch_off");
    return { outcome: "switched-off" as const, why: trip.why };
  });
}

// ---- the pass, held tasks, Needs you -------------------------------------------------------------------------------

/** The selection a stored route's build leg carries (route v3), or undefined. */
function selectionOf(json: unknown): Selection | undefined {
  const route: PhaseRoute | null = typeof json === "string" ? routeFromJson(json) : null;
  return route === null ? undefined : legOf(route, "build").selection;
}

const settingsHref = (repo: string) => `/settings/models?scope=${encodeURIComponent(repo)}#models-suggested`;
function notify(store: Store, repo: string, dedupeKey: string, subject: string, body: string, now: Date, link = settingsHref(repo)): void {
  store.enqueueNotification({ dedupeKey, kind: "routing", subject, body, pushClass: "attention", link, source: { project: repo } }, now);
}
function resolveRuleNotices(store: Store, ruleId: number, now: Date): void {
  store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE kind = 'routing' AND resolved_at IS NULL AND (dedupe_key LIKE ? OR dedupe_key LIKE ?)")
    .run(now.toISOString(), `route-rule-paused:${ruleId}:%`, `route-rule-expiring:${ruleId}`);
}

/** Hold a task approved under a rule that switched itself off: nothing starts on it (no strike: nothing ran) until a
 * person approves it again — the hold goes with that yes (store.ts sealScopeApproval). */
export function holdRuleOff(store: Store, taskRef: number, taskId: string, model: string, now: Date): void {
  const name = modelName(store, model);
  store.holdOwned({ taskRef, ownerKind: "backoff", ownerId: `rule-off:${taskRef}`, reason: `Results for ${name} dropped after you approved this. Approve it again or re-file it.`, until: null }, now);
}

/**
 * The reconcile pass's routing step (operate.ts, after the records are evaluated again): each live rule checked
 * against its sealed terms; Needs you told about a rule that switched off, paused or ends soon; tasks approved under a
 * switched-off rule held, with their plans re-filed on the configured builder so a person can approve them again; and
 * plans still waiting for approval under a rule that is no longer live re-filed the same way. Each task is its own
 * transaction; one that can't be re-filed now (a live claim) is tried again next pass.
 */
export function routeRulesPass(store: Store, repo: string, now: Date): { switchedOff: number; paused: number; held: number; refiled: number } {
  const counts = { switchedOff: 0, paused: 0, held: 0, refiled: 0 };
  for (const rule of rulesOf(store, repo, now).filter(one => one.state === "active")) {
    const checked = switchOffIfTripped(store, rule.id, now);
    if (checked.outcome === "switched-off") counts.switchedOff++;
    if (checked.outcome === "paused") counts.paused++;
    if (checked.outcome === "kept" && rule.grant !== null && Date.parse(rule.grant.expires) - now.getTime() <= EXPIRY_WARNING_DAYS * DAY) {
      notify(store, repo, `route-rule-expiring:${rule.id}`, `${modelName(store, rule.model)} for ${sizeWord(rule.cohortSize)} tasks ends on ${rule.grant.expires.slice(0, 10)}`,
        "Its 90 days are nearly over. After that, these tasks build on the configured model again. A new suggestion follows if its results still earn it.", now);
    }
  }
  for (const rule of rulesOf(store, repo, now)) {
    const name = modelName(store, rule.model);
    if (rule.state === "switched-off") notify(store, repo, `route-rule-off:${rule.id}`, `${name} switched itself off for ${sizeWord(rule.cohortSize)} tasks`,
      `Its results dropped: ${rule.endReason ?? "its terms tripped"}. New ${sizeWord(rule.cohortSize)} tasks build on the configured model. Tasks approved on ${name} that haven't started wait for you to approve them again.`, now);
    if (rule.state === "paused") notify(store, repo, `route-rule-paused:${rule.id}:${rule.generation}`, `${name} for ${sizeWord(rule.cohortSize)} tasks is paused`,
      "Models changed since you accepted it, so its evidence may not compare any more. Keep it or drop it in Settings → Models.", now);
    if (rule.state === "expired") notify(store, repo, `route-rule-expired:${rule.id}`, `${name} for ${sizeWord(rule.cohortSize)} tasks ended`,
      "Its 90 days are over. These tasks build on the configured model again; tasks already approved keep their model.", now);
  }
  // Trials (slice 3): one past its days ends; tasks already approved on it keep their place and model.
  for (const trial of trialsOf(store, repo, now).filter(one => one.state === "trialling" || one.state === "paused")) {
    const expires = trialExpiry(store, trial);
    if (expires === null || expires <= now.getTime()) endRuleByPlane(store, trial.id, trial.generation, "expired", "trial-ended", now);
  }
  // Tasks under a rule that is no longer live, and plans waiting on a trial place that no longer stands.
  const live = new Set(liveEarnedRules(store, repo).map(one => one.id));
  const rows = store.handle.prepare(`SELECT ts.task_id, tr.id AS ref, ts.proposed_route_json, ts.approved_route_json, ts.approved_digest, ts.digest
      FROM task_scope ts JOIN task_ref tr ON tr.backend = ? AND tr.external_id = ts.task_id JOIN task t ON t.id = ts.task_id
     WHERE tr.repo = ? AND t.state NOT IN ('done','cancelled','failed') AND (ts.proposed_route_json LIKE '%"selection"%' OR ts.approved_route_json LIKE '%"selection"%')`).all(BUILT_IN, repo);
  for (const row of rows) {
    const taskId = String(row["task_id"]), ref = Number(row["ref"]);
    const approved = row["approved_digest"] != null && row["approved_digest"] === row["digest"];
    const proposed = selectionOf(row["proposed_route_json"]);
    try {
      store.transact(() => {
        if (approved) {
          const held = ruleHoldOf(store, taskId);
          if (held === null) return;
          holdRuleOff(store, ref, taskId, held.model, now);
          counts.held++;
        } else if (proposed?.kind === "rule" ? live.has(proposed.rule) : proposed?.kind === "trial" ? trialPlaceLive(store, proposed, ref) : true) {
          return;
        }
        if (store.hasLiveClaim(ref, now)) return;
        if (store.refileScope(taskId, now) !== null) counts.refiled++;
      });
    } catch { /* the next pass tries again */ }
  }
  return counts;
}

// ---- what the person sees ------------------------------------------------------------------------------------------

/**
 * The evidence line beside a route whose build leg an earned rule selected (approval sheet, approval step, chat side
 * panel, text card), or null for any other route. The selection is sealed; the counts read "so far", from the
 * records as they stand.
 */
export function selectionEvidenceWords(store: Store, route: PhaseRoute | null, now: Date): string | null {
  if (route === null) return null;
  const selection = legOf(route, "build").selection;
  if (selection?.kind === "trial") return trialEvidenceWords(store, selection);
  if (selection?.kind !== "rule") return null;
  const rule = ruleById(store, selection.rule);
  if (rule === null) return "Why this model: an earned rule chose it; that rule is gone now. Change the builder if you want another model.";
  const name = modelName(store, rule.model);
  const since = new Date(now.getTime() - SUGGEST_TERMS.windowDays * DAY).toISOString();
  const evidence = evidenceOf(cohortRecords(store, rule.repo, rule.cohortSize, rule.provider, rule.model, since));
  const standing = rule.configured.model === null ? null : evidenceOf(cohortRecords(store, rule.repo, rule.cohortSize, rule.configured.provider, rule.configured.model, since));
  const counts = evidence.decided === 0 ? "No decided similar tasks yet." : `So far, ${evidence.mature} of the last ${evidence.decided} decided similar tasks were accepted with checks passing${notCountedWords(evidence)}.`;
  const cost = evidence.medianMicrousd !== null && standing?.medianMicrousd != null
    ? ` Observed median ${dollarsOf(evidence.medianMicrousd)} a task, ${dollarsOf(standing.medianMicrousd)} on ${modelName(store, rule.configured.model!)} (observed, not a promise).` : "";
  const state = rule.state === "active" ? "" : rule.state === "switched-off" ? ` This rule switched itself off since: approve again after re-filing, or change the builder.` : ` This rule is ${rule.state === "paused" ? "paused" : "off"} now; approving keeps ${name}.`;
  return `Why this model: ${name} builds ${sizeWord(rule.cohortSize)} tasks in this project. ${counts}${cost}${state}`;
}

/** The evidence line for a task's proposed (or, once approved, sealed) route. */
export function taskEvidenceWords(store: Store, taskId: string, now: Date): string | null {
  try {
    const row = store.handle.prepare("SELECT proposed_route_json, approved_route_json, approved_digest, digest FROM task_scope WHERE task_id = ?").get(taskId);
    if (row === undefined) return null;
    const json = row["approved_digest"] != null && row["approved_digest"] === row["digest"] ? row["approved_route_json"] : row["proposed_route_json"];
    return selectionEvidenceWords(store, typeof json === "string" ? routeFromJson(json) : null, now);
  } catch { return null; }
}

/** A rule in words for Settings and the command line. */
export function ruleWords(store: Store, rule: RuleRow): string {
  const name = modelName(store, rule.model);
  const what = `${name} builds ${sizeWord(rule.cohortSize)} tasks instead of ${rule.configured.model === null ? "the configured model" : modelName(store, rule.configured.model)}`;
  if (rule.state === "active") return `${what}, since ${rule.acceptedAt.slice(0, 10)}${rule.grant === null ? "" : `, until ${rule.grant.expires.slice(0, 10)}`}.`;
  if (rule.state === "paused") return `${what}: paused because Models changed. Keep or drop it.`;
  if (rule.state === "switched-off") return `${what}: switched itself off on ${rule.endedAt?.slice(0, 10) ?? "?"} (${rule.endReason ?? "its results dropped"}).`;
  if (rule.state === "expired") return `${what}: ended on ${rule.endedAt?.slice(0, 10) ?? "?"}.`;
  return `${what}: turned off${rule.endedBy === null ? "" : ` by ${rule.endedBy}`} on ${rule.endedAt?.slice(0, 10) ?? "?"}.`;
}

// ---- trials (slice 3) ------------------------------------------------------------------------------------------------

/** When to offer a trial (docs/plans/results-routing.md, "Trials"): the configured Claude builder of a cohort has at
 * least 10 decided records here at ≥ 90% accepted with checks passing, and a cheaper Claude model has too few results
 * here to be suggested on its own. A trial tries it on the next 10 eligible tasks, each approved by a person. */
export const TRIAL_TERMS = Object.freeze({ places: 10, configuredMinDecided: 10, configuredMinMature: 0.9, days: 90 });

export type TrialOffer = {
  /** `trial:<size>:<model>:<offer>` — what the person starts, and what Not now names. */
  id: string;
  repo: string; cohortSize: "small" | "medium"; provider: "claude"; model: string; name: string;
  configured: { provider: string; model: string; name: string };
  evidence: Evidence; configuredEvidence: Evidence; prices: Prices; depends: Record<string, number>;
  places: number;
  offer: { evidence: string; prices: string; depends: string };
};

/** A trial offer's id read back: its cohort, model and the three digest prefixes it was offered under. */
export function readTrialOfferId(id: string): { size: "small" | "medium"; model: string; evidence: string; prices: string; depends: string } | null {
  return id.startsWith("trial:") ? readSuggestionId(id.slice("trial:".length)) : null;
}

/** What a trial offer for this cohort and model would say now, whether or not it qualifies: the parts its digests
 * bind, and why it doesn't qualify (null: it does). */
export function trialOfferNow(store: Store, repo: string, size: "small" | "medium", model: string, now: Date): { offer: TrialOffer | null; why: string | null; parts: TrialOffer["offer"] | null } {
  const configured = configuredBuilder(store, repo, size);
  if (configured === null) return { offer: null, why: "the configured builder can't be read", parts: null };
  if (configured.provider !== "claude") return { offer: null, why: "only Claude reports the model it ran, so only a Claude builder runs a trial", parts: null };
  if (model === configured.model || !exactModelId(model) || readSuggestionId(`${size}:${model}:000000000000`) === null) return { offer: null, why: "that model can't be tried here", parts: null };
  const since = new Date(now.getTime() - SUGGEST_TERMS.windowDays * DAY).toISOString();
  const rows = cohortRecords(store, repo, size, "claude", model, since);
  const standingRows = cohortRecords(store, repo, size, "claude", configured.model, since);
  const evidence = evidenceOf(rows), configuredEvidence = evidenceOf(standingRows);
  const cheaper = pricesOf(store, "claude", model), standing = pricesOf(store, "claude", configured.model);
  const prices: Prices | null = cheaper === null || standing === null ? null : { model: cheaper, configured: standing };
  const depends = dependsOf(store, repo);
  const parts = {
    evidence: short({ trial: true, repo, size, model, configured, own: decidedOf(rows).slice(0, SUGGEST_TERMS.newest).map(one => [one.task, one.state]),
      standing: decidedOf(standingRows).slice(0, SUGGEST_TERMS.newest).map(one => [one.task, one.state]) }),
    prices: short(prices), depends: short(depends),
  };
  const share = configuredEvidence.decided === 0 ? 0 : configuredEvidence.mature / configuredEvidence.decided;
  const why = configuredEvidence.decided < TRIAL_TERMS.configuredMinDecided ? `the configured model has ${configuredEvidence.decided} decided tasks here; ${TRIAL_TERMS.configuredMinDecided} are needed to compare`
    : share < TRIAL_TERMS.configuredMinMature - 1e-9 ? "fewer than 90% of the configured model's own decided tasks here were accepted with checks passing"
    : evidence.decided >= SUGGEST_TERMS.minDecided ? "it has enough results here to be judged on them"
    : prices === null ? "one of the two models has no listed price"
    : !(prices.model.in < prices.configured.in && prices.model.out < prices.configured.out) ? "it isn't cheaper than the configured model on both input and output"
    : null;
  if (why !== null) return { offer: null, why, parts };
  return {
    offer: {
      id: `trial:${size}:${model}:${parts.evidence.slice(0, 4)}${parts.prices.slice(0, 4)}${parts.depends.slice(0, 4)}`,
      repo, cohortSize: size, provider: "claude", model, name: modelName(store, model),
      configured: { ...configured, name: modelName(store, configured.model) }, evidence, configuredEvidence, prices: prices!, depends, places: TRIAL_TERMS.places, offer: parts,
    },
    why: null, parts,
  };
}

/**
 * The trials a project offers now: per size, where nothing is suggested (a suggestion has enough evidence to stand on
 * its own) and no rule or trial is live, the closest cheaper Claude model the catalog lists now (the dearest of those
 * cheaper on both prices, then the newest), unless the project's switch is off or a person said Not now to it.
 */
export function trialOffersFor(store: Store, repo: string, now: Date): TrialOffer[] {
  if (!suggestModelsOn(store, repo)) return [];
  const suggested = new Set(suggestionsFor(store, repo, now).map(one => one.cohortSize));
  const out: TrialOffer[] = [];
  for (const size of ["small", "medium"] as const) {
    if (suggested.has(size)) continue;
    if (store.handle.prepare("SELECT 1 FROM route_rule WHERE repo = ? AND cohort_size = ? AND state IN ('active','trialling','paused')").get(repo, size) !== undefined) continue;
    const offers = seenModels(store, "claude").filter(one => exactModelId(one.id) && !notNowStands(store, repo, size, one.id, now))
      .flatMap(one => { const offer = trialOfferNow(store, repo, size, one.id, now).offer; return offer === null ? [] : [{ offer, released: one.releasedAt ?? "" }]; });
    offers.sort((a, b) => b.offer.prices.model.in - a.offer.prices.model.in || b.offer.prices.model.out - a.offer.prices.model.out || b.released.localeCompare(a.released) || a.offer.model.localeCompare(b.offer.model));
    if (offers[0] !== undefined) out.push(offers[0].offer);
  }
  return out;
}

/** A trial offer in plain words, the evidence first. */
export function trialOfferWords(offer: TrialOffer): string {
  const c = offer.configuredEvidence, e = offer.evidence;
  const own = e.decided === 0 ? `${offer.name} has no decided tasks here yet` : `${offer.name} has ${e.decided} decided task${e.decided === 1 ? "" : "s"} here so far; ${SUGGEST_TERMS.minDecided} are needed to suggest it`;
  return `${offer.configured.name} does well on ${sizeWord(offer.cohortSize)} tasks here (${c.mature} of the last ${c.decided} accepted with checks passing). ${own}. Try it on the next ${offer.places}; a person approves each one.`;
}

/** A project's trials a person sees: live (trialling, paused) and, for 30 days, the ones that ended. */
export function trialsOf(store: Store, repo: string, now: Date): RuleRow[] {
  return store.handle.prepare(`SELECT * FROM route_rule WHERE repo = ? AND kind = 'trial' AND (state IN ('trialling','paused') OR ended_at >= ?) ORDER BY cohort_size, id DESC`)
    .all(repo, new Date(now.getTime() - NOT_NOW_DAYS * DAY).toISOString()).map(readRule);
}
/** When a trial's days end, from its sealed grant; null when that can't be read (it then ends: fail closed). */
function trialExpiry(store: Store, trial: RuleRow): number | null {
  try {
    const grant = JSON.parse(String(store.handle.prepare("SELECT grant_json FROM route_rule WHERE id = ?").get(trial.id)?.["grant_json"])) as { expires?: unknown };
    const expires = typeof grant.expires === "string" ? Date.parse(grant.expires) : NaN;
    return Number.isFinite(expires) ? expires : null;
  } catch { return null; }
}

/**
 * Start a trial, in one transaction: the person re-proved (a step-up); the offer still standing, at the same prices
 * and on the same configuration generations it was offered under, with its eligibility re-checked now (a stale
 * offer refuses); the configuration valid with the trial's builder added (checkScope: repairs resume its session);
 * and the size's one winner free (concurrent starts: one wins). A refusal names which.
 */
export function startTrial(store: Store, input: { repo: string; id: string }, door: RuleDoor, now: Date): { ok: true; trial: number; offer: TrialOffer } | RuleRefusal {
  return act(store, () => {
    if (!known(store, input.repo)) throw new Refused(refused("unknown-project"));
    const proved = prove(store, door, "trial-start", input.repo);
    const asked = readTrialOfferId(input.id);
    if (asked === null) throw new Refused(refused("not-found"));
    if (store.handle.prepare("SELECT 1 FROM route_rule WHERE repo = ? AND cohort_size = ? AND state IN ('active','trialling','paused')").get(input.repo, asked.size) !== undefined) throw new Refused(refused("taken"));
    const now_ = trialOfferNow(store, input.repo, asked.size, asked.model, now);
    if (now_.parts !== null && now_.parts.depends.slice(0, 4) !== asked.depends) throw new Refused(refused("config-changed"));
    if (now_.parts !== null && now_.parts.prices.slice(0, 4) !== asked.prices) throw new Refused(refused("price-changed"));
    if (now_.offer === null || now_.parts === null || now_.parts.evidence.slice(0, 4) !== asked.evidence || !suggestModelsOn(store, input.repo)
      || suggestionsFor(store, input.repo, now).some(one => one.cohortSize === asked.size)) throw new Refused(refused("stale-suggestion"));
    const offer = now_.offer;
    const candidate = { id: 0, generation: 1, cohortSize: offer.cohortSize, provider: "claude" as const, model: offer.model, configured: { provider: offer.configured.provider, model: offer.configured.model } };
    const checked = checkScope(store, input.repo, { rules: [...liveEarnedRules(store, input.repo), candidate] });
    if (checked.kind !== "ok") throw new Refused(refused("invalid", `${REFUSAL_WORDS.invalid} ${checked.problem}`));
    const grant = { policyVersion: ROUTING_POLICY_VERSION, cutoff: now.toISOString(), expires: new Date(now.getTime() + TRIAL_TERMS.days * DAY).toISOString(), places: offer.places };
    const trial = insertTrial(store, proved, { repo: input.repo, cohortSize: offer.cohortSize, model: offer.model, configuredProvider: offer.configured.provider,
      configuredModel: offer.configured.model, limit: offer.places, grant, prices: offer.prices, depends: offer.depends }, now);
    if (trial === null) throw new Refused(refused("taken"));
    store.recordAction({ at: now.toISOString(), actor: proved.actor, repo: input.repo, taskId: null, runId: null, action: "model trial started", outcome: "changed", source: "policy",
      detail: `the next ${offer.places} ${sizeWord(offer.cohortSize)} tasks try ${offer.model} instead of ${offer.configured.model}, each approved by a person (trial ${trial})` });
    return { ok: true as const, trial, offer };
  });
}

/** Stop a live or paused trial. Plans waiting on it are re-filed on the configured builder; tasks a person already
 * approved on it keep that model. */
export function stopTrial(store: Store, trialId: number, door: RuleDoor, now: Date): { ok: true; trial: RuleRow } | RuleRefusal {
  return act(store, () => {
    const trial = ruleById(store, trialId);
    if (trial === null || trial.kind !== "trial" || (trial.state !== "trialling" && trial.state !== "paused")) throw new Refused(refused("not-found"));
    const proved = prove(store, door, "trial-stop", trial.repo);
    if (!endTrialByDoor(store, proved, trial.id, trial.generation, now)) throw new Refused(refused("not-found"));
    const places = trialPlacesOf(store, trial.id);
    store.recordAction({ at: now.toISOString(), actor: proved.actor, repo: trial.repo, taskId: null, runId: null, action: "model trial stopped", outcome: "changed", source: "policy",
      detail: `${sizeWord(trial.cohortSize)} tasks build on the configured model again after ${places.consumed} of ${places.limit} trial tasks (trial ${trial.id})` });
    return { ok: true as const, trial: ruleById(store, trial.id)! };
  });
}

/** A trial's progress in words, as Settings, the command line and chat say it. */
export function trialWords(store: Store, trial: RuleRow): string {
  const name = modelName(store, trial.model);
  const places = trialPlacesOf(store, trial.id);
  const used = places.consumed + places.reserved;
  const progress = `${used} of ${places.limit} so far (${places.consumed} started, ${places.reserved} waiting)`;
  const instead = trial.configured.model === null ? "the configured model" : modelName(store, trial.configured.model);
  if (trial.state === "trialling") return `Trying ${name} instead of ${instead} on the next ${places.limit} ${sizeWord(trial.cohortSize)} tasks: ${progress}. A person approves each one.`;
  if (trial.state === "paused") return `Trying ${name} on ${sizeWord(trial.cohortSize)} tasks: paused because Models changed (${progress}). Stop it; a new offer follows.`;
  if (trial.state === "finished") return `Tried ${name} on ${places.limit} ${sizeWord(trial.cohortSize)} tasks, finished on ${trial.endedAt?.slice(0, 10) ?? "?"}. Their results count as they're decided.`;
  if (trial.state === "expired") return `Trying ${name} on ${sizeWord(trial.cohortSize)} tasks ended on ${trial.endedAt?.slice(0, 10) ?? "?"} after ${places.consumed} of ${places.limit}.`;
  return `Trying ${name} on ${sizeWord(trial.cohortSize)} tasks: stopped${trial.endedBy === null ? "" : ` by ${trial.endedBy}`} on ${trial.endedAt?.slice(0, 10) ?? "?"} after ${places.consumed} of ${places.limit}.`;
}

/** The evidence line for a build leg a trial selected: which model, and which trial task this is ("trial 3 of 10"). */
function trialEvidenceWords(store: Store, selection: { rule: number; reservation: number }): string {
  const trial = ruleById(store, selection.rule);
  if (trial === null || trial.kind !== "trial") return "Trying a cheaper model: that trial is gone now. Change the builder if you want another model.";
  const place = trialOrdinalOf(store, selection.reservation);
  const name = modelName(store, trial.model);
  const which = place === null || place.trial !== trial.id || place.state === "released" ? "its trial place was given up" : `trial ${place.ordinal} of ${trial.limit ?? "?"}`;
  const state = trial.state === "trialling" || trial.state === "finished" ? "" : ` The trial is ${trial.state === "paused" ? "paused" : "over"} now; approving keeps ${name}.`;
  return `Trying a cheaper model: ${name}, ${which}. A person approves each trial task; you can pick another model before approving.${state}`;
}

/** The project's live trial for a size, as Settings reads it (null when none). */
export function liveTrialOf(store: Store, repo: string, size: "small" | "medium"): RuleRow | null {
  const live = liveTrialFor(store, repo, size);
  return live === null ? null : ruleById(store, live.id);
}
