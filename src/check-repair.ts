/**
 * A failed check gets one owner and a bounded repair (docs/plans/fleet-follow-through.md, part 2).
 *
 * One `check_repair` row per task family, revision and failure: the UNIQUE key is what keeps the same failure on the
 * same revision from starting a second repair, however many times it is seen. The row's owner is the task that built
 * the revision. The repair itself is the existing ledger's (`maybeTriggerRepair`, `repair_chain`), so it is an ordinary
 * revision: the source scope verbatim, the ordinary rails, the ordinary approval.
 *
 * Who says yes doesn't change here. A mode a person signed with automatic repair and a limit drafts and approves through
 * the seal that already exists. Without that signature nothing is drafted and nothing spends: the row waits for a person,
 * and a person's repair is a draft that takes the normal plan approval. A model never moves a row past that.
 *
 * Failure text never reaches this file's decisions: the failure key comes from the sealed receipt and the log's failing
 * file names, and it only ever matches rows, it grants nothing.
 */
import { createHash } from "node:crypto";
import { maybeTriggerRepair, type RepairTrigger } from "./dispose.js";
import { readingFleet } from "./fleet-schema.js";
import { familyRootOf, settleFindingAnswers } from "./findings.js";
import { failingTestsOf } from "./gate-failure.js";
import { CHECK_REPAIR_LIMIT, modeTermsFromJson } from "./modes.js";
import { releaseCheckScope } from "./scope.js";
import { readVerificationView } from "./contracts/verification-view.js";
import { failedVerificationEvidence } from "./verification-evidence.js";
import { saveEvidencePair } from "./evidence-pair.js";
import type { Store } from "./store.js";

export type CheckRepairState = "waiting" | "repairing" | "rerunning" | "with-person" | "parked" | "fixed" | "closed";
export type CheckRepair = {
  id: number; familyRoot: string; ownerTask: string; repo: string; revision: string; sourceRun: number; state: CheckRepairState;
  why: string; repairTask: string | null; attempt: number | null; createdAt: string; updatedAt: string;
};

const repairOf = (row: Record<string, unknown>): CheckRepair => ({
  id: Number(row["id"]), familyRoot: String(row["family_root"]), ownerTask: String(row["owner_task"]), repo: String(row["repo"]), revision: String(row["revision"]),
  sourceRun: Number(row["source_run"]), state: String(row["state"]) as CheckRepairState, why: String(row["why"]), repairTask: row["repair_task"] === null ? null : String(row["repair_task"]),
  attempt: row["attempt"] === null ? null : Number(row["attempt"]), createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"]),
});

export function checkRepairsOfTask(store: Store, taskId: string): CheckRepair[] {
  return readingFleet(() => store.handle.prepare("SELECT * FROM check_repair WHERE family_root = ? ORDER BY id DESC").all(familyRootOf(store, taskId)).map(repairOf), []);
}

export function checkRepairOfRun(store: Store, runId: number): CheckRepair | null {
  return readingFleet(() => {
    const row = store.handle.prepare("SELECT * FROM check_repair WHERE source_run = ? ORDER BY id DESC LIMIT 1").get(runId);
    return row === undefined ? null : repairOf(row);
  }, null);
}

/** What makes this failure this failure: the command, how it ended, and which files failed. Never the log's own bytes,
 * which differ on every run. */
export function failureKeyOf(receipt: string, log: string): string {
  const view = readVerificationView(receipt);
  const facts = view.ok ? view.value : null;
  const failing = failingTestsOf(log)?.map(one => one.file).sort() ?? [];
  const result = facts === null ? null : facts.result as { exitCode?: number; failure?: string };
  return createHash("sha256").update(JSON.stringify(["toolroll:check-failure", facts?.command.digest ?? null, result?.exitCode ?? null, result?.failure ?? null, failing])).digest("hex").slice(0, 32);
}

