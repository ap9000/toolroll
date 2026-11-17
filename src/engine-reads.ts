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
import { agentSaidOf, type Run, type Store, type TaskFamily } from "./store.js";
import { failedAttemptSentence, latestFinishedAttempt, stopSuggestionOf } from "./needs-you.js";
import { retryPinsOf } from "./local-owner-acts.js";
import { assignmentOf, owedAcceptance, personCompletionRefusal, type AssignmentSnapshot } from "./assignment.js";
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
import { DIFF_CONTEXT_MAX, ENGINE_API_VERSION, type AgentsRead, type ResultDiff, type ResultDiffContext, type ResultDiffFile, type StepCard, type StepCards } from "./contracts/engine-api.js";
import { agentSetupOf, detectionLines, NO_AGENT_YET, npmRegistryOf, type AgentDetection } from "./agent-detect.js";
import { scanPatchForSecrets } from "./evidence.js";
import { fastCompletionProblem } from "./fast-start.js";
import { viewedGitSync } from "./teardown-git.js";
import { wasInterrupted } from "./run-ending.js";

/** A run that is the task's delivered result (task-views.ts runIsTaskResult): a finished build or investigation. */
export const isResultRun = (run: Pick<Run, "role" | "finishedAt">): boolean => run.finishedAt !== null && (run.role === "builder" || run.role === "scout");

/** Approvals no person gave at the moment of approval (a check rule's own yes). */
const AUTOMATIC = new Set(["auto-check", "auto-green"]);

type StepRead = { store: Store; family: TaskFamily; now: Date; access: WorkSummaryAccess; evidenceRoot: string;
  /** Who is reading (their completion is what `review.accept.needs` speaks of); null: nobody in particular. */
  viewer?: string | null };

/** One task's step cards: the task page's road and rows (taskRoad, stepRowsOf) over the facts they read, each with
 * the agent, time and cost of the runs behind it. */
