/**
 * The only writer of the results-routing rows (docs/plans/results-routing.md, Protection item 1): run_cohort,
 * route_record, models_generation, route_rule, route_exposure*, route_trial_reservation, run.exec_class and
 * task_ref.revision_origin. Release-auto's routing scan (route-hooks.ts) needs a person for any SQL that writes them
 * from anywhere else (the migration and the Models row writers in store.ts aside).
 *
 * Each writer enforces its own invariants, so a new caller can't skip a guard that lives in its caller: a class or
 * an origin outside its list refuses, a first write is never overwritten, a cohort is written only for a code-writing
 * run that exists, and a record is saved only in a state/reason pair the contract names.
 *
 * A policy path (release-auto.ts EVAL_POLICY).
 */
import { isProtectedWork } from "./approval-policy.js";
import { currentLocalOwner, localOwnerInFlight, localOwnerStandsNow } from "./local-owner.js";
import { passwordlessOn } from "./passwordless.js";
import { machineActing } from "./scope.js";
import { NOT_COUNTED_REASONS, RECORD_STATES, REJECT_REASONS, REVISION_ORIGINS, type ExecClass, type IneligibleReason, type RevisionOrigin, type Selection } from "./contracts/route-results.js";
import type { RecordValue } from "./route-results.js";
import type { EarnedRule } from "./phase-routing.js";
import { BUILT_IN, nightlyTaskRef, releaseTaskRef, type Store } from "./store.js";

// ---- execution class --------------------------------------------------------------------------------------------

/** A failed run's raw reason, by whose account it failed. Anything not listed counts as the model's (conservative: a
 * missing or unknown class counts against the cheaper model, never for it). */
export const EXEC_CLASS_OF_REASON: Readonly<Record<string, ExecClass>> = Object.freeze({
  timeout: "model", agent: "model", "agent-reported": "model", "no-op": "model", "no-handoff": "model",
  "moved-head": "model", "moved-branch": "model", "commit-failure": "model",
  git: "infrastructure", setup: "infrastructure", "provider-init": "infrastructure", "provider-unattested": "infrastructure",
  "provider-protocol": "infrastructure", stopped: "infrastructure",
});
/** The gateway's terminal classes that say the provider, not the model, ended the attempt. */
export const INFRASTRUCTURE_TERMINALS: ReadonlySet<string> = new Set(["auth-expired", "usage-exhausted", "credits-depleted", "transient-throttle"]);

/** The class a failed run's raw reason (before the tick's normalization) and its terminal class give. */
export function execClassOf(reason: string, terminalClass: string | null): ExecClass {
  if (terminalClass !== null && INFRASTRUCTURE_TERMINALS.has(terminalClass)) return "infrastructure";
  return Object.prototype.hasOwnProperty.call(EXEC_CLASS_OF_REASON, reason) ? EXEC_CLASS_OF_REASON[reason]! : "model";
}

// ---- cohort snapshot (written at admission) ---------------------------------------------------------------------

export type CohortRow = {
  run: number; taskRef: number; rootRef: number; repo: string | null; role: "builder" | "repair";
  size: "small" | "medium" | "large" | null; risky: boolean | null; qualityMode: "default" | "strict";
  evidenceDemands: boolean; publication: "none" | "notify" | "automerge"; release: boolean; protected: boolean;
  selection: Selection; routeDigest: string; provider: string; model: string | null;
  cohortSize: "small" | "medium" | null; ineligible: IneligibleReason | null; startedAt: string;
};

export type CohortInput = {
  run: number; taskRef: number; role: "builder" | "repair"; routeDigest: string; provider: string; model: string | null;
  qualityMode: "default" | "strict"; startedAt: string;
};

/** The sealed facts a code-writing run's eligibility is decided from, conservatively: anything unreadable or not
 * sealed is not eligible. Pure reads of the store, in the admission transaction. */
