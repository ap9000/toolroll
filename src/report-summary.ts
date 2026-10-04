import { readVerifiedReport } from "./evidence.js";
import type { Store } from "./store.js";
import type { ParsedReport } from "./scout-report.js";

/** The report a scout delivered, for get_task: title, summary, follow-ups —
 * verified before it is read; the document itself stays on the task page. */
export function reportSummaryFor(
  store: Store,
  evidenceRoot: string | undefined,
  taskRef: number,
): { title: string; summary: string; followUps: { title: string; goal: string }[] } | { problem: string } | null {
  if (store.latestReportArtifact(taskRef) === null) return null;
  if (evidenceRoot === undefined) return { problem: "a report exists, but this surface cannot read evidence" };
  const view = readVerifiedReport(store, evidenceRoot, taskRef);
  if (view === null) return null;
  if (!view.ok) return { problem: view.problem };
  return { title: view.report.title, summary: view.report.summary, followUps: view.report.followUps };
}

/** The longest full report a later flow step is given through {{stage.<id>.report}}. */
export const REPORT_FILL_LIMIT = 20_000;

/** What a report zone gives the zones after it besides its summary: its items as a numbered list (title, why, URL)
 * and the report's markdown, capped. Empty strings when it has neither. */
export function reportFillIns(report: Pick<ParsedReport, "items" | "report">): { items: string; report: string } {
  const items = report.items.map((one, index) => `${index + 1}. ${one.title}\n   ${one.why.replace(/\s*\n\s*/g, " ")}\n   ${one.url}`).join("\n");
  const document = report.report.length <= REPORT_FILL_LIMIT ? report.report : `${report.report.slice(0, REPORT_FILL_LIMIT)}\n… (the rest of the report is on its task)`;
  return { items, report: document };
}