/** Parked work stays quiet: a person already has this task, or it is stopped. */
function parkedWhy(store: Store, taskRef: number, runId: number, now: Date): string | null {
  if (store.activeHolds(taskRef, now).length > 0) return "This task is on hold.";
  if (store.applicableStopFor(runId) !== null) return "This attempt was stopped.";
  if (store.decisionsForTask(taskRef).some(one => one.state === "open" || one.state === "expired")) return "This task is waiting for an answer.";
  if (store.pendingSteerCount(taskRef) > 0) return "This task has a note waiting for its next attempt.";
  return null;
}

/** Why an approved plan can't cover a repair of this result, or null when it can. */
function notCovered(store: Store, taskId: string, runId: number): string | null {
  const scope = store.getScope(taskId);
  if (scope === null) return "This task has no approved plan to repair under.";
  if (scope.releaseTerms != null || releaseCheckScope(scope) || (scope.candidate ?? null) !== null) return "Its plan only covers checking this commit. A fix needs a task of its own.";
  if (store.lookupRef(taskId)?.deliverable === "report") return "This task delivers a report: there's no code to repair.";
  const publication = store.publicationForRun(runId);
  if (publication !== null && !(publication.state === "intended" && publication.attempts === 0)) return "This result is published. Fix it through its pull request.";
  return null;
}

/** The attempts this family's repair chain has spent. */
const attemptsUsed = (store: Store, taskId: string): number => store.repairLineageOf(taskId).attempts.reduce((highest, row) => Math.max(highest, row.attempt), 0);

function move(store: Store, id: number, state: CheckRepairState, why: string, now: Date, draft?: { task: string; attempt: number }): void {
  store.handle.prepare("UPDATE check_repair SET state = ?, why = ?, updated_at = ?, repair_task = COALESCE(?, repair_task), attempt = COALESCE(?, attempt) WHERE id = ?")
    .run(state, why, now.toISOString(), draft?.task ?? null, draft?.attempt ?? null, id);
  store.bumpWake();
}

function askPerson(store: Store, row: { id: number; ownerTask: string; sourceRun: number }, subject: string, body: string, now: Date): void {
  store.enqueueNotification({ source: { run: row.sourceRun }, dedupeKey: `check-repair:${row.id}:${subject}`, kind: "check-repair", pushClass: "attention", subject, body, link: `/t/${encodeURIComponent(row.ownerTask)}` }, now);
}

/** Take the row one step, from where it stands now. A person's yes is never decided here: `person` only says a person asked for the draft. */
function advance(store: Store, repo: string, root: string, row: CheckRepair, now: Date, person: boolean): RepairTrigger | null {
  const run = store.getRun(row.sourceRun);
  const ref = run === null ? null : store.refById(run.taskRef);
  const verdict = store.proofVerdictFor(row.sourceRun);
  if (run === null || ref === null || verdict === null) { move(store, row.id, "with-person", "The failed attempt's records can't be read.", now); return null; }
  const parked = person ? null : parkedWhy(store, run.taskRef, run.id, now);
  if (parked !== null) { move(store, row.id, "parked", parked, now); return null; }
  const uncovered = notCovered(store, row.ownerTask, run.id);
  if (uncovered !== null) {
    move(store, row.id, "with-person", uncovered, now);
    // A release's check speaks for itself (release-adapters.ts): one voice for one failure.
    if (store.getScope(row.ownerTask)?.releaseTerms == null) askPerson(store, row, "A failed check needs you", `The check failed on ${row.revision.slice(0, 7)}, and a repair can't run under this plan. ${uncovered}`, now);
    return null;
  }
  const mode = store.activeMode(repo, now);
  const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
  const auto = terms?.repairAuto === true;
  const limit = auto ? terms!.repairMaxAttempts : CHECK_REPAIR_LIMIT;
  const used = attemptsUsed(store, row.ownerTask);
  if (used >= limit) {
    const why = `${used} repair${used === 1 ? "" : "s"} tried, which is the limit. It's yours to decide.`;
    move(store, row.id, "with-person", why, now);
    askPerson(store, row, "Repairs ran out on a failed check", `The check still fails on ${row.revision.slice(0, 7)} after ${used} repair${used === 1 ? "" : "s"}. The failed check's log is on the result.`, now);
    return null;
  }
  if (!auto && !person) {
    move(store, row.id, "waiting", "Waiting for a person to start a repair.", now);
    store.enqueueNotification({ source: { run: run.id }, dedupeKey: `check-repair:${row.id}:waiting`, kind: "check-repair", subject: "A check failed", body: `The check failed on ${row.revision.slice(0, 7)}. Start a repair on the task page.`, link: `/t/${encodeURIComponent(row.ownerTask)}` }, now);
    return null;
  }
  const trigger = maybeTriggerRepair(store, repo, root, run.id, verdict.verdict, now, "verification", !person);
  if (trigger.kind === "drafted") {
    move(store, row.id, "repairing", trigger.approved ? `Repair ${trigger.draftTaskId} is approved under the signed mode and will build next.` : `Repair ${trigger.draftTaskId} is drafted and waits for its plan to be approved.`, now, { task: trigger.draftTaskId, attempt: trigger.attempt });
    saveEvidencePair(store, root, { taskId: row.ownerTask, runId: run.id, by: "Toolroll" }, now);
  } else if (trigger.kind === "rerun") {
    move(store, row.id, "rerunning", "The failure looks unrelated to this change, so the check runs once more on the same commit.", now);
  } else {
    const why = trigger.kind === "stopped" ? stopWords(trigger.reason) : "A repair can't start from this result. It's yours to decide.";
    move(store, row.id, "with-person", why, now);
    if (trigger.kind === "stopped") askPerson(store, row, "A repair stopped", why, now);
  }
  return trigger;
}