export function cohortOf(store: Store, input: CohortInput): CohortRow {
  const base: CohortRow = {
    run: input.run, taskRef: input.taskRef, rootRef: input.taskRef, repo: null, role: input.role, size: null, risky: null, qualityMode: input.qualityMode,
    evidenceDemands: false, publication: "none", release: false, protected: false, selection: { kind: "configured" },
    routeDigest: input.routeDigest, provider: input.provider, model: input.model, cohortSize: null, ineligible: null, startedAt: input.startedAt,
  };
  const ineligible = (row: CohortRow, reason: IneligibleReason): CohortRow => ({ ...row, cohortSize: null, ineligible: reason });
  const ref = store.handle.prepare("SELECT backend, external_id, repo FROM task_ref WHERE id = ?").get(input.taskRef);
  if (ref === undefined || ref["backend"] !== BUILT_IN) return ineligible(base, "not-built-in");
  const taskId = String(ref["external_id"]);
  const repo = ref["repo"] === null ? null : String(ref["repo"]);
  // The family's root, so the record pass finds the family without walking it: a lineage that can't be proved is
  // its own root (and its record says so).
  const family = store.taskFamilyOf(taskId, null, true);
  const rootRef = family !== null && family.problem === null ? family.root.refId : input.taskRef;
  const sealed = store.sealedRouteOf(taskId);
  if (!sealed.ok) return ineligible({ ...base, rootRef, repo }, "no-sealed-route");
  const route = sealed.route;
  const build = route.legs[1]!;
  const selection: Selection = build.selection ?? { kind: build.chosen === "override" ? "override" : build.chosen === "pinned" ? "pin" : "configured" };
  const scope = store.getScope(taskId);
  const terms = store.handle.prepare("SELECT release_terms_json, release_check_json FROM task_scope WHERE task_id = ?").get(taskId);
  const release = releaseTaskRef(store, input.taskRef) || nightlyTaskRef(store, input.taskRef)
    || (terms !== undefined && (terms["release_terms_json"] != null || terms["release_check_json"] != null));
  const isProtected = repo === null ? false : isProtectedWork(store.approvalRules(repo), scope?.touches ?? []);
  const row: CohortRow = {
    ...base, rootRef, repo, size: route.size?.size ?? null, risky: route.size?.risky ?? null,
    qualityMode: route.qualityMode === "strict" || input.qualityMode === "strict" ? "strict" : "default",
    evidenceDemands: route.evidence.some(kind => kind === "screenshot" || kind === "manual-review"),
    publication: route.publication, release, protected: isProtected, selection,
  };
  // Every reason is a sealed fact or a project rule read now; the first that applies is kept.
  if (row.release) return ineligible(row, "release");
  if (row.protected) return ineligible(row, "protected");
  if (row.qualityMode === "strict") return ineligible(row, "strict");
  if (row.evidenceDemands) return ineligible(row, "evidence-demands");
  if (row.publication === "automerge") return ineligible(row, "automerge");
  if (row.risky !== false || route.risk !== "routine") return ineligible(row, row.risky === null ? "unsized" : "risky");
  if (row.size === null) return ineligible(row, "unsized");
  if (row.size === "large") return ineligible(row, "large");
  return { ...row, cohortSize: row.size, ineligible: null };
}



/** Keep a failed run's execution class from its raw reason, before the tick normalizes it (dispose.ts). First write
 * wins: a later ending of the same run never rewrites the class it was kept with. */
export function recordExecClass(store: Store, runId: number, reason: string): void {
  if (!Number.isSafeInteger(runId) || runId < 1 || typeof reason !== "string") throw new Error("an execution class names a run and its raw reason");
  const terminal = store.handle.prepare("SELECT terminal_class FROM run WHERE id = ?").get(runId)?.["terminal_class"];
  const kept = execClassOf(reason, terminal == null ? null : String(terminal));
  store.handle.prepare("UPDATE run SET exec_class = ? WHERE id = ? AND exec_class IS NULL").run(kept, runId);
}

/** Who a revision came from, written once with the revision's seal; never on a task that revises nothing. */
export function recordRevisionOrigin(store: Store, taskId: string, origin: RevisionOrigin): void {
  if (!(REVISION_ORIGINS as readonly string[]).includes(origin)) throw new Error(`unknown revision origin: ${String(origin)}`);
  store.handle.prepare("UPDATE task_ref SET revision_origin = ? WHERE backend = 'built-in' AND external_id = ? AND revision_of IS NOT NULL AND revision_origin IS NULL")
    .run(origin, taskId);
}

