/**
 * Why a release check failed, in one of four classes (docs/plans/eval-harness.md, phase 1 C), and what each class
 * allows. This replaces the flat "two flakes" allowance (AUTO_FLAKE_CAP) for release checks and for GitHub CI.
 *
 *   deterministic    typecheck, build, a failing test, a scripted journey, an upgrade, a required test gone:
 *                    nothing tolerated, never rerun to pass; the branch is fixed and the new commit released.
 *   infrastructure   independently confirmed by the plane itself: the check never started, this worker lost the
 *                    build, Toolroll's own shutdown stopped it — or, on GitHub, a job that failed before any of the
 *                    workflow's own steps ran. At most one rerun per incident and two per candidate, under the same
 *                    approval; a pass after them counts.
 *   unknown          exit 1 with no failing test named, an unexplained timeout or signal, no result at all: an error
 *                    that blocks. A diagnostic rerun may run, but its pass doesn't erase the failure: a person decides.
 *   agent-behaviour  a real-model journey failed (or passed only on its retry): counted, never rerun to pass.
 *
 * Only plane-side facts can make a failure "infrastructure": the sealed receipt's own result (which the builder writes
 * from the process it ran), and GitHub's own job and step records read by the plane's gh. Nothing the candidate writes —
 * its output, a label it prints, its report — can. The report is candidate-written: it is read only to choose among
 * the classes that block (deterministic, agent-behaviour, unknown), never to allow a rerun. gate-failure.ts's
 * classifyGateFailure reads the log and is never evidence that a release failure is harmless.
 */
import { CHECK_REPORT_CAPTURE, readSealedJson } from "./check-report.js";
import { readCheckReport, type CheckReport } from "./contracts/release-check.js";
import { regateTask } from "./dispose.js";
import { INFRA_RERUNS_PER_CANDIDATE, INFRA_RERUNS_PER_INCIDENT, type FailureClassName } from "./release.js";
import type { Store } from "./store.js";
import { verificationEvidence } from "./verification-evidence.js";

export type FailureClass = FailureClassName;
export type ClassifiedFailure = { class: FailureClass; why: string };

/** The plane's limits for confirmed infrastructure failures (one rerun per incident, two per candidate). */
export { INFRA_RERUNS_PER_CANDIDATE, INFRA_RERUNS_PER_INCIDENT };
/** The ledger action that records each rerun the release asked for, and why. */
export const RELEASE_RECHECK_ACTION = "release check rerun";

/** What a sealed verification receipt says about the check (receipt.result, and its coverage). */
export type CheckFacts = {
  result: { configured: boolean; ran?: boolean; exitCode?: number; attemptFailed?: boolean; failure?: string };
  coverage?: string | undefined;
};

/** The failures that mean the check never started or never finished for a reason the plane itself saw. */
const PLANE_INFRA: Readonly<Record<string, string>> = {
  "spawn-failed": "the check never started: the machine couldn't start its command",
  "retry-spawn-failed": "the check's retry never started: the machine couldn't start its command",
  "custody-lost": "this worker lost the build before the check could finish",
  "stopped-by-toolroll": "Toolroll's own shutdown stopped the check before it finished",
};

/**
 * One failed check, classified. `facts` come from the plane's sealed receipt; `report` (the check's own report, sealed
 * when valid) only ever picks among the classes that block. Null when the check passed.
 */
