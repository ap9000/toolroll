/**
 * Result records (docs/plans/results-routing.md, slice 1): what each finished task family shows about the model that
 * built it, read only from Toolroll's own rows (runs, their cohort snapshots, checks, completions, merges, review
 * findings and revision origins) — never worktree files, park payloads, agent reports or lead tool calls.
 *
 * A policy path (release-auto.ts EVAL_POLICY): the execution-class table, eligibility and the lifecycle decide what
 * counts as a cheaper model's evidence, so a change here needs a person. The only writer is route-store.ts.
 *
 * Read-only in slice 1: nothing here suggests, routes or switches anything.
 */
import { isProtectedWork, protectedChanges } from "./approval-policy.js";
import { assignmentChecksForRun } from "./assignment.js";
import {
  INELIGIBLE_REASONS, REASON_WORDS, selectionSchema,
  type ExecClass, type IneligibleReason, type NotCountedReason, type RecordReason, type RecordState, type RejectReason, type ResultRecordView, type Selection,
} from "./contracts/route-results.js";
import { changedFilesOf, COMPLETION_ACTION } from "./result-completion.js";
import { BUILT_IN, nightlyTaskRef, releaseTaskRef, runAccounting, type Run, type Store } from "./store.js";

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
const INFRASTRUCTURE_TERMINALS: ReadonlySet<string> = new Set(["auth-expired", "usage-exhausted", "credits-depleted", "transient-throttle"]);

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

// ---- the record ---------------------------------------------------------------------------------------------------

/** How long an accepted result waits before it counts, and how long a result may wait for an answer. */
export const MATURE_AFTER_MS = 14 * 24 * 60 * 60_000;
export const UNANSWERED_AFTER_MS = 30 * 24 * 60 * 60_000;
/** The explicit cutoff for a family's spending and counts: they keep accumulating through later revision and repair
 * runs (a verdict, once final, never moves) until the family is quiet — every version ended and no run open — or
 * this long after its first run, whichever is first. */
export const ACCUMULATE_FOR_MS = 90 * 24 * 60 * 60_000;

export type RecordValue = {
  taskRef: number; task: string; repo: string | null; cohortSize: "small" | "medium" | null; provider: string | null; model: string | null;
  state: RecordState; reason: RecordReason | null; resultRun: number | null; firstStartedAt: string | null; acceptedAt: string | null;
  decidedAt: string | null; modelFailures: number; infraFailures: number; apiMicrousd: number; subscriptionRuns: number;
  subscriptionTokens: number; unknownRuns: number; remediationRuns: number; selections: Selection[]; settled: boolean;
  /** Accumulating counts: person revisions, whether the family's first built run's own check passed (null: none
   * recorded), and agent turns (runs whose provider reports none counted apart). */
  personRevisions: number; firstCheckPassed: boolean | null; agentTurns: number; turnsUnknownRuns: number;
  /** The family is quiet, or past ACCUMULATE_FOR_MS: with a final verdict, the record closes. */
  accumulationEnded: boolean;
};

type CohortRead = { run: number; repo: string | null; cohortSize: "small" | "medium" | null; ineligible: string | null; model: string | null; provider: string; selection: Selection | null; startedAt: string };

function cohortsFor(store: Store, runs: readonly number[]): Map<number, CohortRead> {
  const rows = store.handle.prepare("SELECT * FROM run_cohort WHERE run IN (SELECT value FROM json_each(?))").all(JSON.stringify(runs));
  return new Map(rows.map(row => {
    let selection: Selection | null = null;
    try { const read = selectionSchema.safeParse(JSON.parse(String(row["selection_json"]))); selection = read.success ? read.data : null; } catch { selection = null; }
    const size = row["cohort_size"] === "small" || row["cohort_size"] === "medium" ? row["cohort_size"] : null;
    return [Number(row["run"]), { run: Number(row["run"]), repo: row["repo"] == null ? null : String(row["repo"]), cohortSize: size,
      ineligible: row["ineligible"] == null ? null : String(row["ineligible"]), model: row["model"] == null ? null : String(row["model"]),
      provider: String(row["provider"]), selection, startedAt: String(row["started_at"]) }] as const;
  }));
}