/**
 * A code-writing run's cohort snapshot, in its admission transaction (store.ts admitRun), written once and never
 * updated. A snapshot that can't be computed is never a refused admission: the run is recorded as not eligible, and a
 * write that fails leaves no row (its record then reads "started before results were recorded"), so a cheaper model
 * never gains from either.
 */
export function writeRunCohort(store: Store, input: CohortInput): void {
  if (input.role !== "builder" && input.role !== "repair") return;
  let row;
  try { row = cohortOf(store, input); }
  catch { row = { ...fallbackCohort(input), ineligible: "no-sealed-route" as const }; }
  try {
    store.handle.prepare(`INSERT INTO run_cohort (run, task_ref, root_ref, repo, role, size, risky, quality_mode, evidence_demands, publication, release, protected,
        selection_json, route_digest, provider, model, cohort_size, ineligible, started_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM run WHERE id = ? AND role IN ('builder','repair'))
      ON CONFLICT (run) DO NOTHING`)
      .run(row.run, row.taskRef, row.rootRef, row.repo, row.role, row.size, row.risky === null ? null : row.risky ? 1 : 0, row.qualityMode,
        row.evidenceDemands ? 1 : 0, row.publication, row.release ? 1 : 0, row.protected ? 1 : 0, JSON.stringify(row.selection), row.routeDigest,
        row.provider, row.model, row.cohortSize, row.ineligible, row.startedAt, row.run);
  } catch { /* no snapshot: not counted, never counted as good */ }
}

function fallbackCohort(input: CohortInput) {
  return { run: input.run, taskRef: input.taskRef, rootRef: input.taskRef, repo: null, role: input.role, size: null, risky: null, qualityMode: input.qualityMode,
    evidenceDemands: false, publication: "none" as const, release: false, protected: false, selection: { kind: "configured" as const },
    routeDigest: input.routeDigest, provider: input.provider, model: input.model, cohortSize: null, startedAt: input.startedAt };
}

/** Save a family's record as evaluated now. A decision time is kept while the state stays the same. Once a verdict
 * is final (settled) it never moves — state, reason, result run, acceptance and decision time stay as decided — but
 * the family's spending and counts keep being updated from later revision and repair runs until the record closes
 * (route-results.ts ACCUMULATE_FOR_MS); a closed record is never written again. */
export function saveResultRecord(store: Store, value: RecordValue, now: Date): void {
  if (!(RECORD_STATES as readonly string[]).includes(value.state)) throw new Error(`unknown record state: ${value.state}`);
  const reasons: readonly string[] = value.state === "rejected" ? REJECT_REASONS : value.state === "not-counted" ? NOT_COUNTED_REASONS : [];
  if ((value.reason === null) !== (reasons.length === 0) || (value.reason !== null && !reasons.includes(value.reason))) throw new Error(`a ${value.state} record can't have the reason ${String(value.reason)}`);
  store.handle.prepare(`INSERT INTO route_record (task_ref, repo, cohort_size, provider, model, state, reason, result_run, first_started_at, accepted_at, decided_at,
      model_failures, infra_failures, api_microusd, subscription_runs, subscription_tokens, unknown_runs, remediation_runs, person_revisions,
      first_check_passed, agent_turns, turns_unknown_runs, provenance_json, settled, closed, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (task_ref) DO UPDATE SET
      decided_at = CASE WHEN route_record.settled = 1 OR (route_record.state = excluded.state AND route_record.reason IS excluded.reason)
        THEN COALESCE(route_record.decided_at, excluded.decided_at) ELSE excluded.decided_at END,
      state = CASE WHEN route_record.settled = 1 THEN route_record.state ELSE excluded.state END,
      reason = CASE WHEN route_record.settled = 1 THEN route_record.reason ELSE excluded.reason END,
      result_run = CASE WHEN route_record.settled = 1 THEN route_record.result_run ELSE excluded.result_run END,
      accepted_at = CASE WHEN route_record.settled = 1 THEN route_record.accepted_at ELSE excluded.accepted_at END,
      repo = CASE WHEN route_record.settled = 1 THEN route_record.repo ELSE excluded.repo END,
      cohort_size = CASE WHEN route_record.settled = 1 THEN route_record.cohort_size ELSE excluded.cohort_size END,
      provider = CASE WHEN route_record.settled = 1 THEN route_record.provider ELSE excluded.provider END,
      model = CASE WHEN route_record.settled = 1 THEN route_record.model ELSE excluded.model END,
      first_started_at = excluded.first_started_at, model_failures = excluded.model_failures, infra_failures = excluded.infra_failures,
      api_microusd = excluded.api_microusd, subscription_runs = excluded.subscription_runs, subscription_tokens = excluded.subscription_tokens,
      unknown_runs = excluded.unknown_runs, remediation_runs = excluded.remediation_runs, person_revisions = excluded.person_revisions,
      first_check_passed = excluded.first_check_passed, agent_turns = excluded.agent_turns, turns_unknown_runs = excluded.turns_unknown_runs,
      provenance_json = excluded.provenance_json,
      settled = MAX(route_record.settled, excluded.settled),
      closed = CASE WHEN MAX(route_record.settled, excluded.settled) = 1 THEN excluded.closed ELSE 0 END,
      evaluated_at = excluded.evaluated_at
    WHERE route_record.closed = 0`)
    .run(value.taskRef, value.repo, value.cohortSize, value.provider, value.model, value.state, value.reason, value.resultRun, value.firstStartedAt,
      value.acceptedAt, value.decidedAt, value.modelFailures, value.infraFailures, Math.max(0, Math.round(value.apiMicrousd)), value.subscriptionRuns,
      value.subscriptionTokens, value.unknownRuns, value.remediationRuns, value.personRevisions, value.firstCheckPassed === null ? null : value.firstCheckPassed ? 1 : 0,
      value.agentTurns, value.turnsUnknownRuns, JSON.stringify(value.selections), value.settled ? 1 : 0, value.settled && value.accumulationEnded ? 1 : 0,
      now.toISOString());
}

