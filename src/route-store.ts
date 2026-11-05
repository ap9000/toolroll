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
import { NOT_COUNTED_REASONS, RECORD_STATES, REJECT_REASONS, REVISION_ORIGINS, type ExecClass, type IneligibleReason, type RevisionOrigin, type Selection } from "./contracts/route-results.js";
import type { RecordValue } from "./route-results.js";
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
