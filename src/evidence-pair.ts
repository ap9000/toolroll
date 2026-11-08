/**
 * Before-and-after evidence (docs/plans/fleet-follow-through.md, part 4), and a bug fix's optional failing test first.
 *
 * The before side is saved from a sealed failed check: its run, commit, receipt digest and command digest. The after
 * side is never stored. It is read each time from the family's newest result, so a newer commit reads as out of date
 * without anything having to notice. Rerunning uses the follow-up check road (result-follow-ups.ts): the same approved
 * command, in a fresh checkout, on the latest commit, with no agent.
 *
 * A failing-test-first report is the agent's own words, shown as that. It is not a check Toolroll ran.
 */
import { readVerificationView } from "./contracts/verification-view.js";
import { followUpChecksOf, requestFollowUpChecks, type RunLevel } from "./result-follow-ups.js";
import { readingFleet } from "./fleet-schema.js";
import { cleanFindingText, familyRootOf, NOT_ON_TASK, runOnTask } from "./findings.js";
import { runCheckLevel } from "./check-levels.js";
import { failedVerificationEvidence, verificationEvidence } from "./verification-evidence.js";
import type { Run, Store } from "./store.js";


export type EvidenceReading = "failing" | "fixed" | "still-failing" | "check-changed" | "out-of-date";
export type EvidenceSide = { run: number; head: string; status: "passed" | "failed"; via: "build" | "follow-up"; screenshots: number[] };
export type EvidencePair = {
  id: number; familyRoot: string; before: EvidenceSide; receiptDigest: string; commandDigest: string | null; savedBy: string; savedAt: string;
  after: EvidenceSide | null; latestHead: string | null; latestRun: number | null; reading: EvidenceReading;
};

/** The family's builder runs that finished with a commit, newest first. */
function familyRuns(store: Store, taskId: string): Run[] {
  const family = store.taskFamilyOf(taskId, null, true);
  const ids = family === null || family.problem !== null ? [taskId] : family.versions.map(one => one.id);
  return ids.flatMap(id => {
    const ref = store.lookupRef(id);
    return ref === null ? [] : store.runsFor(ref.id).filter(one => one.role === "builder" && one.finishedAt !== null && one.headRevision !== null);
  }).sort((a, b) => b.id - a.id);
}

const screenshotsOf = (store: Store, runId: number): number[] => store.artifactsFor(runId).filter(one => one.kind === "screenshot").map(one => one.id);

/** The command a run's sealed receipt ran, and whether it passed. Null when it has no readable receipt. */
function sealedCheck(store: Store, root: string, runId: number): { digest: string; passed: boolean } | null {
  const gate = verificationEvidence(store, root, runId);
  if (!gate.ok || gate.bytes === null) return null;
  const view = readVerificationView(gate.bytes);
  if (!view.ok) return null;
  const result = view.value.result;
  return { digest: view.value.command.digest, passed: result.configured && result.ran === true && result.exitCode === 0 };
}

/** The newest result of the family that ran `digest`, by the build's own check or a follow-up check on its commit. */
function afterSide(store: Store, root: string, runs: readonly Run[], beforeRun: number, digest: string | null, now: Date): EvidenceSide | "check-changed" | null {
  let otherCommand = false;
  for (const run of runs) {
    if (run.id < beforeRun) break;
    const follow = followUpChecksOf(store, run.id, now).filter(one => (one.state === "passed" || one.state === "failed") && one.head === run.headRevision).at(-1);
    if (follow !== undefined && (digest === null || follow.digest === digest)) return { run: run.id, head: follow.head, status: follow.state as "passed" | "failed", via: "follow-up", screenshots: screenshotsOf(store, run.id) };
    if (follow !== undefined) otherCommand = true;
    if (run.id === beforeRun) continue;
    const own = sealedCheck(store, root, run.id);
    if (own === null) continue;
    if (digest !== null && own.digest !== digest) { otherCommand = true; continue; }
    return { run: run.id, head: run.headRevision!, status: own.passed ? "passed" : "failed", via: "build", screenshots: screenshotsOf(store, run.id) };
  }
  return otherCommand ? "check-changed" : null;
}

function pairOf(store: Store, root: string, row: Record<string, unknown>, taskId: string, now: Date): EvidencePair {
  const runs = familyRuns(store, taskId);
  const beforeRun = Number(row["before_run"]);
  const commandDigest = row["command_digest"] === null ? null : String(row["command_digest"]);
  const found = afterSide(store, root, runs, beforeRun, commandDigest, now);
  const latest = runs[0] ?? null;
  const after = found === "check-changed" ? null : found;
  const reading: EvidenceReading = found === "check-changed" ? "check-changed"
    : after === null ? latest !== null && latest.headRevision !== String(row["before_head"]) ? "out-of-date" : "failing"
      : after.head !== latest?.headRevision ? "out-of-date"
        : after.status === "passed" ? "fixed" : "still-failing";
  return {
    id: Number(row["id"]), familyRoot: String(row["family_root"]),
    before: { run: beforeRun, head: String(row["before_head"]), status: "failed", via: "build", screenshots: screenshotsOf(store, beforeRun) },
    receiptDigest: String(row["receipt_digest"]), commandDigest, savedBy: String(row["saved_by"]), savedAt: String(row["saved_at"]),
    after, latestHead: latest?.headRevision ?? null, latestRun: latest?.id ?? null, reading,
  };
}