/** The generation of one (scope, phase) Models row set: 0 before anything changed it. */
export function modelsGenerationOf(store: Store, scope: string, phase: string): number {
  return Number(store.handle.prepare("SELECT generation FROM models_generation WHERE scope = ? AND phase = ?").get(scope, phase)?.["generation"] ?? 0);
}

/**
 * Move a (scope, phase) generation: called by every Models row writer (store.ts), inside the writer's own
 * transaction, whenever a row actually changed. Rules that depend on a generation that moved are paused in the same
 * transaction (pauseDependentRules), so a configuration change can never leave a rule running on terms it no longer
 * has.
 */
export function bumpModelsGeneration(store: Store, scope: string, phase: string, now: Date): number {
  if (typeof scope !== "string" || scope === "" || typeof phase !== "string" || phase === "") throw new Error("a generation names its scope and phase");
  store.handle.prepare(`INSERT INTO models_generation (scope, phase, generation, changed_at) VALUES (?, ?, 1, ?)
    ON CONFLICT (scope, phase) DO UPDATE SET generation = generation + 1, changed_at = excluded.changed_at`).run(scope, phase, now.toISOString());
  pauseDependentRules(store, now);
  return modelsGenerationOf(store, scope, phase);
}

/** Pause every running rule or trial whose recorded dependency generations no longer match: a compare-and-swap on
 * the rule's own generation, so a rule another writer already moved is left to that writer. An unreadable
 * dependency list pauses too. */
export function pauseDependentRules(store: Store, now: Date): number {
  let paused = 0;
  for (const rule of store.handle.prepare("SELECT id, generation, depends_json FROM route_rule WHERE state IN ('active','trialling')").all()) {
    let stale = true;
    try {
      const depends = JSON.parse(String(rule["depends_json"])) as Record<string, unknown>;
      stale = typeof depends !== "object" || depends === null || Array.isArray(depends) || Object.entries(depends).some(([key, generation]) => {
        const at = key.lastIndexOf("|");
        return at <= 0 || typeof generation !== "number" || modelsGenerationOf(store, key.slice(0, at), key.slice(at + 1)) !== generation;
      });
    } catch { stale = true; }
    if (!stale) continue;
    paused += Number(store.handle.prepare(`UPDATE route_rule SET state = 'paused', generation = generation + 1, end_reason = 'config-changed', ended_at = ?
      WHERE id = ? AND generation = ? AND state IN ('active','trialling')`).run(now.toISOString(), rule["id"], rule["generation"]).changes);
  }
  return paused;
}

/** A deleted project's results-routing rows (project-delete.ts, through store.ts forgetProjectModels): its rules,
 * their exposures and trial places, its records and its runs' cohort snapshots. How many rows went. */