export function stepCardsOf({ store, family, now, access, evidenceRoot, viewer = null }: StepRead): StepCards {
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
      rows: [...summary.revisionChanges, ...summary.decisions, ...(summary.why === null ? [] : [{ label: "Why model", words: summary.why }]), ...summary.differs].map(one => ({ label: one.label, words: one.words, lines: "lines" in one ? [...(one.lines ?? [])] : [] })),
      warnings: summary.warnings.map(one => one.words), usualLabel: summary.usualLabel, usual: summary.usual.map(one => ({ label: one.label, words: one.words })) };
  })();
  const cards: StepCard[] | null = current.state === "cancelled" ? cancelledCards(builds, current.updatedAt ?? null) : rows === null ? null : rows.map(row => ({
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
    // A cancelled task's own word (the stage's is "Stopped"): it ended because a person cancelled it.
    headline: current.state === "cancelled" ? "Cancelled" : card?.status.headline ?? null,
    liveRun: live?.id ?? null,
    cards,
    // The result this task's page offers Accept and Send back on (chat-decide.ts resultFresh reads the same facts).
    review: assignment !== null && assignment.state === "ready-to-check" && assignment.receipt !== null && assignment.receipt.taskId === current.id
      ? { run: assignment.receipt.runId, receipt: assignment.receipt.digest, source: revisionSourceOf(scope?.digest ?? null),
        accept: acceptFactsOf(store, assignment, viewer, evidenceRoot) } : null,
    // The build Open build shell would open (the result waiting, else the newest build), and why it can't be, in the
    // words the start refuses with (server/terminals.ts takeOverOf): asked before anything is confirmed.
    shell: shellOf(store, family,
      assignment !== null && assignment.state === "ready-to-check" && assignment.receipt !== null && assignment.receipt.taskId === current.id
        ? assignment.receipt.runId : builds[0]?.id ?? null),
    failure: current.state === "failed" ? failureOf(store, ref?.id ?? null, builds) : null,
    waiting: (() => {
      const waiting = waitingOf(store, current.id, now);
      if (waiting === null) return null;
      // What the agent said on its way out of the last build, while it waits to try again (the Steps tab shows it).
      const last = latestFinishedAttempt(builds);
      return { ...waiting, agentSaid: last !== null && last.outcome === "failed" ? agentSaidOf(store, last.id) : null };
    })(),
    // A hold matters only while the task could still run: a cancelled or finished task has nothing to resume.
    held: current.state === "cancelled" || current.state === "done" ? null : heldOf(store, ref?.id ?? null, builds, now),
    retry: current.state === "failed" ? (() => { const pins = retryPinsOf(store, current.id); return pins === null ? null : { run: pins.run, digest: pins.digest }; })() : null,
    approval: scope !== null && approved && scope.approvedBy !== null
      ? { by: scope.approvedBy, you: viewer !== null && scope.approvedBy === viewer, automatic: AUTOMATIC.has(String(scope.approvalBasis ?? "")) } : null,
    room: `task:${encodeURIComponent(root.id)}`,
  };
}

/** The words Open build shell is refused with when its build has nothing to open on, as the start itself says them
 * (server/terminals.ts takeOverOf, which re-proves every one of them when a terminal is asked for). */
export const SHELL_NO_RESULT = "This build has no saved result yet. Wait for it to finish (or stop it), then open the build shell.";
export const SHELL_NO_COMMIT = "This build has no saved commit to open a terminal on.";

/** Open build shell's build (`run`) and why it can't be opened (null: it can be, as far as the saved facts say). */
function shellOf(store: Store, family: TaskFamily, runId: number | null): StepCards["shell"] {
  if (runId === null) return null;
  const run = resultRunsOf(store, family).find(one => one.id === runId) ?? null;
  if (run === null) return { run: runId, why: SHELL_NO_RESULT };
  const revision = run.headRevision;
  if (revision === null || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(revision)) return { run: runId, why: SHELL_NO_COMMIT };
  return { run: runId, why: null };
}

/** A failed task's latest finished build attempt in one plain line, how many attempts in a row failed (newest first,
 * stopping at the first that didn't), and its suggestion (needs-you.ts, the words the task page says). */
function failureOf(store: Store, taskRef: number | null, builds: readonly Run[]): NonNullable<StepCards["failure"]> {
  const last = latestFinishedAttempt(builds);
  // The engine's own count (claim.ts addStrike): failures since the last success or the last person's Retry, which
  // clears them (store.requeueTask resetStrikes). The words "N consecutive failures" mean exactly that.
  const failedInARow = taskRef === null ? 0
    : Number(store.handle.prepare("SELECT strikes FROM task_ref WHERE id = ?").get(taskRef)?.["strikes"] ?? 0);
  return { line: failedAttemptSentence(last?.reason), failedInARow, suggestion: last === null ? null : stopSuggestionOf(last.reason),
    agentSaid: last === null ? null : agentSaidOf(store, last.id) };
}

/** A cancelled task's history: its builds as they ran, then Cancelled, the end (no road goes on from there). */
function cancelledCards(builds: readonly Run[], at: string | null): StepCard[] {
  const out: StepCard[] = [];
  const latest = builds[0] ?? null;
  if (latest !== null) {
    const failed = latest.outcome === "failed" || latest.outcome === "refused" || wasInterrupted(latest);
    out.push({ key: "build", label: "Build", state: failed ? "stuck" : "done", mark: failed ? "stuck" : "done",
      sentence: failed ? failedAttemptSentence(latest.reason).replace(/[.\s]+$/, "") : "The build finished", at: latest.finishedAt,
      needsYou: false, inChain: true, ...runFacts(builds) });
  }
  out.push({ key: "ready", label: "Cancelled", state: "skipped", mark: "skipped", sentence: "Cancelled: nothing else will run for this task.",
    at, needsYou: false, inChain: true, ...runFacts([]) });
  return out;
}

/** A person's hold on a queued task (the operator's own: "Hold the next attempt", the terminal's Stop retrying): what
 * Resume releases (POST /t/<task>/unhold with `hold`, proved where it is released), its reason, and the last build's
 * failure in a short line. Null when no such hold stands. */
function heldOf(store: Store, taskRef: number | null, builds: readonly Run[], now: Date): StepCards["held"] {
  if (taskRef === null) return null;
  const hold = store.activeHolds(taskRef, now).find(one => one.ownerKind === "operator") ?? null;
  if (hold === null) return null;
  const last = latestFinishedAttempt(builds);
  return { id: hold.id, reason: hold.reason,
    lastFailure: last !== null && last.outcome === "failed" ? failedAttemptSentence(last.reason).replace(/[.\s]+$/, "") : null };
}

/** When a waiting task tries again and why its last build stopped (contracts/engine-api.ts waitingSchema). */
type Waiting = { retryAt: string | null; lastFailure: string | null };

/** A queued task waiting to start again: when the next try is due (its backoff hold's end; null: when a builder is
 * free) and the last build's failure in one short line. Null unless the task is queued and its last build failed or a
 * backoff holds it. */
export function waitingOf(store: Store, taskId: string, now: Date): Waiting | null {
  return waitingForTasks(store, [taskId], now).get(taskId) ?? null;
}

/**
 * waitingOf for many tasks at once (the Work rows read): one statement whatever the number of rows, never a few per
 * row. Tasks with nothing to wait on are absent.
 */
export function waitingForTasks(store: Store, taskIds: readonly string[], now: Date): Map<string, Waiting> {
  const out = new Map<string, Waiting>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return out;
  const at = now.toISOString();
  // One statement: the queued built-in tasks among them, each with its earliest-held active backoff (activeHolds' order)
  // and its latest finished build attempt (ended means a finish time or an outcome: latestFinishedAttempt).
  const rows = store.handle.prepare(`SELECT task.id AS task,
      EXISTS (SELECT 1 FROM hold WHERE hold.task_ref = task_ref.id AND hold.owner_kind = 'backoff' AND (hold.until IS NULL OR hold.until > ?)) AS held,
      (SELECT hold.until FROM hold WHERE hold.task_ref = task_ref.id AND hold.owner_kind = 'backoff' AND (hold.until IS NULL OR hold.until > ?) ORDER BY hold.held_at, hold.id LIMIT 1) AS until,
      (SELECT run.outcome FROM run WHERE run.task_ref = task_ref.id AND run.role IN ('builder', 'scout', 'repair') AND (run.finished_at IS NOT NULL OR run.outcome IS NOT NULL) ORDER BY run.id DESC LIMIT 1) AS outcome,
      (SELECT run.reason FROM run WHERE run.task_ref = task_ref.id AND run.role IN ('builder', 'scout', 'repair') AND (run.finished_at IS NOT NULL OR run.outcome IS NOT NULL) ORDER BY run.id DESC LIMIT 1) AS reason
    FROM task JOIN task_ref ON task_ref.backend = 'built-in' AND task_ref.external_id = task.id
    WHERE task.state = 'queued' AND task.id IN (${ids.map(() => "?").join(", ")})
      -- A person's hold (Stop retrying, a pause, a question, an incident) means it isn't waiting to try again.
      AND NOT EXISTS (SELECT 1 FROM hold WHERE hold.task_ref = task_ref.id AND hold.owner_kind <> 'backoff' AND (hold.until IS NULL OR hold.until > ?))`).all(at, at, ...ids, at);
  for (const row of rows) {
    const failed = row["outcome"] === "failed";
    const held = Number(row["held"]) === 1;
    if (!failed && !held) continue;
    out.set(String(row["task"]), {
      retryAt: held && row["until"] != null ? String(row["until"]) : null,
      lastFailure: failed ? failedAttemptSentence(row["reason"] == null ? null : String(row["reason"])).replace(/[.\s]+$/, "") : null,
    });
  }
  return out;
}

/** Who ran a step's latest run, when its runs started and ended, and their recorded cost together. Runs are newest first. */
function runFacts(runs: readonly Run[]): Pick<StepCard, "agent" | "startedAt" | "latestStartedAt" | "finishedAt" | "costUsd" | "runs"> {
  const latest = runs[0] ?? null;
  const costs = runs.map(run => run.costUsd).filter((one): one is number => typeof one === "number" && Number.isFinite(one));
  return {
    agent: latest === null ? null : { provider: latest.provider, model: latest.modelReported ?? latest.model ?? null },
    startedAt: runs.at(-1)?.startedAt ?? null,
    latestStartedAt: latest?.startedAt ?? null,
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

/** What accepting a waiting result means for `viewer`, read the way the completion reads it (assignment.ts
 * acknowledgeCurrent, acceptAndCompleteAsOperator; result-page's personCompletionRefusal): words only, never permission. */
function acceptFactsOf(store: Store, assignment: AssignmentSnapshot, viewer: string | null, evidenceRoot: string): NonNullable<StepCards["review"]>["accept"] {
  const receipt = assignment.receipt!;
  const blockers = assignment.readiness?.blockers ?? [];
  // Cheap first (wire budgets): only a project that protects something can need a second person, and only then are the
  // result's changed files read (protectedResultProblem answers null at once for a project without rules, so this is
  // the same answer as personCompletionRefusal's, without reading every build's file list for nothing).
  const rules = assignment.repo === null ? null : store.approvalRules(assignment.repo);
  const guarded = rules !== null && (rules.protectProject || rules.protectedPaths.length > 0);
  return {
    owed: owedAcceptance(receipt, blockers),
    blockers: blockers.map(one => one.message),
    needs: guarded ? personCompletionRefusal(store, receipt.taskId, receipt.runId, viewer, evidenceRoot) : fastCompletionProblem(store, receipt.taskId, receipt.runId, viewer),
  };
}

/** The largest file a context read loads (its head blob), and the longest line it sends. */
const CONTEXT_FILE_BYTES = 2 * 1024 * 1024;
const CONTEXT_LINE_CHARS = 2_000;
/**
 * Whether a file holds key material a context read never shows, anywhere in it (conservative: a false alarm only
 * hides context): a PEM private key, a PuTTY private key, an AWS secret key assignment (any value), or a private JWK
 * ("d" alongside "kty", "crv" or "n": a JWK is often spread over many lines, so this looks at the whole file).
 */
function keyMaterialIn(content: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) || /PuTTY-User-Key-File-\d+:/.test(content)) return true;
  if (/\b(?:aws_secret_access_key|SecretAccessKey)\b["']?\s*[=:]/i.test(content)) return true;
  return /"d"\s*:\s*"[^"]{8,}"/.test(content) && /"(?:kty|crv|n)"\s*:/.test(content);
}

/**
 * Lines `from`..`from + count - 1` of one file of a result as its build left it, to show context its hunks hide
 * (T2's context expand). The file is the patch's own file `file` (the same sealed bytes the hunks read), read at the
 * run's recorded head commit from the project's repository as Toolroll records them (`repo`, `run.headRevision`), never
 * from anything a checkout says: the head must be the one the saved stat names, and the read goes through the hardened
 * view (viewedGitSync: no config, hooks, filters or network the checkout chose). At most DIFF_CONTEXT_MAX lines, from a
 * file of at most CONTEXT_FILE_BYTES that is text; a line that looks like a key is replaced as the saved diff does.
 * null when the result or the file isn't there.
 */
export function resultDiffContextOf(store: Store, evidenceRoot: string, taskId: string, run: Run, file: number, from: number, count: number,
  repo: string | null): ResultDiffContext | null {
  const source = diffSourceOf(store, evidenceRoot, run);
  if (!source.ok) return null;
  const text = patchFiles(source.patch)[file];
  if (text === undefined) return null;
  const one = parseReviewDiff(text).files[0];
  if (one === undefined) return null;
  const answer = (lines: ResultDiffContext["lines"], lineCount: number | null, problem: string | null): ResultDiffContext =>
    ({ version: ENGINE_API_VERSION, task: taskId, run: run.id, file, from, lines, lineCount, problem });
  const unread = "The rest of this file can't be read here. Press w to see it in the browser.";
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(count) || count < 1 || count > DIFF_CONTEXT_MAX) return answer([], null, unread);
  if (/^deleted file mode /m.test(text) || /^\+\+\+ \/dev\/null$/m.test(text)) return answer([], 0, "This file was removed by the change.");
  const stat = source.stat?.stat;
  const head = run.headRevision;
  if (repo === null || head === null || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) || stat == null || "problem" in stat || stat.head !== head) return answer([], null, unread);
  // Which file: the one git itself listed as changed for this run (the saved stat, its names NUL-delimited from git),
  // matched exactly by the patch file's name. Text inside the patch never chooses another file to read.
  const path = stat.files.map(changed => changed.path).find(changed => changed === one.path) ?? null;
  if (path === null || path === "" || path.startsWith("/") || path.split("/").some(part => part === ".." || part === "." || part === "")
    || /[\u0000-\u001f\u007f]/.test(path)) return answer([], null, unread);
  let bytes: Buffer;
  try {
    const listed = viewedGitSync(repo, ["--no-replace-objects", "--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", head, "--", path],
      { timeoutMs: 10_000, maxBuffer: 64 * 1024, binding: { repo } });
    if (listed.status !== 0) return answer([], null, unread);
    const entry = listed.stdout.split("\0").map(row => /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/s.exec(row)).find(match => match !== null && match[5] === path);
    if (entry == null) return answer([], 0, "This file isn't in the result's commit.");
    const [, mode, kind, oid, sized] = entry as unknown as [string, string, string, string, string];
    if (kind !== "blob" || (mode !== "100644" && mode !== "100755") || sized === "-") return answer([], null, "This file isn't text.");
    const size = Number(sized);
    if (size > CONTEXT_FILE_BYTES) return answer([], null, "This file is too large to show here. Press w to see it in the browser.");
    const read = viewedGitSync(repo, ["--no-replace-objects", "cat-file", "blob", oid], { timeoutMs: 10_000, maxBuffer: size + 1024, binding: { repo }, buffer: true });
    if (read.status !== 0 || read.stdout.length !== size) return answer([], null, unread);
    bytes = read.stdout;
  } catch {
    return answer([], null, unread);
  }
  let content: string;
  try {
    if (bytes.includes(0)) throw new Error("binary");
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return answer([], null, "This file isn't text.");
  }
  // A private key can span lines, and any window could start or end inside one: a file holding key material anywhere
  // shows none of its hidden lines here (not only the lines asked for).
  if (keyMaterialIn(content)) return answer([], null, "This file holds what looks like a private key or secret, so its hidden lines aren't shown here.");
  const all = content.split("\n");
  if (all.at(-1) === "") all.pop();
  const lineCount = all.length;
  const whole = all.slice(from - 1, from - 1 + count).map(line => line.replace(/\r$/, ""));
  // The saved diff's rule for keys (evidence.ts), on each line WHOLE (before any cut, so a key across the cut is found):
  // checked as lines the change adds, each hit replaced by its marker; only then is a long line shortened.
  const hits = new Map(scanPatchForSecrets(["diff --git a/f b/f", `@@ -0,0 +1,${whole.length} @@`, ...whole.map(line => `+${line}`)].join("\n")).map(hit => [hit.line - 3, hit.name] as const));
  const lines = whole.map((line, index) => {
    const name = hits.get(index);
    return { newLine: from + index, text: name === undefined ? line.slice(0, CONTEXT_LINE_CHARS) : `[redacted: ${name} detected on this line]` };
  });
  return answer(lines, lineCount, null);
}

