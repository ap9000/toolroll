/**
 * Lead fan-out (docs/plans/lead-fan-out.md): a sweep's table and verdicts, read from facts — never a model.
 *
 * Each row is a child's assignment (the same state words the board uses), its verdict, and its result. The verdict is
 * the first line of the child's conclusion, `Verdict: fixed | not reproducible | blocked | done — why`, which the
 * sweep's brief asks for. It is read strictly: anything else reads as no verdict, never a guess.
 */
import { assignmentOf, type AssignmentSnapshot } from "./assignment.js";
import type { Store } from "./store.js";

export const SWEEP_VERDICTS = ["fixed", "not reproducible", "blocked", "done"] as const;
export type SweepVerdict = typeof SWEEP_VERDICTS[number];

/** The line every sweep child's brief asks for, appended to the shared rules. */
export const VERDICT_RULE = "Start your handoff's conclusion with one line: `Verdict: fixed`, `Verdict: not reproducible`, `Verdict: blocked` or `Verdict: done`, then ` — ` and one sentence why (the root cause, what you tried, or what blocks it).";

/** A conclusion's verdict line, read strictly. */
export function verdictOf(conclusion: string | null | undefined): { verdict: SweepVerdict; why: string } | null {
  if (typeof conclusion !== "string") return null;
  const first = conclusion.split("\n", 1)[0]!.trim();
  const match = /^Verdict:\s*(fixed|not reproducible|not-reproducible|blocked|done)\s*(?:—|–|-|:)\s*(.{1,300})$/i.exec(first);
  if (match === null) return null;
  const verdict = match[1]!.toLowerCase().replace("-", " ") as SweepVerdict;
  return SWEEP_VERDICTS.includes(verdict) ? { verdict, why: match[2]!.trim() } : null;
}

export type SweepRow = {
  ordinal: number;
  label: string;
  task: string;
  state: AssignmentSnapshot["state"] | "missing";
  detail: string;
  verdict: { verdict: SweepVerdict; why: string } | null;
  /** The child's result, when it has one. */
  result: { taskId: string; runId: number } | null;
};

export type SweepTable = {
  id: number;
  title: string;
  repo: string;
  maxParallel: number;
  rows: SweepRow[];
  counts: { settled: number; working: number; total: number; byVerdict: Partial<Record<SweepVerdict, number>> };
};

const SETTLED: ReadonlySet<SweepRow["state"]> = new Set(["ready-to-check", "complete", "cancelled", "needs-decision", "missing"]);

/** A sweep as its table shows it; null when there is no such sweep or this reader may not see its project. */
export function sweepTable(store: Store, id: number, now: Date, repos: readonly string[], root?: string): SweepTable | null {
  const sweep = store.getSweep(id);
  if (sweep === null || !repos.includes(sweep.repo)) return null;
  const rows = store.sweepTasks(id).map(child => {
    const assignment = assignmentOf(store, child.rootTask, now, { principal: "operator", repos }, root);
    const run = assignment?.receipt?.runId ?? null;
    const resultTask = assignment?.receipt?.taskId ?? null;
    const conclusion = run === null ? null : store.getRun(run)?.handoff ?? null;
    return {
      ordinal: child.ordinal, label: child.label, task: child.rootTask,
      state: assignment?.state ?? "missing", detail: assignment?.detail ?? "This task is gone.",
      verdict: verdictOf(conclusion),
      result: run === null || resultTask === null ? null : { taskId: resultTask, runId: run },
    } satisfies SweepRow;
  });
  const byVerdict: Partial<Record<SweepVerdict, number>> = {};
  for (const row of rows) if (row.verdict !== null) byVerdict[row.verdict.verdict] = (byVerdict[row.verdict.verdict] ?? 0) + 1;
  const settled = rows.filter(row => SETTLED.has(row.state)).length;
  return { id, title: sweep.title, repo: sweep.repo, maxParallel: sweep.maxParallel, rows,
    counts: { settled, working: rows.length - settled, total: rows.length, byVerdict } };
}

/** "8 of 11 settled — 5 fixed, 2 not reproducible, 1 blocked": the sweep in one line. */
export function sweepLine(table: SweepTable): string {
  const verdicts = SWEEP_VERDICTS.filter(one => (table.counts.byVerdict[one] ?? 0) > 0).map(one => `${table.counts.byVerdict[one]} ${one}`);
  return `${table.counts.settled} of ${table.counts.total} settled${verdicts.length === 0 ? "" : ` — ${verdicts.join(", ")}`}`;
}