export function forgetProjectRoutes(store: Store, repo: string): number {
  const db = store.handle;
  const rules = "SELECT id FROM route_rule WHERE repo = ?";
  const refs = "SELECT id FROM task_ref WHERE repo = ?";
  let rows = 0;
  rows += Number(db.prepare(`DELETE FROM route_trial_reservation WHERE rule IN (${rules}) OR task_ref IN (${refs})`).run(repo, repo).changes);
  rows += Number(db.prepare(`DELETE FROM route_exposure_event WHERE exposure IN (SELECT id FROM route_exposure WHERE rule IN (${rules}) OR task_ref IN (${refs}))`).run(repo, repo).changes);
  rows += Number(db.prepare(`DELETE FROM route_exposure WHERE rule IN (${rules}) OR task_ref IN (${refs})`).run(repo, repo).changes);
  rows += Number(db.prepare("DELETE FROM route_rule WHERE repo = ?").run(repo).changes);
  rows += Number(db.prepare(`DELETE FROM route_record WHERE repo = ? OR task_ref IN (${refs})`).run(repo, repo).changes);
  rows += Number(db.prepare(`DELETE FROM run_cohort WHERE repo = ? OR task_ref IN (${refs}) OR root_ref IN (${refs})`).run(repo, repo, repo).changes);
  return rows;
}

// ---- earned rules: the doors and their writers (slice 2) ---------------------------------------------------------

/** A person who proved themselves for this act (model-choices.ts ModelAuthority's shape): the account, the credential
 * generation the proof was checked against, how they proved it, and whether the session or login still stands. */
export type RulePerson = { actor: string; generation: number; method: string; live: () => boolean };
/** Who asks a rule act: a person, or this computer's local owner (local mode) inside the one act it may do. */
export type RuleDoor = { kind: "person"; person: RulePerson } | { kind: "local-owner"; actor: string };
/** The acts and the door each takes (docs/plans/results-routing.md, Authority). Raising acts take a person with a
 * step-up; lowering acts take a person, or a local owner whose in-flight act is exactly the one named here. */
export const RULE_ACTS = Object.freeze({
  accept: { raising: true, localAct: null },
  keep: { raising: true, localAct: null },
  "suggest-on": { raising: true, localAct: null },
  "turn-off": { raising: false, localAct: "routing-turn-off" },
  dismiss: { raising: false, localAct: "dismiss-suggestion" },
  "suggest-off": { raising: false, localAct: "dismiss-suggestion" },
} as const);
export type RuleAct = keyof typeof RULE_ACTS;
export type RuleRefusalReason = "lead-refused" | "authority";
/** A door proved inside the write's own transaction: minted only by proveRuleDoor, and spent only there. */
export type ProvedRuleDoor = { readonly actor: string; readonly act: RuleAct; readonly via: "person" | "local-owner" };
const provedDoors = new WeakSet<ProvedRuleDoor>();
/** Proofs a raising act accepts: a password or identity provider now, or (only while Passwordless is on) a session
 * or remembered CLI login. A lowering act also accepts a signed-in session: it only takes authority away. */
const RAISING_PROOFS = new Set(["password-now", "sso-now", "fresh-password", "fresh-sso", "session", "cli-login"]);

/**
 * The rule doors' one proof, run inside the write's transaction: a lead token or a remote API token never acts
 * (`lead-refused`); a person is re-proved — the same account, still active, still an instance operator who can open
 * the project, at the credential generation the proof was made under, by a proof that still stands (model-choices.ts
 * applyModelChoices' re-proof); a local owner only for a lowering act, only while it still stands, and only when its
 * in-flight act is exactly that act's.
 */
