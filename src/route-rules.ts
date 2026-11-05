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
import { seenModel } from "./model-catalog.js";
import { legOf, routeFromJson, type PhaseRoute } from "./phase-routing.js";
import {
  endRuleByDoor, endRuleByPlane, insertEarnedRule, keepPausedRule, liveEarnedRules, modelsGenerationOf, proveRuleDoor, recordNotNow,
  ruleHoldOf, writeSuggestModels, type RuleAct, type RuleDoor, type RuleRefusalReason,
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
    const asked = readSuggestionId(input.id);
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
  // Tasks under a rule that is no longer live.
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
        } else if (proposed?.kind !== "rule" || live.has(proposed.rule)) {
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