/** A failed code-writing run's class: its kept class; otherwise a provider terminal or an interruption before the
 * provider started is infrastructure; anything else (a missing write included) is the model's. */
function classOfRun(run: Run, kept: string | null): ExecClass {
  if (kept === "model" || kept === "infrastructure") return kept;
  if (run.terminalClass != null && INFRASTRUCTURE_TERMINALS.has(run.terminalClass)) return "infrastructure";
  if ((run.outcome === "interrupted" || run.reason === "interrupted") && run.providerStartedAt === null) return "infrastructure";
  return "model";
}

const FAILED_OUTCOMES = new Set(["failed", "interrupted"]);

/**
 * A task family's record, evaluated now from its rows (null: no code-writing run, or a family whose lineage can't be
 * proved). The order is the plan's: what can't be attributed to one model and one cohort first, then a live attempt
 * (pending), then every rejection, then what isn't counted, then acceptance and maturity.
 */
export function evaluateFamily(store: Store, rootTaskId: string, evidenceRoot: string | undefined, now: Date): RecordValue | null {
  const family = store.taskFamilyOf(rootTaskId, null, true);
  if (family === null || family.problem !== null || family.root.id !== rootTaskId) return null;
  const versionOf = new Map<number, string>();
  const runs: Run[] = [];
  for (const version of family.versions) {
    for (const run of store.runsFor(version.refId)) {
      if (run.role !== "builder" && run.role !== "repair") continue;
      runs.push(run);
      versionOf.set(run.id, version.id);
    }
  }
  if (runs.length === 0) return null;
  runs.sort((a, b) => a.id - b.id);
  const ids = runs.map(run => run.id);
  const cohorts = cohortsFor(store, ids);
  const kept = new Map(store.handle.prepare("SELECT id, exec_class FROM run WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids))
    .map(row => [Number(row["id"]), row["exec_class"] == null ? null : String(row["exec_class"])] as const));

  // Spending, kept apart by kind and never added across kinds.
  let apiMicrousd = 0, subscriptionRuns = 0, subscriptionTokens = 0, unknownRuns = 0, remediationRuns = 0;
  for (const run of runs) {
    if (run.role === "repair" || versionOf.get(run.id) !== family.root.id) remediationRuns++;
    if (run.providerStartedAt === null) continue;
    const accounting = runAccounting(store, run.id);
    if (accounting === null || accounting.amount.kind === "unknown") unknownRuns++;
    else if (accounting.amount.kind === "api") apiMicrousd += accounting.amount.microusd;
    else { subscriptionRuns++; subscriptionTokens += (accounting.usage.in ?? 0) + (accounting.usage.out ?? 0); }
  }
  let agentTurns = 0, turnsUnknownRuns = 0;
  for (const run of runs) {
    if (run.providerStartedAt === null) continue;
    if (run.agentTurns == null) turnsUnknownRuns++; else agentTurns += run.agentTurns;
  }
  const firstBuilt = runs.find(run => run.outcome === "built");
  const firstCheck = firstBuilt === undefined ? null : store.runCheckFor(firstBuilt.id)?.status ?? null;
  const personRevisions = store.handle.prepare("SELECT COUNT(*) AS n FROM task_ref WHERE id IN (SELECT value FROM json_each(?)) AND revision_origin = 'person'")
    .get(JSON.stringify(family.versions.filter(one => one.id !== family.root.id).map(one => one.refId)))?.["n"];
  const quiet = family.versions.every(one => one.state === "done" || one.state === "cancelled" || one.state === "failed") && runs.every(run => run.outcome !== null);
  let modelFailures = 0, infraFailures = 0;
  for (const run of runs) {
    const failedCheck = run.outcome === "built" && store.runCheckFor(run.id)?.status === "failed";
    if (!FAILED_OUTCOMES.has(run.outcome ?? "") && !failedCheck) continue;
    if (failedCheck || classOfRun(run, kept.get(run.id) ?? null) === "model") modelFailures++;
    else infraFailures++;
  }
  const first = cohorts.get(runs[0]!.id);
  const attributed = runs.map(run => cohorts.get(run.id)).filter((one): one is CohortRead => one !== undefined);
  const value: RecordValue = {
    taskRef: family.root.refId, task: family.root.id, repo: family.root.repo, cohortSize: first?.cohortSize ?? null,
    provider: first?.provider ?? runs[0]!.provider, model: first?.model ?? runs[0]!.model, state: "pending", reason: null, resultRun: null,
    firstStartedAt: first?.startedAt ?? runs[0]!.startedAt, acceptedAt: null, decidedAt: null, modelFailures, infraFailures,
    apiMicrousd, subscriptionRuns, subscriptionTokens, unknownRuns, remediationRuns,
    selections: attributed.map(one => one.selection).filter((one): one is Selection => one !== null), settled: false,
    personRevisions: Number(personRevisions ?? 0), firstCheckPassed: firstCheck === "passed" ? true : firstCheck === "failed" ? false : null,
    agentTurns, turnsUnknownRuns,
    accumulationEnded: quiet || now.getTime() >= Date.parse(first?.startedAt ?? runs[0]!.startedAt) + ACCUMULATE_FOR_MS,
  };
  const reject = (reason: RejectReason): RecordValue => ({ ...value, state: "rejected", reason, decidedAt: now.toISOString(), settled: true });
  const notCounted = (reason: NotCountedReason, settled: boolean): RecordValue => ({ ...value, state: "not-counted", reason, decidedAt: settled ? now.toISOString() : null, settled });

  // 1. One cohort and one model, or the record can't say anything about a model.
  if (attributed.length !== runs.length) return notCounted("before-records", true);
  // A family whose runs disagree (a revision re-sized large, one run under strict) is mixed; one whose runs all agree
  // on not being eligible is not eligible.
  if (new Set(attributed.map(one => `${one.repo ?? ""}\u0000${one.cohortSize ?? "not-eligible"}`)).size > 1) return notCounted("mixed-cohort", true);
  if (attributed.some(one => one.cohortSize === null)) return notCounted("not-eligible", true);
  if (new Set(attributed.map(one => `${one.provider}\u0000${one.model ?? ""}`)).size > 1) return notCounted("mixed-models", true);
  for (const run of runs) {
    if (run.providerStartedAt === null || run.outcome === null) continue;
    if (run.modelReported == null) return notCounted("model-not-reported", true);
    if (run.modelReported !== cohorts.get(run.id)!.model) return notCounted("mixed-models", true);
  }
  // 2. A person who asked for changes, or a HIGH finding, rejected a result already: that stands whatever the family
  //    does next (its later runs still add to its spending).
  if (value.personRevisions > 0) return reject("person-revision");
  if (highFinding(store, ids)) return reject("high-finding");
  // 3. Still running: nothing to say yet.
  if (runs.some(run => run.outcome === null)) return value;
  const current = family.current;
  const result = [...runs].reverse().find(run => versionOf.get(run.id) === current.id && run.role === "builder" && (run.outcome === "built" || run.outcome === "no-change"));
  if (result === undefined) {
    if (current.state === "failed") return modelFailures === 0 && infraFailures > 0 ? notCounted("infrastructure-only", true) : reject("task-failed");
    if (current.state === "cancelled") return notCounted("cancelled-before-result", true);
    return value;
  }
  value.resultRun = result.id;
  // 4. Rejections, checked first among what a result can be.
  if (modelFailures >= 2) return reject("model-failures");
  if (family.versions.some(one => one.state === "failed")) return reject("task-failed");
  if (current.state === "cancelled") return reject("cancelled-after-result");
  if (store.proofVerdictFor(result.id)?.verdict === "refuted") return reject("proof-refuted");
  const checks = evidenceRoot === undefined ? null : assignmentChecksForRun(store, evidenceRoot, result.id, now);
  if (checks?.status === "failed") return reject("check-failed");
  // 5. Not counted.
  const answerBy = Date.parse(result.finishedAt ?? result.startedAt) + UNANSWERED_AFTER_MS;
  if (checks === null || checks.status === "unavailable") return notCounted("check-unavailable", now.getTime() >= answerBy);
  if (checks.status === "not-run") return notCounted("no-check", now.getTime() >= answerBy);
  const rules = value.repo === null ? null : store.approvalRules(value.repo);
  // Post-build: each built run's own diff inventory; one that can't be read whole (or was never saved) is unknown.
  for (const run of runs) {
    if (run.outcome !== "built") continue;
    const changed = changedFilesOf(store, run.id, evidenceRoot!);
    if (changed === null) return notCounted("changed-files-unknown", true);
    if (rules !== null && protectedChanges(rules, changed).length > 0) return notCounted("touched-protected", true);
  }
  // 6. Accepted by a person's completion of this result, or by its merge; then mature after 14 days.
  const acceptedAt = acceptanceOf(store, family.root.id, current.id, result.id);
  if (acceptedAt === null) return now.getTime() >= answerBy ? notCounted("unanswered", true) : value;
  const matureAt = Date.parse(acceptedAt) + MATURE_AFTER_MS;
  if (now.getTime() < matureAt) return { ...value, state: "provisional", acceptedAt };
  return { ...value, state: "mature", acceptedAt, decidedAt: new Date(matureAt).toISOString(), settled: true };
}

/** Whether the automatic review graded any of these runs' results HIGH. */
function highFinding(store: Store, runs: readonly number[]): boolean {
  const rows = store.handle.prepare("SELECT findings_json FROM build_review WHERE run IN (SELECT value FROM json_each(?)) AND findings_json IS NOT NULL").all(JSON.stringify(runs));
  return rows.some(row => {
    try {
      const findings = (JSON.parse(String(row["findings_json"])) as { findings?: { severity?: unknown }[] }).findings;
      return Array.isArray(findings) && findings.some(one => one?.severity === "HIGH");
    } catch { return true; /* an unreadable review counts against, never for */ }
  });
}

/** When a person accepted this result: the earliest person-proved completion of exactly this run (a machine's
 * completion, a lead's, or Toolroll's own `system:landed` is not acceptance), or its merge. */
function acceptanceOf(store: Store, rootId: string, currentId: string, runId: number): string | null {
  const completed = store.handle.prepare(`SELECT MIN(at) AS at FROM action_ledger WHERE action = ? AND source = 'work' AND task_id IN (?, ?)
    AND run_id = ? AND detail = 'proof person' AND actor LIKE 'operator:%'`).get(COMPLETION_ACTION, rootId, currentId, runId)?.["at"];
  const merged = store.handle.prepare(`SELECT MIN(COALESCE(m.settled_at, m.created_at)) AS at FROM merge_intent m JOIN publication p ON p.id = m.publication
    WHERE p.run = ? AND m.state = 'merged'`).get(runId)?.["at"];
  const times = [completed, merged].filter((one): one is string => typeof one === "string" && Number.isFinite(Date.parse(one)));
  return times.length === 0 ? null : times.sort()[0]!;
}

// ---- reading and re-evaluating ------------------------------------------------------------------------------------

/** The record in plain words, as the task page and `models results` say it. */
export function recordWords(record: Pick<RecordValue, "state" | "reason" | "model" | "resultRun" | "acceptedAt">): string {
  const model = record.model ?? "this model";
  if (record.state === "pending") return record.resultRun === null ? "Pending: no result yet" : "Pending: waiting for the result to be accepted";
  if (record.state === "provisional") return `Accepted: counts for ${model} 14 days after acceptance`;
  if (record.state === "mature") return `Counts for ${model}: accepted, checks passed`;
  const words = record.reason === null ? "" : REASON_WORDS[record.reason];
  return record.state === "rejected" ? `Counts against ${model}: ${words}` : `Not counted: ${words}`;
}

/** A record row as saved, in the shape `models results --json` and the task page read. */
export function recordView(row: Record<string, unknown>, task: string): ResultRecordView {
  const n = (key: string) => Number(row[key] ?? 0);
  const s = (key: string) => row[key] == null ? null : String(row[key]);
  let selections: Selection[] = [];
  try { selections = (JSON.parse(String(row["provenance_json"] ?? "[]")) as unknown[]).flatMap(one => { const read = selectionSchema.safeParse(one); return read.success ? [read.data] : []; }); } catch { selections = []; }
  const state = String(row["state"]) as RecordState;
  const reason = s("reason") as RecordReason | null;
  const view = {
    task, repo: s("repo"), size: s("cohort_size") as "small" | "medium" | null, provider: s("provider"), model: s("model"), state, reason,
    resultRun: row["result_run"] == null ? null : n("result_run"), acceptedAt: s("accepted_at"), decidedAt: s("decided_at"),
  };
  return {
    ...view, words: recordWords(view), failures: { model: n("model_failures"), infrastructure: n("infra_failures") },
    spend: { apiMicrousd: n("api_microusd"), subscriptionRuns: n("subscription_runs"), subscriptionTokens: n("subscription_tokens"), unknownRuns: n("unknown_runs"), remediationRuns: n("remediation_runs") },
    selections, personRevisions: n("person_revisions"),
    firstCheckPassed: row["first_check_passed"] == null ? null : Number(row["first_check_passed"]) === 1,
    turns: { known: n("agent_turns"), unknownRuns: n("turns_unknown_runs") }, closed: n("closed") === 1,
  };
}

/** The value as a view, for a record evaluated now and not (yet) saved. */
export function valueView(value: RecordValue): ResultRecordView {
  return recordView({ repo: value.repo, cohort_size: value.cohortSize, provider: value.provider, model: value.model, state: value.state, reason: value.reason,
    result_run: value.resultRun, accepted_at: value.acceptedAt, decided_at: value.decidedAt, model_failures: value.modelFailures, infra_failures: value.infraFailures,
    api_microusd: value.apiMicrousd, subscription_runs: value.subscriptionRuns, subscription_tokens: value.subscriptionTokens, unknown_runs: value.unknownRuns,
    remediation_runs: value.remediationRuns, provenance_json: JSON.stringify(value.selections), person_revisions: value.personRevisions,
    first_check_passed: value.firstCheckPassed === null ? null : value.firstCheckPassed ? 1 : 0, agent_turns: value.agentTurns,
    turns_unknown_runs: value.turnsUnknownRuns, closed: value.settled && value.accumulationEnded ? 1 : 0 }, value.task);
}

/** The saved records of these projects, newest first (by their family's first run). */
export function resultRecords(store: Store, repos: readonly string[], limit = 200): ResultRecordView[] {
  return store.handle.prepare(`SELECT r.*, t.external_id AS task FROM route_record r JOIN task_ref t ON t.id = r.task_ref
    WHERE r.repo IN (SELECT value FROM json_each(?)) ORDER BY r.first_started_at DESC, t.external_id DESC LIMIT ?`).all(JSON.stringify(repos), limit)
    .map(row => recordView(row, String(row["task"])));
}

/** A task's record: its family root's saved record, or, before the first pass saves one, the record evaluated now. */
export function resultRecordOf(store: Store, taskId: string, evidenceRoot: string | undefined, now: Date): ResultRecordView | null {
  const family = store.taskFamilyOf(taskId, null, true);
  if (family === null || family.problem !== null) return null;
  const row = store.handle.prepare("SELECT * FROM route_record WHERE task_ref = ?").get(family.root.refId);
  if (row !== undefined) return recordView(row, family.root.id);
  const value = evaluateFamily(store, family.root.id, evidenceRoot, now);
  return value === null ? null : valueView(value);
}

/** The task page's "Result record" line: the record's words, or null when the task has none (or it can't be read:
 * a record never fails the page). */
export function resultRecordWordsOf(store: Store, taskId: string, evidenceRoot: string | undefined, now: Date): string | null {
  try { return resultRecordOf(store, taskId, evidenceRoot, now)?.words ?? null; } catch { return null; }
}

/** The families the re-evaluation pass looks at: a root task with a code-writing run that has a cohort snapshot, whose
 * record is missing or not closed (a final verdict still gathers its family's later spending until it closes); the
 * least recently evaluated first. */
export function familiesToEvaluate(store: Store, repo: string, limit: number): string[] {
  return store.handle.prepare(`SELECT root.external_id AS task FROM run_cohort c JOIN task_ref root ON root.id = c.root_ref
    LEFT JOIN route_record rec ON rec.task_ref = c.root_ref
    WHERE c.repo = ? AND (rec.task_ref IS NULL OR rec.closed = 0)
    GROUP BY c.root_ref ORDER BY COALESCE(MIN(rec.evaluated_at), ''), c.root_ref LIMIT ?`).all(repo, limit).map(row => String(row["task"]));
}

export { INELIGIBLE_REASONS };