export function proveRuleDoor(store: Store, door: RuleDoor, act: RuleAct, repo: string): { ok: true; door: ProvedRuleDoor } | { ok: false; reason: RuleRefusalReason } {
  if (machineActing() || process.env["TOOLROLL_LEAD_TOKEN"] !== undefined) return { ok: false, reason: "lead-refused" };
  const spec = RULE_ACTS[act];
  if (door.kind === "local-owner") {
    const local = currentLocalOwner();
    if (spec.localAct === null || local === null || !localOwnerInFlight(local) || local.act !== spec.localAct || local.account !== door.actor || !localOwnerStandsNow(store, local)) return { ok: false, reason: "authority" };
    const proved: ProvedRuleDoor = Object.freeze({ actor: door.actor, act, via: "local-owner" as const });
    provedDoors.add(proved);
    return { ok: true, door: proved };
  }
  const { person } = door;
  if (person.method === "lead-token" || person.method === "remote-token") return { ok: false, reason: "lead-refused" };
  const account = store.accountOf(person.actor);
  const proof = spec.raising
    ? RAISING_PROOFS.has(person.method) && ((person.method !== "session" && person.method !== "cli-login") || passwordlessOn(store))
    : RAISING_PROOFS.has(person.method) || person.method === "local-owner";
  if (account === null || account.revokedAt !== null || account.generation !== person.generation || !store.isInstanceOperator(person.actor)
    || !store.accountCanAccess(person.actor, repo) || !person.live() || !proof) return { ok: false, reason: "authority" };
  const proved: ProvedRuleDoor = Object.freeze({ actor: person.actor, act, via: "person" as const });
  provedDoors.add(proved);
  return { ok: true, door: proved };
}

function spend(door: ProvedRuleDoor, act: RuleAct | readonly RuleAct[]): void {
  const acts: readonly RuleAct[] = typeof act === "string" ? [act] : act;
  if (!provedDoors.has(door) || !acts.includes(door.act)) throw new Error("a rule write needs a door proved for exactly this act");
  provedDoors.delete(door);
}

export type RuleInsert = {
  repo: string; cohortSize: "small" | "medium"; provider: string; model: string; configuredProvider: string; configuredModel: string | null;
  grant: unknown; prices: unknown; depends: Readonly<Record<string, number>>;
};
/** Insert an accepted earned rule, live. The winner index makes a second live rule for the same project and size
 * refuse (null); nothing else is written. */
export function insertEarnedRule(store: Store, door: ProvedRuleDoor, rule: RuleInsert, now: Date): number | null {
  spend(door, "accept");
  if (rule.provider !== "claude" || (rule.cohortSize !== "small" && rule.cohortSize !== "medium")) throw new Error("only a Claude cohort of small or routine tasks can earn a rule");
  try {
    const inserted = store.handle.prepare(`INSERT INTO route_rule (repo, cohort_size, kind, provider, model, configured_provider, configured_model, state, generation,
        grant_json, prices_json, depends_json, trial_limit, accepted_by, accepted_at)
      VALUES (?, ?, 'rule', ?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL, ?, ?)`)
      .run(rule.repo, rule.cohortSize, rule.provider, rule.model, rule.configuredProvider, rule.configuredModel, JSON.stringify(rule.grant),
        JSON.stringify(rule.prices), JSON.stringify(rule.depends), door.actor, now.toISOString());
    return Number(inserted.lastInsertRowid);
  } catch (error) {
    if (/UNIQUE constraint failed/.test(String(error))) return null;
    throw error;
  }
}

/** A person's or local owner's end of a live rule — turned off, or a paused one dropped — by compare-and-swap on its
 * generation. False when the rule moved since (or isn't live). */
export function endRuleByDoor(store: Store, door: ProvedRuleDoor, ruleId: number, generation: number, now: Date): boolean {
  spend(door, "turn-off");
  const row = store.handle.prepare("SELECT state FROM route_rule WHERE id = ?").get(ruleId);
  const state = row?.["state"] === "paused" ? "dropped" : "turned-off";
  return Number(store.handle.prepare(`UPDATE route_rule SET state = ?, generation = generation + 1, ended_at = ?, ended_by = ?, end_reason = ?
    WHERE id = ? AND generation = ? AND state IN ('active','trialling','paused')`).run(state, now.toISOString(), door.actor, state === "dropped" ? "dropped" : "turned-off", ruleId, generation).changes) === 1;
}

/** Keep a paused rule: live again, on the configuration generations it depends on now. Its sealed grant (terms,
 * cutoff, expiry) never changes. */
