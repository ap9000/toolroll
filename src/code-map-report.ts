/**
 * Builds with and without the map (docs/plans/code-map.md §7), by assigned arm. Run usage is overwritten in place, so no
 * instant inside a run can be rebuilt: a run counts when it was admitted before its family's cutoff and has finished,
 * and then its whole usage counts. Measures come from those runs, never route_record's totals, which grow until `closed`.
 * People read this; nothing switches on it. Unknown is null, shown as —, never 0.
 */
import { firstCheckPassedOf, personRevisionsOf } from "./route-results.js";
import { runAccounting, type Run, type Store } from "./store.js";

export const ENOUGH_FAMILIES = 10;
export type Arm = "map" | "holdout";
type FamilyRead = {
  root: string; arm: Arm; eligible: boolean; status: "complete" | "still-running" | "in-window";
  revisions: number; firstCheck: boolean | null; apiMicrousd: number | null; subscriptionTokens: number | null; turns: number | null;
  differently: boolean; record: string | null;
};
export type ArmReport = {
  families: number; notEligible: number; complete: number; stillRunning: number; inWindow: number; deliveredDifferently: number;
  /** Per complete family; null with no known value. */
  personRevisions: number | null; firstCheckPassed: { passed: number; known: number }; apiUsd: number | null; subscriptionTokens: number | null; turns: number | null;
  records: Record<string, number>;
};
export type CodeMapReport = { v: 1; repo: string; asOf: string; enrollUntil: string | null; enough: boolean; arms: Record<Arm, ArmReport> };

/** The family's counted runs: admitted before the cutoff. A run after it never counts. */
function countedRuns(store: Store, refs: readonly number[], cutoff: number): Run[] {
  return refs.flatMap(ref => store.runsFor(ref)).filter(run => (run.role === "builder" || run.role === "repair") && Date.parse(run.startedAt) < cutoff).sort((a, b) => a.id - b.id);
}

function readFamily(store: Store, row: Record<string, unknown>, now: Date): FamilyRead | null {
  const root = String(row["root_task"]), arm = String(row["arm"]) as Arm, cutoff = Date.parse(String(row["observe_until"]));
  const family = store.taskFamilyOf(root, null, true);
  const versions = family !== null && family.problem === null ? family.versions : [];
  const refs = versions.length > 0 ? versions.map(one => one.refId) : [store.refFor("built-in", root).id];
  const runs = countedRuns(store, refs, cutoff);
  const unfinished = runs.some(run => run.finishedAt === null);
  const status = unfinished ? "still-running" : now.getTime() < cutoff ? "in-window" : "complete";
  const ids = JSON.stringify(runs.map(run => run.id));
  const cohort = store.handle.prepare("SELECT ineligible FROM run_cohort WHERE run IN (SELECT value FROM json_each(?)) ORDER BY run LIMIT 1").get(ids);
  const eligible = cohort !== undefined && cohort["ineligible"] === null;
  let apiMicrousd: number | null = 0, subscriptionTokens: number | null = 0, turns: number | null = 0;
  for (const run of runs) {
    if (run.providerStartedAt === null) continue;
    const accounting = runAccounting(store, run.id);
    if (accounting === null || accounting.amount.kind === "unknown") { apiMicrousd = null; subscriptionTokens = null; }
    else if (accounting.amount.kind === "api") { if (apiMicrousd !== null) apiMicrousd += accounting.amount.microusd; }
    else if (subscriptionTokens !== null) subscriptionTokens += (accounting.usage.in ?? 0) + (accounting.usage.out ?? 0);
    if (run.agentTurns == null) turns = null; else if (turns !== null) turns += run.agentTurns;
  }
  // A revision counts when it was filed before the cutoff; the root isn't one.
  const filed = versions.filter(one => one.id !== root && Date.parse(one.createdAt) < cutoff).map(one => one.refId);
  const states = store.handle.prepare("SELECT state FROM code_map_snapshot WHERE run IN (SELECT value FROM json_each(?))").all(ids).map(one => String(one["state"]));
  const record = versions.length === 0 ? undefined : store.handle.prepare("SELECT state FROM route_record WHERE task_ref = ?").get(family!.root.refId);
  return { root, arm, eligible, status, revisions: personRevisionsOf(store, filed), firstCheck: firstCheckPassedOf(store, runs), apiMicrousd, subscriptionTokens, turns,
    differently: states.some(state => state !== arm), record: record === undefined ? null : String(record["state"]) };
}