export function classifyCheckFailure(facts: CheckFacts, report: CheckReport | null): ClassifiedFailure | null {
  const result = facts.result;
  const passedCoverage = facts.coverage === undefined || facts.coverage === "full" || facts.coverage === "composed";
  if (result.configured && result.ran === true && result.exitCode === 0 && passedCoverage) return null;
  if (!result.configured) return { class: "unknown", why: "no check is configured" };
  if (result.ran !== true) {
    const failure = result.failure ?? "";
    const infra = PLANE_INFRA[failure];
    if (infra !== undefined) return { class: "infrastructure", why: infra };
    if (failure === "timed-out" || failure === "retry-timed-out") return { class: "unknown", why: "the check timed out, and nothing says why" };
    if (failure === "no-result") return { class: "unknown", why: "the check gave no complete result (no valid report, or a part, file or journey with no outcome)" };
    if (failure === "coverage-incomplete") return { class: "deterministic", why: facts.coverage === "identity-removed" ? "a required test was removed, renamed or newly skipped" : "the check didn't cover everything it owed" };
    return { class: "unknown", why: `the check couldn't run to its end (${failure || "no reason recorded"})` };
  }
  // It ran and exited nonzero (or its coverage fell short): what failed, from its report — only among blocking classes.
  if (report === null) return { class: "unknown", why: `the check exited ${result.exitCode ?? "nonzero"} and gave no report naming what failed` };
  const deterministic: string[] = [], agent: string[] = [], unexplained: string[] = [];
  for (const part of report.parts) {
    if (!part.selected || !part.ran || part.code === null) continue;
    if (part.timedOut || part.signal != null) { unexplained.push(`${part.part} ${part.timedOut ? "timed out" : `was ended by ${part.signal}`}`); continue; }
    if ((part.part === "typecheck" || part.part === "build") && part.code !== 0) deterministic.push(`the ${part.part} failed`);
  }
  for (const file of report.units?.files ?? []) if (file.state === "failed") deterministic.push(`${file.file} failed`);
  if ((report.units?.runErrors ?? 0) > 0 && !(report.units?.files ?? []).some(file => file.state === "failed")) unexplained.push(`${report.units!.runErrors} unit errors no test owned`);
  for (const run of report.journeys) for (const group of run.groups) {
    if (group.state !== "failed") continue;
    (run.kind === "real" ? agent : deterministic).push(`${run.script}${run.kind === "real" ? " real-model" : ""} journey group ${group.group} failed`);
  }
  for (const version of report.upgrades?.versions ?? []) if (version.state === "failed") deterministic.push(`the upgrade from ${version.version} failed`);
  const list = (items: string[]) => `${items.slice(0, 4).join("; ")}${items.length > 4 ? `; and ${items.length - 4} more` : ""}`;
  if (deterministic.length > 0) return { class: "deterministic", why: list(deterministic) };
  if (agent.length > 0) return { class: "agent-behaviour", why: list(agent) };
  if (unexplained.length > 0) return { class: "unknown", why: list(unexplained) };
  return { class: "unknown", why: `the check exited ${result.exitCode ?? "nonzero"} with no failing test identified` };
}

/** What passed only on a retry inside a passing check (a real-model journey group, a unit file): counted and reported,
 * never silently part of a pass. Null when there is no valid report to read it from: unknown, never "no retries". */
export function retriedInside(report: CheckReport | null): string[] | null {
  if (report === null) return null;
  return [
    ...report.journeys.flatMap(run => run.groups.filter(group => group.state === "passed" && group.retried).map(group => `${run.script}${run.kind === "real" ? " real-model" : ""} journey group ${group.group}`)),
    ...(report.units?.files ?? []).filter(file => file.flaky).map(file => `${file.file}`),
  ];
}

/** A run's check, classified from its sealed receipt and sealed report; null when it passed, or can't be read (then
 * `unreadable` says why — an unreadable receipt is itself unknown). */
export function classifyRunCheck(store: Store, root: string, runId: number): ClassifiedFailure | null {
  const gate = verificationEvidence(store, root, runId);
  if (!gate.ok) return { class: "unknown", why: `the check's receipt can't be read: ${gate.problem}` };
  if (gate.bytes === null) return { class: "unknown", why: "no machine check is recorded" };
  let receipt: { result?: CheckFacts["result"]; coverage?: string };
  try { receipt = JSON.parse(gate.bytes.toString()) as typeof receipt; } catch { return { class: "unknown", why: "the check's receipt can't be read" }; }
  if (receipt.result === undefined || typeof receipt.result !== "object") return { class: "unknown", why: "the check's receipt names no result" };
  const sealed = readSealedJson(store, root, runId, CHECK_REPORT_CAPTURE);
  const parsed = sealed === null ? null : readCheckReport(sealed.value);
  return classifyCheckFailure({ result: receipt.result, coverage: receipt.coverage }, parsed?.ok === true ? parsed.value : null);
}

/**
 * What passed only on a retry inside a run's check (eval-harness review 1, finding 3): the summary sealed into its
 * protected receipt, which a damaged or lost report can't take away; for an older receipt without one, read from the
 * sealed report. Null — unknown — when neither can be read, or when a readable report disagrees with the receipt.
 */