export function keepPausedRule(store: Store, door: ProvedRuleDoor, ruleId: number, generation: number, depends: Readonly<Record<string, number>>): boolean {
  spend(door, "keep");
  return Number(store.handle.prepare(`UPDATE route_rule SET state = 'active', generation = generation + 1, depends_json = ?, ended_at = NULL, ended_by = NULL, end_reason = NULL
    WHERE id = ? AND generation = ? AND state = 'paused'`).run(JSON.stringify(depends), ruleId, generation).changes) === 1;
}

/** "Not now" on one suggestion: kept as an ended offer (state dropped, reason not-now) so the same suggestion stays
 * quiet for its 30 days; it never blocks a rule. */
export function recordNotNow(store: Store, door: ProvedRuleDoor, offer: { repo: string; cohortSize: "small" | "medium"; provider: string; model: string; configuredProvider: string; configuredModel: string | null; prices: unknown }, now: Date): void {
  spend(door, "dismiss");
  store.handle.prepare(`INSERT INTO route_rule (repo, cohort_size, kind, provider, model, configured_provider, configured_model, state, generation,
      grant_json, prices_json, depends_json, trial_limit, accepted_by, accepted_at, ended_at, ended_by, end_reason)
    VALUES (?, ?, 'rule', ?, ?, ?, ?, 'dropped', 1, '{"notNow":true}', ?, '{}', NULL, ?, ?, ?, ?, 'not-now')`)
    .run(offer.repo, offer.cohortSize, offer.provider, offer.model, offer.configuredProvider, offer.configuredModel, JSON.stringify(offer.prices),
      door.actor, now.toISOString(), now.toISOString(), door.actor);
}

/** A project's "Suggest cheaper models" switch. False when the project isn't saved here. */
export function writeSuggestModels(store: Store, door: ProvedRuleDoor, repo: string, on: boolean): boolean {
  spend(door, on ? "suggest-on" : "suggest-off");
  return Number(store.handle.prepare("UPDATE project SET suggest_models = ? WHERE path = ?").run(on ? 1 : 0, repo).changes) === 1;
}

/** The plane's own end of a rule (no person): switched off by its sealed trigger, paused (a configuration or grant
 * change), or expired. A compare-and-swap on the rule's generation and a live state: false when it moved since. */
export function endRuleByPlane(store: Store, ruleId: number, generation: number, to: "switched-off" | "paused" | "expired", reason: string, now: Date): boolean {
  const from = to === "expired" ? "('active','trialling','paused')" : "('active','trialling')";
  return Number(store.handle.prepare(`UPDATE route_rule SET state = ?, generation = generation + 1, ended_at = ?, ended_by = NULL, end_reason = ?
    WHERE id = ? AND generation = ? AND state IN ${from}`).run(to, now.toISOString(), reason.slice(0, 200), ruleId, generation).changes) === 1;
}

// ---- exposure: one row per task and rule, events append-only -----------------------------------------------------

/** The exposure rows a filing writes (store.ts saveScope): a build leg sealed under a rule opens the task's exposure
 * to it (`proposed`) or, filed again, adds `refiled`; a filing that no longer selects a rule the task was exposed to
 * adds `refiled` to that open exposure, which its approval then closes as approved with another model. Re-filing
 * never adds a row. */
export function noteExposureFiled(store: Store, taskRef: number, selection: Selection | undefined, now: Date): void {
  const at = now.toISOString();
  const open = store.handle.prepare("SELECT id, rule FROM route_exposure WHERE task_ref = ? AND closed_at IS NULL").all(taskRef);
  const rule = selection?.kind === "rule" || selection?.kind === "trial" ? selection.rule : null;
  for (const one of open) appendExposureEvent(store, Number(one["id"]), "refiled", null, at);
  if (rule === null || open.some(one => Number(one["rule"]) === rule)) return;
  // Exposed once per task and rule: a closed exposure to the same rule is never reopened.
  const made = store.handle.prepare("INSERT INTO route_exposure (task_ref, rule, created_at) VALUES (?, ?, ?) ON CONFLICT (task_ref, rule) DO NOTHING").run(taskRef, rule, at);
  if (Number(made.changes) === 1) appendExposureEvent(store, Number(made.lastInsertRowid), "proposed", null, at);
}

/** An approval closes the task's open exposures: as proposed when it sealed that very rule, otherwise approved with
 * the model it sealed. */
