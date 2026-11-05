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
import { NOT_COUNTED_REASONS, RECORD_STATES, REJECT_REASONS, REVISION_ORIGINS, type RevisionOrigin } from "./contracts/route-results.js";
import { cohortOf, evaluateFamily, execClassOf, familiesToEvaluate, type CohortInput, type RecordValue } from "./route-results.js";
import type { Store } from "./store.js";

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

/** Save a family's record as evaluated now. A decision time is kept while the state stays the same. */
export function saveResultRecord(store: Store, value: RecordValue, now: Date): void {
  if (!(RECORD_STATES as readonly string[]).includes(value.state)) throw new Error(`unknown record state: ${value.state}`);
  const reasons: readonly string[] = value.state === "rejected" ? REJECT_REASONS : value.state === "not-counted" ? NOT_COUNTED_REASONS : [];
  if ((value.reason === null) !== (reasons.length === 0) || (value.reason !== null && !reasons.includes(value.reason))) throw new Error(`a ${value.state} record can't have the reason ${String(value.reason)}`);
  store.handle.prepare(`INSERT INTO route_record (task_ref, repo, cohort_size, provider, model, state, reason, result_run, first_started_at, accepted_at, decided_at,
      model_failures, infra_failures, api_microusd, subscription_runs, subscription_tokens, unknown_runs, remediation_runs, provenance_json, settled, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (task_ref) DO UPDATE SET repo = excluded.repo, cohort_size = excluded.cohort_size, provider = excluded.provider, model = excluded.model,
      decided_at = CASE WHEN route_record.state = excluded.state AND route_record.reason IS excluded.reason THEN COALESCE(route_record.decided_at, excluded.decided_at) ELSE excluded.decided_at END,
      state = excluded.state, reason = excluded.reason, result_run = excluded.result_run, first_started_at = excluded.first_started_at,
      accepted_at = excluded.accepted_at, model_failures = excluded.model_failures, infra_failures = excluded.infra_failures,
      api_microusd = excluded.api_microusd, subscription_runs = excluded.subscription_runs, subscription_tokens = excluded.subscription_tokens,
      unknown_runs = excluded.unknown_runs, remediation_runs = excluded.remediation_runs, provenance_json = excluded.provenance_json,
      settled = excluded.settled, evaluated_at = excluded.evaluated_at
    WHERE route_record.settled = 0`)
    .run(value.taskRef, value.repo, value.cohortSize, value.provider, value.model, value.state, value.reason, value.resultRun, value.firstStartedAt,
      value.acceptedAt, value.decidedAt, value.modelFailures, value.infraFailures, Math.max(0, Math.round(value.apiMicrousd)), value.subscriptionRuns,
      value.subscriptionTokens, value.unknownRuns, value.remediationRuns, JSON.stringify(value.selections), value.settled ? 1 : 0, now.toISOString());
}

/** The re-evaluation pass (the reconcile pass of each project, operate.ts): every family with a cohort snapshot whose
 * record is missing or not settled is evaluated again from its rows, oldest evaluation first, at most `limit` a
 * pass. Each family is its own transaction, so one unreadable family never holds the others back. */
export function reevaluateResultRecords(store: Store, repo: string, evidenceRoot: string | undefined, now: Date, limit = 100): number {
  let saved = 0;
  for (const task of familiesToEvaluate(store, repo, limit)) {
    try {
      store.transact(() => {
        const value = evaluateFamily(store, task, evidenceRoot, now);
        if (value !== null) { saveResultRecord(store, value, now); saved++; }
      });
    } catch { /* the next pass tries again */ }
  }
  return saved;
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
