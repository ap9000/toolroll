/**
 * The engine API's reads (solo-workbench plan v2, A0; contracts/engine-api.ts): a task's step cards and a result's
 * diff, file by file. Pure reads over the store and the sealed evidence: nothing here decides who may see what — the
 * route table and the handlers (server/engine-api.ts) admit the caller and the task before any of these runs, and
 * each read is given only what that admission resolved.
 *
 * Cheap on purpose: the step cards read the task's one assignment snapshot, its own work status and its runs (one
 * task's facts, never the whole Work projection or the task page); the diff reads the sealed patch and parses only the
 * file asked for, so the 2 MB result document is never built for a terminal.
 */
import type { Run, Store, TaskFamily } from "./store.js";
import { assignmentOf } from "./assignment.js";
import { assignmentCardOf } from "./assignment-ui.js";
import { assignmentStageOf, stageOfCode } from "./task-status.js";
import { taskRoad, type RoadChecks } from "./first-run.js";
import { stepRowsOf, type StepRowFacts } from "./workspace-ui.js";
import { approvalOf } from "./scope.js";
import { approvalSummaryOf, summaryContextOf } from "./approval-summary.js";
import { taskWorkSummaryOf, type WorkSummaryAccess } from "./work-summary.js";
import { terminalDiffView } from "./result-evidence-readers.js";
import { parseReviewDiff } from "./server/render-results.js";
import { revisionSourceOf } from "./result-review.js";
import { ENGINE_API_VERSION, type ResultDiff, type ResultDiffFile, type StepCard, type StepCards } from "./contracts/engine-api.js";

/** A run that is the task's delivered result (task-views.ts runIsTaskResult): a finished build or investigation. */
export const isResultRun = (run: Pick<Run, "role" | "finishedAt">): boolean => run.finishedAt !== null && (run.role === "builder" || run.role === "scout");

/** Approvals no person gave at the moment of approval (a check rule's own yes). */
const AUTOMATIC = new Set(["auto-check", "auto-green"]);

type StepRead = { store: Store; family: TaskFamily; now: Date; access: WorkSummaryAccess; evidenceRoot: string };

/** One task's step cards: the task page's road and rows (taskRoad, stepRowsOf) over the facts they read, each with
 * the agent, time and cost of the runs behind it. */