const stopWords = (reason: Extract<RepairTrigger, { kind: "stopped" }>["reason"]): string => ({
  "repair-attempts-spent": "The repairs allowed were used up.",
  "repair-no-progress": "Two repairs in a row didn't reduce what's failing, so Toolroll stopped.",
  "repair-refused-integrity": "The result disagrees with its approved terms, so a person reads it first.",
}[reason]);

/**
 * Route one failed check. Runs at disposition. A failure already on record for this family and revision changes nothing,
 * unless it was the one rerun of an unrelated failure, which now goes to a person through the ledger's own rerun stop.
 */
export function routeFailedCheck(store: Store, repo: string, root: string, runId: number, now: Date): CheckRepair | null {
  const run = store.getRun(runId);
  if (run === null || run.role !== "builder" || run.finishedAt === null || !run.headRevision) return null;
  const taskId = store.externalIdFor(run.taskRef);
  if (taskId === null) return null;
  const failure = failedVerificationEvidence(store, root, runId);
  if (failure.kind !== "failed") return null;
  const familyRoot = familyRootOf(store, taskId);
  const key = failureKeyOf(failure.receipt, failure.log);
  return store.transact(() => {
    const earlier = store.handle.prepare("SELECT * FROM check_repair WHERE family_root = ? AND revision = ? AND failure_key = ?").get(familyRoot, run.headRevision, key);
    if (earlier !== undefined) {
      const row = repairOf(earlier);
      if (row.state === "rerunning") {
        store.handle.prepare("UPDATE check_repair SET source_run = ? WHERE id = ?").run(runId, row.id);
        maybeTriggerRepair(store, repo, root, runId, store.proofVerdictFor(runId)?.verdict ?? "refuted", now, "verification", true);
        move(store, row.id, "with-person", "It failed again on the same commit. It's yours to decide.", now);
      }
      return repairOf(store.handle.prepare("SELECT * FROM check_repair WHERE id = ?").get(row.id)!);
    }
    // A newer failure replaces an older one nobody took up.
    store.handle.prepare("UPDATE check_repair SET state = 'closed', why = 'A newer attempt replaced this result.', updated_at = ? WHERE family_root = ? AND state IN ('waiting', 'parked', 'rerunning')").run(now.toISOString(), familyRoot);
    const made = store.handle.prepare(`INSERT INTO check_repair (family_root, owner_task, repo, revision, failure_key, source_run, state, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', '', ?, ?)`)
      .run(familyRoot, taskId, repo, run.headRevision, key, runId, now.toISOString(), now.toISOString());
    const row = repairOf(store.handle.prepare("SELECT * FROM check_repair WHERE id = ?").get(Number(made.lastInsertRowid))!);
    advance(store, repo, root, row, now, false);
    return repairOf(store.handle.prepare("SELECT * FROM check_repair WHERE id = ?").get(row.id)!);
  });
}