const mean = (values: readonly (number | null)[]): number | null => { const known = values.filter((one): one is number => one !== null); return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length; };

function armReport(all: readonly FamilyRead[]): ArmReport {
  const eligible = all.filter(one => one.eligible);
  const complete = eligible.filter(one => one.status === "complete");
  const checks = complete.filter(one => one.firstCheck !== null);
  const api = mean(complete.map(one => one.apiMicrousd));
  const records: Record<string, number> = {};
  for (const one of eligible) if (one.record !== null) records[one.record] = (records[one.record] ?? 0) + 1;
  return {
    families: all.length, notEligible: all.length - eligible.length, complete: complete.length, stillRunning: eligible.filter(one => one.status === "still-running").length, inWindow: eligible.filter(one => one.status === "in-window").length,
    deliveredDifferently: eligible.filter(one => one.differently).length, personRevisions: mean(complete.map(one => one.revisions)),
    firstCheckPassed: { passed: checks.filter(one => one.firstCheck === true).length, known: checks.length }, apiUsd: api === null ? null : api / 1_000_000,
    subscriptionTokens: mean(complete.map(one => one.subscriptionTokens)), turns: mean(complete.map(one => one.turns)), records,
  };
}

export function codeMapReport(store: Store, repo: string, now: Date): CodeMapReport {
  const rows = store.handle.prepare("SELECT root_task, arm, observe_until FROM code_map_family WHERE repo = ? ORDER BY root_task").all(repo);
  const reads = rows.flatMap(row => readFamily(store, row, now) ?? []);
  const arms = { map: armReport(reads.filter(one => one.arm === "map")), holdout: armReport(reads.filter(one => one.arm === "holdout")) };
  const until = store.handle.prepare("SELECT code_map_enroll_until AS at FROM project WHERE path = ?").get(repo)?.["at"];
  return { v: 1, repo, asOf: now.toISOString(), enrollUntil: typeof until === "string" ? until : null, enough: arms.map.complete >= ENOUGH_FAMILIES && arms.holdout.complete >= ENOUGH_FAMILIES, arms };
}

const number = (value: number | null, digits = 1): string => (value === null ? "—" : value.toFixed(digits));
/** The rows every surface shows: a label and each arm's value. Below 10 complete families in an arm there is no comparison. */
export function reportRows(report: CodeMapReport): { label: string; map: string; holdout: string }[] {
  const both = (label: string, read: (arm: ArmReport) => string) => ({ label, map: read(report.arms.map), holdout: read(report.arms.holdout) });
  const counts = [
    both("Builds enrolled", arm => String(arm.families)), both("Compared", arm => String(arm.complete)), both("Still running", arm => String(arm.stillRunning)),
    both("Still in their window", arm => String(arm.inWindow)), both("Not eligible", arm => String(arm.notEligible)), both("Delivered differently", arm => String(arm.deliveredDifferently)),
  ];
  if (!report.enough) return counts;
  return [...counts,
    both("Revisions by a person, per build", arm => number(arm.personRevisions, 2)),
    both("First check passed", arm => (arm.firstCheckPassed.known === 0 ? "—" : `${arm.firstCheckPassed.passed} of ${arm.firstCheckPassed.known}`)),
    both("API dollars, per build", arm => (arm.apiUsd === null ? "—" : `$${arm.apiUsd.toFixed(2)}`)),
    both("Subscription tokens, per build", arm => number(arm.subscriptionTokens, 0)),
    both("Turns, per build", arm => number(arm.turns, 1)),
    both(`Result records as of ${report.asOf.slice(0, 10)}`, arm => Object.entries(arm.records).sort().map(([state, count]) => `${count} ${state}`).join(", ") || "—"),
  ];
}
export const NOT_ENOUGH = "Not enough results yet.";
