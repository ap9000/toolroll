/** Results and runs: the review cockpit, evidence, receipts, diffs and the result panel. */
import { assignmentPresentationOf,historicalAssessmentReason,shortenedMaterialReason } from "../assignment-presentation.js";
import { assignmentActionHref,assignmentStatusOf,assignmentWithEvidence } from "../assignment-ui.js";
import { type AssignmentSnapshot,owedAcceptance } from "../assignment.js";
import { type BrowserCheckItem,type BrowserNeedAction,type BrowserResultPanel,type BrowserResultView } from "../browser-workspace.js";
import { CHECK_LEVEL_WORDS,liveQuickCommand } from "../check-levels.js";
import { LIMITS } from "../decision.js";
import { readVerifiedArtifact,readVerifiedProofForRun,type ReportShot,reportShotsOf } from "../evidence.js";
import { type FailureExplanation,isInternalErrorReason,NEEDS,runReasonWords } from "../needs-you.js";
import { type RouteStamp } from "../phase-routing.js";
import { projectName } from "../project.js";
import { coverageStateWords,coverageWords,type CriterionEvidenceRef,type CriterionMatrixRow,dispatchStatusToken,GOAL_ASSESSMENT_PENDING,manualReviewCriterionOf,manualReviewOnly,passFraction,personCheckWords,plainReasonWords,type ProofVerdict,reviewConflict,semanticCoverage } from "../proof.js";
import { type PullRequestView } from "../pull-request-flow.js";
import { qualityModeTitle } from "../quality.js";
import { acceptWithChecksOf,type ResultActFacts,resultActsOf } from "../result-acts.js";
import { SCREENSHOT_CAPTURE,structuredHandoffView,type StructuredHandoffView,terminalDiffView,type TerminalDiffView } from "../result-evidence-readers.js";
import { ADD_TESTS_ACTION,type FollowUpCheck,followUpChecksOf } from "../result-follow-ups.js";
import { evidenceHealthOf,evidenceProblemDetailsOf,evidenceResultStatusOf,isRevisionFeedback,RESULT_REVIEW_SCRIPT,RESULT_TABS,resultFactsAttributeMap,resultLeadOf,type ResultScreenshot,type ResultTab,revisionBatchOf,revisionSourceOf,type SharedResultFacts } from "../result-review.js";
import { type BuildReviewView,findingWords } from "../review-switch.js";
import { type AcceptanceCriterion,type approvalOf } from "../scope.js";
import { parseReport,type ReportItem } from "../scout-report.js";
import { type Artifact,type DiffComment,type Publication,type RepairChainRow,type ReviewRetryState,type Run,type Store,type TaskState } from "../store.js";
import { runCostWords } from "../summary.js";
import { checkBackingOf,CHECKED_AT_RELEASE,demoChecksOf,type ReleaseState,type PullRequestFact,pullRequestFactOf,requirementsOf,requirementWordOf,STATUS_MORE,statusDetailsHtml,statusIconSvg,statusWhyHtml,type TaskStatus } from "../task-status.js";
import { ACCEPT_NEEDS_REASON,acceptWordsOf,cantAcceptYetOf,type DisplayStatus,evidenceProblemOf,MISMATCH_HEADLINE,type PublicationFacts,receiptHeadingOf,receiptPublicationWords,reportMismatchesOf,RESULT_DECISION_SENTENCE,resultHeadlineOf,resultStatusOf,REVIEW_TOKENS,type ReviewFacts } from "../workspace-ui.js";
import { createHash,randomBytes } from "node:crypto";
import { buildsViews,type Chrome,oneLineOf,projectChip,safePrUrl,screen,type Screen,sentenceCase,strokeIcon,when,whenTime } from "./chrome.js";
import { chatResultHref,reviewHref,taskChatHref,taskHref } from "./http.js";
import { attributes,type Html,html,htmlString,joinHtml,postForm } from "../html.js";
import { publicationFactsOf,statusActionHref,statusLineHtml } from "./render-tasks.js";

export const RUNS_PAGE = 50;

/**
 * A vscode://file href, or null (arc 6, finding 2): the link exists only
 * when every part is provably tame — an absolute, control-free worktree;
 * a relative, single-line path whose segments contain no empty, dot,
 * dot-dot, or backslash components (so lexical resolution stays below the
 * worktree); a line inside the same 1..1,000,000 range the comment form
 * enforces. Encoding failures return null — a file row degrades to plain
 * text, never to a 500. The scheme is a constant, never data.
 */
export function editorFileHref(worktree: string, path: string, line?: number | null): string | null {
  if (!worktree.startsWith("/") || /[\u0000-\u001f\u007f]/.test(worktree)) return null;
  if (path === "" || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith("/") || path.includes("\\")) return null;
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return null;
  const rootSegments = worktree.replace(/\/+$/, "").split("/");
  if (rootSegments.some(segment => segment === "." || segment === "..")) return null;
  try {
    const root = rootSegments.map(segment => encodeURIComponent(segment)).join("/");
    const file = segments.map(segment => encodeURIComponent(segment)).join("/");
    const at = line !== undefined && line !== null && Number.isInteger(line) && line >= 1 && line <= 1_000_000 ? `:${line}` : "";
    return `vscode://file${root}/${file}${at}`;
  } catch {
    return null;
  }
}

/** The execution profile in plain words (v24): what the password signs
 * says WHAT RUNS — provider, exact model, permissions, and the real
 * bounds — or says honestly that it cannot yet. */
/** The state badges the criterion-to-evidence matrix renders with — one
 * shared vocabulary, so a "failed" row reads the same shade of trouble on
 * the task page, the run page, the board, done, builds, the inbox, and
 * chat (v39, extending Priority 2's "one surface, six places" rule from
 * the verdict word to the per-criterion state). */
export function matrixStateBadge(state: CriterionMatrixRow["state"]): Html {
  // Red belongs to a Failed headline alone (task-status.ts); an unmet requirement is an amber note.
  const cls = state === "pass" ? "badge-done" : state === "failed" ? "badge-note" : state === "missing" ? "badge-note" : "badge-manual-review";
  // The same words as the Checks tab and the card's Requirements row (task-status.ts).
  return html`<span class="badge ${cls}" data-matrix-state="${state}">${requirementWordOf({ state })}</span>`;
}

/** v40: the bounded repair chain's own line — presented as the user-facing
 * recovery it represents, without exposing the internal workflow name.
 * Renders on the task page and the run page identically. */
export function repairChainHtml(chain: RepairChainRow | null): Html {
  if (chain === null) return html``;
  const basisWords = chain.basis === "mode" ? "approved automatically" : "ready for your approval";
  const outcomeWords =
    chain.outcome === "drafted"
      ? chain.draftTask === null ? "No fix could be prepared" : `Targeted fix ${basisWords}`
      : chain.outcome === "resolved"
        ? `Completed on attempt ${chain.attempt}`
        : chain.outcome === "attempts-spent"
          ? `Stopped after ${chain.attempt} attempt${chain.attempt === 1 ? "" : "s"}`
          : chain.outcome === "no-progress"
            ? "Stopped because two attempts made no progress"
            : "Stopped because the evidence may conflict with the approved work";
  const link = chain.draftTask === null ? "" : html` <a href="${taskHref(chain.draftTask)}">${chain.draftTask}</a>`;
  const details = chain.unresolved.length === 0
    ? ""
    : html`<details><summary>What it is fixing</summary><p class="meta">${chain.unresolved.join(", ")}</p></details>`;
  return html`<div class="card repair-chain" data-repair-outcome="${chain.outcome}"><p class="row"><strong>Automatic recovery</strong> — ${outcomeWords}${link}</p>${details}</div>`;
}

/**
 * The bounded review-retry panel (v50), shared by the task page and the
 * result cockpit so both say the same thing: which attempt is running or
 * queued, how the latest one ended, every root attempt on record, and the
 * ONE explicit act — a Retry review form — rendered only while the store's
 * allowance admits it and this session may ask (an approver's cookie
 * session). Every other state shows the same control disabled, in words,
 * so a person always sees why nothing more will happen by itself. Empty
 * when no review was ever asked for.
 */
export function reviewRetryPanel(
  _taskId: string,
  _sourceRun: number,
  retry: ReviewRetryState | null,
  _options: { csrf: string; canAct: boolean; returnTo: string | null },
): Html {
  if (retry === null || retry.state === "unrequested") return html``;
  const attempts = retry.attempts.map(one =>
    html`<li data-review-attempt="${one.attempt}" data-review-outcome="${one.outcome ?? "open"}"><a href="/r/${one.runId}">Run #${one.runId}</a> · ${one.outcome ?? "unfinished"}${one.reason === null ? "" : html` · ${one.reason}`}</li>`);
  return html`<details class="review-history" data-review-state="${retry.state}"><summary>Previous assessments</summary><p class="meta">Saved history; no separate review will be started.</p>${attempts.length === 0 ? "" : html`<ol aria-label="previous assessments">${attempts}</ol>`}</details>`;
}

/** A one-line summary of the matrix for list rows too dense for the full
 * table (done, builds, board, inbox) — "2/3 criteria", plus a worst-state
 * badge so trouble is visible without opening the row. `[]` renders
 * nothing. */
export function criterionMatrixSummary(matrix: readonly CriterionMatrixRow[]): Html {
  if (matrix.length === 0) return html``;
  const { passed, total } = passFraction(matrix);
  const worst = matrix.some(row => row.state === "missing" || row.state === "failed")
    ? "failed"
    : matrix.some(row => row.state === "manual-review")
      ? "manual-review"
      : "pass";
  return worst === "pass"
    ? html` <span class="badge badge-done">${passed}/${total} criteria</span>`
    : html`${matrixStateBadge(worst)} <span class="badge">${passed}/${total} criteria</span>`;
}

/** Where a criterion's own typed evidence ref resolves to a stored
 * artifact, keyed `${kind}:${ref}` — built once per run from its
 * artifacts (v39 review finding: "link artifacts where possible"). A
 * `changed-path` ref never gets its own per-file artifact, so every one of
 * those shares the single terminal-diff patch, under the wildcard key. A
 * `manual-review` ref never resolves — it names nothing machine-checkable. */
export type EvidenceLinkMap = ReadonlyMap<string, number>;
export const CHECK_LOG_CAPTURE = /^sh -c "(.+)" \(exit \d+(?:, timed out)?\)$/;
export function evidenceLinksFor(artifacts: readonly Artifact[]): EvidenceLinkMap {
  const map = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.kind === "screenshot") {
      const path = SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1];
      if (path !== undefined) map.set(`screenshot:${path}`, artifact.id);
    } else if (artifact.kind === "check-log") {
      const command = CHECK_LOG_CAPTURE.exec(artifact.capture)?.[1];
      if (command !== undefined) map.set(`check:${command}`, artifact.id);
    } else if (artifact.kind === "terminal-diff") {
      map.set("changed-path:*", artifact.id);
    }
  }
  return map;
}

/** Read the approved requirement first; inspect its saved evidence on demand.
 * Machine results, reviewer judgements and missing context remain separate.
 * Warnings stay outside the disclosure, including on compact surfaces. */