export function stepCardsOf({ store, family, now, access, evidenceRoot }: StepRead): StepCards {
  const current = family.current, root = family.root;
  const ref = store.lookupRef(current.id);
  const scope = store.getScope(current.id);
  const runs = ref === null ? [] : store.runsFor(ref.id);
  const assignment = assignmentOf(store, current.id, now, access, evidenceRoot);
  // The task's own work status (one task's facts, not the whole Work projection), as the task page reads it.
  const item = taskWorkSummaryOf(store, current.id, now, access);
  const live = runs.find(run => run.finishedAt === null) ?? null;
  const planning = live?.role === "planner";
  const card = assignment === null || item === null ? null : assignmentCardOf(assignment, { workStatus: item.status, planning });
  const approval = approvalOf(scope);
  const approved = approval.approved;
  const report = ref?.deliverable === "report";
  const plannerRuns = runs.filter(run => run.role === "planner");
  // "Just code": no plan was asked for or written and the person's yes came with the task, so the chain has no Plan
  // and no Approval step (a client leaves those cards out).
  const justCode = plannerRuns.length === 0 && (ref?.plan ?? null) === null && approved;
  const journey = current.state === "cancelled" || item === null ? null : (() => {
    const read = assignment !== null ? assignmentStageOf(assignment, { token: item.status.token, views: item.status.views }, planning) : stageOfCode(item.status.token, { planning });
    const checks: RoadChecks = card?.status.check ?? null;
    return taskRoad(read, approved, current.state === "done", { checks, report });
  })();
  const facts: StepRowFacts = {
    journey,
    scout: report,
    status: card === null ? null : { status: { headline: card.status.headline }, attempts: card.attempts },
    approved: scope !== null && approved && scope.approvedBy !== null && scope.approvedAt !== null
      ? { by: scope.approvedBy, at: scope.approvedAt, automatic: AUTOMATIC.has(String(scope.approvalBasis ?? "")), rule: null } : null,
    approve: null,
    plan: plannerRuns.length === 0 && ref?.plan == null ? null
      : { lead: null, by: plannerRuns[0]?.provider ?? null, at: plannerRuns.find(run => run.finishedAt !== null)?.finishedAt ?? null, planning },
    result: assignment?.receipt == null ? null : { selected: assignment.receipt },
    thread: runs.filter(isResultRun).map(run => ({ kind: "result", at: run.finishedAt! })),
  };
  const rows = stepRowsOf(facts);
  const builds = runs.filter(run => run.role === "builder" || run.role === "scout" || run.role === "repair");
  const reviews = runs.filter(run => run.role === "reviewer");
  const behind: Record<StepCard["key"], Run[]> = { plan: plannerRuns, approve: [], build: builds, checks: [], review: reviews, ready: [] };
  // The waiting approval's terms: the one summary every surface shows (approval-summary.ts), its key what a yes pins.
  const terms = scope === null || approved ? null : (() => {
    const summary = approvalSummaryOf(scope, summaryContextOf(store, current.id, scope, now));
    return { key: summary.key, revision: summary.revision,
      rows: [...summary.decisions, ...(summary.why === null ? [] : [{ label: "Why model", words: summary.why }]), ...summary.differs].map(one => ({ label: one.label, words: one.words, lines: "lines" in one ? [...(one.lines ?? [])] : [] })),
      warnings: summary.warnings.map(one => one.words), usualLabel: summary.usualLabel, usual: summary.usual.map(one => ({ label: one.label, words: one.words })) };
  })();
  const cards: StepCard[] | null = rows === null ? null : rows.map(row => ({
    key: row.key, label: row.label, state: row.state, mark: row.mark, sentence: row.sentence, at: row.at, needsYou: row.needsYou,
    inChain: !(justCode && (row.key === "plan" || row.key === "approve")),
    ...runFacts(behind[row.key]),
    ...(row.key === "approve" && terms !== null ? { terms } : {}),
  }));
  // The automatic review, where one ran: its own card after Checks (a chain's Review step reads the same way).
  if (cards !== null && reviews.length > 0) {
    const latest = reviews[0]!;
    const state: StepCard["state"] = latest.finishedAt === null ? "current" : latest.outcome === "failed" || latest.outcome === "refused" ? "stuck" : "done";
    const at = cards.findIndex(one => one.key === "ready");
    cards.splice(at === -1 ? cards.length : at, 0, {
      key: "review", label: "Review", state, mark: state === "current" ? "live" : state === "stuck" ? "stuck" : "done",
      sentence: state === "current" ? "Reviewing now" : state === "stuck" ? "The review didn't finish" : "Reviewed",
      at: latest.finishedAt, needsYou: false, inChain: true, ...runFacts(reviews),
    });
  }
  return {
    version: ENGINE_API_VERSION,
    task: { id: current.id, root: root.id, title: root.title, state: current.state, project: current.repo },
    chain: justCode ? "just-code" : "plan-first",
    headline: card?.status.headline ?? null,
    liveRun: live?.id ?? null,
    cards,
    // The result this task's page offers Accept and Send back on (chat-decide.ts resultFresh reads the same facts).
    review: assignment !== null && assignment.state === "ready-to-check" && assignment.receipt !== null && assignment.receipt.taskId === current.id
      ? { run: assignment.receipt.runId, receipt: assignment.receipt.digest, source: revisionSourceOf(scope?.digest ?? null) } : null,
    room: `task:${encodeURIComponent(root.id)}`,
  };
}

