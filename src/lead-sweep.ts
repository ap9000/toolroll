/**
 * Lead fan-out (docs/plans/lead-fan-out.md): a sweep's table and verdicts, read from facts — never a model.
 *
 * Each row is a child's assignment (the same state words the board uses), its verdict, and its result. The verdict is
 * the first line of the child's conclusion, `Verdict: fixed | not reproducible | blocked | done — why`, which the
 * sweep's brief asks for. It is read strictly: anything else reads as no verdict, never a guess.
 */
import { createHash } from "node:crypto";
import { withActor } from "./actor.js";
import { assignmentOf, type AssignmentSnapshot } from "./assignment.js";
import { chatTaskRun } from "./chat-task-actions.js";
import { verifiedAuthor, type Store } from "./store.js";
import { requestTaskStop, type StopRequest } from "./task-control.js";

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
  /** The child's family root: its identity in the sweep. */
  task: string;
  /** The task the family is on now (a revision of the child, after one): what an act on this row acts on. */
  active: string;
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
      ordinal: child.ordinal, label: child.label, task: child.rootTask, active: assignment?.activeTaskId ?? child.rootTask,
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

/** Not ready yet: working, being checked, or waiting on a decision — what "cancel the rest" acts on. */
export const SWEEP_OPEN: ReadonlySet<SweepRow["state"]> = new Set(["working", "checking", "needs-decision"]);

/** One open item exactly as it stands now: its active task, state, attempt (a running build to stop) and last change. */
export type SweepOpenItem = { label: string; task: string; state: string; run: number | null; at: string | null };

/** Exactly what "cancel the rest" would act on now; any change makes a card or a form for it stale. */
export function sweepOpen(store: Store, table: SweepTable, now: Date): SweepOpenItem[] {
  return table.rows.filter(row => SWEEP_OPEN.has(row.state)).map(row => ({
    label: row.label, task: row.active, state: row.state, run: chatTaskRun(store, row.active, "stop", now), at: store.getTask(row.active)?.updatedAt ?? null,
  }));
}

export const sweepOpenDigest = (open: readonly SweepOpenItem[]): string => createHash("sha256").update(JSON.stringify(open)).digest("hex");

/**
 * Cancel the rest: a running build is stopped through the ordinary stop (process-exit safeguards and all); anything
 * else is cancelled. Every refusal is said, never swallowed. The caller has proved `open` is what stands now.
 */
export function cancelSweepRest(store: Store, actor: string, open: readonly SweepOpenItem[], now: Date, via: StopRequest["via"]): string {
  let cancelled = 0, stopping = 0;
  const refused: string[] = [];
  for (const item of open) {
    if (item.run !== null) {
      const stop = requestTaskStop(store, { taskId: item.task, runId: item.run, by: verifiedAuthor(actor), via }, now);
      if (stop.ok) stopping += 1; else refused.push(`${item.label} (${stop.detail})`);
      continue;
    }
    const result = withActor({ account: actor, lead: false }, () => store.cancelTask(item.task, now));
    if (result.ok) cancelled += 1; else refused.push(`${item.label} (${String((result as { reason?: unknown }).reason ?? "refused")})`);
  }
  const parts = [`Cancelled ${cancelled} item${cancelled === 1 ? "" : "s"}.`];
  if (stopping > 0) parts.push(`Stop requested for ${stopping} running build${stopping === 1 ? "" : "s"}: ${stopping === 1 ? "it stops" : "they stop"} at the next safe point; cancel ${stopping === 1 ? "it" : "them"} from the task page once stopped.`);
  if (refused.length > 0) parts.push(`Not cancelled: ${refused.join("; ")}.`);
  parts.push("Finished results stay.");
  return parts.join(" ");
}
