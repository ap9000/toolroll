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
import { DIFF_CONTEXT_MAX, ENGINE_API_VERSION, type ResultDiff, type ResultDiffContext, type ResultDiffFile, type StepCard, type StepCards } from "./contracts/engine-api.js";
import { scanPatchForSecrets } from "./evidence.js";
import { viewedGitSync } from "./teardown-git.js";

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
      ? { run: assignment.receipt.runId, receipt: assignment.receipt.digest, source: revisionSourceOf(scope?.digest ?? null),
        accept: acceptFactsOf(store, assignment, viewer, evidenceRoot) } : null,
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

/** What accepting a waiting result means for `viewer`, read the way the completion reads it (assignment.ts
 * acknowledgeCurrent, acceptAndCompleteAsOperator; result-page's personCompletionRefusal): words only, never permission. */
function acceptFactsOf(store: Store, assignment: AssignmentSnapshot, viewer: string | null, evidenceRoot: string): NonNullable<StepCards["review"]>["accept"] {
  const receipt = assignment.receipt!;
  const blockers = assignment.readiness?.blockers ?? [];
  return {
    owed: owedAcceptance(receipt, blockers),
    blockers: blockers.map(one => one.message),
    needs: personCompletionRefusal(store, receipt.taskId, receipt.runId, viewer, evidenceRoot),
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
  if (/\baws_secret_access_key\b\s*[=:]/i.test(content)) return true;
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