export function noteExposureSealed(store: Store, taskRef: number, sealed: { selection: Selection | undefined; model: string }, now: Date): void {
  const at = now.toISOString();
  for (const one of store.handle.prepare("SELECT id, rule FROM route_exposure WHERE task_ref = ? AND closed_at IS NULL").all(taskRef)) {
    const same = (sealed.selection?.kind === "rule" || sealed.selection?.kind === "trial") && sealed.selection.rule === Number(one["rule"]);
    appendExposureEvent(store, Number(one["id"]), same ? "approved-as-proposed" : "approved-with-other", same ? null : sealed.model, at);
  }
}

/** A cancel closes the task's open exposures. */
export function noteExposureCancelled(store: Store, taskRef: number, now: Date): void {
  for (const one of store.handle.prepare("SELECT id FROM route_exposure WHERE task_ref = ? AND closed_at IS NULL").all(taskRef)) {
    appendExposureEvent(store, Number(one["id"]), "cancelled", null, now.toISOString());
  }
}

const EXPOSURE_CLOSERS = new Set(["approved-as-proposed", "approved-with-other", "cancelled"]);
/** Append one event, in order: `proposed` first and only once, nothing after a closing event, and a closing event
 * closes the exposure in the same write. Anything out of order refuses. */
function appendExposureEvent(store: Store, exposure: number, kind: "proposed" | "refiled" | "approved-as-proposed" | "approved-with-other" | "cancelled", model: string | null, at: string): void {
  const events = store.handle.prepare("SELECT kind FROM route_exposure_event WHERE exposure = ? ORDER BY id").all(exposure).map(one => String(one["kind"]));
  if (kind === "proposed" ? events.length !== 0 : events[0] !== "proposed" || events.some(one => EXPOSURE_CLOSERS.has(one))) throw new Error(`exposure event ${kind} out of order`);
  if ((kind === "approved-with-other") !== (model !== null)) throw new Error("only an approval with another model names it");
  store.handle.prepare("INSERT INTO route_exposure_event (exposure, kind, model, at) VALUES (?, ?, ?, ?)").run(exposure, kind, model, at);
  if (EXPOSURE_CLOSERS.has(kind)) store.handle.prepare("UPDATE route_exposure SET closed_at = ? WHERE id = ? AND closed_at IS NULL").run(at, exposure);
}

// ---- reads routing makes at filing and admission ------------------------------------------------------------------

/** A project's live earned rules, as routing reads them (phase-routing.ts EarnedRule): kind rule, state active, a
 * Claude model. A row that doesn't read is left out (it can only ever not apply). */
export function liveEarnedRules(store: Store, repo: string | null): EarnedRule[] {
  if (repo === null) return [];
  return store.handle.prepare("SELECT * FROM route_rule WHERE repo = ? AND kind = 'rule' AND state = 'active' ORDER BY id").all(repo).flatMap(row => {
    const size = row["cohort_size"];
    if ((size !== "small" && size !== "medium") || row["provider"] !== "claude") return [];
    return [{ id: Number(row["id"]), generation: Number(row["generation"]), cohortSize: size, provider: "claude" as const, model: String(row["model"]),
      configured: { provider: String(row["configured_provider"]), model: row["configured_model"] == null ? null : String(row["configured_model"]) } }];
  });
}

/** Why a build of this task must not start under the rule its route sealed, or null: the rule switched itself off
 * after the approval and the task hasn't started (docs/plans/results-routing.md, "When a rule ends"). A rule turned off
 * by a person, or expired, keeps the sealed model; a started task's later attempts finish under it. */
export function ruleHoldOf(store: Store, taskId: string): { rule: number; model: string } | null {
  const sealed = store.sealedRouteOf(taskId);
  if (!sealed.ok) return null;
  const selection = sealed.route.legs[1]?.selection;
  if (selection?.kind !== "rule") return null;
  const rule = store.handle.prepare("SELECT state, model FROM route_rule WHERE id = ?").get(selection.rule);
  if (rule === undefined || rule["state"] !== "switched-off") return null;
  const started = store.handle.prepare(`SELECT 1 FROM run JOIN task_ref ON task_ref.id = run.task_ref
    WHERE task_ref.backend = ? AND task_ref.external_id = ? AND run.role IN ('builder','repair') LIMIT 1`).get(BUILT_IN, taskId);
  return started === undefined ? { rule: selection.rule, model: String(rule["model"]) } : null;
}