export function criterionMatrixHtml(
  matrix: readonly CriterionMatrixRow[],
  options: { compact?: boolean; runId?: number; links?: EvidenceLinkMap; fileAnchors?: ReadonlyMap<string, string>; verdict?: string | null; release?: ReleaseState | undefined } = {},
): Html {
  if (matrix.length === 0) return html``;
  const kinds: Record<CriterionEvidenceRef["kind"], string> = {
    check: "Checks", "changed-path": "Changed files", screenshot: "Screenshots", "manual-review": "You check",
  };
  const evidenceLink = (a: CriterionEvidenceRef): Html => {
    const text = html`<code>${a.ref}</code>`;
    const anchor = a.kind === "changed-path" ? options.fileAnchors?.get(a.ref) : undefined;
    if (anchor !== undefined) return html`<a href="#${anchor}">${text}</a>`;
    const artifactId = options.links?.get(`${a.kind}:${a.ref}`) ?? (a.kind === "changed-path" ? options.links?.get("changed-path:*") : undefined);
    return artifactId !== undefined && options.runId !== undefined
      ? html`<a href="/r/${options.runId}/evidence/${artifactId}">${text}</a>`
      : text;
  };
  const rows = matrix.map((row, index) => {
    const state = row.state;
    const awaitingAssessment = row.assessment?.evidenceState === "pass" && row.review === null;
    const confirmed = row.assessment !== undefined && state === "pass";
    // Plain words (task-status brief): the retired assessment step is not a state a person acts on.
    // The card's Requirements row reads the same words from the same source (task-status.ts), so they agree.
    const label = requirementWordOf(row, options.verdict, options.release);
    const cls = label === "Met" ? "badge-done" : label === "You check" ? "badge-manual-review" : "badge-note";
    const warnings: Html[] = [];
    // Only replace the known boilerplate. Other recorded failure details
    // remain verbatim, so concision cannot hide a different problem.
    const detail = row.detail.filter(line => !(row.assessment && row.review && line === `${row.review.author} ${row.review.judgement === "contradicts" ? "contradicts" : "needs more evidence for"} criterion "${row.id}": ${row.review.note}`) && !(state === "manual-review" && /^criterion "[^"\n]+" requires manual-review evidence — an operator must accept it before this can verify$/.test(line)));
    // A requirement a release check covers, or that waits only on one, has nothing wrong to say.
    if (!awaitingAssessment && state !== "pass" && label !== "Met" && label !== CHECKED_AT_RELEASE && detail.length > 0) warnings.push(html`<ul class="requirement-issues">${detail.map(line => html`<li>${line}</li>`)}</ul>`);
    const review = row.review;
    if (review !== null && review.judgement !== "upholds") {
      warnings.push(html`<div class="requirement-warning" data-review-judgement="${review.judgement}"><strong>${review.judgement === "contradicts" ? "Reviewer found a problem" : "Reviewer could not confirm this"}</strong><p>${review.note}</p></div>`);
    }
    const coverage = row.coverage;
    if (coverage !== undefined && (coverage.state === "gap" || coverage.gaps.length > 0)) {
      warnings.push(html`<div class="requirement-warning" data-context-coverage="${coverage.state}"><strong>Review context is missing</strong>${coverage.gaps.length === 0 ? html`<p>The saved context cannot support this requirement.</p>` : html`<ul>${coverage.gaps.map(gap => html`<li>${gap}</li>`)}</ul>`}${coverage.priorSupport === "invalid" ? html`<p>The earlier review no longer supports this requirement.</p>` : ""}</div>`);
    }
    const answered = row.answered ?? [];
    const groups = Object.entries(kinds).flatMap(([kind, name]) => {
      const refs = answered.filter(one => one.kind === kind);
      return refs.length === 0 ? [] : [html`<div class="requirement-evidence-group"><strong>${name} · ${refs.length}</strong><ul>${refs.map(ref => html`<li>${evidenceLink(ref)}</li>`)}</ul></div>`];
    });
    const reviewDetails = review === null ? "" : html`<div class="requirement-evidence-group"><strong>Previous assessment</strong><p>${review.judgement === "upholds" ? html`${review.note} ` : ""}<span class="meta">${review.author}</span></p></div>`;
    return html`<li class="requirement" data-criterion-id="${row.id}">${[
      html`<div class="requirement-heading"><span>Requirement ${index + 1}</span><span class="badge ${cls}" data-matrix-state="${state}">${label}</span></div>`,
      html`<p class="requirement-statement">${row.statement}</p>`,
      review?.judgement === "upholds" && !confirmed ? html`<p class="requirement-review" data-review-judgement="upholds">Reviewer confirmed</p>` : "",
      warnings,
      html`<details class="requirement-evidence"><summary>View evidence</summary><div class="requirement-evidence-body">`,
      html`<p class="meta">Required: ${row.requiredEvidence.map(kind => kinds[kind]).join(", ") || "No evidence types specified"}</p>`,
      answered.length === 0 ? html`<p class="meta">No evidence was submitted for this requirement.</p>` : groups,
      state !== "pass" || detail.length === 0 ? "" : html`<div class="requirement-evidence-group"><strong>Verification notes</strong><ul>${detail.map(line => html`<li>${line}</li>`)}</ul></div>`,
      reviewDetails,
      coverage === undefined ? "" : html`<p class="meta"${coverage.state === "gap" ? "" : html` data-context-coverage="${coverage.state}"`}>Review context: ${coverageStateWords(coverage)}</p>`,
      coverage?.assets === undefined ? "" : html`<p class="meta" data-context-assets>${coverage.assets}</p>`,
      html`<p class="meta">Requirement ID: <code>${row.id}</code></p></div></details></li>`,
    ]}`;
  });
  return html`<div class="result-section criterion-matrix"><strong>Requirements · ${matrix.length}</strong><ol class="requirement-list">${rows}</ol></div>`;
}

/** One policy summary beneath the requirements. Per-requirement concerns
 * are already visible in the matrix; do not repeat their full text here. */
export function semanticCoverageHtml(matrix: readonly CriterionMatrixRow[], qualityMode: "default" | "strict"): Html {
  if (!matrix.some(row => row.review != null || row.assessment !== undefined)) return html``;
  const coverage = semanticCoverage(matrix, qualityMode);
  return html`<details class="result-section semantic-coverage" data-semantic-coverage="${coverage.satisfied === true ? "satisfied" : coverage.satisfied === null ? "unsettled" : "unsatisfied"}" data-coverage-policy="${coverage.policy}"><summary>Previous assessment</summary><p class="meta">The saved assessment confirmed ${coverage.upheld.length} of ${coverage.total} requirements.</p></details>`;
}

/** A same-site path or "/": never a scheme, a host, or a protocol-relative road. */
/** The words a result page shows for a refusal its own form led to, by the fixed code a redirect carries. */
export const ACCEPT_ANYWAY_NEEDS_REASON = "Accepting anyway needs a reason.";
export const RESULT_REFUSALS: Record<string, string> = { reason: ACCEPT_ANYWAY_NEEDS_REASON };

/** A same-site page address with a refusal code added, before any fragment. */
export function withRefusal(href: string, code: keyof typeof RESULT_REFUSALS): string {
  const at = href.indexOf("#");
  const [path, hash] = at === -1 ? [href, ""] : [href.slice(0, at), href.slice(at)];
  return `${path}${path.includes("?") ? "&" : "?"}refused=${code}${hash}`;
}

// ---- the review cockpit (Priority 5) ----------------------------------------
// The field parallelizes generation and lets review pile up (M8.19); this
// page compresses it. Read-only by design — ranked advice and deep links,
// no merge button, because the PR is the terminus and the person merges
// on GitHub.

/** The queue reads at most this many completed tasks — the store's own
 * page ceiling, admission bound before it. */
export const REVIEW_QUEUE_CAP = 100;

/** The one return road the comment endpoint honors besides its own run
 * page: the cockpit's selected-result link, exactly. */
export const REVIEW_RETURN = /^\/review\?result=[A-Za-z0-9._~%-]{1,200}$/;

/** Review priority: a deterministic, LABELED presentation aid over facts
 * the done list already carries. Band 0 goes first; the words name why.
 * It is never a verdict — the stored proof verdict stays the authority,
 * and an operator's acceptance lowers a band without touching it. */
export type ReviewPriority = { band: 0 | 1 | 2; label: "needs action" | "review" | "no flags"; reasons: string[] };

export type ReviewQueueFacts = {
  /** Only an exact current task/run match carries the assignment status. */
  assignment?: AssignmentSnapshot | null;
  proofReasons?: readonly string[];
  runId: number | null;
  outcome: string | null;
  proofVerdict: ProofVerdict | null;
  proofAccepted: boolean;
  proofMatrix: readonly CriterionMatrixRow[];
  ciFailing: boolean;
  publicationState: string | null;
};

export const PRIORITY_LABELS: Record<ReviewPriority["band"], ReviewPriority["label"]> = { 0: "needs action", 1: "review", 2: "no flags" };

export function reviewPriorityOf(row: ReviewQueueFacts): ReviewPriority {
  if (row.assignment != null && (row.assignment.receipt?.runId ?? null) === row.runId) {
    const presentation = assignmentPresentationOf(row.assignment);
    const band = row.assignment.state === "needs-decision" ? 0 : row.assignment.state === "ready-to-check" ? 1 : 2;
    return { band, label: PRIORITY_LABELS[band], reasons: band === 2 ? [] : [presentation.status.label] };
  }
  const reasons: string[] = [];
  let band: ReviewPriority["band"] = 2;
  const raise = (to: ReviewPriority["band"], why: string): void => {
    if (to < band) band = to;
    reasons.push(why);
  };
  if (row.runId === null) {
    raise(1, "no build record");
    return { band, label: PRIORITY_LABELS[band], reasons };
  }
  const ids = (predicate: (one: CriterionMatrixRow) => boolean): string => row.proofMatrix.filter(predicate).map(one => one.id).join(", ");
  const contradicted = ids(one => one.review?.judgement === "contradicts");
  const broken = ids(one => one.state === "failed" || one.state === "missing");
  const manual = ids(one => one.state === "manual-review");
  const humanReview = manualReviewOnly({ verdict: row.proofVerdict ?? "", reasons: row.proofReasons ?? [], matrix: row.proofMatrix });
  if (row.proofVerdict === "refuted") {
    raise(row.proofAccepted ? 1 : 0, row.proofAccepted ? "conflicting evidence — accepted with exception" : "conflicting evidence");
  } else if (humanReview) {
    raise(1, row.proofAccepted ? "accepted after human review" : "human review needed");
  } else if (row.proofVerdict === "short") {
    raise(row.proofAccepted ? 1 : 0, row.proofAccepted ? "missing evidence — accepted with exception" : "missing evidence");
  }
  if (contradicted !== "") raise(row.proofAccepted ? 1 : 0, `reviewer raised a concern with ${contradicted}`);
  if (broken !== "") raise(row.proofAccepted ? 1 : 0, `missing or failed evidence for ${broken}`);
  if (row.ciFailing) raise(0, "CI failing on its pull request — observed, not inferred");
  if (row.publicationState === "failed") raise(1, "publication failed — the branch never reached its remote");
  if (manual !== "" && !row.proofAccepted && !humanReview) raise(1, `manual review needed for ${manual}`);
  if (row.proofVerdict === null && row.outcome !== "no-change") raise(1, "no verification result");
  return { band, label: PRIORITY_LABELS[band], reasons };
}

/** Ranked, stable: band first, then newest completion, then task id — the
 * same input always yields the same queue, whoever loads it. */
export function rankReviewQueue<T extends ReviewQueueFacts & { completedAt: string; taskId: string }>(rows: readonly T[]): (T & { priority: ReviewPriority })[] {
  return rows
    .map(row => ({ ...row, priority: reviewPriorityOf(row) }))
    .sort((a, b) =>
      a.priority.band !== b.priority.band
        ? a.priority.band - b.priority.band
        : a.ciFailing !== b.ciFailing
          ? Number(b.ciFailing) - Number(a.ciFailing)
        : a.completedAt !== b.completedAt
          ? b.completedAt.localeCompare(a.completedAt)
          : a.taskId.localeCompare(b.taskId),
    );
}

/** Whether a changed path sits inside the scope's signed "touches" — an
 * exact file, a directory prefix (with or without its slash), or a plain
 * `*` / `**` glob. Touches are advisory in the scope; here they only
 * decide which files wear the "outside the signed touches" flag. */
export function withinSignedTouches(path: string, touches: readonly string[]): boolean {
  return touches.some(raw => {
    const touch = raw.trim().replace(/^\.\//, "");
    if (touch === "") return false;
    if (touch.includes("*")) return touchGlob(touch).test(path);
    const dir = touch.endsWith("/") ? touch : `${touch}/`;
    return path === touch || path.startsWith(dir);
  });
}

/** A signed touch's glob as a regular expression, gitignore-style: `*`
 * stays inside one segment; `**` followed by `/` spans zero or more
 * directories, so `src/**` followed by `/*.ts` matches `src/a.ts` as well
 * as `src/nested/a.ts` (v2 review, comment 2); a bare `**` spans anything.
 * Whatever the glob names, its contents are inside it too. */
export function touchGlob(raw: string): RegExp {
  // A trailing slash names a directory; the contents clause below covers it.
  const touch = raw.replace(/\/+$/, "");
  let pattern = "";
  for (let at = 0; at < touch.length; ) {
    if (touch.startsWith("**/", at)) {
      pattern += "(?:[^/]*/)*";
      at += 3;
    } else if (touch.startsWith("**", at)) {
      pattern += ".*";
      at += 2;
    } else if (touch[at] === "*") {
      pattern += "[^/]*";
      at += 1;
    } else {
      pattern += (touch[at] as string).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      at += 1;
    }
  }
  return new RegExp(`^${pattern}(?:/.*)?$`);
}

/** A stable, attribute-safe anchor for one file of the sealed patch —
 * derived from the path's bytes, never from the path's characters, so a
 * hostile file name can neither break the id nor escape the attribute. */
export function diffFileAnchor(path: string): string {
  return `diff-file-${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16)}`;
}

export type ReviewFileRow = {
  path: string;
  additions: number | null;
  deletions: number | null;
  renamedFrom: string | null;
  anchor: string | null;
  outsideTouches: boolean;
  cited: boolean;
};

/** Paths whose churn a reviewer reads first — dependency manifests and
 * locks, CI workflows, container and schema definitions, migrations, the
 * environment files secrets live in, and files NAMED for credentials.
 * The credential words match only as whole `-`/`_`/`.`-delimited pieces
 * of the file name (v2 review, comment 4): `auth.ts`, `api-token.ts`,
 * `secrets.json` count; `author.ts`, `tokenizer.ts`, and `.envelope.ts`
 * are ordinary names and do not. `permission` is not a credential word
 * at all — `permissions-ui.tsx` is a screen, not a secret. */
export const SENSITIVE_PATH =
  /(^|\/)(\.github|migrations?)\/|(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile|\.env(\.[^/]+)?|schema[^/]*\.(sql|prisma)|(?:[^/]*[-_.])?(auth|secrets?|tokens?|credentials?)(?:[-_.][^/]*)?)$/i;
export const LARGE_CHANGE_LINES = 200;

/** The changed-file list's own review priority: outside the signed
 * touches first, then files a machine cannot diff or a criterion never
 * cited, then the rest by churn. Presentation only — the sealed patch
 * keeps its own order beneath, byte for byte. */
export function reviewFilePriority(file: ReviewFileRow, proofCitesPaths: boolean): ReviewPriority {
  const reasons: string[] = [];
  let band: ReviewPriority["band"] = 2;
  const raise = (to: ReviewPriority["band"], why: string): void => {
    if (to < band) band = to;
    reasons.push(why);
  };
  if (file.outsideTouches) raise(0, "outside approved paths");
  if (file.additions === null || file.deletions === null) raise(1, "binary file — preview unavailable");
  if (SENSITIVE_PATH.test(file.path)) raise(1, "dependencies, CI, schema, or credentials");
  if (proofCitesPaths && !file.cited) raise(1, "not referenced by a requirement");
  if (file.additions !== null && file.deletions !== null && file.additions + file.deletions >= LARGE_CHANGE_LINES) raise(1, "a large change");
  if (file.anchor === null) raise(1, "not in the recorded diff — see the full diff");
  return { band, label: PRIORITY_LABELS[band], reasons };
}

export function orderChangedFiles(files: readonly ReviewFileRow[], proofCitesPaths: boolean): (ReviewFileRow & { priority: ReviewPriority })[] {
  const churn = (file: ReviewFileRow): number => (file.additions ?? 0) + (file.deletions ?? 0);
  return files
    .map(file => ({ ...file, priority: reviewFilePriority(file, proofCitesPaths) }))
    .sort((a, b) =>
      a.priority.band !== b.priority.band
        ? a.priority.band - b.priority.band
        : churn(a) !== churn(b)
          ? churn(b) - churn(a)
          : a.path.localeCompare(b.path),
    );
}

export type CompletedWorkRow = ReturnType<Store["listCompletedWorkScoped"]>[number] & { historyProblem?: string | null };
export type RankedReviewRow = CompletedWorkRow & { ciFailing: boolean; priority: ReviewPriority; assignment?: AssignmentSnapshot | null };

/** What the cockpit shows of one selected result — a projection of the
 * scope, plan, run, artifact, verdict, and publication records,
 * each read through the verifier the run page already uses. */
export type ReviewCockpitView = {
  taskId: string;
  title: string;
  repo: string | null;
  completedAt: string;
  historyProblem: string | null;
  priority: ReviewPriority;
  assignment: AssignmentSnapshot | null;
  /** null = no scope was ever filed (a task marked done by hand). */
  intent: {
    goal: string;
    outOfScope: string | null;
    touches: string[];
    acceptance: AcceptanceCriterion[];
    approval: ReturnType<typeof approvalOf>;
    approvedBy: string | null;
  } | null;
  plan: { revision: number; sha256: string; approach: string | null } | null;
  /** null = the task is done with no finished build attempt on record. */
  run: {
    id: number;
    role: string;
    outcome: string | null;
    runner: string;
    provider: string;
    model: string | null;
    finishedAt: string | null;
    branch: string | null;
    headRevision: string | null;
    ranMinutes: number | null;
    cost: string;
    summary: string | null;
  } | null;
  /** The shared result detail (package 3) — the same records, the same
   * panel, as the run page and the chat's result view. */
  detail: ResultDetail | null;
  /** v50: the result's bounded review-retry history, null when never asked. */
  reviewRetry: ReviewRetryState | null;
  /** The same history as the shared projection's facts (review fixes). */
  review: ReviewFacts | null;
  notes: { id: number; author: string; note: string; createdAt: string }[];
  /** The demo database: no check runs here, and the Checks row says so. */
  demo?: boolean;
  /** A build that didn't deliver a result: what it missed, the suggestion, and Retry when the task can be retried here. */
  failure?: (FailureExplanation & { retry: { action: string; note: string } | null; acceptAnyway?: { action: string; run: number } | null }) | null;
};

/** The receipt's own proof-state word, so the cockpit and the task page
 * never disagree on the state's name or its precedence: the stored
 * verdict decides, whatever the run's outcome — a no-change run with a
 * refuted proof reads as refuted, never as "no change needed". The one
 * word the receipt never needs is "No build record": a manual completion
 * has no receipt to share it with. */
/** The cockpit's headline status: the shared projection over the same
 * verdict, acceptance, and publication rows the task page reads. */
export function cockpitStatusOf(view: ReviewCockpitView): DisplayStatus {
  // The receipt's own status (package 3): the same projection the chat
  // receipt and the run page print, read from the shared detail.
  if (view.run === null || view.detail === null) return view.assignment === null ? resultHeadlineOf(resultStatusOf(null, null)) : assignmentPresentationOf(view.assignment).status;
  const receiptStatus = receiptStatusOf(view.detail.receipt);
  if (view.assignment !== null) return assignmentStatusOf(assignmentWithEvidence(view.assignment, receiptStatus, view.run.id));
  return resultHeadlineOf(receiptStatus);
}

/** Turn verifier records into one sentence a project owner can act on.
 * A command-not-found result means the check could not start, not that the
 * product itself failed. The stored record remains unchanged. */
export function verificationExplanation(verdict: ProofVerdict | null, reasons: readonly string[]): string {
  const plain = reasons.map(reason => {
    if (
      reason === "the approved verification command passed after the approved setup command ran"
      || reason === "the approved verification command passed after the approved setup command restored project dependencies"
    ) {
      return "Toolroll ran the approved setup automatically, then the project check passed.";
    }
    if (
      reason === "the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled"
      || reason === "the approved verification command could not start because a project dependency was unavailable and no approved recovery was enabled"
    ) {
      return "The project check couldn't start because a required project executable was missing. Automatic recovery wasn't enabled for this check.";
    }
    if (
      reason === "automatic recovery stopped because the approved setup changed after self-healing was authorized"
      || reason === "automatic recovery stopped because its approved setup or project-check settings changed"
      || reason === "automatic recovery stopped because the project setup or check changed"
    ) {
      return "Automatic recovery stopped because the project setup or check changed. Review and reapprove automatic recovery before retrying.";
    }
    if (
      reason === "the approved setup command failed during automatic recovery"
      || reason === "the approved setup command could not restore the project dependencies"
    ) {
      return "The approved project setup failed, so automatic recovery stopped before retrying the project check.";
    }
    if (reason === "automatic recovery stopped because the setup command changed tracked files after the build") {
      return "Automatic recovery stopped because project setup changed files after the build. Review those changes before retrying.";
    }
    if (reason === "automatic recovery stopped because tracked files no longer matched the built result") {
      return "Automatic recovery stopped because files changed after the build was saved. Review those changes before retrying.";
    }
    if (reason === "automatic recovery stopped because the checkout moved away from the built commit") {
      return "Automatic recovery stopped because Toolroll found a different project version than the one it built. Review the build log before retrying.";
    }
    if (reason === "automatic recovery stopped because Toolroll could not confirm that the built checkout was unchanged") {
      return "Automatic recovery stopped because Toolroll couldn't confirm that no files changed after the build was saved. Review the build log, then try again.";
    }
    if (
      reason === "the required project executable was still unavailable after replaying the approved setup command"
      || reason === "project dependencies were still unavailable after replaying the approved setup command"
    ) {
      return "Automatic recovery ran once, but the required project executable was still missing.";
    }
    if (reason === "the retried verification command timed out after automatic recovery") {
      return "Automatic recovery ran the approved setup, but the retried project check timed out.";
    }
    if (reason === "the retried verification command could not be started after automatic recovery") {
      return "Automatic recovery ran the approved setup, but Toolroll still couldn't start the project check.";
    }
    if (reason === "automatic recovery stopped because this worker no longer owned the build") {
      return "Automatic recovery stopped because this worker no longer owned the build. A current worker can retry safely.";
    }
    if (reason === "the approved verification command could not be run") {
      return "Toolroll couldn't run the project check.";
    }
    const recoveredFailure = /^the repository's approved verification command exited (-?[0-9]+) after the approved setup command was replayed$/.exec(reason);
    if (recoveredFailure !== null) {
      return `Automatic recovery ran the approved setup, but the project check still failed (exit ${Number(recoveredFailure[1])}).`;
    }
    const exit = /^the repository's approved verification command exited (-?[0-9]+)$/.exec(reason);
    if (exit !== null) {
      const code = Number(exit[1]);
      return code === 127
        ? "Toolroll couldn't run the project check because a required command wasn't available."
        : `The project check failed (exit ${code}).`;
    }
    if (reason === "the sealed diff is unavailable or truncated; the claimed changed paths cannot be verified against it") {
      return "The recorded changes were incomplete, so they could not be verified.";
    }
    const plainWords = plainReasonWords(reason);
    if (plainWords !== reason) return plainWords;
    const sentence = reason.trim();
    return sentence === "" ? "" : `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}${/[.!?]$/.test(sentence) ? "" : "."}`;
  }).filter(Boolean);
  if (plain.length > 0) return [...new Set(plain)].join(" ");
  if (verdict === "verified") return "Toolroll independently verified this result.";
  if (verdict === "attested") return "The agent supplied evidence, but no independent project check was available.";
  if (verdict === "short") return "Some approved requirements still need evidence.";
  if (verdict === "refuted") return "Recorded evidence conflicts with this result.";
  return "No verification result is available for this build.";
}

export function verificationRecovered(reasons: readonly string[]): boolean {
  return reasons.some(reason =>
    reason === "the approved verification command passed after the approved setup command ran"
    || reason === "the approved verification command passed after the approved setup command restored project dependencies"
  );
}

/** Whether a reviewer can annotate this result's diff here: the shared
 * detail's own answer (a verified, non-empty sealed patch read by a
 * session that holds a CSRF token) — decided once, in `resultDetailOf`. */
export function canAnnotateDiff(view: ReviewCockpitView | null, csrf: string): boolean {
  return view !== null && view.detail !== null && csrf !== "" && view.detail.canAnnotate;
}

export function reviewCockpitPage(
  chrome: Chrome,
  data: {
    queue: readonly RankedReviewRow[];
    /** The queue's ceiling — printed when the queue reaches it. */
    queueCap: number;
    selected: ReviewCockpitView | null;
    /** The deep link resolved a completion older than the queue shows. */
    beyondQueue: boolean;
    missing: string | null;
    csrf: string;
    /** v50: an approver's session may ask for a review retry here. */
    canRetryReview: boolean;
    noted: boolean;
    /** What this person's last post from this page was refused for, in words (`refused=` on the address). */
    refusal?: string | null;
    /** Package 3: the selected local result view and the panel's draft keys. */
    tab: ResultTab;
    user: string;
    now: Date;
  },
): Screen {
  const { queue, selected, csrf } = data;
  const elevated = queue.filter(one => one.priority.band < 2).length;
  const queueRows =
    queue.length === 0
      ? html`<p class="meta">No results in this review list.</p>`
      : html`<ol class="cockpit-queue-list">${joinHtml(
        queue
          .map(row => {
            const current = selected !== null && selected.taskId === row.taskId;
            const status = row.assignment == null ? null : assignmentPresentationOf(row.assignment).status;
            const reasons = row.priority.reasons;
            const why = status === null
              ? reasons.length === 0 ? "" : html`<span class="cockpit-why">${reasons[0] as string}${reasons.length > 1 ? ` · +${reasons.length - 1} more` : ""}</span>`
              : html`<span class="cockpit-why">${statusLineHtml(status)}</span>`;
            return html`<li data-review-priority="${row.priority.band}"><a class="cockpit-row${current ? " current" : ""}" href="${reviewHref(row.taskId, row.runId)}"${current ? html` aria-current="page"` : ""}>${[
              html`<span class="cockpit-row-head"><strong>${row.title}</strong></span>`,
              html`<span class="cockpit-row-meta">${whenTime(row.completedAt)}${row.runId === null ? " · no build" : row.outcome === "no-change" ? " · no change" : ""}${row.prNumber === null ? "" : ` · PR #${row.prNumber}`}</span>`,
              row.historyProblem ? html`<span class="cockpit-why" data-history-problem>History unavailable</span>` : why,
              status !== null && row.ciFailing ? html`<span class="cockpit-why">CI is failing</span>` : "",
            ]}</a></li>`;
          }), "\n")}</ol>`;
  const queuePane =
    html`<aside class="cockpit-queue" aria-label="review queue"><h2>Recent results <span class="lane-count">${queue.length}</span></h2>${
      elevated > 0 || queue.length >= data.queueCap ? html`<p class="meta cockpit-queue-hint">${elevated === 0 ? "" : `${elevated} ${elevated === 1 ? "needs" : "need"} your attention`}${queue.length >= data.queueCap ? `${elevated > 0 ? ". " : ""}Showing the newest ${data.queueCap}; older results still open from their task` : ""}</p>` : ""
    }${queueRows}</aside>`;
  const missingNote =
    data.missing === null
      ? ""
      : html`<p class="problem">No completed task <span class="mono">${data.missing}</span> is in view here — it may not be finished, or it is outside this console's projects. ${selected === null ? "" : "Showing the top of the queue instead."}</p>`;
  const beyondNote =
    !data.beyondQueue || selected === null
      ? ""
      : html`<p class="meta cockpit-beyond" data-cockpit-beyond="1">This result is not in the current review list.</p>`;
  const detailParts = selected === null ? null : reviewCockpitDetailParts(selected, csrf, data.noted, data.canRetryReview, data.tab, data.user);
  const detail = detailParts === null ? html`<section class="cockpit-detail"><p class="meta">Nothing to review yet.</p></section>` : detailParts.html;
  // The rebuilt page (shadcn/ui): the selected result at full width, the
  // list one tap away in the header.
  const view: BrowserResultView = {
    kind: "result",
    results: queue.map(row => {
      const status = row.assignment == null ? null : assignmentPresentationOf(row.assignment).status;
      const reasons = row.priority.reasons;
      return {
        title: row.title, href: reviewHref(row.taskId, row.runId), at: row.completedAt,
        status: status === null ? null : { label: status.label, tone: status.tone },
        notes: [...(row.historyProblem ? ["History unavailable"] : status === null && reasons.length > 0 ? [reasons[0] as string] : []), ...(status !== null && row.ciFailing ? ["CI is failing"] : [])],
        current: selected !== null && selected.taskId === row.taskId,
        needsYou: row.priority.band < 2,
      };
    }),
    attention: elevated,
    capped: queue.length >= data.queueCap ? data.queueCap : null,
    missing: data.missing === null ? null : `No completed task ${data.missing} is in view here — it may not be finished, or it is outside this console's projects.`,
    beyond: data.beyondQueue && selected !== null,
    selected: detailParts === null ? null : data.refusal == null ? detailParts.selected : { ...detailParts.selected, problem: data.refusal },
  };
  return screen("review", joinHtml([
    selected === null ? html`<h1>Results</h1>` : "",
    missingNote,
    beyondNote,
    data.refusal == null || selected === null ? "" : html`<p class="problem" data-result-refusal>${data.refusal}</p>`,
    html`<div class="cockpit">${queuePane}${detail}</div>`,
  ], "\n"), {
    chrome,
    workspace: { view },
    functional: { script: reviewEvidenceScript() + (selected !== null && selected.detail !== null ? RESULT_REVIEW_SCRIPT : ""), fetches: false },
  });
}

/** The selected result: intent → proof → changes → publication → acts,
 * one scan path, every fact labeled by its source. */
export function reviewCockpitDetail(view: ReviewCockpitView, csrf: string, noted: boolean, canRetryReview = false, tab: ResultTab = "summary", user = ""): Html {
  return reviewCockpitDetailParts(view, csrf, noted, canRetryReview, tab, user).html;
}

/** The selected result's HTML and, for the rebuilt page, the same result
 * as data: every form and panel body is the one the HTML carries. */
export function reviewCockpitDetailParts(view: ReviewCockpitView, csrf: string, noted: boolean, canRetryReview: boolean, tab: ResultTab, user: string): { html: Html; selected: NonNullable<BrowserResultView["selected"]> } {
  const parts: Html[] = [];
  const run = view.run;
  const proof = view.detail?.proof ?? null;
  const accepted = proof?.accepted !== null && proof?.accepted !== undefined;
  const canAnnotate = canAnnotateDiff(view, csrf);
  const status = cockpitStatusOf(view);

  // Header: what this is, its verdict word, and why it sits where it does.
  parts.push(
    joinHtml([
      html`<header class="cockpit-head" data-review-task="${view.taskId}">`,
      html`<h1>${view.title}</h1>`,
      html`<p class="meta">${run === null ? "No build" : `Build #${run.id}`} · <a href="${taskHref(view.taskId)}">Open task</a>${projectChip(view.repo)}</p>`,
      html`<p class="cockpit-chips">${statusLineHtml(status)}</p>`,
      html`</header>`,
    ]),
  );

  if (view.detail === null && view.historyProblem !== null) parts.push(html`<p class="problem" data-history-problem>${view.historyProblem} <a href="${taskHref(view.taskId)}">Open task</a></p>`);
  // The primary next act — exactly one road, chosen from the state.
  parts.push(reviewNextAction(view, csrf, accepted, canAnnotate));

  // Approved intent: the signed scope's words, the plan's approach.
  const intent = view.intent;
  let intentView: { approval: string; approvedAt: string | null; html: string } | null = null;
  if (intent === null) {
    parts.push(html`<section class="card cockpit-section" data-cockpit-section="intent"><h3>Approved scope</h3><p class="meta">No scope was filed for this task, so there is no approved goal or boundary to review.</p></section>`);
  } else {
    // The time itself goes to the page as a stamp: the one formatter words it in the viewer's zone.
    const approvalWords = intent.approval.approved
      ? `Approved by ${intent.approvedBy ?? "an operator"}`
      : intent.approval.reason === "changed"
        ? "The scope changed after approval. The words below are the current text, not the signed one."
        : "Never approved. The result was built without a signed scope.";
    const approval = intent.approval.approved
      ? html`Approved by ${intent.approvedBy ?? "an operator"} · ${whenTime(intent.approval.at)}`
      : approvalWords;
    const body = joinHtml([
      html`<p class="recap" style="margin-top:.25rem"><strong>Goal</strong> ${intent.goal}</p>`,
      intent.outOfScope === null ? html`<p class="meta">No boundary was stated</p>` : html`<p class="recap"><strong>Not this</strong> ${intent.outOfScope}</p>`,
      intent.touches.length === 0
        ? html`<p class="meta">No expected paths were signed — every changed file reads as in bounds</p>`
        : html`<p class="row"><span class="meta">Expected to touch</span> ${joinHtml(intent.touches.map(one => html`<span class="mono">${one}</span>`), " ")}</p>`,
      view.plan === null
        ? ""
        : html`<p class="meta">Plan revision ${view.plan.revision} · <span class="mono" title="${view.plan.sha256}">${view.plan.sha256.slice(0, 12)}…</span>${view.plan.approach === null ? "" : ` — ${view.plan.approach}`}</p>`,
    ]);
    intentView = { approval: approvalWords, approvedAt: intent.approval.approved ? intent.approval.at ?? null : null, html: htmlString(body) };
    parts.push(
      html`<details class="card cockpit-section cockpit-disclosure" data-cockpit-section="intent"><summary><h3>Approved scope<small>What this build was asked to do · ${approval}</small></h3><span class="cockpit-disclosure-action">View</span></summary><div class="cockpit-disclosure-body">${body}</div></details>`,
    );
  }

  const selected: NonNullable<BrowserResultView["selected"]> = {
    taskId: view.taskId, title: view.title, project: view.repo === null ? null : projectName(view.repo), build: run === null ? null : run.id,
    taskHref: taskHref(view.taskId), chatHref: taskChatHref(view.taskId),
    status: { label: status.label, tone: status.tone, token: status.token },
    problem: view.detail === null ? view.historyProblem : null,
    next: reviewNextActionOf(view, csrf), complete: null, decision: null, checks: null, intent: intentView, noRun: null, panel: null,
    notes: view.notes.map(one => ({ author: one.author, at: one.createdAt, note: one.note })),
    acts: { primary: null, secondary: null, line: null }, runChecks: null, mismatch: null,
    // The raw run record lives under Details now (2026-10-02): /r/<id> for this result redirects here.
    record: run === null ? null : { build: run.id, href: `/r/${run.id}?record=1`, facts: [
      { label: "Agent", value: [run.provider, run.model].filter(Boolean).join(" · ") },
      { label: "Worker", value: run.runner },
      ...(run.branch === null ? [] : [{ label: "Branch", value: run.branch }]),
      ...(run.finishedAt === null ? [] : [{ label: "Finished", value: when(run.finishedAt) }]),
      ...(run.ranMinutes === null ? [] : [{ label: "Ran", value: `${run.ranMinutes} min` }]),
    ] },
  };

  if (run === null || view.detail === null) {
    parts.push(
      html`<section class="card cockpit-section" id="verification" data-cockpit-section="proof"><h3>Verification</h3><p class="meta">This task has no finished build record, so there are no captured changes or checks to review.</p><p class="row"><a href="${taskHref(view.taskId)}">Open the task →</a></p></section>`,
    );
    return { html: html`<section class="cockpit-detail">${joinHtml(parts, "\n")}</section>`, selected: { ...selected, noRun: "This task has no finished build record, so there are no captured changes or checks to review." } };
  }

  // The result itself (package 3): the same panel the run page and the
  // chat's result view render — Summary / Changes / Checks with Request
  // changes beside it. The cockpit adds its own acts under Checks: the
  // v50 review-retry panel and the accept-with-exception form.
  const extraChecks = reviewRetryPanel(view.taskId, run.id, view.reviewRetry, { csrf, canAct: false, returnTo: null });
  const here = reviewHref(view.taskId);
  const assignment = view.assignment === null ? null : assignmentWithEvidence(view.assignment, receiptStatusOf(view.detail.receipt), run.id);
  const checks = assignment?.receipt?.checks;
  if (checks !== undefined) parts.push(html`<p class="${checks.status === "failed" || checks.status === "unavailable" ? "problem" : "meta"}" data-actual-checks="${checks.status}">${checks.detail}${checks.logArtifactId === null ? "" : html` <a href="/r/${run.id}/evidence/${checks.logArtifactId}">Open check output</a>`}</p>`);
  if (assignment?.completion != null) parts.push(html`<p class="meta" data-result-completed>Marked complete by ${assignment.completion.actor.replace(/^operator:/, "")}.</p>`);
  const panel = resultPanelParts(view.detail, {
    place: "review",
    tab,
    csrf,
    user,
    noted,
    requestToken: randomBytes(16).toString("hex"),
    hrefFor: one => `${here}&run=${run.id}${one === "summary" ? "" : `&tab=${one}`}`,
    returnTo: `${here}&run=${run.id}`,
    back: null,
    extraChecks,
    headStatus: false,
    action: false,
  });
  parts.push(html`<div id="verification" data-cockpit-section="result">${panel.html}</div>`);

  // What no acceptance resolves (a failed check, a HIGH finding): Complete is refused, so no Accept is offered and
  // the one line says the next step.
  const hardStop = hardBlockerOf(assignment);
  const blocked = hardStop ?? cantAcceptYetOf(proof?.verdict ?? null, proof?.reasons ?? [], accepted);
  const youCheck = panel.panel.youCheck;
  // Accept and finish posts the completion; when an acceptance is owed (the person's own checks, or a reason a
  // report that doesn't match its changes asks for), the same request records it first.
  const owed = accepted ? null : youCheck?.accept != null ? { note: null } : panel.panel.need?.accept != null ? { note: panel.panel.need.accept.note }
    : blocked === ACCEPT_NEEDS_REASON ? { note: "Why is this safe to accept?" } : null;
  const complete = hardStop === null && assignment?.state === "ready-to-check" && assignment.receipt !== null && canRetryReview && csrf !== ""
    ? { action: `${taskHref(view.taskId)}/complete`, receipt: assignment.receipt.digest, run: run.id, accept: owed } : null;
  if (complete !== null) parts.push(completionForm(view.taskId, run.id, complete.receipt, view.detail?.pullRequestTo ?? null, owed));
  // The one decision, after the evidence: Accept and finish only when every requirement is met and the checks passed.
  const acceptsHere = complete !== null || panel.panel.need?.accept != null || youCheck?.accept != null;
  const matrix = proof === null || proof.proofProblem !== null ? [] : proof.matrix;
  const unanswered = accepted || youCheck == null ? [] : youCheck.items.length > 0 ? youCheck.items.map(one => one.statement === "" ? one.words : one.statement) : youCheck.lines;
  const base = !acceptsHere ? null : acceptWordsOf({
    // Checks Off that a release check already covers read as passed (release-coverage.ts).
    checks: checks === undefined ? null : checks.running != null ? "running" : checks.level === "off" && checks.status !== "passed" ? checks.release != null ? "passed" : "off" : checks.status,
    // Release-aware words (task-status.ts): a requirement waiting only on a release check, or covered by one, isn't unmet.
    unmet: matrix.filter(row => !["Met", "You check", CHECKED_AT_RELEASE].includes(requirementWordOf(row, null, checks === undefined ? undefined : checkBackingOf(checks)))).length,
    action: complete !== null ? "complete" : "accept",
    publishing: view.detail?.publishing ?? "other",
    proof: proof !== null && proof.proof !== null && proof.proofProblem === null,
  });
  // Refuted: plain Accept and finish stays as allowed, in outline, and the one line before the acts (acts.line) says why.
  const settled = base === null || blocked === null ? base : { ...base, label: "Accept and finish" as const, ready: false };
  const decision = settled === null ? null : { sentence: RESULT_DECISION_SENTENCE, ...settled, ...acceptWithChecksOf(settled, { unanswered, notRight: [] }),
    base: { label: settled.label, ready: settled.ready, why: settled.why } };
  // Run checks: no check ran on this result (or its saved one can't be read), the project has one, and an approver may run it.
  const followUps = view.detail.followUps ?? null;
  const checksRunning = checks?.running != null || (followUps?.checks.some(one => one.state === "waiting" || one.state === "running") ?? false);
  const runChecks = canRetryReview && csrf !== "" && followUps !== null && (followUps.full || followUps.quick) && !checksRunning &&
    (checks === undefined || ((checks.status === "not-run" || checks.status === "unavailable") && checks.release == null))
    // Back on this result's Checks tab, where #follow-ups shows the run it started.
    ? { action: `/r/${run.id}/checks`, level: followUps.full ? "full" as const : "quick" as const, returnTo: `${here}&run=${run.id}&tab=checks` } : null;
  const need = panel.panel.need;
  const nextKind = selected.next?.kind;
  // A failed build: what went wrong is the card, Retry the act; a link to this same page goes nowhere, so it isn't one.
  const failure = view.failure == null ? null : { line: view.failure.line, evidence: view.failure.evidence, suggestion: view.failure.suggestion, retry: view.failure.retry,
    link: view.failure.link === null || (view.failure.link.href.startsWith(`${here}&run=${run.id}`) && !view.failure.link.href.includes("#")) ? null : view.failure.link,
    ...(view.failure.acceptAnyway == null ? {} : { acceptAnyway: { ...view.failure.acceptAnyway, returnTo: `${here}&run=${run.id}` } }) };
  const actFacts: ResultActFacts = failure !== null
    ? { accept: null, runChecks: runChecks !== null, checksRunning, blocked: null, canRequest: false, need: null, next: null, failed: { retry: failure.retry !== null, acceptAnyway: failure.acceptAnyway !== undefined } }
    : {
    accept: settled === null ? null : { ready: settled.ready },
    runChecks: runChecks !== null,
    checksRunning,
    blocked,
    canRequest: panel.panel.canRequest && panel.panel.request !== null,
    need: need === null || need.accept != null ? null : need.rebuild != null ? "rebuild" : need.confirm !== null ? "confirm-stopped" : null,
    next: nextKind === "revise" || nextKind === "draft-repair" ? nextKind : null,
    unanswered: settled === null ? 0 : unanswered.length,
    notRight: 0,
  };
  const acts = resultActsOf(actFacts);

  // A refuted result's card lists every recorded disagreement, each tied to its lines; when the report itself doesn't
  // match the changes (not a failed check), that is the headline.
  const mismatch = failure !== null || proof === null || accepted || proof.verdict !== "refuted" ? null : (() => {
    const patch = view.detail?.terminal?.patch ?? null;
    const files = patch === null || "problem" in patch ? [] : parseReviewDiff(patch.text).files;
    // Each file's first change: the lines it added (else every line it shows), and where that change starts (its link target).
    const hunkStart = new Map<string, number>();
    const changes = new Map(files.map(file => {
      const shown = file.hunks[0]?.lines.filter(line => line.newLine !== null && line.kind !== "meta") ?? [];
      if (shown[0]?.newLine != null) hunkStart.set(file.path, shown[0].newLine);
      const added = shown.filter(line => line.kind === "addition");
      const lines = (added.length > 0 ? added : shown).map(line => line.newLine as number);
      return [file.path, lines.length === 0 ? null : { from: Math.min(...lines), to: Math.max(...lines) }] as const;
    }));
    const changesHref = `${here}&run=${run.id}&tab=changes`;
    const found = reportMismatchesOf(proof.reasons, proof.proofProblem === null ? proof.matrix : [], changes);
    // The saved report itself can't be read: that is the evidence problem, said once.
    if (proof.proofProblem !== null) found.push({ text: `The saved report can't be read: ${proof.proofProblem}`, path: null, lines: null, inChanges: null, note: null, reason: proof.proofProblem });
    if (found.length === 0) return null;
    return {
      headline: evidenceProblemOf(proof.verdict, proof.reasons) === "mismatched" ? MISMATCH_HEADLINE : null,
      rows: found.map(one => ({
        text: one.text, path: one.path, absent: one.inChanges === false,
        lines: one.lines === null ? null : one.lines.from === one.lines.to ? `line ${one.lines.from}` : `lines ${one.lines.from}–${one.lines.to}`,
        href: one.path !== null && one.inChanges === true ? `${changesHref}#${diffFileAnchor(one.path)}${hunkStart.has(one.path) ? `-L${hunkStart.get(one.path)}` : ""}`
          : one.note !== null && (proof.proof?.caveats.length ?? 0) >= one.note ? `${here}&run=${run.id}#report-note-${one.note}` : null,
        noteLabel: one.path === null && one.note !== null ? `The report, note ${one.note}` : null,
      })),
      said: [...new Set([...proof.reasons, ...found.map(one => one.reason)].flatMap(reason => [reason, plainReasonWords(reason)]))],
    };
  })();

  if (view.notes.length > 0) {
    parts.push(
      html`<section class="card cockpit-section" data-cockpit-section="notes"><h3>Operator notes</h3>${
        joinHtml(view.notes.map(one => html`<p class="row"><span class="meta">${one.author} · ${whenTime(one.createdAt)}</span> ${one.note}</p>`), "\n")
      }</section>`,
    );
  }

  return {
    html: html`<section class="cockpit-detail">${joinHtml(parts, "\n")}</section>`,
    selected: {
      ...selected, complete: failure === null ? complete : null, decision: failure === null ? decision : null, acts, actFacts, runChecks, mismatch, failure,
      // A failed build reads Failed, whatever its task has done since; its outcome is what went wrong.
      // Run checks is the decision's own act on this page; a status row never sends the person to Chat for it.
      panel: (() => {
        // A Chat link to this same result would lead back here: it isn't one.
        const elsewhere = (href: string | null): boolean => href !== null && !href.endsWith("#follow-ups") && !new RegExp(`^/chat\\?task=[^&]+&result=${run.id}(?:&|$)`).test(href);
        const shown = panel.panel.status === null ? null : view.demo === true ? demoChecksOf(panel.panel.status) : panel.panel.status;
        const missed = proof === null || proof.proofProblem !== null ? 0 : requirementsOf(proof.matrix)?.missed ?? 0;
        const status = shown === null ? null : { ...shown, details: shown.details.map(one => ({ ...one,
          href: elsewhere(one.href) ? one.href : null, action: one.action !== null && elsewhere(one.action.href) ? one.action : null })) };
        return failure === null ? { ...panel.panel, status }
          : { ...panel.panel, outcome: failure.line, need: null, youCheck: null, status: status === null ? null : { ...status, headline: "Failed" as const, tone: "danger" as const, sentence: failure.line, need: null,
              // Read as Failed, the Requirements row counts what it missed, as the task's card does.
              details: status.details.map(one => one.key !== "requirements" || missed === 0 ? one : { ...one, text: `${missed} missed`, mark: "failed" as const, action: null }) },
            // What it missed is said once, in plain words above; the recorded wording stays under Details.
            attention: panel.panel.attention.filter(one => !(proof?.reasons ?? []).includes(one) && !(proof?.matrix ?? []).some(row => row.detail.includes(one))) };
      })(),
      ...(failure === null ? {} : { status: { label: "Failed", tone: "problem" as const, token: "failed" } }),
      checks: checks === undefined ? null : { detail: checks.detail, problem: checks.status === "failed" || checks.status === "unavailable", logHref: checks.logArtifactId === null ? null : `/r/${run.id}/evidence/${checks.logArtifactId}` },
    },
  };
}

/** What Accept and finish owes before it completes, as the form asks for it: the server's own rule
 * (owedAcceptance), so the form asks for exactly what the completion requires. */
export function owedAcceptanceOf(receipt: AssignmentSnapshot["receipt"]): { note: string | null } | null {
  const owed = owedAcceptance(receipt);
  return owed === null ? null : owed === "person-check" ? { note: null } : { note: "Why is this safe to accept?" };
}

export function completionForm(taskId: string, runId: number, digest: string, pullRequestTo: string | null = null, accept: { note: string | null } | null = null): Html {
  // Accept and finish, in one request: with an acceptance owed (the person's own checks, or an exception and
  // its reason, asked for right here), the same post records it first.
  const reason = accept?.note == null ? "" : html`<label class="meta" for="complete-reason-${runId}">${ACCEPT_NEEDS_REASON}</label><input type="text" id="complete-reason-${runId}" name="note" maxlength="500" required placeholder="${accept.note}">`;
  const options = { attrs: { class: "card result-complete" }, hidden: { receipt: digest, run: runId, accept: accept === null ? null : "1" } };
  if (pullRequestTo !== null) {
    // With pull requests set up: the PR is the primary road, a bare finish the quiet one beside it.
    return postForm(`${taskHref(taskId)}/complete`, html`${reason}<p class="meta">Finishes the task. A pull request opens on ${pullRequestTo} from this exact commit when you ask for one.</p><div class="result-complete-actions"><button type="submit" name="publish" value="1" style="min-height:44px">Complete and open a pull request</button><button type="submit" class="secondary" style="min-height:44px">Accept and finish</button></div>`, options);
  }
  return postForm(`${taskHref(taskId)}/complete`, html`${reason}<p class="meta">Finishes the task. Checks stay unchanged; nothing is published or deployed.</p><button type="submit" style="min-height:44px">Accept and finish</button>`, options);
}

/** What the task page shows about a result's pull request: the view, or the offer to open one. */
export type TaskPullRequest = { taskId: string; view: PullRequestView | null; offer: { taskId: string; runId: number; digest: string } | null; target: string | null;
  /** The same pull request as the shared status's detail row reads it. */
  fact?: PullRequestFact | null };

/** The pull request, in one card: its state and link, one line of detail, and the one action it needs — Merge
 * behind the password when checks passed, or Open a pull request for a result completed without one. */
export function pullRequestCardHtml(pr: TaskPullRequest, csrf: string): Html {
  if (pr.view === null) {
    if (pr.offer === null || csrf === "") return html``;
    return html`<section class="card pull-request" id="merge" data-pull-request="none"><div class="pull-request-head"><strong>No pull request</strong></div><p class="meta">This result was completed without one.</p>${
      postForm(`${taskHref(pr.offer.taskId)}/complete`, html`<button type="submit" class="secondary">Open a pull request</button>`, { attrs: { class: "pull-request-act" }, hidden: { receipt: pr.offer.digest, run: pr.offer.runId, publish: "1" } })
    }</section>`;
  }
  const view = pr.view;
  const url = safePrUrl(view.prUrl);
  const link = view.prNumber === null ? "" : url === null ? html`<span class="mono">PR #${view.prNumber}</span>` : html`<a href="${url}" class="mono" rel="noreferrer" target="_blank">PR #${view.prNumber}</a>`;
  // A pull request's trouble never undoes the result: amber, never red.
  const tone = view.state === "ready" || view.state === "merged" ? "ok" : view.state === "failing" || view.state === "failed" ? "problem" : "waiting";
  const revision = view.revisionTask === null || view.state !== "failing" ? "" : html` <a href="${taskHref(view.revisionTask)}">Open revision</a>`;
  const merged = view.mergeCommit === null ? "" : html`<p class="meta">Merge commit <span class="mono">${view.mergeCommit.slice(0, 12)}</span></p>`;
  const target = pr.target === null ? "the base branch" : pr.target;
  const act = !view.canMerge || csrf === "" || view.prNumber === null ? "" :
    postForm(`${taskHref(pr.taskId)}/merge`, html`<p class="meta">${view.mergeMethod === "squash" ? "Squash-merges" : view.mergeMethod === "rebase" ? "Rebase-merges" : "Merges"} PR #${view.prNumber} into ${target} and deletes its branch.</p><label>Password<input type="password" name="token" autocomplete="current-password" required></label>${
      view.fullCheck === null ? html`<button type="submit">Merge</button>` : html`<input type="hidden" name="anyway" value="1"><button type="submit" class="secondary">Merge anyway</button>`}`,
    { attrs: { class: "pull-request-act", "data-merge-form": true }, hidden: { run: view.runId } });
  return html`<section class="card pull-request pull-request--${tone}" id="merge" data-pull-request="${view.state}"><div class="pull-request-head"><strong>${view.label}</strong>${link}</div><p class="meta">${view.detail}${revision}</p>${merged}${act}</section>`;
}

/** Exactly one primary road per result, chosen from its state; the
 * others stay reachable from their own sections. Every form posts to the
 * endpoint that already owns the act, with the session's CSRF token; a
 * bearer session (no token) sees the road named, never a form. */
export function reviewNextAction(view: ReviewCockpitView, csrf: string, _accepted: boolean, _canAnnotate: boolean): Html {
  const next = reviewNextActionParts(view, csrf);
  return next === null ? html`` : html`<div class="card cockpit-next" data-next-action="${next.kind}"><div><strong>${next.title}</strong><span class="meta">${next.detail}</span></div>${next.control}</div>`;
}

/** The next action for the browser workspace's JSON: its control as markup text. */
export function reviewNextActionOf(view: ReviewCockpitView, csrf: string): { kind: string; title: string; detail: string; control: string } | null {
  const next = reviewNextActionParts(view, csrf);
  return next === null ? null : { ...next, control: htmlString(next.control) };
}

function reviewNextActionParts(view: ReviewCockpitView, csrf: string): { kind: string; title: string; detail: string; control: Html } | null {
  const run = view.run;
  const detail = view.detail;
  const card = (kind: string, title: string, detailWords: string, control: Html) => ({ kind, title, detail: detailWords, control });
  if (run === null || detail === null) {
    return card("inspect-task", "No build to review", "This task was marked complete without a build record.", html`<a class="button-link" href="${taskHref(view.taskId)}">Open the task</a>`);
  }
  if (detail.ciFailing && csrf !== "") {
    return card("draft-repair", "CI is failing on its pull request", "Toolroll confirmed the failure. Draft one repair task, then approve it before it runs.", postForm(`/r/${run.id}/draft-repair`, html`<button type="submit">Draft a repair task</button>`));
  }
  if (detail.comments.length > 0 && csrf !== "") {
    return card("revise", `${detail.comments.length} note${detail.comments.length === 1 ? "" : "s"} ready`, "Create one revision from these notes. You approve it before it runs.", postForm(`/r/${run.id}/revise`, html`${revisionSealFields(detail.comments, detail.sourceDigest)}<button type="submit">Revise</button>`, { returnTo: reviewHref(view.taskId) }));
  }
  return null;
}

/**
 * Plain words for the machine's own vocabulary — no internal token ever
 * reaches a page. Every map here has a generic fallback: a kind a newer
 * daemon invents degrades to honest generic prose, never to its raw name.
 */
export const PHASE_WORDS: Record<string, string> = {
  "agent-running": "agent working",
  "validating-handoff": "checking the handoff",
  "correcting-proof": "correcting evidence",
  "capturing-evidence": "capturing evidence",
  committing: "committing",
};

/** An agent's phase on the home card, from the machine's own vocabulary. */
export function homePhaseWords(run: Pick<Run, "role" | "phase">): string {
  if (run.role === "planner") return "Planning";
  if (run.role === "reviewer") return "Reviewing";
  if (run.role === "scout") return "Investigating";
  const words: Record<string, string> = { "agent-running": "Writing the change", "validating-handoff": "Checking its handoff", "capturing-evidence": "Saving its evidence",
    committing: "Committing", "verifying-proof": "Running the checks", "correcting-proof": "Correcting its evidence" };
  return run.phase === null ? "Starting" : words[run.phase] ?? "Working";
}

export function phaseWords(phase: string): string {
  return PHASE_WORDS[phase] ?? "the agent is working";
}

/** A recorded reason in one plain line; machine output (a stack trace, a path, "Error:" text) waits on the run record. */
export function reasonWords(reason: string): string {
  return isInternalErrorReason(reason) ? "stopped with an internal error" : oneLineOf(runReasonWords(reason.trim().split(/\r?\n/, 1)[0] ?? ""), 140);
}

export const INCIDENT_WORDS: Record<string, string> = {
  "malformed-decision": "the agent's question was malformed",
  "attempts-exhausted": "failed too many times in a row",
  "commit-failure": "the commit failed",
  "malformed-plan": "the plan was malformed",
  "plan-attempts-exhausted": "planning failed too many times",
  "malformed-report": "the scout's report was malformed",
};

export function incidentWords(kind: string): string {
  return INCIDENT_WORDS[kind] ?? "something went wrong — the run records have the detail";
}

export const EVIDENCE_WORDS: Record<string, string> = {
  diff: "Diff",
  status: "Build status",
  "park-payload": "Question record",
  plan: "Plan",
  "terminal-diff": "Final diff",
  "diff-stat": "Change summary",
  "base-tree": "Starting files",
  handoff: "Agent handoff",
  "revision-brief": "Revision brief",
  report: "Report",
  proof: "Agent proof",
  "check-log": "Check log",
  screenshot: "Screenshot",
  "structured-output": "Agent response",
  "plan-contract": "Plan contract",
  "review-context": "Review context",
};

/** Byte counts as people read them. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function evidenceWords(kind: string): string {
  return EVIDENCE_WORDS[kind] ?? "a stored record";
}

/** The badge for a run's outcome. A null outcome reads "running" ONLY when
 * the caller proved the run's lease is the task's current live claim — an
 * orphaned run keeps saying what actually became of it. */
export function runOutcomeBadge(run: Run, live: boolean): Html {
  if (!live && run.role === "planner" && run.reason === "plan-drafted") {
    return html`<span class="badge">Planned</span>`;
  }
  if (!live && run.reason === "interrupted") return html`<span class="badge">Interrupted</span>`;
  return live
    ? html`<span class="badge badge-running">Running</span>`
    : html`<span class="badge badge-${run.outcome ?? "cut"}">${sentenceCase(run.outcome ?? "never finished")}</span>`;
}

export const runNoun = (run: Pick<Run, "role">): string =>
  run.role === "planner" ? "plan" : run.role === "reviewer" ? "review" : run.role === "scout" ? "report" : "build";


export function runsPage(
  chrome: Chrome,
  rows: (Run & { taskId: string })[],
  liveIds: ReadonlySet<number>,
  nextCursor: number | null,
  verdicts: Map<number, { verdict: ProofVerdict; matrix?: CriterionMatrixRow[] }> = new Map(),
  accepted: ReadonlySet<number> = new Set(),
): Screen {
  const list =
    rows.length === 0
      ? html`<p class="meta">No builds yet \u2014 they appear once an approved task is dispatched.</p>`
      : joinHtml(rows
          .map(run => {
            const verdict = verdicts.get(run.id)?.verdict ?? null;
            const needsVerification =
              (verdict === "short" || verdict === "refuted") && !accepted.has(run.id)
                ? html` <span class="badge badge-failed">${verdict === "refuted" ? "conflicting evidence" : "missing evidence"}</span>`
                : "";
            return html`<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> <a href="${taskHref(run.taskId)}" class="mono">${run.taskId}</a> ${[
              runOutcomeBadge(run, liveIds.has(run.id)),
              run.qualityMode === "strict" ? html` <span class="badge">Strict review</span>` : "",
              needsVerification,
              criterionMatrixSummary(verdicts.get(run.id)?.matrix ?? []),
              run.provider === "claude" ? "" : html` <span class="meta mono">${run.provider}</span>`,
              html`<span class="right meta mono">${whenTime(run.startedAt)}${run.providerStartedAt === null && run.tokensIn === null && run.tokensOut === null && run.costUsd === null ? "" : ` \u00b7 ${runCostWords(run, liveIds.has(run.id))}`}</span></p>`,
            ]}`;
          }), "\n");
  const older = nextCursor === null ? "" : html`<p><a href="/runs?before=${nextCursor}">older →</a></p>`;
  return screen("builds", joinHtml([html`<h1>Builds <a class="badge" href="/peek">Peek at the live ones \u2192</a></h1>`, buildsViews("builds"), html`<p class="hint">one build = one attempt by an agent to complete a task, on its own branch</p>`, list, older], "\n"), { chrome });
}

/** The evidence bundle (Priority 2): the closed machine-authored verdict,
 * the agent's proof (or why it cannot be shown), the plane's own re-run
 * check, and every validated screenshot — each row labeled by source so
 * "the agent said" and "the machine proved" never blur together. */
export type ProofBundleView = {
  verdict: ProofVerdict | null;
  reasons: string[];
  accepted: { by: string; note: string | null; at: string } | null;
  proof: { criteria: { statement: string; verdict: string; how: string }[]; checks: { command: string; exitCode: number; summary: string }[]; caveats: string[] } | null;
  proofProblem: string | null;
  /** The check log as stored: its text when the bytes verify, else the
   * `problem` (repair 2026-09-14) — a log that no longer verifies shows no
   * text and offers no download. `bytesOriginal`/`bytesStored` let a
   * shortened log's download be described as the stored part only. */
  checkLog: { text: string; artifactId: number; truncated: boolean; problem: string | null; bytesOriginal: number; bytesStored: number } | null;
  /** Every stored screenshot artifact; one whose bytes no longer verify
   * carries its `problem` and is never rendered or called validated
   * (workspace package 3). */
  screenshots: ResultScreenshot[];
  /** Screenshot paths the proof cites that no stored artifact answers. */
  uncapturedScreenshots: string[];
  /** v39: the criterion-to-evidence matrix, one row per signed criterion —
   * `[]` when the scope this run built against signed no rubric. */
  matrix: CriterionMatrixRow[];
  /** v39 review finding: where a row's answered evidence ref resolves to a
   * stored artifact, for `criterionMatrixHtml` to link. */
  matrixLinks: EvidenceLinkMap;
  /** v40: the verdict BEFORE an independent reviewer's judgements were
   * folded in — null when no review has folded. */
  machineVerdict: ProofVerdict | null;
  /** v40: this run's own place in a bounded repair chain, if any. */
  repairChain: RepairChainRow | null;
  /** v51: the policy semantic coverage is read under. */
  qualityMode: "default" | "strict";
};

/** The smallest complete answer to "what did this task deliver?". It is a
 * projection of the same sealed handoff, proof, screenshot, and diff records
 * used by the run page—not a new persistence layer or another verdict. */
export type CompletionReceiptView = {
  runId: number;
  /** The run's role — a scout's receipt is a report, not a diff. */
  role: string;
  outcome: string | null;
  summary: string | null;
  verdict: ProofVerdict | null;
  /** The verdict's recorded reasons — what tells a failed check from
   * mismatched evidence (package 1). */
  reasons: string[];
  accepted: boolean;
  /** A no-change conclusion's two records — handoff and sealed diff. */
  recordComplete: boolean;
  /** The run's own publication record, when one exists: the heading names
   * a PR or a merge only from this, never from the outcome. */
  publication: PublicationFacts;
  /** This run's independent review, when one was asked (review fixes). */
  review: ReviewFacts | null;
  matrix: CriterionMatrixRow[];
  /** v51: the semantic-coverage lines (`coverageWords`) — independent
   * review standing under the run's policy, plus every named context gap.
   * Rendered beside the machine verdict on the task and chat receipts. */
  coverage: string[];
  /** Concise pass (2026-09-13): the coverage lines are secondary — behind a
   * disclosure — only while nothing is owed: review optional and not yet
   * settled, or satisfied. A strict-quality shortfall, a strict review
   * still pending, or a named context gap stays in the open. */
  coverageSecondary: boolean;
  diff:
    | { fileCount: number; additions: number; deletions: number; binaryCount: number; filesTruncated: boolean }
    | { problem: string }
    | null;
  screenshots: ResultScreenshot[];
  caveats: string[];
  /** The run's own report artifact (a scout's deliverable), verified at
   * render — the investigation's result leads with it (package 3). */
  report: RunReportView | null;
  /** The facts every result surface prints identically (package 3). */
  facts: SharedResultFacts;
};

/** A scout run's report as this run stored it: verified and parsed, or
 * the reason it cannot be shown. The download link serves the exact
 * stored bytes as text — never as a page. */
export type RunReportView =
  | { ok: true; artifactId: number; title: string; summary: string; document: string; followUps: number; truncated: boolean; items: ReportItem[]; shots: ReportShot[] }
  | { ok: false; artifactId: number; problem: string };

/** What a scout found, each with its link and picture, then any screenshot no item shows. Every link is the cited
 * http(s) address the report parser admitted; every picture is served from verified evidence. */
export function reportItemsHtml(items: readonly ReportItem[], shots: readonly ReportShot[], runId: number): Html {
  const picture = (shot: ReportShot): Html =>
    shot.artifactId === null
      ? html`<p class="meta">Screenshot unavailable: ${shot.problem ?? "it can't be shown"}</p>`
      : html`<a class="receipt-shot" href="/r/${runId}/evidence/${shot.artifactId}"><img src="/r/${runId}/evidence/${shot.artifactId}" alt="${shot.caption}" loading="lazy"><span>${shot.caption}</span></a>`;
  const link = (url: string): Html => html`<a href="${url}" rel="noopener noreferrer nofollow" target="_blank" class="report-link">${url}</a>`;
  const shown = new Set(items.map(one => one.image).filter((one): one is string => one !== null));
  const loose = shots.filter(one => !shown.has(one.file));
  if (items.length === 0 && loose.length === 0) return html``;
  return html`<div class="report-items" data-report-items="${items.length}">${
    items.length === 0 ? "" : html`<p><strong>What it found</strong></p><ol>${items.map(item => {
      const shot = item.image === null ? undefined : shots.find(one => one.file === item.image);
      return html`<li data-report-item><p><strong>${item.title}</strong></p><p class="meta">${item.why}</p><p class="meta">${link(item.url)}</p>${
        shot === undefined ? "" : html`<div class="receipt-visuals">${picture(shot)}</div>`}</li>`;
    })}</ol>`}${
    loose.length === 0 ? "" : html`<p><strong>Screenshots</strong></p><div class="receipt-visuals" aria-label="the scout's screenshots">${loose.map(picture)}</div>`
  }</div>`;
}

export function runReportView(artifacts: Artifact[], root: string): RunReportView | null {
  const artifact = [...artifacts].reverse().find(one => one.kind === "report");
  if (artifact === undefined) return null;
  let read: ReturnType<typeof readVerifiedArtifact>;
  try {
    read = readVerifiedArtifact(root, artifact);
  } catch {
    return { ok: false, artifactId: artifact.id, problem: "the report file could not be read" };
  }
  if (!read.ok) return { ok: false, artifactId: artifact.id, problem: read.problem };
  const parsed = parseReport(read.content.toString("utf8"), { stored: true });
  if (!parsed.ok) return { ok: false, artifactId: artifact.id, problem: artifact.truncated ? "the report was shortened at storage and cannot be read; the missing part was never captured" : "the stored report is not a report this console can read" };
  return { ok: true, artifactId: artifact.id, title: parsed.report.title, summary: parsed.report.summary, document: parsed.report.report, followUps: parsed.report.followUps.length, truncated: artifact.truncated,
    items: parsed.report.items, shots: reportShotsOf(artifacts, root, artifact.run, parsed.report.images) };
}

/** The shared facts (package 3), computed ONCE from the same verified
 * records every surface reads: the head from the sealed diff summary when
 * it verifies (else the run record, and the source is named), the signed
 * criteria passed from the machine's matrix, the proof's caveats, every
 * evidence problem in words, and the observed publication state. */
export function sharedResultFactsOf(
  run: Run,
  proof: ProofBundleView | null,
  terminal: TerminalDiffView | null,
  handoff: StructuredHandoffView | null,
  report: RunReportView | null,
  publication: PublicationFacts,
): SharedResultFacts {
  const stat = terminal?.stat ?? null;
  const statOk = stat !== null && !("problem" in stat);
  const passed = proof === null || proof.matrix.length === 0 ? null : passFraction(proof.matrix);
  const patch = terminal?.patch ?? null;
  const evidenceProblems = evidenceProblemDetailsOf({
    proofProblem: proof?.proofProblem ?? null,
    diff: patch === null ? null : "problem" in patch ? { problem: patch.problem } : { truncated: patch.truncated },
    stat: stat === null ? null : "problem" in stat ? { problem: stat.problem } : { filesTruncated: stat.filesTruncated },
    checkLog:
      proof?.checkLog === null || proof?.checkLog === undefined
        ? null
        : proof.checkLog.problem === null ? { truncated: proof.checkLog.truncated } : { problem: proof.checkLog.problem },
    screenshots: proof?.screenshots ?? [],
    uncapturedScreenshots: proof?.uncapturedScreenshots ?? [],
    report: report === null ? null : report.ok ? { ok: true, truncated: report.truncated } : { problem: report.problem },
    reportExpected: run.role === "scout",
    handoffPresent: handoff !== null,
    outcome: run.outcome,
  });
  return {
    runId: run.id,
    base: statOk ? stat.base : run.baseRevision,
    head: statOk ? stat.head : run.headRevision,
    headSource: statOk ? "sealed diff" : run.headRevision === null ? null : "run record",
    checks: passed === null ? null : { passed: passed.passed, total: passed.total },
    caveats: proof?.proof?.caveats ?? [],
    evidenceProblems: evidenceProblems.map(one => one.words),
    evidenceHealth: evidenceHealthOf(evidenceProblems),
    publicationState: publication === null ? "none" : publication.state,
    publicationWords: receiptPublicationWords(publication),
  };
}


export function proofBundleView(store: Store, run: Run, artifacts: Artifact[], root: string): ProofBundleView | null {
  const verdictRow = store.proofVerdictFor(run.id);
  const acceptanceRow = store.proofAcceptance(run.id);
  const proofView = readVerifiedProofForRun(store, root, run.id);
  const checkLogArtifact = artifacts.find(one => one.kind === "check-log") ?? null;
  const screenshotArtifacts = artifacts.filter(one => one.kind === "screenshot");

  if (verdictRow === null && proofView === null && checkLogArtifact === null && screenshotArtifacts.length === 0) {
    return null;
  }

  const proof = proofView !== null && proofView.ok ? proofView.proof : null;
  const captionFor = (path: string): string => proof?.screenshots.find(one => one.path === path)?.caption ?? path;
  const screenshots = screenshotArtifacts.flatMap((artifact): ResultScreenshot[] => {
    const path = SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1];
    if (path === undefined) return [];
    // The bytes are re-verified at render (workspace package 3): a shot
    // whose file is gone or altered is named as unavailable, never shown
    // as validated visual proof.
    let problem: string | null = null;
    try {
      const read = readVerifiedArtifact(root, artifact);
      if (!read.ok) problem = read.problem;
    } catch {
      problem = "the file could not be read";
    }
    return [{ path, caption: captionFor(path), artifactId: artifact.id, problem }];
  });
  const stored = new Set(screenshots.map(one => one.path));
  const uncapturedScreenshots = (proof?.screenshots ?? []).map(one => one.path).filter(path => !stored.has(path));

  let checkLog: ProofBundleView["checkLog"] = null;
  if (checkLogArtifact !== null) {
    // Re-verified at render: a log whose bytes no longer hash to their
    // record is a named evidence problem, never shown as output.
    let read: ReturnType<typeof readVerifiedArtifact>;
    try {
      read = readVerifiedArtifact(root, checkLogArtifact);
    } catch {
      read = { ok: false, problem: "the file could not be read" };
    }
    const sizes = { bytesOriginal: checkLogArtifact.bytesOriginal, bytesStored: checkLogArtifact.bytesStored };
    checkLog = read.ok
      ? { text: read.content.toString("utf8"), artifactId: checkLogArtifact.id, truncated: checkLogArtifact.truncated, problem: null, ...sizes }
      : { text: "", artifactId: checkLogArtifact.id, truncated: checkLogArtifact.truncated, problem: read.problem, ...sizes };
  }

  return {
    verdict: verdictRow?.verdict ?? null,
    reasons: verdictRow?.reasons ?? [],
    accepted: acceptanceRow === null ? null : { by: acceptanceRow.approver, note: acceptanceRow.note, at: acceptanceRow.acceptedAt },
    proof:
      proof === null
        ? null
        : {
            criteria: proof.criteria.map(one => ({ statement: one.statement, verdict: one.verdict, how: one.how })),
            checks: proof.checks,
            caveats: proof.caveats,
          },
    proofProblem: proofView !== null && !proofView.ok ? proofView.problem : null,
    checkLog,
    screenshots,
    uncapturedScreenshots,
    matrix: verdictRow?.matrix ?? [],
    // A matrix row links only to records that still verify (repair
    // 2026-09-14): a damaged screenshot or check log is named as a
    // problem above, never offered as a download.
    matrixLinks: (() => {
      const damaged = new Set([...screenshots.filter(one => one.problem !== null).map(one => one.artifactId), ...(checkLog !== null && checkLog.problem !== null ? [checkLog.artifactId] : [])]);
      return new Map([...evidenceLinksFor(artifacts)].filter(([, id]) => !damaged.has(id)));
    })(),
    machineVerdict: verdictRow?.machineVerdict ?? null,
    qualityMode: run.qualityMode ?? "default",
    repairChain: store.repairChainFor(run.id) ?? (() => {
      const ref = store.refById(run.taskRef);
      return ref === null ? null : store.repairChainForDraft(ref.externalId);
    })(),
  };
}

export function completionReceiptView(store: Store, run: Run, artifacts: Artifact[], root: string, review: ReviewFacts | null = null): CompletionReceiptView {
  const handoff = structuredHandoffView(artifacts, root);
  const proof = proofBundleView(store, run, artifacts, root);
  const terminal = terminalDiffView(artifacts, root);
  const report = runReportView(artifacts, root);
  const stat = terminal?.stat ?? null;
  const coverage = semanticCoverage(proof?.matrix ?? [], run.qualityMode ?? "default");
  const publication = publicationFactsOf(store.publicationForRun(run.id));
  return {
    runId: run.id,
    role: run.role,
    outcome: run.outcome,
    summary: run.role === "scout" ? report?.ok ? report.summary : "The report needs attention." : handoff?.conclusion ?? run.handoff,
    verdict: proof?.verdict ?? null,
    reasons: proof?.reasons ?? [],
    accepted: proof?.accepted !== null && proof?.accepted !== undefined,
    recordComplete: handoff !== null && terminal !== null,
    publication,
    review,
    matrix: proof?.matrix ?? [],
    diff:
      stat === null || "problem" in stat
        ? stat
        : {
            fileCount: stat.fileCount,
            additions: stat.additions,
            deletions: stat.deletions,
            binaryCount: stat.binaryCount,
            filesTruncated: stat.filesTruncated,
          },
    screenshots: proof?.screenshots ?? [],
    caveats: proof?.proof?.caveats ?? [],
    coverage: coverage.contextGaps.length > 0 || (proof?.matrix ?? []).some(row => row.review != null || row.assessment !== undefined) ? coverageWords(coverage) : [],
    coverageSecondary: coverage.contextGaps.length === 0 && (coverage.satisfied === true || (coverage.satisfied === null && !coverage.required)),
    report,
    facts: sharedResultFactsOf(run, proof, terminal, handoff, report, publication),
  };
}

export type ReviewDiffLine = {
  kind: "context" | "addition" | "deletion" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};
export type ReviewDiffHunk = { header: string; lines: ReviewDiffLine[] };
export type ReviewDiffFile = { path: string; oldPath: string | null; meta: string[]; hunks: ReviewDiffHunk[] };
export type ReviewDiff = { files: ReviewDiffFile[]; linesTruncated: boolean };

export const REVIEW_DIFF_LINE_CAP = 4_000;

/** Parse only the stable structure Git's unified patch format guarantees.
 * Unknown metadata remains visible, and a patch that cannot be structured
 * falls back to the sealed raw record—presentation never becomes proof. */
export function parseReviewDiff(text: string): ReviewDiff {
  const files: ReviewDiffFile[] = [];
  let file: ReviewDiffFile | null = null;
  let hunk: ReviewDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let rendered = 0;
  let linesTruncated = false;

  const pathOf = (raw: string): string => {
    const withoutTimestamp = raw.split("\t", 1)[0]?.trim() ?? raw.trim();
    let decoded = withoutTimestamp;
    if (decoded.startsWith('"') && decoded.endsWith('"')) {
      try { decoded = JSON.parse(decoded) as string; } catch { decoded = decoded.slice(1, -1); }
    }
    return decoded === "/dev/null" ? decoded : decoded.replace(/^[ab]\//, "");
  };

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const at = raw.lastIndexOf(" b/");
      file = { path: at === -1 ? "changed file" : pathOf(raw.slice(at + 1)), oldPath: null, meta: [raw], hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith("--- ")) {
      file.oldPath = pathOf(raw.slice(4));
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const nextPath = pathOf(raw.slice(4));
      if (nextPath !== "/dev/null") file.path = nextPath;
      file.meta.push(raw);
      continue;
    }
    const hunkHeader = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@(.*)$/.exec(raw);
    if (hunkHeader !== null) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) {
      if (raw !== "") file.meta.push(raw);
      continue;
    }
    if (rendered >= REVIEW_DIFF_LINE_CAP) {
      linesTruncated = true;
      continue;
    }
    rendered += 1;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      hunk.lines.push({ kind: "addition", text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      hunk.lines.push({ kind: "deletion", text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      hunk.lines.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
    }
  }
  return { files, linesTruncated };
}

export function reviewDiffHtml(
  patch: { text: string; truncated: boolean; artifactId: number },
  stat: TerminalDiffView["stat"],
  runId: number,
  commentable: boolean,
  anchors: ReadonlyMap<string, string> = new Map(),
): Html {
  const parsed = parseReviewDiff(patch.text);
  const structured = parsed.files.some(file => file.hunks.length > 0);
  if (!structured) {
    return html`<details><summary>The patch${patch.truncated ? " (TRUNCATED — the raw record says how much was cut)" : ""}</summary><pre class="mono" style="overflow-x:auto">${patch.text}</pre></details>${storedDownloadLink(runId, patch.artifactId, "diff", patch.truncated)}`;
  }
  const stats = stat !== null && !("problem" in stat) ? new Map(stat.files.map(one => [one.path, one] as const)) : new Map();
  const annotateIcon = strokeIcon(html`<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8"/>`);
  const files = parsed.files.map((one, fileIndex) => {
    const counts = stats.get(one.path);
    const countWords = counts === undefined
      ? ""
      : counts.additions === null || counts.deletions === null
        ? html`<span class="diff-file-counts">binary</span>`
        : html`<span class="diff-file-counts"><b>+${counts.additions}</b><i>−${counts.deletions}</i></span>`;
    const fileAnchor = anchors.get(one.path);
    // Each change is a link target of its own (#<file anchor>-L<first new line>): a result names the exact lines.
    const hunks = one.hunks.map(hunk => {
      const first = hunk.lines.find(line => line.newLine !== null && line.kind !== "meta")?.newLine ?? null;
      return html`<section class="diff-hunk"${fileAnchor === undefined || first === null ? "" : html` id="${fileAnchor}-L${first}"`}><div class="diff-hunk-head">${hunk.header}</div><div class="diff-lines">${hunk.lines.map(line => {
        const lineNumber = line.newLine ?? line.oldLine;
        const side = line.newLine === null && line.oldLine !== null ? "old" : "new";
        const annotate = !commentable || lineNumber === null || line.kind === "meta"
          ? html`<span class="diff-annotate-space"></span>`
          : html`<button type="button" class="diff-annotate pick-line" data-path="${one.path}" data-line="${lineNumber}" data-side="${side}" aria-label="Annotate ${one.path}, ${side} line ${lineNumber}" title="Annotate this line">${annotateIcon}</button>`;
        const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : line.kind === "context" ? " " : "·";
        return html`<div class="diff-line diff-${line.kind}">${annotate}<span class="diff-gutter">${line.oldLine ?? ""}</span><span class="diff-gutter">${line.newLine ?? ""}</span><code><b aria-hidden="true">${marker}</b>${line.text}</code></div>`;
      })}</div></section>`;
    });
    const anchor = anchors.get(one.path);
    return html`<details class="diff-file"${fileIndex === 0 ? " open" : ""}${anchor === undefined ? "" : html` id="${anchor}"`}><summary><span class="diff-file-name">${one.path}</span>${countWords}</summary>${
      one.oldPath !== null && one.oldPath !== "/dev/null" && one.oldPath !== one.path ? html`<p class="diff-rename meta">from ${one.oldPath}</p>` : ""}${hunks}</details>`;
  });
  return html`<div class="diff-review" data-review-diff>${
    commentable
      ? html`<div class="diff-review-bar"><span class="meta">${parsed.files.length} changed file${parsed.files.length === 1 ? "" : "s"}</span><div class="diff-modes" role="group" aria-label="diff mode"><button type="button" data-diff-mode="view" aria-pressed="true">View</button><button type="button" data-diff-mode="annotate" aria-pressed="false">Annotate</button></div></div><p class="diff-review-help">Select a line, then describe what should change. Nothing is revised until you create the revision below.</p>`
      : ""}${files}${
    patch.truncated
      ? html`<p class="diff-cut">The sealed diff was shortened at storage: the rest of the change was never captured, here or in the download.</p>`
      : parsed.linesTruncated ? html`<p class="diff-cut">This visual diff is shortened. Review the sealed patch before approving.</p>` : ""
  }</div>${storedDownloadLink(runId, patch.artifactId, "diff", patch.truncated)}`;
}

/** The check log as stored (repair 2026-09-14): its output behind a
 * disclosure when the bytes verify — a shortened log says so in the
 * summary and its download is the stored part; a log that no longer
 * verifies is a named problem with no output and no download. */
export function checkLogHtml(log: NonNullable<ProofBundleView["checkLog"]>, runId: number, extra: Html): Html {
  if (log.problem !== null) {
    return html`<p class="problem" data-check-log="damaged"${extra}>The check log no longer verifies (${log.problem}). Its output is not shown, and there is nothing to download.</p>`;
  }
  return html`<details data-check-log="${log.truncated ? "shortened" : "ok"}"${extra}><summary>Check output${log.truncated ? ` (shortened — ${log.bytesStored} of ${log.bytesOriginal} bytes stored)` : ""}</summary><pre class="mono" style="overflow-x:auto;max-height:18rem">${
      // Each line is a link target (#check-log-L<n>): a failed task names the exact line its check ended on.
      joinHtml(log.text.split("\n").map((line, index) => html`<span id="check-log-L${index + 1}">${line}</span>`), "\n")}</pre></details>${
    storedDownloadLink(runId, log.artifactId, "check log", log.truncated)}`;
}

/** The download link for a stored record (repair 2026-09-14): a shortened
 * record's link says it holds the stored part only — never "the full"
 * bytes that were cut at storage and exist nowhere. */
export function storedDownloadLink(runId: number, artifactId: number, what: string, truncated: boolean): Html {
  return html`<p class="meta"><a href="/r/${runId}/evidence/${artifactId}">${truncated ? `Download the stored part of the ${what} (shortened at storage — not the full ${what})` : `Download the ${what}`}</a></p>`;
}

/** Render the terminal diff card: stat and capture health first, the bounded
 * patch beneath a fold. `editor` (arc 6) links file rows to vscode:// on the
 * reviewing device; `commentable` adds a per-file "comment" button the
 * page's prefill script reads — a real button, keyboard-reachable, separate
 * from the link so the two never fight over one click (finding 4). */
export function terminalDiffCard(
  view: TerminalDiffView,
  runId: number,
  editor: { worktree: string } | null = null,
  commentable = false,
): Html {
  const parts: Html[] = [html`<h2>What changed</h2>`];

  if (view.stat === null) {
    parts.push(html`<p class="meta">No change summary was captured for this build</p>`);
  } else if ("problem" in view.stat) {
    parts.push(html`<p class="meta">Stat: ${view.stat.problem}</p>`);
  } else {
    const s = view.stat;
    const zero = s.fileCount === 0;
    parts.push(
      html`<p class="row"><span class="mono">${s.base.slice(0, 12)} → ${s.head.slice(0, 12)}</span> — ${
        zero
          ? "no changes, verified"
          : `${s.fileCount} file(s) · +${s.additions} −${s.deletions}` +
            (s.binaryCount > 0 ? ` · ${s.binaryCount} binary` : "") +
            (s.filesTruncated ? " · file list cut, counts complete" : "")}</p>`,
    );
    if (!zero) {
      const fileName = (path: string): Html | string => {
        const href = editor === null ? null : editorFileHref(editor.worktree, path);
        return href === null ? path : html`<a href="${href}">${path}</a>`;
      };
      parts.push(
        html`<div class="evidence">${joinHtml(
          s.files
            .slice(0, 40)
            .map(
              file =>
                html`<p class="row mono">${fileName(file.path)}${file.renamedFrom === undefined ? "" : ` (was ${file.renamedFrom})`} <span class="meta">${file.additions === null || file.deletions === null ? "binary" : `+${file.additions} −${file.deletions}`}</span>${commentable ? html` <button type="button" class="pick-file" data-path="${file.path}">Comment</button>` : ""}</p>`,
            ), "\n")}${
          s.files.length > 40 ? html`<p class="meta">…and ${s.files.length - 40} more file(s)</p>` : ""}</div>`,
      );
      if (editor !== null) {
        parts.push(html`<p class="meta">File links open in VS Code on THIS device — if the build's worktree is gone, a link opens nothing</p>`);
      }
    }
  }

  if (view.patch === null) {
    parts.push(html`<p class="meta">The final diff was not captured for this build</p>`);
  } else if ("problem" in view.patch) {
    parts.push(html`<p class="meta">Patch: ${view.patch.problem}</p>`);
  } else if (view.patch.text.trim() === "") {
    parts.push(html`<p class="meta">Empty diff — captured successfully, nothing changed</p>`);
  } else {
    parts.push(reviewDiffHtml(view.patch, view.stat, runId, commentable));
  }

  return joinHtml(parts, "\n");
}

/**
 * The evidence bundle (Priority 2): the closed verdict first — the one
 * sentence every other surface agrees with — then criteria, the agent's
 * declared checks, the plane's own re-run (labeled "re-run here", never
 * confused with the agent's own claim), caveats, and every validated
 * screenshot as a thumbnail linking to the full image. Renders nothing
 * when the run predates the proof system.
 */
export function evidenceBundleCard(view: ProofBundleView | null, run: Pick<Run, "id" | "role" | "outcome">, publication: PublicationFacts = null, review: ReviewFacts | null = null): Html {
  if (view === null) return html``;
  const runId = run.id;
  const parts: Html[] = [html`<h2>Verification and evidence</h2>`];

  if (view.verdict !== null) {
    // The same status line every other surface renders for this run
    // (workspace package 1), beside the verdict's own explanation.
    const status = resultStatusOf({ runId, role: run.role, outcome: run.outcome, verdict: view.verdict, reasons: view.reasons, accepted: view.accepted !== null, review }, publication);
    parts.push(html`<p class="row" data-proof-verdict="${dispatchStatusToken(view.verdict)}">${statusLineHtml(status)} <span class="meta">${verificationExplanation(view.verdict, view.reasons)}</span></p>`);
  }
  if (view.accepted !== null) {
    parts.push(
      html`<p class="meta">Accepted with an exception by <span class="mono">${view.accepted.by}</span> · ${whenTime(view.accepted.at)}${view.accepted.note === null ? "" : ` — ${view.accepted.note}`}</p>`,
    );
  }

  parts.push(criterionMatrixHtml(view.matrix, { runId, links: view.matrixLinks, verdict: view.verdict }));
  parts.push(semanticCoverageHtml(view.matrix, view.qualityMode));
  if (reviewConflict(view.matrix, view.machineVerdict, view.verdict)) {
    parts.push(html`<p class="meta">An independent review found conflicting evidence.</p>`);
  }
  parts.push(repairChainHtml(view.repairChain));

  if (view.proofProblem !== null) {
    parts.push(html`<p class="meta">Verification details are unavailable: ${view.proofProblem}</p>`);
  } else if (view.proof !== null) {
    if (view.proof.criteria.length > 0) {
      parts.push(
        html`<div class="result-section"><strong>Acceptance criteria</strong><ul>${
          view.proof.criteria
            .map(one => html`<li><span class="badge${one.verdict === "met" ? " badge-done" : one.verdict === "not-met" ? " badge-failed" : ""}">${sentenceCase(one.verdict)}</span> ${one.statement} <span class="meta">— ${one.how}</span></li>`)
        }</ul></div>`,
      );
    }
    if (view.proof.checks.length > 0) {
      parts.push(
        html`<div class="result-section"><strong>Checks reported by the agent</strong><ul>${
          view.proof.checks.map(one => html`<li><span class="mono">${one.command}</span> <span class="meta">(exit ${one.exitCode}) — ${one.summary}</span></li>`)
        }</ul></div>`,
      );
    }
    if (view.proof.caveats.length > 0) {
      parts.push(html`<div class="result-section"><strong>Caveats</strong><ul>${view.proof.caveats.map(one => html`<li>${one}</li>`)}</ul></div>`);
    }
  }

  if (view.checkLog !== null) parts.push(checkLogHtml(view.checkLog, runId, html``));

  if (view.screenshots.length > 0) {
    parts.push(
      html`<div class="result-section"><strong>Screenshots</strong>${joinHtml(
        view.screenshots
          .map(
            shot =>
              html`<p class="row"><a href="/r/${runId}/evidence/${shot.artifactId}"><img src="/r/${runId}/evidence/${shot.artifactId}" alt="${shot.caption}" style="max-width:12rem;max-height:9rem;border-radius:var(--radius);border:1px solid var(--border)"></a> <span class="meta">${shot.caption} · <span class="mono">${shot.path}</span></span></p>`,
          ), "\n")}</div>`,
    );
  }

  return parts.length === 1 ? html`` : joinHtml(parts, "\n");
}

/** A calm, scan-first result receipt for the task and its focused chat.
 * The full ledger remains one click away; this card carries only the facts
 * needed to decide whether to inspect, discuss, or move on. */
/** The receipt's proof-state word and tone, from the stored verdict and
 * the operator's acceptance alone — shared with the review cockpit's
 * header chip so the two surfaces never name one state differently. */
/** The receipt's facts as the shared projection reads them. */
/** A result's follow-ups: checks run on its commit since it finished, and its tests task. */
export function followUpsFor(store: Store, evidenceRoot: string, run: Run, now: Date): NonNullable<ResultDetail["followUps"]> | null {
  if (run.role !== "builder" || run.finishedAt === null || run.headRevision === null) return null;
  const repo = store.refById(run.taskRef)?.repo ?? null;
  const tests = store.handle.prepare("SELECT outcome FROM action_ledger WHERE run_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(run.id, ADD_TESTS_ACTION);
  return { repo, checks: followUpChecksOf(store, run.id, now, evidenceRoot), testsTask: tests === undefined ? null : String(tests["outcome"]),
    quick: repo !== null && liveQuickCommand(store, repo) !== null, full: repo !== null && store.liveVerifyCommand(repo) !== null };
}

export const FOLLOW_UP_WORDS: Record<FollowUpCheck["state"], string> = { waiting: "waiting for a worker", running: "running", passed: "passed", failed: "failed", "not-run": "didn't run" };
/** Run checks and Add tests, under the result's Checks: what ran since, then the two acts. */
export function followUpsHtml(followUps: NonNullable<ResultDetail["followUps"]>, runId: number, o: ResultPanelOptions): Html {
  // A batch check names every result it ran with and the exact commit it tested (batch-checks.ts).
  const batchHow = (one: FollowUpCheck): string => {
    const peers = one.batch?.members.filter(member => member.run !== runId).map(member => member.task) ?? [];
    return one.batch?.mode === "together" && peers.length > 0 ? ` together with ${peers.join(", ")}`
      : one.batch?.mode === "split" ? " on its own after its batch failed" : one.batch?.mode === "conflict" ? " on its own (it conflicted with another result)" : "";
  };
  const rows = followUps.checks.map(one => html`<li data-follow-up-check="${one.state}"${one.why === "batch" ? html` data-batch="${one.batch?.mode ?? "waiting"}"` : ""}>${CHECK_LEVEL_WORDS[one.level]} checks ${
    one.why === "batch" && one.state === "waiting" ? "waiting to check with other results" : FOLLOW_UP_WORDS[one.state]}${batchHow(one)}${
    one.exitCode === null || one.state === "passed" ? "" : ` (exit ${one.exitCode})`} on <span class="mono">${(one.tested ?? one.head).slice(0, 7)}</span><span class="meta"> · ${
    one.why === "pull-request" ? "for the pull request" : one.why === "batch" ? "batch check" : one.actor}${one.note === null ? "" : ` · ${one.note}`}</span>${
    one.logArtifactId === null ? "" : html` <a href="/r/${runId}/evidence/${one.logArtifactId}">Log</a>`}</li>`);
  const canCheck = followUps.quick || followUps.full;
  const checkActs = !canCheck || o.csrf === "" ? null : postForm(`/r/${runId}/checks`,
    followUps.quick && followUps.full ? html`<button type="submit" name="level" value="quick">Run quick checks</button><button type="submit" name="level" value="full" class="secondary">Run full checks</button>`
      : html`<button type="submit" name="level" value="${followUps.quick ? "quick" : "full"}">Run checks</button>`, { attrs: { class: "follow-up-act" }, returnTo: o.returnTo });
  const tests = followUps.testsTask !== null ? html`<p class="meta">Tests task: <a href="${taskHref(followUps.testsTask)}">${followUps.testsTask}</a></p>`
    : o.csrf === "" ? null : postForm(`/r/${runId}/add-tests`, html`<button type="submit" class="secondary">Add tests</button>`, { attrs: { class: "follow-up-act" }, returnTo: o.returnTo });
  return html`<section class="result-section follow-ups" id="follow-ups" data-follow-ups><strong>Follow-ups</strong>${
    rows.length === 0 ? "" : html`<ul class="follow-up-list">${rows}</ul>`}${
    canCheck || followUps.repo === null ? "" : html`<p class="meta">No approved check to run. <a href="/settings/checks?repo=${encodeURIComponent(followUps.repo)}">Set one up</a>.</p>`}${
    checkActs === null && tests === null ? "" : html`<div class="follow-up-acts">${checkActs}${tests}</div>`}</section>`;
}

export function receiptStatusOf(view: CompletionReceiptView, review: ReviewFacts | null = view.review): DisplayStatus {
  // The evidence health rides the status (repair 2026-09-14): a result
  // whose stored records are damaged is never called ready on the strength
  // of a verdict recorded before the damage.
  return evidenceResultStatusOf(
    { runId: view.runId, role: view.role, outcome: view.outcome, verdict: view.verdict, reasons: view.reasons, accepted: view.accepted, recordComplete: view.recordComplete, review },
    view.publication, view.facts.evidenceHealth,
  );
}

export function completionReceiptCard(view: CompletionReceiptView, taskId: string, place: "task" | "chat", standing: DisplayStatus = receiptStatusOf(view), assignment: AssignmentSnapshot | null = null, headline = true): Html {
  const current = assignment?.receipt?.runId === view.runId ? assignment : null;
  const presentation = current === null ? null : assignmentPresentationOf(current);
  const status = presentation?.status ?? standing;
  // The verdict on record, whatever review is in flight: the criteria
  // count's source label reads from it, never from the review's tone.
  const stored = receiptStatusOf(view, null);
  const inReview = REVIEW_TOKENS.has(status.token);
  const facts = view.facts;
  const shown = view.screenshots.filter(one => one.problem === null);
  const unavailable = view.screenshots.length - shown.length;
  const diff =
    view.diff === null
      ? "Change summary unavailable"
      : "problem" in view.diff
        ? "Change summary unavailable"
        : view.diff.fileCount === 0
          ? "No repository changes"
          : `${view.diff.fileCount} file${view.diff.fileCount === 1 ? "" : "s"} · +${view.diff.additions} −${view.diff.deletions}` +
            (view.diff.binaryCount > 0 ? ` · ${view.diff.binaryCount} binary` : "") +
            (view.diff.filesTruncated ? " · list shortened" : "");
  const criteria =
    facts.checks === null
      ? "No requirements set"
      : `${facts.checks.passed}/${facts.checks.total} requirements met`;
  // The deliverable leads (package 3): a scout's report by its title, UI
  // work by its validated screenshots. Unverifiable shots are counted as
  // unavailable, never shown, never called validated.
  const lead =
    view.report !== null
      ? view.report.ok
        ? html`<p class="receipt-report"><strong>${view.report.title}</strong> <span class="meta">${oneLineOf(view.report.summary, 240)}</span></p>`
        : html`<p class="receipt-report problem">The report cannot be shown: ${view.report.problem}.</p>`
      : shown.length === 0
        ? ""
        : html`<div class="receipt-visuals" aria-label="validated screenshots">${shown
            .slice(0, 4)
            .map(
              shot =>
                html`<a class="receipt-shot" href="/r/${view.runId}/evidence/${shot.artifactId}"><img src="/r/${view.runId}/evidence/${shot.artifactId}" alt="${shot.caption}"><span>${shot.caption}</span></a>`,
            )}</div>`;
  // Caveats and evidence problems stay in the open, ahead of the counts
  // and any readiness words below them.
  const attention = current === null ? [...facts.evidenceProblems, ...view.caveats] : [];
  const caveats =
    attention.length === 0
      ? ""
      : html`<div class="receipt-caveats" data-result-attention="${attention.length}"><strong>Before you move on</strong><ul>${attention.map(one => html`<li>${plainReasonWords(one)}</li>`)}</ul></div>`;
  // v51: semantic coverage, distinct from the machine proof word above —
  // the same lines the CLI prints, so chat and terminal cannot disagree.
  // Nothing owed (optional and unsettled, or satisfied) folds behind a
  // disclosure; a strict shortfall or a context gap stays in the open.
  const coverage =
    view.coverage.length === 0
      ? ""
      : current !== null || view.coverageSecondary
        ? html`<details class="receipt-coverage" data-semantic-coverage="secondary"><summary>Previous assessment</summary><ul>${view.coverage.map(one => html`<li>${one}</li>`)}</ul></details>`
        : html`<div class="receipt-coverage" data-semantic-coverage=""><strong>Previous assessment</strong><ul>${view.coverage.map(one => html`<li>${one}</li>`)}</ul></div>`;
  const resultHref = status.token === "review-failed" ? reviewHref(taskId) : place === "chat" ? chatResultHref(taskId, view.runId, status.action?.kind === "open-review" ? "checks" : "summary") : statusActionHref(status, taskId, view.runId, view.publication?.prUrl ?? null) ?? `/r/${view.runId}`;
  return joinHtml([
    html`<section class="card completion-receipt" data-card-kind="result-receipt"${attributes(resultFactsAttributeMap(facts))}>`,
    html`<div class="receipt-head"><div><h2>${receiptHeadingOf(view.outcome, view.publication, view.role)}</h2></div>`,
    html`${headline ? statusLineHtml(status) : ""}</div>`,
    // The agent's handoff is its narrative, labeled as such; the
    // publication line is the observed record — never "shipped".
    lead,
    html`<p class="receipt-summary">${conciseOutcomeOf(view.summary ?? (view.outcome === "no-change" ? "The agent found that no repository change was needed." : "The build finished without a concise handoff."))}</p>`,
    headline ? html`<div class="receipt-actions"><a class="button-link" href="${resultHref}" data-open-result data-primary-action>${status.action?.label ?? "Open result"}</a></div>` : "",
    // A pull request that couldn't open never undoes the result: an amber note, not red.
    view.publication?.state === "failed" ? html`<p class="receipt-note">${statusIconSvg("note")} Pull request couldn't open. The commit is safe locally.</p>` : "",
    caveats,
    coverage,
    html`<details class="receipt-details"><summary>${STATUS_MORE}</summary>`,
    view.summary !== null && view.summary !== conciseOutcomeOf(view.summary) ? html`<p class="recap">${view.summary}</p>` : "",
    html`<p class="receipt-publication" data-receipt-publication="${facts.publicationState}">${facts.publicationWords}</p>`,
    // A review in flight is the receipt's primary status too (its chip
    // above); the detail — the earlier verdict as history (review fixes,
    // finding 4) — is secondary, behind a native disclosure that reads the
    // same words on the task page and in chat.
    inReview ? html`<details class="receipt-history"><summary>Review history</summary><p class="receipt-review meta" data-receipt-review="${status.token}">${status.detail}</p></details>` : "",
    // The matrix count is the proof's own citation; it reads as verified
    // only when the machine verified the result (workspace package 1).
    html`<div class="receipt-facts"><span><strong>${criteria}</strong><small>${stored.tone === "problem" ? html`the agent's own claim — not checked` : stored.token === "agent-attested" ? html`the agent's own claim, no project check` : "against the approved scope"}</small></span>`,
    html`<span><strong>${diff}</strong><small>${facts.head === null ? "no commit recorded" : `head ${facts.head.slice(0, 12)} · ${facts.headSource ?? ""}`}</small></span>`,
    html`<span><strong>${view.screenshots.length} screenshot${view.screenshots.length === 1 ? "" : "s"}</strong><small>${view.screenshots.length === 0 ? "none required or captured" : unavailable === 0 ? "validated visual proof" : `${unavailable} unavailable — not validated`}</small></span></div>`,
    html`<div class="receipt-actions">`,
    place === "task"
      ? html`<a href="${taskChatHref(taskId)}">Discuss in chat →</a>`
      : html`<a href="/r/${view.runId}">Full build record →</a>`,
    // The cockpit (Priority 5): the same records, arranged for a reviewer.
    html`<a href="${reviewHref(taskId)}">Open result →</a>`,
    html`</div></details></section>`,
  ]);
}

/**
 * ONE result presentation (workspace package 3) for the run page, the
 * review cockpit, and the chat's result detail. Every fact here comes
 * from the same verified records the receipt reads; the surfaces differ
 * only in where the panel sits and which links lead away from it.
 */
export type ResultDetail = {
  /** Where "Complete and open a pull request" opens one; null when only "Mark complete" is offered. */
  pullRequestTo?: string | null;
  /** Where publishing stands: a pull request can be opened, publishing isn't set up, or neither said. Accept never publishes. */
  publishing?: "pull-request" | "off" | "other";
  learning?: Html;
  skillTest?: boolean;
  rootId?: string;
  history?: Html;
  taskId: string;
  run: Run;
  receipt: CompletionReceiptView;
  assignment?: AssignmentSnapshot | null;
  handoff: StructuredHandoffView | null;
  proof: ProofBundleView | null;
  terminal: TerminalDiffView | null;
  publication: Publication | null;
  ciFailing: boolean;
  files: (ReviewFileRow & { priority: ReviewPriority })[];
  outsideTouches: string[];
  fileAnchors: ReadonlyMap<string, string>;
  comments: DiffComment[];
  pastComments?: DiffComment[];
  reviewerFindings: DiffComment[];
  /** The build's one automatic review, when its project had review on. */
  automaticReview?: BuildReviewView | null;
  /** Revisions already sealed from this run — the forward link. Each
   * carries the shared status projection's own words for the child
   * (repair 2026-09-14): CURRENT exact approval and actual activity, so
   * held or paused work is never called building because it was once
   * approved, and a rescoped child reads as needing approval again. */
  revisions: { id: string; title: string; state: TaskState; approved: boolean; standing: string; tone: string }[];
  /** The source scope digest the panel was rendered against (null = no
   * scope) — the revision form's source binding. */
  sourceDigest: string | null;
  route: RouteStamp | null;
  editor: { worktree: string } | null;
  /** Signed criteria on the scope this run built against. */
  signedCriteria: number;
  /** Whether a reviewer can annotate here (sealed non-empty patch verifies, cookie session). */
  canAnnotate: boolean;
  /** Follow-ups on this result (result-follow-ups.ts): checks run since, the tests task, and what can run. */
  followUps?: { repo: string | null; checks: FollowUpCheck[]; testsTask: string | null; quick: boolean; full: boolean } | null;
};

export type ResultPanelOptions = {
  place: "run" | "review" | "chat";
  tab: ResultTab;
  csrf: string;
  /** The server-named account, for the browser's bounded draft keys. */
  user: string;
  /** The page carries a receipt for a just-posted note: focus the box. */
  noted: boolean;
  /** This render's request token for the note form (replay dedupe). */
  requestToken: string;
  hrefFor: (tab: ResultTab) => string;
  /** Where the forms send the reader back (validated server-side too). */
  returnTo: string;
  back: { href: string; label: string } | null;
  /** Surface-specific acts that belong under Checks (the cockpit's review
   * retry panel and its accept-with-exception form). */
  extraChecks?: Html;
  /** The cockpit's header already carries the status chip: said once. */
  headStatus?: boolean;
  /** The cockpit renders its own next-action card: no panel action. */
  action?: boolean;
  /** Accept and finish sits beside the panel: it records the person's own checks too, so the panel offers no separate Accept. */
  finishes?: boolean;
};

/** The revision form's binding (repair 2026-09-14): the exact ids of the
 * notes this page displays and the source terms it was rendered against.
 * The server seals these ids and no others. */
export function revisionSealFields(comments: readonly { id: number }[], sourceDigest: string | null): Html {
  return html`<input type="hidden" name="batch" value="${revisionBatchOf(comments)}"><input type="hidden" name="source" value="${revisionSourceOf(sourceDigest)}">`;
}

/** Older machine-checked results saved a mechanical sentence; say the same
 * facts in plain words (the version id stays, shortened). */
export function plainConclusionOf(conclusion: string): string {
  const prepared = /^Prepared candidate ([0-9a-f]{7,40}) was checked out by the machine; no agent ran\. (The branch already matched it\.|The sealed diff spans this task's base to that candidate\.)/.exec(conclusion);
  if (prepared === null) return conclusion;
  const rest = conclusion.slice(prepared[0].length).trim();
  return `Checked the prepared version ${prepared[1]!.slice(0, 7)}; no agent ran. ${prepared[2]!.startsWith("The branch") ? "The branch already matched it." : "The changes cover everything since the task started."}${rest === "" ? "" : ` ${rest}`}`;
}

export function resultPanelHtml(detail: ResultDetail, o: ResultPanelOptions): Html {
  return resultPanelParts(detail, o).html;
}

/** The panel's HTML and the same panel in parts, for the rebuilt result page. */
export function resultPanelParts(detail: ResultDetail, o: ResultPanelOptions): { html: Html; panel: BrowserResultPanel } {
  const { run, receipt, proof, terminal, handoff } = detail;
  const facts = receipt.facts;
  const current = detail.assignment?.receipt?.runId === run.id ? detail.assignment : null;
  const followUps = detail.followUps ?? null;
  const resultLinks = { result: o.hrefFor("summary"), checks: o.hrefFor("checks"), pullRequest: `${taskHref(detail.rootId ?? detail.taskId)}#merge`,
    ...(followUps !== null && (followUps.quick || followUps.full) && o.csrf !== "" ? { runChecks: `${o.hrefFor("checks")}#follow-ups` } : {}) };
  const presentation = current == null ? null : assignmentPresentationOf(current, { additionalAttention: [...facts.evidenceProblems, ...receipt.caveats],
    ...(detail.publication === null ? {} : { pullRequest: pullRequestFactOf({ ...detail.publication, lastCheckState: detail.ciFailing ? "failing" : detail.publication.lastCheckState }) }),
    evidence: { damaged: facts.evidenceHealth.damaged, missing: facts.evidenceHealth.missing, shortened: facts.evidenceHealth.shortened }, links: resultLinks });
  const taskStatus = presentation?.taskStatus ?? null;
  const status = presentation?.status ?? resultHeadlineOf(receiptStatusOf(receipt));
  const stored = receiptStatusOf(receipt, null);
  const humanReview = manualReviewOnly(proof === null ? null : { ...proof, verdict: proof.verdict ?? "" });
  // Needs you: the action that resolves it comes first; Request changes stays beside it, never alone.
  // On the result itself, "Review result" would link here: accepting it is what resolves it.
  const need = needActionOf(current, taskStatus, o.csrf, o.returnTo, {
    accepted: proof?.accepted != null, humanReview, run: run.id, action: `${taskHref(detail.taskId)}/accept-proof`, refuted: proof?.verdict === "refuted",
    // What Store.finalResultReason refuses: a verified, attested, accepted or published result.
    rebuildable: proof?.accepted == null && proof?.verdict !== "verified" && proof?.verdict !== "attested" && !(detail.publication !== null && ["pushed", "opened"].includes(detail.publication.state)) });
  const directAssessment = proof?.matrix.some(row => row.assessment !== undefined) === true;
  const awaitingGoalReview = directAssessment && proof?.reasons.length === 1 && proof.reasons[0] === GOAL_ASSESSMENT_PENDING;
  const assessmentReasons = directAssessment ? new Set(proof!.matrix.flatMap(row => row.review ? [`${row.review.author} ${row.review.judgement === "contradicts" ? "contradicts" : "needs more evidence for"} criterion "${row.id}": ${row.review.note}`] : [])) : new Set<string>();
  const physicalReasons = receipt.reasons.filter(reason => !assessmentReasons.has(reason));
  const runId = run.id;
  const shots = proof?.screenshots ?? [];
  const shown = shots.filter(one => one.problem === null);
  const stat = terminal?.stat ?? null;
  const statOk = stat !== null && !("problem" in stat);
  const patch = terminal?.patch ?? null;
  const patchOk = patch !== null && !("problem" in patch);
  const lead = resultLeadOf({ role: run.role, report: receipt.report !== null, screenshots: shown.length, diff: (patchOk && patch.text.trim() !== "") || (statOk && stat.fileCount > 0) });
  const tabHref = (tab: ResultTab): string => o.hrefFor(tab);

  // ---- attention: problems and caveats, ahead of every readiness word ----
  const publication = detail.publication;
  const prUrl = publication === null ? null : safePrUrl(publication.prUrl);
  const attention: string[] = [];
  // The visible status already says verification is needed. Only omit the
  // generic repeat; failed checks, specific reasons and damaged evidence stay.
  const missingVerdictNamed = o.headStatus !== false && status.token === "verification-needed" && receipt.verdict === null && receipt.reasons.length === 0;
  if (current == null && !humanReview && !awaitingGoalReview && (!directAssessment || physicalReasons.length > 0) && !missingVerdictNamed && stored.token !== "evidence-damaged" && (stored.tone === "problem" || stored.tone === "attention")) attention.push(verificationExplanation(receipt.verdict, physicalReasons));
  // Exact criterion assessment notes are already shown in Requirements;
  // do not repeat them as a second current attention message.
  if (presentation !== null) attention.push(...presentation.attention.map(one => one.detail).filter(detail => !assessmentReasons.has(detail)));
  if (current == null) attention.push(...facts.evidenceProblems);
  if (detail.outsideTouches.length > 0) attention.push(`${detail.outsideTouches.length} changed file${detail.outsideTouches.length === 1 ? "" : "s"} outside the approved paths: ${detail.outsideTouches.join(", ")}.`);
  // A failed caveat can already be quoted in full by its verification
  // reason. Keep that explanation once and retain every other caveat.
  if (current == null) attention.push(...receipt.caveats.filter(caveat => !historicalAssessmentReason(caveat) && !attention.some(problem => problem.includes(caveat))));
  attention.push(...(handoff?.followUps ?? []).map(one => `Follow-up: ${one}`));
  // The automatic review: a HIGH that did not send the work back, or a review
  // that could not finish, is the person's to see. (Said once when the
  // current assignment already carries it.)
  const automatic = detail.automaticReview ?? null;
  if (automatic !== null && automatic.sentBackAs === null) {
    const reviewed = [...(automatic.state === "not-reviewed" ? [`Not reviewed: ${automatic.reason ?? "the automatic review did not finish"}.`] : []), ...automatic.high.map(one => `Review: ${findingWords(one)}`)];
    for (const line of reviewed) if (!attention.includes(line)) attention.push(line);
  }
  // Publication risks stay in the open (repair 2026-09-14); the routine
  // publication fact lives with the build details below.
  // With the shared status, the pull request is its own quiet row (its reason under Details).
  if (publication !== null && publication.state === "failed" && taskStatus === null) {
    attention.push(`Publication failed after ${publication.attempts} attempt${publication.attempts === 1 ? "" : "s"}${publication.lastError === null ? "" : ` — ${oneLineOf(publication.lastError, 200)}`}. No pull request or merge is recorded.`);
  }
  if (detail.ciFailing && publication !== null && taskStatus === null) attention.push(`CI is failing on PR #${publication.prNumber} at the last check.`);
  // Requirements only a person can confirm: plain words and one Accept,
  // in neutral ink — nothing failed. Accepting records the person's
  // decision and leaves the recorded checks as they are.
  const personChecks = proof === null || proof.accepted !== null ? [] : [
    ...proof.matrix.filter(row => row.state === "manual-review").map(row => personCheckWords(row.statement)),
    ...(proof.matrix.length > 0 ? [] : proof.reasons.filter(reason => manualReviewCriterionOf(reason) !== null).map(() => personCheckWords(null))),
  ];
  const acceptable = personChecks.length > 0 && humanReview && o.csrf !== "" && (current != null || detail.assignment == null);
  const youCheck: BrowserResultPanel["youCheck"] = personChecks.length === 0 ? null : {
    lines: [...new Set(personChecks)],
    items: personCheckItems(proof!, patchOk ? patch.text : null, shown, runId),
    accept: acceptable && need?.accept == null ? { action: `${taskHref(detail.taskId)}/accept-proof`, run: run.id, returnTo: o.returnTo } : null,
  };
  const youCheckForm = youCheck?.accept != null && o.finishes !== true ? youCheck.accept : null;
  const youCheckHtml = youCheck === null ? "" :
    html`<div class="result-you-check" data-result-you-check="${youCheck.lines.length}"><ul>${youCheck.lines.map(one => html`<li>${one}</li>`)}</ul>${
      youCheckForm === null ? "" : postForm(youCheckForm.action, html`<button type="submit" data-accept-result>Accept</button>`, { returnTo: youCheckForm.returnTo, hidden: { run: youCheckForm.run } })
    }</div>`;
  const attentionHtml =
    attention.length === 0
      ? ""
      : html`<div class="result-attention" data-result-attention="${attention.length}"><ul>${attention.map(one => html`<li>${plainReasonWords(one)}</li>`)}</ul></div>`;

  // ---- one outcome, one action (repair 2026-09-14) ------------------------
  // The outcome is the handoff's first sentence, bounded; the agent's full
  // account waits behind a disclosure in Summary so nothing is said twice.
  const conclusion = plainConclusionOf(receipt.summary ?? (run.outcome === "no-change" ? "The agent found that no repository change was needed." : "The build finished without a concise handoff."));
  const outcome = conciseOutcomeOf(conclusion);
  // A failing pull request keeps its repair draft beside the need's action.
  const action = o.action === false ? "" : need !== null ? html`${resultNeedAction(need, o, detail.canAnnotate)}${detail.ciFailing && o.csrf !== "" ? resultPrimaryAction(detail, o, prUrl) : ""}` : resultPrimaryAction(detail, o, prUrl);

  // ---- summary: the deliverable first ----------------------------------
  const summaryParts: Html[] = [];
  const report = receipt.report;
  if (lead === "report") {
    if (report === null) {
      summaryParts.push(html`<p class="problem" data-result-report="missing">This investigation stored no report.</p>`);
    } else if (!report.ok) {
      summaryParts.push(html`<p class="problem" data-result-report="problem">The report cannot be shown: ${report.problem}.</p>`);
    } else {
      // Escaped text in a fenced block, never markup, never a page: the
      // download serves the exact stored bytes as text. The summary is
      // already the outcome line above (and, when shortened there, waits
      // in "What the agent reported"), so the article never repeats it.
      summaryParts.push(
        html`<article class="result-report" data-result-report="ok"><h3>${report.title}</h3>${
          reportItemsHtml(report.items, report.shots, runId)}<pre class="recap plan-doc">${report.document}</pre><p class="meta"><a href="/r/${runId}/evidence/${report.artifactId}">${report.truncated ? "Download the stored part of the report (shortened at storage — not the full report)" : "Download the report"}</a>${report.followUps === 0 ? "" : html` · ${report.followUps} proposed follow-up${report.followUps === 1 ? "" : "s"} on <a href="${taskHref(detail.rootId ?? detail.taskId)}">the task</a>`}</p></article>`,
      );
    }
  } else if (lead === "screenshots") {
    summaryParts.push(
      html`<div class="receipt-visuals result-visuals" aria-label="validated screenshots">${shown
        .map(shot => html`<a class="receipt-shot" href="/r/${runId}/evidence/${shot.artifactId}"><img src="/r/${runId}/evidence/${shot.artifactId}" alt="${shot.caption}"><span>${shot.caption}</span></a>`)}</div>`,
    );
  }
  const unavailableShots = shots.filter(one => one.problem !== null);
  if (lead === "changes") {
    // Code work: the changed files ARE the deliverable; the diff is one tap away.
    summaryParts.push(
      html`<p class="result-files-lead">${detail.files.length === 0 ? "" : html`${joinHtml(detail.files.slice(0, 6).map(one => html`<span class="mono">${one.path}</span>`), ", ")}${detail.files.length > 6 ? ` and ${detail.files.length - 6} more` : ""} — `}<a href="${tabHref("changes")}" data-result-goto="changes">see the diff</a></p>`,
    );
  }
  if (lead === "summary" && run.outcome === "no-change") summaryParts.push(html`<p class="meta">The agent found that no repository change was needed${statOk && stat.fileCount === 0 ? "; the sealed diff is empty" : ""}.</p>`);
  // The agent's own account — its full conclusion (when the outcome line
  // shortened it), what it says it changed, and how it checked — on demand.
  const agentAccount: Html[] = [
    ...(conclusion !== outcome ? [html`<p class="recap">${conclusion}</p>`] : []),
    ...(handoff !== null && handoff.changes.length > 0 ? [html`<ul class="result-changes">${handoff.changes.map(one => html`<li>${one}</li>`)}</ul>`] : []),
    ...(handoff !== null && handoff.verification.length > 0 ? [html`<p class="meta">Checked by the agent:</p><ul class="result-changes" data-cockpit-source="agent-words">${handoff.verification.map(one => html`<li>${one}</li>`)}</ul>`] : []),
    // The report's own notes, each a link target (#report-note-<n>) a mismatch can point at.
    ...(proof?.proof == null || proof.proof.caveats.length === 0 ? [] : [html`<p class="meta">Its notes:</p><ol class="result-changes" data-report-notes>${proof.proof.caveats.map((one, index) => html`<li id="report-note-${index + 1}">${one}</li>`)}</ol>`]),
  ];
  if (agentAccount.length > 0) summaryParts.push(html`<details class="result-notes" data-result-notes-agent><summary>What the agent reported</summary>${agentAccount}</details>`);
  // MEDIUM and LOW never block: suggested follow-ups, on request.
  if (automatic !== null && automatic.followUps.length > 0) {
    summaryParts.push(html`<details class="result-notes" data-review-followups="${automatic.followUps.length}"><summary>Suggested follow-ups · ${automatic.followUps.length}</summary><ul class="result-changes">${
      automatic.followUps.map(one => html`<li><span class="badge">${one.severity === "MEDIUM" ? "Medium" : "Low"}</span> <span class="mono">${`${one.file}:${one.line}`}</span> ${one.scenario}</li>`)
    }</ul></details>`);
  }
  const evidenceSources = [
    ...(report !== null ? [report.ok ? `verified report${report.truncated ? " (shortened)" : ""}` : "report (unverifiable)"] : []),
    ...(patch !== null ? [patchOk ? `sealed diff${patch.truncated ? " (shortened)" : ""}` : "diff (unverifiable)"] : []),
    ...(proof === null ? [] : proof.proofProblem !== null ? ["proof (unreadable)"] : proof.proof !== null ? ["agent proof"] : []),
    ...(proof?.checkLog !== null && proof?.checkLog !== undefined ? [proof.checkLog.problem !== null ? "check log (unverifiable)" : `check log${proof.checkLog.truncated ? " (shortened)" : ""}`] : []),
    ...(shots.length > 0 ? [`${shown.length} validated screenshot${shown.length === 1 ? "" : "s"}${unavailableShots.length > 0 ? `, ${unavailableShots.length} unavailable` : ""}`] : []),
  ];
  const publicationHtml =
    html`<p class="result-publication" data-receipt-publication="${facts.publicationState}">${facts.publicationWords}${
    publication === null || publication.prNumber === null
      ? ""
      : html` ${prUrl === null ? html`<span class="mono">PR #${publication.prNumber}</span>` : html`<a href="${prUrl}">PR #${publication.prNumber}</a>`}<span class="meta" data-ci-observed="${detail.ciFailing ? "failing" : (publication.lastCheckState ?? "none")}"> · ${
          detail.ciFailing ? "CI failing at the last check" : publication.lastCheckState === "passing" ? html`CI passing, observed ${whenTime(publication.lastCheckAt)}` : publication.lastCheckState === "running" ? "CI still running at the last check" : "no CI checks found — verify on GitHub"
        }</span>`}</p>`;
  const agent = runAgentWords(detail.route);
  const links: Html[] = [];
  if (o.place !== "run") links.push(html`<a href="/r/${runId}">Full build record →</a>`);
  if (o.place !== "review") links.push(html`<a href="${reviewHref(detail.taskId)}">Open result →</a>`);
  if (o.place !== "chat") links.push(html`<a href="${taskChatHref(detail.rootId ?? detail.taskId)}">Discuss in chat →</a>`);
  links.push(html`<a href="${taskHref(detail.rootId ?? detail.taskId)}">Task overview →</a>`);
  // Technical facts on demand: build, agent, exact commits, evidence
  // sources, the publication record, and the other pages for this result.
  summaryParts.push(joinHtml([
    html`<details class="result-details" data-result-details><summary>Build details</summary>`,
    unavailableShots.length === 0 ? "" : html`<ul class="result-unavailable meta" data-result-unavailable="${unavailableShots.length}">${unavailableShots.map(one => html`<li>Screenshot unavailable — <span class="mono">${one.path}</span>: ${one.problem ?? ""}</li>`)}</ul>`,
    html`<dl class="result-facts">`,
    html`<div><dt>Build</dt><dd>#${runId} · ${run.runner}${agent === null ? ` · ${run.provider}` : ""}${run.finishedAt === null ? "" : html` · ${whenTime(run.finishedAt)}`}</dd></div>`,
    agent === null ? "" : html`<div><dt>Agent</dt><dd>${agent}</dd></div>`,
    html`<div><dt>Commits</dt><dd>${
      facts.head === null
        ? facts.base === null ? "no commit recorded" : html`<span class="mono">${facts.base.slice(0, 12)}</span> <span class="meta">base · no head recorded</span>`
        : html`<span class="mono">${facts.base === null ? "" : `${facts.base.slice(0, 12)} → `}${facts.head.slice(0, 12)}</span> <span class="meta">from the ${facts.headSource ?? "record"}</span>`
    }</dd></div>`,
    html`<div><dt>Evidence</dt><dd>${evidenceSources.length === 0 ? "nothing was captured" : evidenceSources.join(" · ")}</dd></div>`,
    html`<div><dt>Publication</dt><dd>${publicationHtml}</dd></div>`,
    html`</dl>`,
    html`<p class="result-links meta">${links}</p>`,
    html`</details>`,
  ]));

  // ---- changes -----------------------------------------------------------
  const changeParts: Html[] = [];
  if (terminal === null) {
    changeParts.push(html`<p class="meta">No final diff or change summary was captured for this build${run.role === "scout" ? " — an investigation changes nothing in the repository" : ""}.</p>`);
  } else {
    if (stat === null) changeParts.push(html`<p class="meta">No change summary was captured.</p>`);
    else if (!statOk) changeParts.push(html`<p class="problem">Change summary unavailable: ${stat.problem}.</p>`);
    else {
      changeParts.push(
        html`<p class="row result-stat"><span class="mono">${stat.base.slice(0, 12)} → ${stat.head.slice(0, 12)}</span> — ${
          stat.fileCount === 0
            ? "no changes, verified"
            : `${stat.fileCount} file${stat.fileCount === 1 ? "" : "s"} · +${stat.additions} −${stat.deletions}${stat.binaryCount > 0 ? ` · ${stat.binaryCount} binary` : ""}${stat.filesTruncated ? " · file list cut, counts complete" : ""}`}</p>`,
      );
    }
    if (detail.outsideTouches.length > 0) {
      changeParts.push(html`<p class="problem cockpit-drift" data-cockpit-drift="${detail.outsideTouches.length}"><strong>${detail.outsideTouches.length} changed file${detail.outsideTouches.length === 1 ? "" : "s"} outside the approved paths</strong> — ${joinHtml(detail.outsideTouches.map(path => html`<span class="mono">${path}</span>`), ", ")}. Review these files before accepting the result.</p>`);
    }
    if (detail.files.length > 0) {
      const fileName = (file: ReviewFileRow): Html => {
        const href = detail.editor === null ? null : editorFileHref(detail.editor.worktree, file.path);
        if (href !== null) return html`<a class="mono" href="${href}">${file.path}</a>`;
        return file.anchor === null ? html`<span class="mono">${file.path}</span>` : html`<a class="mono" href="#${file.anchor}">${file.path}</a>`;
      };
      changeParts.push(
        html`<ol class="cockpit-files result-files">${
          detail.files
            .map(file => {
              const counts = file.additions === null || file.deletions === null ? "binary" : `+${file.additions} −${file.deletions}`;
              const flags = html`${file.outsideTouches ? html` <span class="badge badge-failed" data-outside-touches="1">Outside touches</span>` : ""}${file.cited ? html` <span class="badge badge-done">Cited</span>` : ""}`;
              const why = file.priority.reasons.length === 0 ? "" : html` <span class="meta">— ${file.priority.reasons.join("; ")}</span>`;
              return html`<li data-file-priority="${file.priority.band}">${fileName(file)}${file.renamedFrom === null ? "" : html` <span class="meta">(was ${file.renamedFrom})</span>`} <span class="meta">${counts}</span>${flags}${detail.canAnnotate ? html` <button type="button" class="pick-file" data-path="${file.path}">Comment</button>` : ""}${why}</li>`;
            })}</ol>${
          detail.editor === null ? "" : html`<p class="meta">File links open in VS Code on THIS device — if the build's worktree is gone, a link opens nothing.</p>`}`,
      );
    }
    if (patch === null) changeParts.push(html`<p class="meta">The final diff was not captured for this build.</p>`);
    else if (!patchOk) changeParts.push(html`<p class="problem">Diff unavailable: ${patch.problem}.</p>`);
    else if (patch.text.trim() === "") changeParts.push(html`<p class="meta">Empty diff — captured successfully, nothing changed.</p>`);
    else changeParts.push(reviewDiffHtml(patch, stat, runId, detail.canAnnotate, detail.fileAnchors));
  }

  // ---- checks --------------------------------------------------------------
  const checkParts: Html[] = [];
  const reviewerNotes = detail.reviewerFindings.map(one => html`<li><span class="badge${one.severity === "problem" ? " badge-failed" : ""}">${one.severity ?? "note"}</span> ${one.path === null ? "" : html`<span class="mono">${one.path}${one.line === null ? "" : `:${one.line}`}</span> `}${one.note} <span class="meta">— ${one.author}</span>${!isRevisionFeedback(one) && detail.canAnnotate && o.csrf !== "" ? html` <button type="button" class="pick-file" data-path="${one.path ?? ""}" data-line="${one.line ?? ""}" data-review-note="${one.note}">Request change</button>` : ""}</li>`);
  if (proof === null && reviewerNotes.length > 0) checkParts.push(html`<div class="result-section" data-cockpit-source="reviewer"><strong>Previous assessment</strong><ul>${reviewerNotes}</ul></div>`);
  if (run.outcome === "no-change" && !directAssessment) checkParts.push(html`<p class="meta">The build concluded that no repository change was needed. A no-change conclusion owes no proof — its handoff and machine-captured diff are the record.</p>`);
  if (proof === null) {
    if (run.outcome !== "no-change") checkParts.push(html`<p class="meta" data-proof-verdict="none">This build has no verification result or captured evidence. Review its recorded changes yourself.</p>`);
  } else {
    if (proof.verdict !== null && !directAssessment) {
      // The same status line the panel leads with (one status per surface,
      // workspace package 1), beside the machine verdict's own explanation.
      checkParts.push(html`<p class="row result-verdict" data-proof-verdict="${dispatchStatusToken(proof.verdict)}"><span class="meta">At completion: ${humanReview ? "Human review required for the requirements below." : verificationExplanation(proof.verdict, proof.reasons)}</span></p>`);
    } else if (proof.verdict === null && run.outcome !== "no-change") {
      checkParts.push(html`<p class="meta" data-proof-verdict="none">No verification result is available for this build.</p>`);
    }
    if (proof.accepted !== null) checkParts.push(html`<p class="meta">${humanReview ? "Accepted after human review" : "Accepted with an exception"} by <span class="mono">${proof.accepted.by}</span> · ${whenTime(proof.accepted.at)}${proof.accepted.note === null ? "" : ` — ${proof.accepted.note}`}</p>`);
    if (proof.matrix.length === 0) {
      checkParts.push(detail.signedCriteria > 0 ? html`<p class="meta">The approved scope has ${detail.signedCriteria} requirement${detail.signedCriteria === 1 ? "" : "s"}, but this build has no requirement-by-requirement verification.</p>` : html`<p class="meta">This scope signed no acceptance checks.</p>`);
    } else {
      checkParts.push(criterionMatrixHtml(proof.matrix, { runId, links: proof.matrixLinks, fileAnchors: detail.fileAnchors, verdict: proof.verdict,
        release: current?.receipt == null ? undefined : checkBackingOf(current.receipt.checks) }));
    }
    checkParts.push(semanticCoverageHtml(proof.matrix, proof.qualityMode));
    if (reviewConflict(proof.matrix, proof.machineVerdict, proof.verdict)) checkParts.push(html`<p class="meta">An independent review found conflicting evidence.</p>`);
    checkParts.push(repairChainHtml(proof.repairChain));
    if (detail.reviewerFindings.length > 0) {
      checkParts.push(
        html`<div class="result-section" data-cockpit-source="reviewer"><strong>Independent review</strong><ul>${reviewerNotes}</ul></div>`,
      );
    }
    if (proof.proofProblem !== null) checkParts.push(html`<p class="problem">Verification details are unavailable: ${proof.proofProblem}</p>`);
    checkParts.push(proof.checkLog === null ? html`<p class="meta" data-cockpit-source="machine">${current?.receipt?.checks.level === "off" ? "Checks were off for this build." : "No automated check was configured for this build."}</p>` : checkLogHtml(proof.checkLog, runId, html` data-cockpit-source="machine"`));
    checkParts.push(
      proof.proof === null || proof.proof.checks.length === 0
        ? directAssessment ? html`` : html`<p class="meta" data-cockpit-source="agent">The agent reported no checks.</p>`
        : html`<details class="cockpit-proof-group" data-cockpit-source="agent"><summary>Agent checks · ${proof.proof.checks.length}</summary><div class="result-section"><ul>${
          proof.proof.checks.map(one => html`<li><span class="mono">${one.command}</span> <span class="meta">(exit ${one.exitCode}) — ${one.summary}</span></li>`)
        }</ul></div></details>`,
    );
    const screenshotRequired = proof.matrix.some(one => one.requiredEvidence.includes("screenshot"));
    checkParts.push(
      shots.length === 0
        ? directAssessment && !screenshotRequired ? html`` : html`<p class="meta" data-cockpit-source="screenshots">No screenshots${screenshotRequired ? " were captured, although one was required" : " were needed"}.</p>`
        : lead === "screenshots"
          ? html`<p class="meta" data-cockpit-source="screenshots">${shown.length} validated screenshot${shown.length === 1 ? "" : "s"} shown in Summary${unavailableShots.length > 0 ? `; ${unavailableShots.length} unavailable` : ""}.</p>`
          : html`<details class="cockpit-proof-group" data-cockpit-source="screenshots"><summary>Screenshots · ${shown.length}${unavailableShots.length > 0 ? ` (${unavailableShots.length} unavailable)` : ""}</summary><div class="receipt-visuals" aria-label="validated screenshots">${
            shown.map(shot => html`<a class="receipt-shot" href="/r/${runId}/evidence/${shot.artifactId}"><img src="/r/${runId}/evidence/${shot.artifactId}" alt="${shot.caption}"><span>${shot.caption}</span></a>`)
          }</div></details>`,
    );
    checkParts.push(
      receipt.caveats.length === 0
        ? directAssessment ? html`` : html`<p class="meta" data-cockpit-source="caveats">No caveats were reported.</p>`
        : html`<details class="cockpit-proof-group" data-cockpit-source="caveats"><summary>Agent caveats · ${receipt.caveats.length}</summary><ul>${receipt.caveats.map(one => html`<li>${one}</li>`)}</ul></details>`,
    );
  }
  if (followUps !== null && run.role === "builder") checkParts.push(followUpsHtml(followUps, runId, o));
  // The handoff's own account of its checks — the agent's words, labeled
  // as such, whether or not a proof exists.
  if (!directAssessment && handoff !== null && handoff.verification.length > 0) checkParts.push(html`<div class="result-section" data-cockpit-source="agent-words"><strong>The agent's own account</strong><ul>${handoff.verification.map(one => html`<li>${one}</li>`)}</ul></div>`);
  if (o.extraChecks !== undefined) checkParts.push(o.extraChecks);

  // ---- request changes: both feedback styles, one sealed road ------------
  const requestParts: Html[] = [html`<h3 class="so-sr-only">What should change?</h3>`];
  const pathWords = (path: string, line: number | null): Html => {
    const shownPath = `${path}${line === null ? "" : `:${line}`}`;
    const href = detail.editor === null ? null : editorFileHref(detail.editor.worktree, path, line);
    return href === null ? html`<span class="mono">${shownPath}</span> ` : html`<a class="mono" href="${href}">${shownPath}</a> `;
  };
  if (detail.comments.length > 0) {
    requestParts.push(
      html`<p class="meta">Saved for later · ${detail.comments.length}</p><div class="diff-comments" data-result-notes="${detail.comments.length}">${
        detail.comments.map(one => html`<div class="diff-comment"><span class="diff-comment-pin" aria-hidden="true"></span><p>${one.path === null ? "" : pathWords(one.path, one.line)}${one.note}</p><span class="meta">${one.author} · ${whenTime(one.createdAt)}</span></div>`)
      }</div>`,
    );
    if (o.csrf !== "" && !detail.canAnnotate) {
      requestParts.push(
        postForm(`/r/${runId}/revise`, html`${revisionSealFields(detail.comments, detail.sourceDigest)}<div><strong>${detail.comments.length} note${detail.comments.length === 1 ? "" : "s"} ready</strong></div><button type="submit">Request changes</button>`,
          { attrs: { class: "card revision-from-comments" }, returnTo: o.returnTo }),
      );
    }
  }
  if ((detail.pastComments?.length ?? 0) > 0) {
    requestParts.push(html`<details class="result-feedback-history"><summary>Earlier feedback</summary><div class="diff-comments" data-past-feedback>${detail.pastComments!.map(one => html`<div class="diff-comment"><p>${one.path === null ? "" : pathWords(one.path, one.line)}${one.note}</p><span class="meta">${one.author} · ${whenTime(one.createdAt)}</span></div>`)}</div></details>`);
  }
  for (const revision of detail.revisions) {
    // The child's standing is the shared status projection's own words
    // (repair 2026-09-14): current exact approval and actual activity.
    requestParts.push(html`<p class="result-revision" data-result-revision="${revision.id}" data-result-revision-approved="${revision.approved ? "1" : "0"}" data-tone="${revision.tone}"><strong>Revision</strong> <a href="${taskHref(revision.id)}">${revision.title}</a> <span class="meta">· ${revision.standing}</span></p>`);
  }
  if (o.csrf === "") {
    requestParts.push(html`<p class="meta">Sign in with a browser session to request changes.</p>`);
  } else if (!detail.canAnnotate) {
    requestParts.push(html`<p class="meta" data-result-feedback="unavailable">${terminal === null ? "This result has no sealed diff to attach notes to." : "The sealed diff no longer verifies, so notes cannot attach to it."} <a href="${taskChatHref(detail.rootId ?? detail.taskId)}">Discuss in chat →</a></p>`);
  } else {
    requestParts.push(
      html`<details class="result-request-open result-request-form"${detail.comments.length > 0 ? " open" : ""}><summary>What should change?</summary>${
      postForm(`/r/${runId}/comment`, joinHtml([
        revisionSealFields(detail.comments, detail.sourceDigest),
        html`<input type="hidden" data-recorded-requests value="${[...detail.comments, ...(detail.pastComments ?? [])].filter(one => one.sourceKey?.startsWith(`review:${o.user}:`)).map(one => one.sourceKey!.slice(`review:${o.user}:`.length)).join(",")}">`,
        html`<textarea name="note" rows="2" maxlength="${LIMITS.note}" placeholder="Describe the change…" aria-label="review comment" aria-describedby="comment-note-limit"${o.noted ? " autofocus" : ""}></textarea>`,
        html`<span class="meta diff-comment-limit" id="comment-note-limit">up to ${LIMITS.note} characters</span>`,
        html`<details class="result-pin"><summary>Attach to a file or line</summary>`,
        html`<div class="diff-comment-target"><label>File<input type="text" name="path" placeholder="src/…" aria-label="file" class="mono"></label>`,
        html`<label>Line<input type="text" name="line" placeholder="—" aria-label="line" inputmode="numeric"></label></div></details>`,
        html`<div class="result-feedback-actions"><button type="submit" name="intent" value="revise" data-request-changes>Request changes</button><button type="submit" name="intent" value="note" class="quiet" data-save-feedback>Save for later</button></div>`,
      ]), { attrs: { class: "diff-comment-form", id: "comment-form" }, returnTo: o.returnTo, hidden: { tab: o.tab, request: o.requestToken } })
      }</details>`,
    );
  }

  // ---- the panel ---------------------------------------------------------
  const tabCounts: Record<ResultTab, string> = {
    summary: "",
    changes: statOk ? (stat.fileCount === 0 ? "none" : `${stat.fileCount} file${stat.fileCount === 1 ? "" : "s"}`) : terminal === null ? "none" : "",
    checks: "",
  };
  const tabs =
    html`<nav class="result-tabs" role="tablist" aria-label="result views">${
    RESULT_TABS.map(tab => html`<a role="tab" href="${tabHref(tab.key)}" data-result-tab="${tab.key}" aria-selected="${tab.key === o.tab ? "true" : "false"}"${tab.key === o.tab ? "" : html` tabindex="-1"`}>${tab.key === "checks" && proof?.matrix.some(row => row.assessment !== undefined) ? "Requirements" : tab.label}${tabCounts[tab.key] === "" ? "" : html`<span class="count">${tabCounts[tab.key]}</span>`}</a>`)
    }</nav>`;
  const view = (tab: ResultTab, parts: Html[]): Html =>
    html`<div class="result-view" role="tabpanel" data-result-view="${tab}"${tab === o.tab ? "" : " hidden"}>${joinHtml(parts, "\n")}</div>`;
  const heading = receiptHeadingOf(run.outcome, receipt.publication, run.role);
  const panelHtml = joinHtml([
    html`<section class="card result-panel" id="result" data-result-panel data-result-place="${o.place}" data-result-lead="${lead}" data-result-task="${detail.rootId ?? detail.taskId}" data-result-user="${o.user}"${attributes(resultFactsAttributeMap(facts))}>`,
    o.back === null ? "" : html`<p class="result-back"><a href="${o.back.href}" data-result-back>← ${o.back.label}</a></p>`,
    (detail.history ?? ""),
    // One headline: with the shared status, its words lead (task-status.ts); "Changes saved" would compete with them.
    taskStatus !== null && o.headStatus !== false
      ? html`<header class="result-head"><div data-headline-tone="${taskStatus.tone}"><h2 class="status-headline" data-work-status="${status.token}"><i aria-hidden="true"></i>${taskStatus.headline}</h2><p class="status-sentence">${taskStatus.sentence}</p></div></header>`
      : html`<header class="result-head"><div><h2>${heading}</h2></div>${o.headStatus === false ? "" : statusLineHtml(status)}</header>`,
    html`<p class="result-summary">${outcome}</p>`,
    current == null || o.place === "review" && (current.state === "ready-to-check" || current.state === "complete") ? "" :
      html`<div class="verdict" data-current-outcome data-headline="${taskStatus!.headline}">${statusDetailsHtml(taskStatus!)}${statusWhyHtml(taskStatus!)}</div>`,
    attentionHtml,
    youCheckHtml,
    action,
    REVIEW_TOKENS.has(status.token) ? html`<details class="receipt-history"><summary>Review history</summary><p class="receipt-review meta" data-receipt-review="${status.token}">${status.detail}</p></details>` : "",
    tabs,
    view("summary", summaryParts),
    view("changes", changeParts),
    view("checks", checkParts),
    (detail.learning ?? ""),
    detail.skillTest ? "" : html`<section class="result-request" id="request-changes">${joinHtml(requestParts, "\n")}</section>`,
    html`</section>`,
  ]);
  const panel: BrowserResultPanel = {
    attributes: { "data-result-panel": "", "data-result-place": o.place, "data-result-lead": lead, "data-result-task": detail.rootId ?? detail.taskId, "data-result-user": o.user, ...resultFactsAttributeMap(facts) },
    heading, outcome,
    status: taskStatus,
    reviewHistory: REVIEW_TOKENS.has(status.token) ? status.detail : null,
    attention: attention.filter(one => !shortenedMaterialReason(one)).map(plainReasonWords),
    youCheck,
    // The same counts as the Requirements row (a refuted report verifies none of them, and says Unverified).
    requirements: proof === null || proof.verdict === "refuted" ? null : requirementsOf(proof.matrix),
    limits: attention.filter(one => shortenedMaterialReason(one)),
    tabs: RESULT_TABS.map(tab => ({ key: tab.key, label: tab.key === "checks" && proof?.matrix.some(row => row.assessment !== undefined) ? "Requirements" : tab.label, count: tabCounts[tab.key], href: o.hrefFor(tab.key), active: tab.key === o.tab })),
    views: [{ key: "summary", html: htmlString(joinHtml(summaryParts, "\n")) }, { key: "changes", html: htmlString(joinHtml(changeParts, "\n")) }, { key: "checks", html: htmlString(joinHtml(checkParts, "\n")) }],
    history: detail.history === undefined ? "" : htmlString(detail.history),
    learning: detail.learning === undefined ? "" : htmlString(detail.learning),
    request: detail.skillTest ? null : htmlString(joinHtml(requestParts, "\n")),
    canRequest: detail.canAnnotate && o.csrf !== "",
    need,
    requestQuiet: detail.canAnnotate && o.csrf !== "" && detail.comments.length === 0 && (detail.pastComments?.length ?? 0) === 0 && detail.revisions.length === 0,
  };
  return { html: panelHtml, panel };
}

/** Changed lines shown beside one "You check this one" item: at most this many per file, three files. */
export const CHECK_EXCERPT_LINES = 12;

/** Each requirement only a person can confirm, with the evidence to judge
 * it by, inline: the changed lines in the files it cites (citing none, the
 * change's first file, labelled as not cited), the screenshots it cites
 * (none cited: every validated one), and the agent's own note. */
export function personCheckItems(proof: ProofBundleView, patchText: string | null, shots: readonly ResultScreenshot[], runId: number): BrowserCheckItem[] {
  const rows = proof.matrix.filter(row => row.state === "manual-review");
  if (rows.length === 0) return proof.reasons.some(reason => manualReviewCriterionOf(reason) !== null)
    ? [{ id: "you-check", statement: "", words: personCheckWords(null), note: null, excerpts: [], shots: [] }] : [];
  const diff = patchText === null ? null : parseReviewDiff(patchText);
  const excerptOf = (file: ReviewDiffFile, cited: boolean): BrowserCheckItem["excerpts"][number] => {
    const changed = file.hunks.flatMap(hunk => hunk.lines).filter((line): line is ReviewDiffLine & { kind: "addition" | "deletion" } => line.kind === "addition" || line.kind === "deletion");
    return { path: file.path, cited, lines: changed.slice(0, CHECK_EXCERPT_LINES).map(line => ({ kind: line.kind, line: line.newLine ?? line.oldLine, text: line.text })), more: Math.max(0, changed.length - CHECK_EXCERPT_LINES) };
  };
  return rows.map(row => {
    const refs = row.answered ?? [];
    const paths = refs.filter(one => one.kind === "changed-path").map(one => one.ref);
    const files = diff === null ? [] : paths.length > 0 ? diff.files.filter(file => paths.includes(file.path)).map(file => excerptOf(file, true))
      : diff.files.slice(0, 1).map(file => excerptOf(file, false));
    const cited = refs.filter(one => one.kind === "screenshot").map(one => one.ref);
    const pictures = cited.length > 0 ? shots.filter(shot => cited.includes(shot.path)) : shots;
    const notes = refs.filter(one => one.kind === "manual-review").map(one => one.ref.trim()).filter(one => one !== "");
    return {
      id: row.id, statement: row.statement, words: personCheckWords(row.statement), note: notes.length === 0 ? null : notes.join(" "),
      excerpts: files.filter(one => one.lines.length > 0).slice(0, 3),
      shots: pictures.slice(0, 4).map(shot => ({ src: `/r/${runId}/evidence/${shot.artifactId}`, href: `/r/${runId}/evidence/${shot.artifactId}`, caption: shot.caption })),
    };
  });
}

/** The completion blocker no acceptance resolves (a failed check, an unresolved HIGH finding), in words, or null. */
export function hardBlockerOf(assignment: AssignmentSnapshot | null | undefined): string | null {
  return assignment?.readiness?.blockers.find(one => one.key === "check-failed" || one.key === "high")?.message ?? null;
}

/** A Needs you result's one action (needs-you.ts): a link to the act that resolves it, or Confirm it
 * stopped behind the password. Null under every other headline. */
export function needActionOf(assignment: AssignmentSnapshot | null, status: TaskStatus | null, csrf: string, returnTo: string,
  result?: { accepted: boolean; humanReview: boolean; run: number; action: string; rebuildable?: boolean; refuted?: boolean }): BrowserNeedAction | null {
  if (assignment === null || status === null || status.headline !== "Needs you" || status.need == null) return null;
  // Accepting can't resolve it: Request changes is the way on, beside the reason.
  if (result !== undefined && hardBlockerOf(assignment) !== null) return null;
  const action = assignment.primaryAction;
  const rebuild = { href: null, confirm: null, rebuild: { action: `${taskHref(assignment.rootId)}/requeue` } };
  // Built to an earlier plan: Build again, in place (the task page's requeue).
  if (action?.code === "retry-task" && status.need.key === "rebuild" && csrf !== "") return { label: status.need.action.label, ...rebuild };
  if (result !== undefined) {
    if ((status.need.key === "review-result" || result.refuted === true) && !result.accepted && csrf !== "") return { label: result.humanReview ? "Accept result" : "Accept with exception", href: null, confirm: null,
      accept: { action: result.action, run: result.run, returnTo, note: result.humanReview ? null : "Why is this safe to accept?" } };
    // The task page sends the person here: never back to it. What this page can do leads — Accept
    // a check only a person can make, or Build again a result that may run again.
    const here = (action?.code === "open-result" || action?.code === "inspect-run") && action.target.runId === result.run;
    if (here && csrf !== "" && !result.accepted && result.humanReview) return { label: "Accept result", href: null, confirm: null, accept: { action: result.action, run: result.run, returnTo, note: null } };
    if (here && csrf !== "" && result.rebuildable === true) return { label: NEEDS.rebuild.action.label, ...rebuild };
    // Nothing here resolves it: no act at all, never a link back to the task (which sends the person here).
    if (status.need.key === "review-result" || here) return null;
  }
  const confirm = action?.code === "confirm-stopped" && action.target.runId !== null && csrf !== ""
    ? { action: `${taskHref(assignment.rootId)}/confirm-stopped`, run: action.target.runId, returnTo, checked: needsCheck(assignment) } : null;
  return { label: status.need.action.label, href: assignmentActionHref(assignment) ?? taskHref(assignment.rootId), confirm };
}

/** A build Toolroll can't check at all: the approver ticks that they checked before confirming. */
export const needsCheck = (assignment: AssignmentSnapshot): boolean => assignment.need != null && "key" in assignment.need && assignment.need.key === "check-stopped";

/** The server page's form of the same: the need's action first, Request changes as the quiet second. */
export function resultNeedAction(need: BrowserNeedAction, o: ResultPanelOptions, canRequest: boolean): Html {
  const control = need.accept != null
    ? postForm(need.accept.action, html`${
      need.accept.note === null ? "" : html`<input type="text" name="note" maxlength="500" required placeholder="${need.accept.note}" aria-label="${need.accept.note}">`
      }<button type="submit" data-primary-action data-accept-result style="min-height:44px">${need.label}</button>`,
      { attrs: { class: "accept-result" }, returnTo: need.accept.returnTo, hidden: { run: need.accept.run } })
    : need.rebuild != null
    ? postForm(need.rebuild.action, html`<button type="submit" data-primary-action data-rebuild style="min-height:44px">${need.label}</button>`, { attrs: { class: "rebuild" } })
    : need.confirm !== null
    ? postForm(need.confirm.action, html`${
      need.confirm.checked === true ? html`<label><input type="checkbox" name="checked" value="yes" required> Nothing from build #${need.confirm.run} is running</label>` : ""
      }<label>Your password<input type="password" name="token" autocomplete="current-password" required></label><button type="submit" style="min-height:44px">${need.label}</button>`,
      { attrs: { id: "confirm-stopped", class: "confirm-stopped" }, returnTo: need.confirm.returnTo, hidden: { run: need.confirm.run } })
    : html`<a class="button-link" href="${need.href ?? "#"}" data-primary-action>${need.label}</a>`;
  return html`<div class="result-action" data-result-action="need">${control}${canRequest && o.csrf !== "" ? html`<a class="result-feedback-link" href="#request-changes">Request changes</a>` : ""}</div>`;
}

/** The outcome in one bounded sentence (repair 2026-09-14): the handoff's
 * first sentence, cut at a word when it runs past 180 characters. The
 * full conclusion stays available behind the Summary's disclosure. */
export function conciseOutcomeOf(conclusion: string): string {
  const flat = oneLineOf(conclusion, 2_000);
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  const bounded = sentence.length <= 140 ? sentence : `${sentence.slice(0, 140).replace(/\s+\S*$/, "")}…`;
  return bounded.trim();
}

/** Exactly one primary act for the result (repair 2026-09-14), chosen from
 * its state: draft the CI repair, create the revision the notes are
 * waiting for, open the pull request, or request changes. A bearer session
 * (no token) gets no control; the cockpit renders its own next-action
 * card instead (`action: false`). */
export function resultPrimaryAction(detail: ResultDetail, o: ResultPanelOptions, prUrl: string | null): Html {
  const wrap = (kind: string, control: Html): Html => html`<div class="result-action" data-result-action="${kind}">${control}</div>`;
  if (detail.ciFailing && o.csrf !== "") {
    return wrap("draft-repair", postForm(`/r/${detail.run.id}/draft-repair`, html`<button type="submit">Draft a repair task</button>`));
  }
  if (detail.comments.length > 0 && o.csrf !== "") return wrap("revise", html`<a class="result-feedback-link" href="#request-changes">Review saved notes</a>`);
  if (detail.publication !== null && detail.publication.prNumber !== null && prUrl !== null) return wrap("open-pr", html`<a class="button-link" href="${prUrl}">Open PR #${detail.publication.prNumber}</a>`);
  if (detail.assignment == null && detail.proof?.matrix.some(row => row.assessment !== undefined) && detail.proof.reasons.includes(GOAL_ASSESSMENT_PENDING)) return wrap("open-result", html`<a class="button-link" href="${reviewHref(detail.taskId)}">Open result</a>`);
  if (detail.assignment == null && detail.proof?.matrix.some(row => row.assessment !== undefined && row.review?.judgement === "cannot-tell")) return wrap("review-evidence", html`<a class="button-link" href="${o.hrefFor("checks")}">Review evidence</a>`);
  if (detail.canAnnotate && o.csrf !== "") return wrap("request-changes", html`<a class="result-feedback-link" href="#request-changes">Request changes</a>`);
  return html``;
}

/** The run's facts as rows — one renderer for the page and its live
 * fragment (A4). Elapsed ticks client-side while the run is open. */
/** The run's route provenance in plain words (v47): the exact agent it
 * spent as, in which role, and how that agent was chosen. */
export function runAgentWords(route: RouteStamp | null | undefined): string | null {
  if (route === null || route === undefined) return null;
  const role = route.phase === "plan" ? "planner" : route.phase === "build" ? "builder" : route.phase === "repair" ? "repair" : "reviewer";
  const how =
    route.chosen === "fallback"
      ? "the approved fallback"
      : route.chosen === "override"
        ? "chosen by an approver"
        : route.chosen === "pinned"
          ? "pinned"
          : route.chosen === "legacy"
            ? "from the approved profile"
            : "recommended";
  return `${route.provider}${route.model === null ? "" : ` · ${route.model}`} as the ${role} — ${how}`;
}

export function runFactsRows(run: Run, taskId: string, live: boolean, route: RouteStamp | null = null): Html {
  const facts: [string, string | null, boolean?][] = [
    ["task", taskId, true],
    ["role", run.role],
    ["agent", runAgentWords(route)],
    ["quality", qualityModeTitle(run.qualityMode ?? "default")],
    ["outcome", live ? "running" : (run.outcome ?? "never finished")],
    ["phase", live && run.phase !== null ? phaseWords(run.phase) : null],
    ["reason", run.reason === null ? null : isInternalErrorReason(run.reason) ? "stopped with an internal error (below)" : reasonWords(run.reason)],
    ["runner", run.runner, true],
    ["branch", run.branch, true],
    ["model", run.model, true],
    ["starting point", run.baseRevision === null ? null : `${run.baseRevision.slice(0, 12)}…`, true],
    ["ended at", run.headRevision === null ? null : `${run.headRevision.slice(0, 12)}…`, true],
    ["started", when(run.startedAt), true],
    ["finished", when(run.finishedAt), true],
    ["provider started", when(run.providerStartedAt), true],
    ["tokens in", run.tokensIn === null ? null : run.tokensIn.toLocaleString(), true],
    ["tokens out", run.tokensOut === null ? null : run.tokensOut.toLocaleString(), true],
    // Auth is part of the economic fact: Claude's subscription harness
    // reports an API-price equivalent, not a separate API-key charge.
    [
      "usage",
      run.providerStartedAt === null && run.tokensIn === null && run.tokensOut === null && run.costUsd === null ? null : runCostWords(run, live),
      run.costUsd !== null && run.authMode !== "subscription",
    ],
  ];
  const elapsed =
    live && run.startedAt !== null
      ? html`<p class="row"><span class="meta" style="min-width:8.5rem">elapsed</span> <time class="mono" data-elapsed-since="${run.startedAt}"></time></p>`
      : "";
  return html`${joinHtml(
    facts
      .filter((fact): fact is [string, string, boolean?] => fact[1] !== null && fact[1] !== "")
      .map(
        ([label, value, mono]) =>
          html`<p class="row"><span class="meta" style="min-width:8.5rem">${label}</span> <span${mono === true ? html` class="mono"` : ""}>${value}</span></p>`,
      ), "\n")}${elapsed}${
    // Machine output (a stack trace, a path, "Error:" text) reads as an internal error everywhere else; its detail is here, as recorded.
    run.reason !== null && isInternalErrorReason(run.reason)
      ? html`<p class="row"><span class="meta" style="min-width:8.5rem">recorded error</span></p><pre class="mono" id="run-reason-detail" style="white-space:pre-wrap;overflow-wrap:anywhere">${run.reason}</pre>`
      : ""}`;
}

export function runPage(
  chrome: Chrome,
  run: Run,
  taskId: string,
  artifacts: Artifact[],
  terminal: TerminalDiffView | null = null,
  notes: { id: number; author: string; note: string; createdAt: string }[] = [],
  csrf = "",
  comments: DiffComment[] = [],
  ciRepair: { pr: number } | null = null,
  liveScript?: string,
  peekable = false,
  running = false,
  editor: { worktree: string } | null = null,
  editorToggle: { on: boolean } | null = null,
  noted = false,
  structuredHandoff: StructuredHandoffView | null = null,
  proofBundle: ProofBundleView | null = null,
  route: RouteStamp | null = null,
  publicationRow: Publication | null = null,
  review: ReviewFacts | null = null,
  result: { detail: ResultDetail; tab: ResultTab; user: string; requestToken: string } | null = null,
  sourceDigest: string | null = null,
): Screen {
  const rows = runFactsRows(run, taskId, running, route);
  // The live peek region (A2): the poller fills it only on a serve that
  // asserted its runner. Without the assertion the section still appears
  // for a running build and says honestly why it is empty \u2014 a page that
  // silently lacked the region while the task screen promised a live view
  // read as broken (round-4, A1).
  const peek = !running
    ? ""
    : peekable
      ? html`<h2>What is changing right now</h2><div id="run-peek"><p class="meta">Watching\u2026 the first look lands within 15 seconds</p></div><p class="meta" id="run-peek-stamp"></p>`
      : html`<h2>What is changing right now</h2><p class="meta">The live file view is off \u2014 start serve with ${"--runner <name>"} naming this machine's worker, and it appears here</p>`;
  // The live transcript (arc 1): the agent's own words, streamed to a file
  // beside the run and polled as raw text. Honesty stated on the surface:
  // this is display only, and the machine running the agent could alter it.
  const transcript = !running
    ? ""
    : !peekable
      ? html`<h2>What the agent is saying</h2><p class="meta">The live transcript is off \u2014 start serve with ${"--runner <name>"} naming this machine's worker, and it appears here</p>`
      : run.provider !== "claude"
        ? html`<h2>What the agent is saying</h2><p class="meta">The live transcript needs the claude harness for now \u2014 this build runs on ${run.provider}</p>`
        : html`<h2>What the agent is saying</h2><p class="meta">Display only \u2014 this is not evidence, and the machine running the agent could alter it</p><pre id="live-transcript" class="mono" style="max-height:24rem;overflow:auto;white-space:pre-wrap"></pre><p class="meta" id="live-transcript-state"></p>`;
  const resultSummary = structuredHandoff?.conclusion ?? run.handoff;
  const resultList = (label: string, items: string[]): Html | string =>
    items.length === 0
      ? ""
      : html`<div class="result-section"><strong>${label}</strong><ul>${items.map(one => html`<li>${one}</li>`)}</ul></div>`;
  const handoff =
    resultSummary === null
      ? ""
      : html`<section class="card result-card"><h2>Result</h2><p class="recap">${resultSummary}</p>${
        structuredHandoff === null
          ? ""
          : [resultList("completed", structuredHandoff.changes),
            resultList("checks reported by the agent", structuredHandoff.verification),
            resultList("follow-up", structuredHandoff.followUps)]}</section>`;
  const evidence =
    artifacts.length === 0
      ? ""
      : html`<details class="evidence-files"><summary>Saved files <span class="meta">(${artifacts.length})</span></summary><ul>${
        artifacts
          .map(
            artifact =>
              html`<li><a href="/r/${run.id}/evidence/${artifact.id}">${evidenceWords(artifact.kind)}</a> <span class="meta" title="${artifact.bytesStored} bytes stored${artifact.truncated ? ` of ${artifact.bytesOriginal}` : ""}">${artifact.truncated ? `${humanBytes(artifact.bytesStored)} of ${humanBytes(artifact.bytesOriginal)} · partial` : humanBytes(artifact.bytesStored)}</span></li>`,
          )}</ul></details>`;
  // Review comments on the immutable terminal diff (M6.8): listed, added,
  // and sealed into ONE unapproved revision task. The seal is deliberately
  // plain — the ceremony lives on the revision task's approval screen,
  // which restates the batch; this button only creates the unapproved task.
  const hasTerminalDiff = terminal !== null && terminal.patch !== null && !("problem" in (terminal.patch as object));
  const commentPathWords = (path: string, line: number | null): Html => {
    const shown = `${path}${line === null ? "" : `:${line}`}`;
    const href = editor === null ? null : editorFileHref(editor.worktree, path, line);
    return href === null
      ? html`<span class="mono">${shown}</span> `
      : html`<a class="mono" href="${href}">${shown}</a> `;
  };
  const commentRows = comments
    .map(
      one =>
        html`<div class="diff-comment"><span class="diff-comment-pin" aria-hidden="true"></span><p>${one.path === null ? "" : commentPathWords(one.path, one.line)}${one.note}</p><span class="meta">${one.author} · ${whenTime(one.createdAt)}</span></div>`,
    );
  const commentForm =
    csrf === "" || !hasTerminalDiff
      ? null
      : postForm(`/r/${run.id}/comment`, html`<div class="diff-comment-target"><label>File<input type="text" name="path" placeholder="select a line above" aria-label="file" class="mono"></label><label>Line<input type="text" name="line" placeholder="—" aria-label="line" inputmode="numeric"></label></div><label>Change requested<textarea name="note" rows="2" maxlength="${LIMITS.note}" placeholder="Explain what should change and why" aria-label="review comment" aria-describedby="comment-note-limit"${noted ? " autofocus" : ""}></textarea></label><span class="meta diff-comment-limit" id="comment-note-limit">up to ${LIMITS.note} characters</span><button type="submit">Add annotation</button>`,
        { attrs: { class: "card diff-comment-form", id: "comment-form" } });
  // The device-side half of the editor-link activation (arc 6, finding 1):
  // rendered only when the server capability exists and this run belongs
  // to this machine's runner — the person at the browser flips it.
  const editorToggleForm =
    editorToggle === null || csrf === ""
      ? ""
      : postForm("/session/editor-links", html`<button type="submit">${editorToggle.on ? "stop opening files in VS Code from this device" : "open files in VS Code from this device"}</button><span class="meta"> — only useful when this browser runs on the machine that holds the worktrees</span>`,
        { attrs: { class: "row" }, returnTo: `/r/${run.id}`, hidden: { on: editorToggle.on ? "0" : "1" } });
  const reviseForm =
    csrf === "" || comments.length === 0
      ? ""
      : postForm(`/r/${run.id}/revise`, html`${revisionSealFields(comments, sourceDigest)}<div><strong>${comments.length} annotation${comments.length === 1 ? "" : "s"} ready</strong><span class="meta">Creates one revision carrying this exact batch. You review its scope before anything builds.</span></div><button type="submit">Create revision from annotations</button>`,
        { attrs: { class: "card revision-from-comments" } });
  // CI repair, suggestion-first (M8.18): the observed red episode earns a
  // button; the button drafts ONE unapproved task; a person approves it.
  const repairCard =
    ciRepair === null || csrf === ""
      ? ""
      : html`<div class="card"><p><strong>CI is failing on PR #${ciRepair.pr}</strong> <span class="meta">observed by the episode watcher</span></p>${
        postForm(`/r/${run.id}/draft-repair`, html`<button type="submit">Draft a repair task</button><span class="meta"> — one unapproved task; you approve its scope before anything builds</span>`)}</div>`;

  const reviewCard = html`${
    commentRows.length === 0 && commentForm === null ? "" : html`<h2 id="review">Review and revise</h2><p class="meta">Annotate the diff above. When the batch is ready, create one scoped revision task from it.</p>${
      commentRows.length === 0 ? "" : html`<div class="diff-comments">${joinHtml(commentRows, "\n")}</div>`}${commentForm}${reviseForm}${editorToggleForm}`}${repairCard}`;

  const noteRows = joinHtml(
    notes.map(
      one =>
        html`<p class="row"><span class="meta">${one.author} · ${whenTime(one.createdAt)}</span> ${one.note}</p>`,
    ), "\n");
  const noteForm =
    csrf === ""
      ? null
      : postForm(`/r/${run.id}/note`, html`<input type="text" name="note" placeholder="a note for whoever reads this run next" aria-label="run note" style="width:100%;max-width:28rem"><button type="submit">Add note</button>`, { attrs: { class: "row" } });
  const notesCard = notes.length === 0 && noteForm === null ? "" : html`<h2>Operator notes</h2>${noteRows}${noteForm}`;

  // Outcome first (UI polish 2026-09-13): a finished build leads with its
  // result, proof, and diff; the machine facts fold under "Build details".
  // A live build keeps the facts open — they are what a watcher polls.
  const facts =
    running
      ? html`<div id="run-facts">${rows}</div><p class="meta" id="run-facts-stamp"></p>`
      : html`<details class="run-facts-details"><summary>Run record<span class="meta">${[run.runner, run.provider, run.outcome ?? "never finished"].join(" · ")}</span></summary><div id="run-facts">${rows}</div></details>`;
  // A finished result (package 3) is the ONE shared panel — Summary /
  // Changes / Checks with Request changes beside it — the same markup the
  // review cockpit and the chat's result view render. Every other run
  // (live, failed, interrupted) keeps its record-by-record page.
  const resultPanel =
    result === null
      ? null
      : resultPanelHtml(result.detail, {
          place: "run",
          tab: result.tab,
          csrf,
          user: result.user,
          noted,
          requestToken: result.requestToken,
          hrefFor: one => (one === "summary" ? `/r/${run.id}` : `/r/${run.id}?tab=${one}`),
          returnTo: `/r/${run.id}`,
          back: null,
        });
  return screen(`build #${run.id}`, joinHtml([
    html`<h1>Build #${run.id} <span class="meta"><a href="${taskHref(taskId)}">${taskId}</a></span></h1>`,
    running ? facts : "",
    transcript,
    peek,
    ...(resultPanel === null
      ? [
          handoff,
          evidenceBundleCard(proofBundle, run, publicationFactsOf(publicationRow), review),
          terminal === null ? "" : terminalDiffCard(terminal, run.id, editor, commentForm !== null),
          reviewCard,
        ]
      : [resultPanel, editorToggleForm]),
    running ? "" : facts,
    evidence,
    notesCard,
  ], "\n"), {
    chrome,
    // One composed functional script (arc 4 contract): the pollers when the
    // run is live, the result panel's tabs/draft script or the legacy
    // comment prefill when a form exists. Neither fetches — they earn
    // neither connect-src nor the noscript refresh.
    ...(liveScript === undefined && commentForm === null && resultPanel === null
      ? {}
      : {
          functional: {
            script: (liveScript ?? "") + (resultPanel !== null ? RESULT_REVIEW_SCRIPT : commentForm === null ? "" : prefillScript()),
            fetches: liveScript !== undefined,
          },
        }),
  });
}

/**
 * Click-to-prefill (arc 6, finding 4): client-side FORM mutation, named as
 * such — normal viewing stays the default; "Annotate" reveals line pins.
 * A pin or file button copies its target into the comment form and focuses
 * the note field. No fetch, endpoint, or submit: comments still leave
 * through the same CSRF'd form POST. Reads data attributes, writes input
 * values, and flips presentational state — never markup. The note counter
 * (follow-up on build 1540) reads the textarea's own maxlength — the
 * server's LIMITS.note — into the helper text, so the two cannot drift.
 */
export function prefillScript(): string {
  return (
    `(function(){var form=document.getElementById("comment-form");if(!form)return;var review=document.querySelector("[data-review-diff]");` +
    `var noteBox=form.querySelector("[name=note]"),limit=document.getElementById("comment-note-limit");if(noteBox&&limit&&noteBox.maxLength>0){` +
    `function tally(){limit.textContent=noteBox.value.length===0?"up to "+noteBox.maxLength+" characters":noteBox.value.length+" of "+noteBox.maxLength+" characters";}tally();noteBox.addEventListener("input",tally);}` +
    `if(review){review.setAttribute("data-mode","view");review.addEventListener("click",function(ev){` +
    `var mode=ev.target&&ev.target.closest?ev.target.closest("button[data-diff-mode]"):null;if(!mode)return;` +
    `var value=mode.getAttribute("data-diff-mode")==="annotate"?"annotate":"view";review.setAttribute("data-mode",value);` +
    `review.querySelectorAll("button[data-diff-mode]").forEach(function(one){one.setAttribute("aria-pressed",String(one===mode));});});}` +
    `document.addEventListener("click",function(ev){` +
    `var button=ev.target&&ev.target.closest?ev.target.closest("button.pick-file,button.pick-line"):null;if(!button)return;` +
    `var path=form.querySelector("[name=path]");var line=form.querySelector("[name=line]");var note=form.querySelector("[name=note]");` +
    `if(path)path.value=button.getAttribute("data-path")||"";` +
    `if(line)line.value=button.getAttribute("data-line")||"";` +
    `form.scrollIntoView({behavior:"smooth",block:"center"});if(note)note.focus();});})();`
  );
}

/** The primary review act opens the Checks view it names. The anchor
 * still lands on the result without JavaScript (the server honours
 * `?tab=checks`); this only removes the reload. */
export function reviewEvidenceScript(): string {
  return (
    `(function(){var link=document.querySelector("[data-open-evidence]"),tab=document.querySelector('[data-result-tab="checks"]'),panel=document.getElementById("result");` +
    `if(!link||!tab||!panel)return;link.addEventListener("click",function(ev){ev.preventDefault();tab.click();panel.scrollIntoView({behavior:"smooth",block:"start"});});})();`
  );
}

/** The facts region alone, for the open-run poll (A4). A finished run's
 * fragment says so instead of quietly growing forms (finding 5), and a run
 * that stopped being the task's live claim says so too — both carry the
 * stop marker, so an open tab quits refetching a dead build (round-4
 * finding 15). */
export function runFactsFragment(run: Run, taskId: string, live: boolean, route: RouteStamp | null = null): Html {
  if (run.outcome !== null) {
    return html`<p class="meta" data-region-stop>finished — <a href="/r/${run.id}">reload for the final record</a></p>`;
  }
  if (!live) {
    return html`<p class="meta" data-region-stop>this build stopped without finishing — <a href="/r/${run.id}">reload for the record</a></p>`;
  }
  return runFactsRows(run, taskId, live, route);
}