/** Who ran a step's latest run, when its runs started and ended, and their recorded cost together. Runs are newest first. */
function runFacts(runs: readonly Run[]): Pick<StepCard, "agent" | "startedAt" | "finishedAt" | "costUsd" | "runs"> {
  const latest = runs[0] ?? null;
  const costs = runs.map(run => run.costUsd).filter((one): one is number => typeof one === "number" && Number.isFinite(one));
  return {
    agent: latest === null ? null : { provider: latest.provider, model: latest.modelReported ?? latest.model ?? null },
    startedAt: runs.at(-1)?.startedAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
    costUsd: costs.length === 0 ? null : Math.round(costs.reduce((sum, one) => sum + one, 0) * 1e6) / 1e6,
    runs: runs.map(run => run.id),
  };
}

// ---- the result's diff, file by file -------------------------------------------------------------------------------

/** The family's result runs, newest first: every run the Result tab can pick. */
export function resultRunsOf(store: Store, family: TaskFamily): Run[] {
  return family.versions.flatMap(version => store.runsFor(version.refId)).filter(isResultRun).sort((a, b) => b.id - a.id);
}

/** The patch cut at each file's `diff --git` line: each file's own text, in the patch's order. */
export function patchFiles(text: string): string[] {
  // Each part without the newline that ends it (that newline belongs to the boundary, not to a last empty line).
  return text.replace(/\r\n/g, "\n").split(/^(?=diff --git )/m).filter(part => part.startsWith("diff --git ")).map(part => part.replace(/\n$/, ""));
}

type DiffSource = { ok: true; patch: string; truncated: boolean; stat: ReturnType<typeof terminalDiffView> } | { ok: false; problem: string };

function diffSourceOf(store: Store, evidenceRoot: string, run: Run): DiffSource {
  const view = terminalDiffView(store.artifactsFor(run.id), evidenceRoot);
  if (view === null) return { ok: false, problem: "This result recorded no changes." };
  if (view.patch === null) return { ok: false, problem: "This result's changes weren't saved." };
  if ("problem" in view.patch) return { ok: false, problem: `This result's changes can't be shown: ${view.patch.problem}.` };
  return { ok: true, patch: view.patch.text, truncated: view.patch.truncated, stat: view };
}

/** A result's changed files with their counts, from its sealed patch (counted from the patch itself, so the list and the
 * hunks read the same bytes), and the saved stat's totals where it verified. */
export function resultDiffOf(store: Store, evidenceRoot: string, taskId: string, run: Run | null): ResultDiff {
  const empty = (problem: string): ResultDiff => ({ version: ENGINE_API_VERSION, task: taskId, run: run?.id ?? null, totals: null, files: [], patchTruncated: false, problem });
  if (run === null) return empty("No result yet.");
  const source = diffSourceOf(store, evidenceRoot, run);
  if (!source.ok) return empty(source.problem);
  const files = patchFiles(source.patch).map((text, index) => {
    const parsed = parseReviewDiff(text).files[0];
    let additions = 0, deletions = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    const binary = /^(?:Binary files .* differ|GIT binary patch)$/m.test(text);
    return { file: index, path: parsed?.path ?? "changed file", oldPath: parsed?.oldPath ?? null, additions, deletions, binary, hunks: parsed?.hunks.length ?? 0 };
  });
  const stat = source.stat?.stat;
  const totals = stat == null || "problem" in stat ? null
    : { files: stat.fileCount, additions: stat.additions, deletions: stat.deletions, binary: stat.binaryCount, filesTruncated: stat.filesTruncated };
  return { version: ENGINE_API_VERSION, task: taskId, run: run.id, totals, files, patchTruncated: source.truncated, problem: null };
}

/** One file's hunks from a result's sealed patch, or null when the result or the file isn't there. */
export function resultDiffFileOf(store: Store, evidenceRoot: string, taskId: string, run: Run, file: number): ResultDiffFile | null {
  const source = diffSourceOf(store, evidenceRoot, run);
  if (!source.ok) return null;
  const text = patchFiles(source.patch)[file];
  if (text === undefined) return null;
  const parsed = parseReviewDiff(text);
  const one = parsed.files[0];
  if (one === undefined) return null;
  return { version: ENGINE_API_VERSION, task: taskId, run: run.id, file: { file, path: one.path, oldPath: one.oldPath, meta: one.meta, hunks: one.hunks }, linesTruncated: parsed.linesTruncated };
}
