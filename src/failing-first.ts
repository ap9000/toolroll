/** Failing test first (docs/plans/fleet-follow-through.md), on its own so the steering mailbox can read it. Evidence pairs
 * reach the builder through follow-up checks, and the mailbox loads with the provider table: importing them from there
 * is a cycle that fails at load in every built command. */
import { z } from "zod";
import { readingFleet } from "./fleet-schema.js";
import { cleanFindingText, familyRootOf } from "./findings.js";
import type { Store } from "./store.js";

export const FAILING_FIRST_OUTPUT_LIMIT = 2_000;
/** Where the agent writes its report, in the attempt's own mailbox folder. */
export const FAILING_FIRST_FILE = "failing-first.json";
export const failingFirstReportSchema = z.strictObject({ key: z.string().min(1).max(64), test: z.string().min(1).max(300), output: z.string().min(1).max(FAILING_FIRST_OUTPUT_LIMIT) });

export type FailingFirst = { askedBy: string; askedAt: string; reportRun: number | null; test: string | null; output: string | null; reportedAt: string | null };

export function failingFirstOf(store: Store, taskId: string): FailingFirst | null {
  return readingFleet(() => {
    const row = store.handle.prepare("SELECT * FROM failing_first WHERE family_root = ?").get(familyRootOf(store, taskId));
    if (row === undefined) return null;
    const text = (key: string): string | null => row[key] === null ? null : String(row[key]);
    return { askedBy: String(row["asked_by"]), askedAt: String(row["asked_at"]), reportRun: row["report_run"] === null ? null : Number(row["report_run"]), test: text("test"), output: text("output"), reportedAt: text("reported_at") };
  }, null);
}

export function askFailingFirst(store: Store, taskId: string, by: string, now: Date): boolean {
  const ref = store.lookupRef(taskId);
  if (ref === null) return false;
  store.handle.prepare("INSERT INTO failing_first (family_root, repo, asked_by, asked_at) VALUES (?, ?, ?, ?) ON CONFLICT (family_root) DO NOTHING").run(familyRootOf(store, taskId), ref.repo, by, now.toISOString());
  return true;
}

export function dropFailingFirst(store: Store, taskId: string): void {
  store.handle.prepare("DELETE FROM failing_first WHERE family_root = ?").run(familyRootOf(store, taskId));
}

/** The agent's report, as data. Only a task that asked takes one. */
export function saveFailingFirstReport(store: Store, taskRef: number, runId: number, report: { test: string; output: string }, now: Date): boolean {
  const taskId = store.refById(taskRef)?.externalId;
  if (taskId === undefined) return false;
  const saved = store.handle.prepare("UPDATE failing_first SET report_run = ?, test = ?, output = ?, reported_at = ? WHERE family_root = ?")
    .run(runId, cleanFindingText(report.test, 300), cleanFindingText(report.output, FAILING_FIRST_OUTPUT_LIMIT), now.toISOString(), familyRootOf(store, taskId));
  return Number(saved.changes) === 1;
}

/** How the step stands, or null when this task didn't ask for it. */
export function failingFirstWords(step: FailingFirst | null): string | null {
  if (step === null) return null;
  return step.reportedAt === null ? "Failing test first was asked for. No report yet." : `The agent reports it wrote ${step.test ?? "a test"} first and saw it fail. Toolroll didn't run this itself.`;
}