export function evidencePairsOf(store: Store, root: string, taskId: string, now: Date): EvidencePair[] {
  return readingFleet(() => store.handle.prepare("SELECT * FROM evidence_pair WHERE family_root = ? ORDER BY id DESC").all(familyRootOf(store, taskId)).map(row => pairOf(store, root, row, taskId, now)), []);
}

export type SavePair = { ok: true; id: number; existing: boolean } | { ok: false; reason: "unknown" | "not-on-task" | "no-failed-check"; message: string };

/** Save a run's failed check as the before side. Only a sealed failure can be saved: there's nothing else to compare. */
export function saveEvidencePair(store: Store, root: string, input: { taskId: string; runId?: number; by: string }, now: Date): SavePair {
  const ref = store.lookupRef(input.taskId);
  if (ref === null) return { ok: false, reason: "unknown", message: `no task \`${input.taskId}\`` };
  // A run named by a caller is checked first, and said plainly: every road (the CLI's --run, the console's form) comes here.
  if (input.runId !== undefined && !runOnTask(store, input.runId, input.taskId)) return { ok: false, reason: "not-on-task", message: NOT_ON_TASK };
  const runId = input.runId ?? familyRuns(store, input.taskId)[0]?.id;
  const run = runId === undefined ? null : store.getRun(runId);
  const root1 = familyRootOf(store, input.taskId);
  if (run === null || run.headRevision === null) return { ok: false, reason: "no-failed-check", message: `${input.taskId} has no finished attempt to save.` };
  const failure = failedVerificationEvidence(store, root, run.id);
  if (failure.kind !== "failed") return { ok: false, reason: "no-failed-check", message: `Attempt #${run.id} has no failed check to save.` };
  const view = readVerificationView(failure.receipt);
  const made = store.handle.prepare(`INSERT INTO evidence_pair (family_root, repo, before_run, before_head, receipt_digest, command_digest, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (family_root, before_run) DO NOTHING`).run(root1, ref.repo, run.id, run.headRevision, failure.digest, view.ok ? view.value.command.digest : null, input.by, now.toISOString());
  if (Number(made.changes) === 1) return { ok: true, id: Number(made.lastInsertRowid), existing: false };
  const row = store.handle.prepare("SELECT id FROM evidence_pair WHERE family_root = ? AND before_run = ?").get(root1, run.id);
  return { ok: true, id: Number(row?.["id"]), existing: true };
}

export type RerunPair = { ok: true; run: number; head: string; request: number; existing: boolean } | { ok: false; message: string };

/** Ask for the same check on the latest commit. Its level is the one the saved failure ran at. The caller proves the person. */
export function rerunEvidence(store: Store, taskId: string, actor: string, now: Date): RerunPair {
  const latest = familyRuns(store, taskId)[0];
  if (latest === undefined) return { ok: false, message: `${taskId} has no finished attempt to check.` };
  const level = runCheckLevel(store, latest.id);
  const asked = requestFollowUpChecks(store, { runId: latest.id, level: (level === "off" || level === null ? "full" : level) as RunLevel, actor }, now);
  return asked.ok ? { ok: true, run: latest.id, head: latest.headRevision!, request: asked.request, existing: asked.existing } : { ok: false, message: asked.message };
}

const short = (head: string | null): string => head === null ? "no commit" : head.slice(0, 7);

/** How a pair reads, in one sentence. */
export function evidenceWords(pair: EvidencePair): string {
  const before = `Failed on ${short(pair.before.head)} (build #${pair.before.run})`;
  switch (pair.reading) {
    case "failing": return `${before}. Not checked since.`;
    case "fixed": return `${before}, passes on ${short(pair.after!.head)} (build #${pair.after!.run}).`;
    case "still-failing": return `${before}, still fails on ${short(pair.after!.head)} (build #${pair.after!.run}).`;
    case "check-changed": return `${before}. The project's check changed since, so the two can't be compared.`;
    case "out-of-date": return `${before}. Out of date: the code is now at ${short(pair.latestHead)}${pair.after === null ? "" : `, and the last check ran on ${short(pair.after.head)}`}.`;
  }
}

export { askFailingFirst, dropFailingFirst, FAILING_FIRST_FILE, failingFirstOf, failingFirstReportSchema, failingFirstWords, saveFailingFirstReport, type FailingFirst } from "./failing-first.js";