export function retriedOfRun(store: Store, root: string, runId: number): string[] | null {
  const sealed = readSealedJson(store, root, runId, CHECK_REPORT_CAPTURE);
  const parsed = sealed === null ? null : readCheckReport(sealed.value);
  const fromReport = retriedInside(parsed?.ok === true ? parsed.value : null);
  const gate = verificationEvidence(store, root, runId);
  if (!gate.ok || gate.bytes === null) return null;
  let check: { retried?: unknown } | undefined;
  try { check = (JSON.parse(gate.bytes.toString()) as { check?: { retried?: unknown } }).check; } catch { return null; }
  const receipt = check?.retried;
  if (receipt === undefined) return fromReport;
  if (receipt === null || !Array.isArray(receipt) || receipt.some(one => typeof one !== "string")) return null;
  if (fromReport !== null && JSON.stringify([...fromReport].sort()) !== JSON.stringify([...receipt as string[]].sort())) return null;
  return receipt as string[];
}

type BuilderRun = { id: number; outcome: string | null; scopeDigest: string | null; finishedAt: string | null; passed: boolean };

/** The task's finished builder runs under `digest`, oldest first, each with whether its check passed. */
function builderRuns(store: Store, taskRef: number, digest: string): BuilderRun[] {
  return store.handle.prepare(`SELECT r.id, r.outcome, r.scope_digest, r.finished_at, c.status FROM run r LEFT JOIN run_check c ON c.run = r.id
      WHERE r.task_ref = ? AND r.role = 'builder' AND r.finished_at IS NOT NULL AND r.scope_digest = ? ORDER BY r.id`).all(taskRef, digest)
    .map(row => ({ id: Number(row["id"]), outcome: row["outcome"] === null ? null : String(row["outcome"]), scopeDigest: String(row["scope_digest"]), finishedAt: String(row["finished_at"]),
      passed: (row["outcome"] === "built" || row["outcome"] === "no-change") && row["status"] === "passed" }));
}

/** The reruns the release asked for on this task (each source run once): run id → its class. */
function reruns(store: Store, taskId: string): Map<number, string> {
  const rows = store.handle.prepare("SELECT run_id, outcome FROM action_ledger WHERE task_id = ? AND action = ? AND run_id IS NOT NULL ORDER BY id").all(taskId, RELEASE_RECHECK_ACTION);
  return new Map(rows.map(row => [Number(row["run_id"]), String(row["outcome"])]));
}

/**
 * Whether a passing check of a release task stands, given every earlier attempt on the same candidate and signed scope:
 * each earlier failure must be confirmed infrastructure the release itself reran (at most two), and nothing in the
 * passing run may have passed only on a retry. A deterministic, unknown or agent failure before it isn't erased by a
 * later pass: a person decides. `retried` is reported even when it stands (a person's approval reads it; an automatic
 * one refuses on it).
 */
export function releaseCheckStanding(store: Store, root: string, input: { taskId: string; run: number }):
  { ok: true; earlier: { run: number; why: string }[]; retried: string[] | null } | { ok: false; why: string; retried: string[] | null } {
  const ref = store.lookupRef(input.taskId);
  const scope = store.getScope(input.taskId);
  const run = store.getRun(input.run);
  if (ref === null || scope === null || run === null || run.taskRef !== ref.id) return { ok: false, why: `run ${input.run} isn't a build of ${input.taskId}`, retried: [] };
  const retried = retriedOfRun(store, root, input.run);
  const digest = run.scopeDigest ?? null;
  if (digest === null) return { ok: false, why: `run ${input.run} recorded no scope`, retried };
  const asked = reruns(store, input.taskId);
  const earlier: { run: number; why: string }[] = [];
  for (const one of builderRuns(store, ref.id, digest)) {
    if (one.id >= input.run || one.passed) continue;
    const classified = one.outcome === "built" || one.outcome === "no-change" ? classifyRunCheck(store, root, one.id) : { class: "unknown" as const, why: `its build ended ${one.outcome ?? "without an outcome"}` };
    if (classified === null) continue;
    if (classified.class !== "infrastructure") return { ok: false, why: `an earlier check of this commit (run ${one.id}) failed: ${classified.why} (${classWords(classified.class)}). A later pass doesn't erase it, so a person decides`, retried };
    if (asked.get(one.id) !== "infrastructure") return { ok: false, why: `an earlier check of this commit (run ${one.id}) failed (${classified.why}) and wasn't rerun by the release, so a person decides`, retried };
    earlier.push({ run: one.id, why: classified.why });
  }
  if (earlier.length > INFRA_RERUNS_PER_CANDIDATE) return { ok: false, why: `infrastructure failed ${earlier.length} times on this commit (at most ${INFRA_RERUNS_PER_CANDIDATE} are rerun), so a person decides`, retried };
  return { ok: true, earlier, retried };
}