export type StartRepair = { ok: true; draft: string; attempt: number; approved: boolean } | { ok: false; reason: "unknown" | "refused"; message: string };

/** A person asks for the repair. The draft takes the normal plan approval: this is not that approval. */
export function startCheckRepair(store: Store, root: string, runId: number, now: Date): StartRepair {
  const row = checkRepairOfRun(store, runId);
  if (row === null) return { ok: false, reason: "unknown", message: `Run ${runId} has no failed check to repair.` };
  if (row.state !== "waiting" && row.state !== "parked" && row.state !== "with-person") return { ok: false, reason: "refused", message: row.repairTask !== null ? `Repair ${row.repairTask} already exists for this failure.` : row.why };
  return store.transact((): StartRepair => {
    const trigger = advance(store, row.repo, root, row, now, true);
    if (trigger?.kind === "drafted") return { ok: true, draft: trigger.draftTaskId, attempt: trigger.attempt, approved: trigger.approved };
    return { ok: false, reason: "refused", message: repairOf(store.handle.prepare("SELECT * FROM check_repair WHERE id = ?").get(row.id)!).why };
  });
}

/** A passing result in the family ends its failed-check rows. Rows the person already holds end too: the code passes now. */
export function settleCheckRepairs(store: Store, taskId: string, verdict: string, now: Date): void {
  if (verdict !== "verified" && verdict !== "attested") return;
  readingFleet(() => store.handle.prepare("UPDATE check_repair SET state = 'fixed', why = 'A later result passed its check.', updated_at = ? WHERE family_root = ? AND state NOT IN ('fixed', 'closed')").run(now.toISOString(), familyRootOf(store, taskId)), null);
}

/** Each sweep: a parked failure whose task is free again takes its next step, unless a newer attempt replaced it. */
export function resumeParkedRepairs(store: Store, root: string, now: Date): number {
  return readingFleet(() => {
    let moved = 0;
    for (const raw of store.handle.prepare("SELECT * FROM check_repair WHERE state = 'parked'").all()) {
      const row = repairOf(raw);
      const run = store.getRun(row.sourceRun);
      if (run === null) continue;
      if (parkedWhy(store, run.taskRef, run.id, now) !== null) continue;
      store.transact(() => {
        if (store.lastBuilderRun(run.taskRef)?.id !== run.id) move(store, row.id, "closed", "A newer attempt replaced this result.", now);
        else advance(store, row.repo, root, row, now, false);
      });
      moved++;
    }
    return moved;
  }, 0);
}

/** A build was accepted as finished: count what it answered, then route its check if it failed. Bookkeeping that never
 * costs the build its result: a problem here leaves the finding open and the failed check on the result. */
export function followBuiltRun(store: Store, repo: string, root: string, runId: number, worktree: string, now: Date): void {
  try { settleFindingAnswers(store, runId, worktree, now); } catch { /* the answers stay saved */ }
  try { store.transact(() => store.savepoint(() => routeFailedCheck(store, repo, root, runId, now))); } catch { /* the failure stays on the result */ }
}

/** How a failed check stands, for a person, in one line. */
export function checkRepairWords(row: CheckRepair): string {
  const head = `Check failed on ${row.revision.slice(0, 7)} (build #${row.sourceRun})`;
  if (row.state === "with-person") return `${head}, needs you. ${row.why}`;
  return row.state === "parked" ? `${head}. Paused: ${row.why}` : `${head}. ${row.why}`;
}