/** An agent's setup as the agents read says it: Toolroll's own commands (agent-detect.ts AGENT_SETUP). */
export function setupOf(id: string, home: string | null = null): AgentsRead["agents"][number]["setup"] {
  const setup = agentSetupOf(id);
  if (setup === null) return { install: null, canInstall: false, signIn: null, canSignIn: false, key: null, check: null, note: null, registry: null, registryUnsure: false };
  const pkg = setup.installRun?.binary === "npm" ? setup.installRun.args[2] ?? null : null;
  const registry = pkg === null || home === null ? { url: null, unsure: false } : npmRegistryOf(home, pkg);
  return { install: setup.install, canInstall: setup.installRun !== null, signIn: setup.signIn, canSignIn: setup.signInRun !== null, key: setup.key, check: setup.check, note: setup.note,
    registry: registry.url, registryUnsure: registry.unsure };
}

/** `GET /engine/agents`: the last detection of this computer's agents (agent-detect.ts) as the contract says it; null
 * (not looked for yet) reads as no agents and the "looking" line. */
export function agentsReadOf(detection: AgentDetection | null, view: "full" | "summary" = "full", home: string | null = null): AgentsRead {
  const agents = (detection?.agents ?? []).map(one => ({ id: one.id, name: one.name, state: one.state, how: one.how, signIn: one.signIn, ready: one.ready, next: one.next, setup: setupOf(one.id, home) }));
  const first = detection?.firstTask ?? null;
  const firstTask = first === null ? null : { id: first, name: agents.find(one => one.id === first)?.name ?? first };
  // Summary (a person who isn't an instance operator, server/welcome.ts agentInventoryOf): who the first task goes to,
  // never which agents this computer has.
  if (view === "summary") {
    const lines = firstTask !== null ? [`Your first task goes to ${firstTask.name}.`] : detection === null ? detectionLines(null) : [NO_AGENT_YET];
    return { version: ENGINE_API_VERSION, checkedAt: detection?.checkedAt ?? null, agents: [], firstTask, lines };
  }
  return { version: ENGINE_API_VERSION, checkedAt: detection?.checkedAt ?? null, agents, firstTask, lines: detectionLines(detection) };
}