export const classWords = (kind: FailureClass): string => ({
  deterministic: "a failure in the code or its tests: fix the branch",
  infrastructure: "confirmed infrastructure",
  unknown: "unexplained: a person decides",
  "agent-behaviour": "a real-model journey: counted, never rerun to pass",
} as const)[kind];

export type RecheckAnswer =
  | { action: "rerun"; class: "infrastructure"; why: string; source: number; run: number }
  | { action: "pending"; source: number }
  | { action: "stop"; class: FailureClass | null; why: string; source: number | null };

/**
 * After a failed release check: the plane classifies the task's newest attempt from its own records and, only for
 * confirmed infrastructure within its limits (one rerun per incident, two per candidate), runs the check again on the
 * same candidate under the same approval (dispose.ts regateTask keeps candidate, scope and approval). Every attempt
 * stays in the evidence; each rerun is in the ledger with its class. Anything else stops, saying which class and why.
 */
export function recheckReleaseTask(store: Store, root: string, taskId: string, now: Date): RecheckAnswer {
  const ref = store.lookupRef(taskId);
  const scope = store.getScope(taskId);
  if (ref === null || scope === null || (scope.releaseTerms ?? null) === null || (scope.candidate ?? null) === null) return { action: "stop", class: null, why: `${taskId} isn't a release task`, source: null };
  // One transaction: the rerun and its ledger row land together, or neither does.
  return store.transact(() => recheckInside(store, root, taskId, ref.repo, String(scope.candidate), now));
}

function recheckInside(store: Store, root: string, taskId: string, repo: string | null, candidate: string, now: Date): RecheckAnswer {
  const ref = store.lookupRef(taskId)!;
  const last = store.lastBuilderRun(ref.id);
  if (last === null) return { action: "stop", class: null, why: `${taskId} has no finished attempt`, source: null };
  const asked = reruns(store, taskId);
  // Already rerun for this incident: the new attempt is queued or running.
  if (asked.has(last.id)) return { action: "pending", source: last.id };
  const classified = last.outcome === "built" || last.outcome === "no-change" ? classifyRunCheck(store, root, last.id) : { class: "unknown" as const, why: `its build ended ${last.outcome ?? "without an outcome"}` };
  if (classified === null) return { action: "stop", class: null, why: `run ${last.id}'s check passed; there is nothing to rerun`, source: last.id };
  if (classified.class !== "infrastructure") return { action: "stop", class: classified.class, why: classified.why, source: last.id };
  const digest = last.scopeDigest ?? null;
  const before = [...asked.entries()].filter(([run, kind]) => kind === "infrastructure" && store.getRun(run)?.scopeDigest === digest).length;
  if (before >= INFRA_RERUNS_PER_CANDIDATE) return { action: "stop", class: "infrastructure", why: `${classified.why}, and the check was already rerun ${before} times on this commit for infrastructure, so a person decides`, source: last.id };
  const rerun = regateTask(store, taskId, now, { kind: "release", name: "toolroll release" });
  if (!rerun.ok) return { action: "stop", class: "infrastructure", why: `${classified.why}, but it can't run again: ${rerun.message}`, source: last.id };
  store.recordAction({ at: now.toISOString(), actor: "toolroll", repo, taskId, runId: last.id, action: RELEASE_RECHECK_ACTION, outcome: "infrastructure", source: "work",
    detail: `${classified.why}; rerun ${before + 1} of at most ${INFRA_RERUNS_PER_CANDIDATE} on ${candidate.slice(0, 7)}, under the same approval` });
  return { action: "rerun", class: "infrastructure", why: classified.why, source: last.id, run: last.id };
}
